"""Render a post.md the way ryokansociety.com would show it.

Writes, next to post.md:
  content.html  the article body exactly as it goes into the CMS (`content_html`)
  preview.html  that body inside the live site's own header, footer, stylesheets and
                blog article template (apps/ryokan-web/src/app/blog/[slug]/page.tsx),
                with photos loaded, plus a small review panel that is not part of the page.

The live template is copied, not imitated: the /blog page shell is fetched from the live site
(cached in exports/ryokan-blog/_template/, refresh with --refresh-template), its scripts are
removed so React can't replace the content, and its stylesheets and fonts are saved locally.
The article-body stylesheet (blog-content.css) is read from the site repo when it's on this
machine (RYOKAN_WEB_DIR, default ~/source/crakseo-directories/apps/ryokan-web), else from the
cached copy.
"""
import html as H
import json
import os
import re
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

SITE = "https://ryokansociety.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130 Safari/537.36")
RYOKAN_WEB = Path(os.environ.get("RYOKAN_WEB_DIR",
                                 Path.home() / "source/crakseo-directories/apps/ryokan-web"))
KAI = re.compile(r"`?\[KAI:[^\]]*\]`?")


# ---------- front matter ----------

def _value(v):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        return [x.strip().strip('"') for x in v[1:-1].split(",") if x.strip()]
    if v.startswith("{") and v.endswith("}"):
        out = {}
        for m in re.finditer(r'(\w+):\s*("(?:[^"\\]|\\.)*"|[^,}]+)', v[1:-1]):
            out[m.group(1)] = m.group(2).strip().strip('"')
        return out
    return v.strip('"')


def split_front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            meta[k.strip()] = _value(v)
    return meta, m.group(2)


# ---------- markdown (the subset our posts use) ----------

def slug_id(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def inline(s):
    codes = []

    def keep_code(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    s = re.sub(r"`([^`]+)`", keep_code, s)
    s = H.escape(s, quote=False)
    def img(m):
        alt, src, w = H.escape(m.group(1)), H.escape(m.group(2)), m.group(3)
        if w:  # ![alt](url){w=360}: fixed-width thumbnail, e.g. inside a table cell
            return (f'<img src="{src}" alt="{alt}" width="{w}" loading="lazy" '
                    f'style="width:{w}px;height:{int(w) * 2 // 3}px;object-fit:cover;margin:0 0 0.375rem">')
        return f'<img src="{src}" alt="{alt}" loading="lazy">'

    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)(?:\{w=(\d+)\})?", img, s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{H.escape(m.group(2))}">{m.group(1)}</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", s)
    return re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{H.escape(codes[int(m.group(1))], quote=False)}</code>", s)


def _cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]


def md_to_html(md):
    lines = md.replace("\r\n", "\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("<"):  # raw HTML block, passed through
            block = []
            while i < len(lines) and lines[i].strip():
                block.append(lines[i]); i += 1
            out.append("\n".join(block))
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            n, t = len(m.group(1)), m.group(2).strip()
            out.append(f'<h{n} id="{slug_id(KAI.sub("", t))}">{inline(t)}</h{n}>')
            i += 1
            continue
        if re.match(r"^\s*(---|\*\*\*)\s*$", line):
            out.append("<hr>"); i += 1
            continue
        if line.startswith(">"):
            block = []
            while i < len(lines) and lines[i].startswith(">"):
                block.append(re.sub(r"^> ?", "", lines[i])); i += 1
            out.append(f"<blockquote>{md_to_html(chr(10).join(block))}</blockquote>")
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|?\s*:?-{3,}", lines[i + 1]):
            head = _cells(line); i += 2
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(_cells(lines[i])); i += 1
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            tb = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows)
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table>")
            continue
        if re.match(r"^\s*([-*]|\d+\.)\s+", line):
            ordered = bool(re.match(r"^\s*\d+\.", line))
            items = []
            while i < len(lines) and re.match(r"^\s*([-*]|\d+\.)\s+", lines[i]):
                items.append(re.sub(r"^\s*([-*]|\d+\.)\s+", "", lines[i])); i += 1
                while i < len(lines) and lines[i].startswith("  ") and lines[i].strip():
                    items[-1] += " " + lines[i].strip(); i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
            continue
        para = []
        while (i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,4}\s|>|\||<|\s*([-*]|\d+\.)\s)", lines[i])
               and not re.match(r"^\s*---\s*$", lines[i])):
            para.append(lines[i].strip()); i += 1
        img = re.fullmatch(r"!\[[^\]]*\]\([^)\s]+\)", para[0]) if para else None
        if img:  # a photo, with its credit line as the caption
            cap = " ".join(para[1:])
            nxt = i
            while nxt < len(lines) and not lines[nxt].strip():
                nxt += 1
            if not cap and nxt < len(lines) and re.fullmatch(r"\*[^*].*\*", lines[nxt].strip()):
                cap, i = lines[nxt].strip(), nxt + 1
            capm = re.fullmatch(r"\*(.*)\*", cap.strip()) if cap else None
            cap_html = f"<figcaption>{inline(capm.group(1) if capm else cap)}</figcaption>" if cap else ""
            out.append(f"<figure>{inline(para[0])}{cap_html}</figure>")
            continue
        out.append(f"<p>{inline(' '.join(para))}</p>")
    return "\n".join(out)


# ---------- the live page shell ----------

def _get(url):
    import requests
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    return r


def refresh_template(tdir):
    """Save the live /blog shell, its stylesheets and fonts, and blog-content.css."""
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / "assets").mkdir(exist_ok=True)
    page = _get(f"{SITE}/blog").text
    css_files = []
    for href in re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"', page):
        url = urljoin(SITE, href)
        css = _get(url).text
        for ref in sorted(set(re.findall(r"url\(([^)]+)\)", css))):
            ref_clean = ref.strip("'\"")
            if ref_clean.startswith("data:"):
                continue
            furl = urljoin(url, ref_clean)
            name = re.sub(r"[^\w.-]", "_", furl.rsplit("/", 1)[-1].split("?")[0])
            try:
                (tdir / "assets" / name).write_bytes(_get(furl).content)
                css = css.replace(f"url({ref})", f"url({name})")
            except Exception:
                css = css.replace(f"url({ref})", f"url({furl})")
        name = re.sub(r"[^\w.-]", "_", url.rsplit("/", 1)[-1])
        (tdir / "assets" / name).write_text(css)
        css_files.append(name)
    (tdir / "blog-shell.html").write_text(page)
    src = RYOKAN_WEB / "src/app/blog/blog-content.css"
    if src.exists():
        (tdir / "assets" / "blog-content.css").write_text(src.read_text())
    meta = {"fetched": date.today().isoformat(), "from": f"{SITE}/blog", "css": css_files,
            "blog_content_css": str(src) if src.exists() else "cached copy"}
    (tdir / "template.json").write_text(json.dumps(meta, indent=1))
    return meta


def blog_content_css(tdir):
    src = RYOKAN_WEB / "src/app/blog/blog-content.css"
    if src.exists():
        return src.read_text()
    cached = tdir / "assets" / "blog-content.css"
    return cached.read_text() if cached.exists() else ""


def label(d):
    try:
        y, m, dd = (int(x) for x in str(d)[:10].split("-"))
        return date(y, m, dd).strftime("%B %-d, %Y")
    except ValueError:
        return str(d)


BOOKING = re.compile(
    r"\b(ryokans?|hotels?|inns?|accommodations?|where to stay|places to stay|private onsen|onsen ryokan)\b", re.I)
INFO_OK = re.compile(r"\b(what is a ryokan|ryokan (etiquette|meaning|dinner|rules|vs\.? hotel|japan)|"
                     r"japanese ryokan|tattoo friendly (onsen|ryokan)|ryokan vs)\b", re.I)


def booking_terms(phrases):
    """Phrases with booking intent (reserved for destination/hub pages). See references/cannibalization.md."""
    out = []
    for ph in phrases:
        s = str(ph or "").strip()
        if s and BOOKING.search(s) and not INFO_OK.search(s):
            out.append(s)
    return out


def cannibal_report(meta, body_md):
    h2s = re.findall(r"^##\s+(.+)$", body_md, re.M)
    checks = {"target": [meta.get("target_keyword")], "secondary": list(meta.get("secondary_keywords") or []),
              "title": [meta.get("title")], "h1": [meta.get("h1")],
              "h2": [h for h in h2s if not h.lower().startswith(("photo credits", "book your", "about the author"))]}
    hits = {k: booking_terms(v) for k, v in checks.items()}
    # A "Where to stay in X: our picks" heading is allowed; "best X ryokan" is not.
    hits["h2"] = [h for h in hits["h2"] if not re.match(r"where to stay in [^:]+: our picks", h, re.I)]
    return {k: v for k, v in hits.items() if v}


def article_markup(meta, body_html):
    """Mirror of apps/ryokan-web/src/app/blog/[slug]/page.tsx."""
    title = H.escape(meta.get("title", ""))
    pub = meta.get("published") or meta.get("updated") or date.today().isoformat()
    upd = meta.get("updated") or pub
    # Proposed template rule (see _authors/kai/dev-notes.md): always show the authored date; show
    # "Last updated" only when the post changed on a later day than it was published.
    updated = (f' <time datetime="{upd}">Last updated {label(upd)}.</time>' if upd > pub else "")
    return f"""<div class="mx-auto max-w-3xl px-4 py-12 sm:px-6">
<nav aria-label="Breadcrumb" class="text-[13px] font-medium text-gray-500"><a class="transition hover:text-gray-700" href="{SITE}/">Home</a><span class="mx-1.5">/</span><a class="transition hover:text-gray-700" href="{SITE}/blog">Ryokan and onsen guides</a></nav>
<article class="mt-6"><header class="mb-8"><h1 class="page-title">{title}</h1>
<p class="mt-4 text-sm text-gray-500"><time datetime="{pub}">Published on {label(pub)}.</time>{updated}</p></header>
<div class="blog-content">{body_html}</div>
<footer class="mt-12 border-t border-gray-100 pt-6"></footer></article></div>"""


def review_panel(meta, body_html, md):
    words = len(re.findall(r"[A-Za-z0-9']+", re.sub(r"<[^>]+>", " ", body_html)))
    links = re.findall(r'<a href="([^"]+)"', body_html)
    own = [u for u in links if u.startswith(SITE)]
    inns = {u for u in own if re.match(rf"{SITE}/[^/?#]+/[^/?#]+$", u)}
    dests = {u.split("?")[0] for u in own if re.match(rf"{SITE}/[^/?#]+(\?.*)?$", u)}
    kai = KAI.findall(md)
    t, d = meta.get("title", ""), meta.get("meta_description", "")
    warn = []
    if meta.get("h1") and meta.get("h1") != t:
        warn.append("The live template uses <b>title</b> as the H1, so the front-matter h1 is not shown.")
    if len(t) > 60:
        warn.append(f"Title is {len(t)} characters (over 60).")
    if len(d) > 155:
        warn.append(f"Meta description is {len(d)} characters (over 155).")
    if "<blockquote>" in body_html:
        warn.append("Blockquotes render grey and italic on the live template.")
    for where, phrases in cannibal_report(meta, md.split("\n---\n", 1)[-1]).items():
        warn.append(f"Booking-page overlap in {where}: {H.escape('; '.join(phrases))} (references/cannibalization.md).")
    if kai:
        warn.append(f"{len(kai)} [KAI] note(s) still in the text (highlighted).")
    w = "".join(f"<li>{x}</li>" for x in warn) or "<li>None</li>"
    url = f"ryokansociety.com › blog › {H.escape(meta.get('slug', '').rsplit('/', 1)[-1])}"
    return f"""<aside id="rv" style="position:fixed;right:16px;bottom:16px;z-index:9999;width:360px;max-width:calc(100vw - 32px);
background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:13px/1.45 system-ui,sans-serif;color:#111">
<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eee;background:#fffbeb;border-radius:12px 12px 0 0">
<b>Local preview, not live</b><button onclick="document.getElementById('rvb').hidden^=1" style="border:0;background:none;cursor:pointer;color:#555">Hide / show</button></div>
<div id="rvb" style="padding:12px 14px">
<div style="color:#5f6368">Google result</div>
<div style="color:#202124;font-size:12px">{url}</div>
<div style="color:#1a0dab;font-size:17px;line-height:1.3">{H.escape(t)}</div>
<div style="color:#4d5156">{H.escape(d)}</div>
<div style="margin-top:10px">{words:,} words · {len(own)} links to our pages ({len(dests)} destination/hub, {len(inns)} inn) · {len(links) - len(own)} external</div>
<div style="margin-top:8px;color:#5f6368">Check</div><ul style="margin:2px 0 0 18px;padding:0;list-style:disc">{w}</ul>
</div></aside>
<style>mark.kai{{background:#fde047;color:#111;padding:0 3px;border-radius:3px;font-style:normal}}</style>"""


def build_preview(meta, body_html, md, tdir, markup=None):
    shell = (tdir / "blog-shell.html").read_text()
    shell = re.sub(r"<script\b.*?</script>", "", shell, flags=re.S)
    shell = re.sub(r'<link[^>]+rel="(?:preload|modulepreload|prefetch)"[^>]*>', "", shell)
    for name in json.loads((tdir / "template.json").read_text())["css"]:
        shell = re.sub(r'<link[^>]+href="[^"]*' + re.escape(name.split("_")[-1]) + r'"[^>]*>',
                       f'<link rel="stylesheet" href="../_template/assets/{name}">', shell)
    shell = re.sub(r'(href|src)="/(?!/)', rf'\1="{SITE}/', shell)
    shell = re.sub(r"<title>.*?</title>", f"<title>{H.escape(meta.get('title', ''))}</title>", shell, flags=re.S)
    shell = shell.replace("</head>", f"<style>{blog_content_css(tdir)}</style></head>")
    shown = KAI.sub(lambda m: f'<mark class="kai">{H.escape(m.group(0).strip("`"))}</mark>', body_html)
    shown = re.sub(r"<code>(\[KAI:[^<]*\])</code>", r'<mark class="kai">\1</mark>', shown)
    main = re.search(r"(<main[^>]*>)(.*?)(</main>)", shell, re.S)
    page = shell[:main.start()] + main.group(1) + (markup or article_markup(meta, shown)) + main.group(3) + shell[main.end():]
    return page.replace("</body>", review_panel(meta, body_html, md) + "</body>")


AUTHOR_NOTE = ("Proposed page: the live site has no author route yet. "
               "Needs /authors/<id>, the photo uploaded to photo_url, and Person schema.")


def load_author(out_root, author):
    """Authors registry: exports/ryokan-blog/_authors/<id>/author.md. Returns (meta, body) or None."""
    aid = (author or "").strip().lower()
    f = out_root / "_authors" / aid / "author.md"
    if not aid or not f.exists():
        return None
    meta, body = split_front_matter(f.read_text())
    return meta, body


def _avatar(a, px):
    return (f'<img src="{SITE}{H.escape(a["photo_url"])}" alt="{H.escape(a["photo_alt"])}" width="{px}" height="{px}" '
            f'loading="lazy" style="width:{px}px;height:{px}px;object-fit:cover;border-radius:9999px;margin:0">')


def byline_html(a):
    """Top of the post body. Plain elements only, so it works inside the current live template."""
    return (f'<p style="display:flex;align-items:center;gap:0.75rem;margin-top:0">{_avatar(a, 44)}'
            f'<span>By <a href="{SITE}{a["slug"]}">{H.escape(a["name"])}</a>, '
            f'{H.escape(a["role"].replace("Founder, ", "founder of "))}</span></p>\n')


def about_html(a):
    """End of the post body, before Photo credits."""
    return (f'<h2 id="about-the-author">About the author</h2>\n'
            f'<div style="display:flex;gap:1rem;align-items:flex-start">{_avatar(a, 96)}'
            f'<p style="margin:0">{inline(a["short_bio"])} '
            f'<a href="{SITE}{a["slug"]}">More about {H.escape(a["name"])} →</a></p></div>\n')


def _local_photo(html, a, rel):
    return html.replace(f'src="{SITE}{H.escape(a["photo_url"])}"', f'src="{rel}"')


def render(post_dir, out_root, refresh=False):
    md_text = (post_dir / "post.md").read_text()
    meta, body = split_front_matter(md_text)
    credits = ""
    if "\n## Photo credits" in body:
        body, credits = body.split("\n## Photo credits", 1)
        credits = "\n## Photo credits" + credits
    body_html = md_to_html(body)
    found = load_author(out_root, meta.get("author"))
    a = found[0] if found else None
    if a:
        body_html = byline_html(a) + body_html + about_html(a)
    body_html += md_to_html(credits) if credits else ""
    (post_dir / "content.html").write_text(body_html + "\n")
    tdir = out_root / "_template"
    if refresh or not (tdir / "blog-shell.html").exists():
        refresh_template(tdir)
    page = build_preview(meta, body_html, md_text, tdir)
    if a:
        page = _local_photo(page, a, f"../_authors/{a['id']}/{a['photo']}")
    (post_dir / "preview.html").write_text(page)
    return {"content_html": str(post_dir / "content.html"), "preview": str(post_dir / "preview.html"),
            "author": a["id"] if a else f"NOT IN REGISTRY: {meta.get('author')!r}",
            "kai_notes": len(KAI.findall(md_text)),
            "template": json.loads((tdir / "template.json").read_text())}


def author_markup(a, bio_html, posts):
    """Proposed author page, styled with the same container and title classes as the blog."""
    items = "".join(f'<li><a href="{SITE}/blog/{s}">{H.escape(t)}</a></li>' for s, t in posts) or "<li>None yet</li>"
    return f"""<div class="mx-auto max-w-3xl px-4 py-12 sm:px-6">
<nav aria-label="Breadcrumb" class="text-[13px] font-medium text-gray-500"><a class="transition hover:text-gray-700" href="{SITE}/">Home</a><span class="mx-1.5">/</span><a class="transition hover:text-gray-700" href="{SITE}/blog">Ryokan and onsen guides</a></nav>
<article class="mt-6"><header class="mb-8" style="display:flex;gap:1.5rem;align-items:center">
<img src="{SITE}{H.escape(a['photo_url'])}" alt="{H.escape(a['photo_alt'])}" width="128" height="128" style="width:128px;height:128px;object-fit:cover;border-radius:9999px">
<div><h1 class="page-title">{H.escape(a['name'])}</h1><p class="mt-2 text-gray-500">{H.escape(a['role'])}</p></div></header>
<div class="blog-content">{bio_html}<h2 id="guides">Guides by {H.escape(a['name'])}</h2><ul>{items}</ul></div></article></div>"""


def person_schema(a):
    return {"@context": "https://schema.org", "@type": "Person", "name": a["name"], "jobTitle": a["role"].split(",")[0],
            "worksFor": {"@type": "Organization", "name": "Ryokan Society", "url": SITE},
            "url": SITE + a["slug"], "image": SITE + a["photo_url"], "description": a["short_bio"]}


def render_author(out_root, aid, refresh=False):
    found = load_author(out_root, aid)
    if not found:
        raise SystemExit(f"No author at {out_root / '_authors' / aid / 'author.md'}")
    a, body = found
    adir = out_root / "_authors" / aid
    posts = []
    for pm in sorted(out_root.glob("*/post.md")):
        m, _ = split_front_matter(pm.read_text())
        if (m.get("author") or "").strip().lower() == aid:
            posts.append((pm.parent.name, m.get("title", pm.parent.name)))
    bio_html = md_to_html(body)
    tdir = out_root / "_template"
    if refresh or not (tdir / "blog-shell.html").exists():
        refresh_template(tdir)
    inner = author_markup(a, bio_html, posts)
    (adir / "content.html").write_text(inner + "\n")
    (adir / "person-schema.json").write_text(json.dumps(person_schema(a), indent=2, ensure_ascii=False) + "\n")
    meta = {"title": a["title"], "meta_description": a["meta_description"], "slug": a["slug"]}
    page = build_preview(meta, bio_html, body, tdir, markup=inner)
    page = page.replace('<div id="rvb" style="padding:12px 14px">', f'<div style="padding:8px 14px;background:#fef2f2;font-size:12px">{AUTHOR_NOTE}</div><div id="rvb" style="padding:12px 14px">')
    page = page.replace("ryokansociety.com › blog › ", "ryokansociety.com › authors › ")
    page = page.replace('href="../_template/', 'href="../../_template/')  # one folder deeper than posts
    (adir / "preview.html").write_text(_local_photo(page, a, a["photo"]))
    return {"preview": str(adir / "preview.html"), "content_html": str(adir / "content.html"),
            "schema": str(adir / "person-schema.json"), "posts": [s for s, _ in posts]}


# ---------------------------------------------------------------- site package
# Everything a developer needs to add a post to apps/ryokan-web as a checked-in local article,
# laid out at the repo's own paths: the article .ts (hero_image_url + author set), the author
# constant, self-hosted images and the two registry lines. We never write to the site repo.

SITE_KEY = "ryokansinjapan"
PUBLIC_DIR = "apps/ryokan-web/public"
LIB_DIR = "packages/travel-web-core/src/lib/blog"


def _camel(s):
    parts = re.split(r"[^A-Za-z0-9]+", s)
    return parts[0].lower() + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def _to_webp(src_bytes, dest, width=1440):
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(src_bytes)).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "WEBP", quality=82)
    return im.size


def _fetch_bytes(url, cache_dir):
    """Cached in <slug>/images/. Wikimedia throttles Python clients (429) but serves curl at a slow pace."""
    import subprocess
    import time
    from urllib.parse import unquote
    cache_dir.mkdir(parents=True, exist_ok=True)
    f = cache_dir / unquote(url.rsplit("/", 1)[-1])
    for n in range(5):
        if f.exists() and f.stat().st_size > 1000:
            return f.read_bytes()
        subprocess.run(["curl", "-s", "-f", "-A", "ryokan-blog-tools/1.0", "-o", str(f), url])
        time.sleep(8 * (n + 1))
    raise RuntimeError(f"could not fetch {url}")


def site_package(post_dir, out_root):
    import time
    md_text = (post_dir / "post.md").read_text()
    meta, _ = split_front_matter(md_text)
    slug = post_dir.name
    pkg = post_dir / "site"
    html = (post_dir / "content.html").read_text()
    photos = json.loads((post_dir / "photos.json").read_text()).get("photos", [])
    images = []
    for ph in photos:
        if "upload.wikimedia.org" not in ph.get("image", ""):
            continue  # inn photos stay on the supplier CDN the inn pages already use
        name = "hero" if ph.get("role") == "hero" else slug_id(ph.get("placement", "photo"))[:40]
        rel = f"/blog/{slug}/{name}.webp"
        dest = pkg / PUBLIC_DIR / rel.lstrip("/")
        if not dest.exists():
            size = _to_webp(_fetch_bytes(ph["image"], post_dir / "images"), dest)
        else:
            from PIL import Image
            size = Image.open(dest).size
        html = html.replace(H.escape(ph["image"]), rel).replace(ph["image"], rel)
        attrs = f'width="{size[0]}" height="{size[1]}"'
        if ph.get("role") == "hero":  # the LCP image: load it first
            html = html.replace(f'<img src="{rel}"', f'<img src="{rel}" {attrs} fetchpriority="high"', 1)
            html = re.sub(rf'(<img src="{re.escape(rel)}"[^>]*?)loading="lazy"', r'\1loading="eager"', html, count=1)
        else:
            html = html.replace(f'<img src="{rel}"', f'<img src="{rel}" {attrs}')
        images.append({"src": rel, "from": ph["image"], "size": list(size), "role": ph.get("role")})
    hero = next((i["src"] for i in images if i["role"] == "hero"), None)

    found = load_author(out_root, meta.get("author"))
    a = found[0] if found else None
    author_const = _camel(a["name"]) if a else None
    if a:
        html = html.replace(f"{SITE}{a['photo_url']}", a["photo_url"])
        src = out_root / "_authors" / a["id"] / a["photo"]
        dest = pkg / PUBLIC_DIR / a["photo_url"].lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        (pkg / LIB_DIR / "authors.add.ts").parent.mkdir(parents=True, exist_ok=True)
        (pkg / LIB_DIR / "authors.add.ts").write_text(
            f"// Append to {LIB_DIR}/authors.ts\n"
            f"export const {author_const} = {{\n"
            f"  name: {json.dumps(a['name'])},\n"
            f"  jobTitle: {json.dumps(a['role'].split(',')[0].lower())},\n"
            f"  bio: {json.dumps(a['short_bio'], ensure_ascii=False)},\n}};\n")

    pub = meta.get("published") or meta.get("updated")
    keywords = [meta.get("target_keyword", "")] + list(meta.get("secondary_keywords") or [])
    body = html.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    const = _camel(slug)
    ts = f"""import type {{ SiteBlogArticle }} from "../local-articles";
{f'import {{ {author_const} }} from "../authors";' if a else ''}

export const {const}: SiteBlogArticle = {{
  id: -{pub.replace('-', '')}01,
  title: {json.dumps(meta.get('title'), ensure_ascii=False)},
  slug: {json.dumps(slug)},
  hero_image_url: {json.dumps(hero)},
  languageCode: "en-US",
  meta_description: {json.dumps(meta.get('meta_description'), ensure_ascii=False)},
  excerpt: {json.dumps(meta.get('meta_description'), ensure_ascii=False)},
  orgWebsite: "{SITE}",
  created_at: "{pub}",
  published_at: "{pub}",
  updated_at: "{meta.get('updated') or pub}",
  published: true,
  seedKeyword: {json.dumps(meta.get('target_keyword'))},
  keywords: {json.dumps([k for k in keywords if k], ensure_ascii=False)},
  content_markdown: "",
  jsonLd: null,
  faqJsonLd: null,
  {f'author: {author_const},' if a else ''}
  content_html: `
{body}`,
}};
"""
    art = pkg / LIB_DIR / "articles" / f"{slug}.ts"
    art.parent.mkdir(parents=True, exist_ok=True)
    art.write_text(ts)
    readme = f"""# Site package: {slug}

Generated by `blog_tools.py site-package {slug}`. Paths mirror the crakseo-directories repo.
Nothing here is live until a developer copies it in and deploys.

1. Copy `{LIB_DIR}/articles/{slug}.ts` into the repo.
2. In `{LIB_DIR}/local-articles.ts`: `import {{ {const} }} from "./articles/{slug}";` and add
   `{SITE_KEY}: [{const}]` to `ARTICLES` (append to the list if the key exists).
3. In `{LIB_DIR}/editorial-gate.ts`: add `"{slug}"` to `REVIEWED_DESTINATION_GUIDES.{SITE_KEY}`
   (create the key if missing). Without this the page 404s.
{f'4. Append `{LIB_DIR}/authors.add.ts` to `{LIB_DIR}/authors.ts` (skip if `{author_const}` exists).' if a else '4. (no author)'}
5. Copy everything under `{PUBLIC_DIR}/` into the repo's `{PUBLIC_DIR}/`
   ({len(images)} post images as 1440 px WebP{', plus the author photo' if a else ''}).

Schema this gives: BlogPosting `image` / og:image from `hero_image_url` ({hero}), and a Person
author ({a['name'] if a else 'none'}). To add the author page URL and photo to that Person, extend
`articleAuthorSchema` in `packages/travel-web-core/src/lib/blog-schema.ts` (see the author dev notes).
"""
    (pkg / "README.md").write_text(readme)
    return {"package": str(pkg), "article": str(art), "hero_image_url": hero,
            "author": author_const, "images": images}
