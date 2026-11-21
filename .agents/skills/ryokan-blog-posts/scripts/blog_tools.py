#!/usr/bin/env python3
"""Research tools for Ryokan Society blog posts. See ../SKILL.md for the workflow.

  blog_tools.py next                          next post in the calendar with no post.md yet
  blog_tools.py site-index [--refresh]        crawl ryokansociety.com destinations + inn links (cached)
  blog_tools.py links <words...>              destination and inn pages matching the words
  blog_tools.py serp-plan <slug>              Semrush MCP params for the top-10 SERP pull
  blog_tools.py pages <slug>                  fetch + dissect every ranking page in <slug>/serp.json
  blog_tools.py questions <slug>              Google autocomplete questions for the target keyword
  blog_tools.py photos <slug> <query> [--n N] license-safe photos (Wikimedia Commons, Openverse)
  blog_tools.py render <slug>                 content.html (what the CMS gets) + preview.html (live site look)
  blog_tools.py cannibal <slug> | --calendar  booking-intent overlap with our destination/hub pages
  blog_tools.py site-package <slug>           files a developer copies into the site repo (article .ts, author, images)
  blog_tools.py render-author <id>            proposed author page from _authors/<id>/author.md

Everything for one post lives in exports/ryokan-blog/<slug>/.
"""
import argparse
import html as htmlmod
import json
import re
import statistics
import sys
import time
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

REPO = Path(__file__).resolve().parents[4]
OUT = REPO / "exports" / "ryokan-blog"
CALENDAR = REPO / "exports" / "ryokan-blog-keywords" / "calendar-data.json"
SITE = "https://ryokansociety.com"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
API_UA = "ryokan-blog-research/0.1 (editorial photo and keyword research)"
# Licenses that allow commercial use on a website with attribution. No NC, no ND.
OK_LICENSES = {"cc0", "pdm", "public domain", "by", "by-sa"}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def post_dir(slug):
    d = OUT / slug
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_json(p, default=None):
    p = Path(p)
    return json.loads(p.read_text()) if p.exists() else default


def write_json(p, data):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(json.dumps(data, indent=1, ensure_ascii=False))


def get(url, ua=BROWSER_UA, timeout=25, **kw):
    return requests.get(url, headers={"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9"}, timeout=timeout, **kw)


def strip_tags(s):
    return htmlmod.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


# ---------- calendar ----------

def cmd_next(_):
    posts = read_json(CALENDAR, [])
    for p in sorted(posts, key=lambda p: p["o"]):
        slug = slugify(p["k"])
        if not (OUT / slug / "post.md").exists():
            print(json.dumps({"slug": slug, "order": p["o"], "title": p["t"], "target": p["k"],
                              "secondaries": p["sec"], "semrush": p["s"], "google": p["g"], "kd": p["kd"],
                              "type": p["ty"], "note": p["nt"], "dir": str(OUT / slug)}, indent=1))
            return
    print("Every calendar post has a post.md.")


# ---------- page dissection ----------

class Dissect(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form"}

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.host = base, urlparse(base).netloc.removeprefix("www.")
        self.skip = 0
        self.heads, self.cur = [], None
        self.words = 0
        self.title, self.meta = "", {}
        self.in_title = False
        self.imgs = self.tables = self.lists = 0
        self.links_in = self.links_out = 0
        self.ld = []
        self.in_ld = False
        self.ld_buf = ""

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and a.get("type") == "application/ld+json":
            self.in_ld, self.ld_buf = True, ""
        if tag in self.SKIP:
            self.skip += 1
            return
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            k = a.get("name") or a.get("property")
            if k:
                self.meta[k.lower()] = a.get("content", "")
        if self.skip:
            return
        if tag in ("h1", "h2", "h3"):
            self.cur = [tag, ""]
        elif tag == "img":
            self.imgs += 1
        elif tag == "table":
            self.tables += 1
        elif tag in ("ul", "ol"):
            self.lists += 1
        elif tag == "a" and a.get("href"):
            h = urlparse(urljoin(self.base, a["href"])).netloc.removeprefix("www.")
            if h == self.host:
                self.links_in += 1
            elif h:
                self.links_out += 1

    def handle_endtag(self, tag):
        if tag == "script" and self.in_ld:
            self.in_ld = False
            try:
                self.ld.append(json.loads(self.ld_buf))
            except ValueError:
                pass
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "title":
            self.in_title = False
        if self.cur and tag == self.cur[0]:
            t = re.sub(r"\s+", " ", self.cur[1]).strip()
            if t:
                self.heads.append((self.cur[0], t))
            self.cur = None

    def handle_data(self, data):
        if self.in_ld:
            self.ld_buf += data
            return
        if self.in_title:
            self.title += data
        if self.skip:
            return
        if self.cur:
            self.cur[1] += data
        self.words += len(re.findall(r"\b\w[\w'’-]*\b", data))


def ld_types_and_dates(ld):
    types, dates, authors = set(), {}, set()

    def walk(x):
        if isinstance(x, list):
            for i in x:
                walk(i)
        elif isinstance(x, dict):
            t = x.get("@type")
            for tt in (t if isinstance(t, list) else [t]):
                if tt:
                    types.add(str(tt))
            for k in ("datePublished", "dateModified"):
                if x.get(k) and k not in dates:
                    dates[k] = str(x[k])[:10]
            au = x.get("author")
            for a in (au if isinstance(au, list) else [au]):
                if isinstance(a, dict) and a.get("name"):
                    authors.add(a["name"])
            for v in x.values():
                if isinstance(v, (list, dict)):
                    walk(v)
    walk(ld)
    return sorted(types), dates, sorted(authors)


def dissect(url):
    rec = {"url": url}
    try:
        r = get(url)
        rec["status"] = r.status_code
        if r.status_code >= 400 or "html" not in r.headers.get("content-type", "html"):
            rec["error"] = f"HTTP {r.status_code}"
            return rec
        p = Dissect(r.url)
        p.feed(r.text[:3_000_000])
    except Exception as e:  # network errors, parser errors: record and move on
        rec["error"] = f"{type(e).__name__}: {e}"[:200]
        return rec
    types, dates, authors = ld_types_and_dates(p.ld)
    rec.update(
        title=p.title.strip(), description=p.meta.get("description", ""),
        words=p.words, images=p.imgs, tables=p.tables, lists=p.lists,
        links_internal=p.links_in, links_external=p.links_out,
        h1=[t for h, t in p.heads if h == "h1"], outline=[f"{h}: {t}" for h, t in p.heads if h != "h1"],
        questions_in_headings=sum(1 for h, t in p.heads if t.endswith("?")),
        schema_types=types, published=dates.get("datePublished") or p.meta.get("article:published_time", "")[:10],
        modified=dates.get("dateModified") or p.meta.get("article:modified_time", "")[:10], authors=authors)
    return rec


KINDS = [
    ("forum", r"reddit\.com|quora\.com|tripadvisor\.[a-z.]+/ShowTopic|community\."),
    ("reviews/OTA", r"tripadvisor|booking\.com|agoda|expedia|hotels\.com|klook|viator|getyourguide|trip\.com|jalan|rakuten|japanican|kayak"),
    ("video", r"youtube\.com|tiktok\.com|instagram\.com"),
    ("encyclopedia", r"wikipedia\.org|wikivoyage\.org|britannica\.com"),
    ("official/tourism board", r"\.go\.jp|\.lg\.jp|\.gr\.jp|\.or\.jp|japan\.travel|visit[a-z-]*\.(com|jp)|tourism|kanko"),
    ("big guide site", r"japan-guide\.com|lonelyplanet|timeout|cntraveler|travelandleisure|nytimes|theguardian|afar\.com|fodors|frommers"),
]


def kind_of(url):
    for k, pat in KINDS:
        if re.search(pat, url, re.I):
            return k
    return "blog/editorial"


def parse_serp_csv(text):
    rows = []
    lines = [l for l in text.strip().splitlines() if l.strip()]
    if not lines:
        return rows
    sep = ";" if lines[0].count(";") >= lines[0].count(",") else ","
    head = [h.strip().lower() for h in lines[0].split(sep)]
    for line in lines[1:]:
        cells = line.split(sep)
        rec = dict(zip(head, cells))
        url = rec.get("url") or rec.get("ur")
        if url:
            rows.append({"position": int(rec.get("position") or rec.get("po") or len(rows) + 1),
                         "domain": rec.get("domain") or urlparse(url).netloc, "url": url.strip()})
    return rows


def cmd_pages(a):
    d = post_dir(a.slug)
    serp = read_json(d / "serp.json")
    if not serp:
        sys.exit(f"Save the Semrush response to {d / 'serp.json'} first (see serp-plan).")
    rows = serp if isinstance(serp, list) else parse_serp_csv(serp.get("data", ""))
    seen = set()
    rows = [r for r in rows if "ryokansociety.com" not in r["url"] and not (r["url"] in seen or seen.add(r["url"]))][: a.top]
    pages = []
    for r in rows:
        rec = dissect(r["url"])
        rec["position"], rec["kind"] = r["position"], kind_of(r["url"])
        pages.append(rec)
        print(f"{r['position']:>2} {rec['kind']:<22} {rec.get('words', '-'):>6}w {r['url'][:80]} {rec.get('error', '')}", file=sys.stderr)
        time.sleep(0.5)
    write_json(d / "pages.json", pages)
    ok = [p for p in pages if "words" in p]
    words = [p["words"] for p in ok]
    heads = Counter()
    for p in ok:
        seen = set()
        for h in p["outline"]:
            for w in re.findall(r"[a-z][a-z'-]{3,}", h.split(": ", 1)[1].lower()):
                if w not in seen and w not in STOP:
                    seen.add(w)
                    heads[w] += 1
    summary = {
        "kinds": Counter(p["kind"] for p in pages).most_common(),
        "beatable_articles": [p["url"] for p in pages if p["kind"] in ("blog/editorial", "big guide site")],
        "fetched": len(ok), "failed": [p["url"] for p in pages if "error" in p],
        "words_median": int(statistics.median(words)) if words else None,
        "words_top3_median": int(statistics.median([p["words"] for p in ok if p["position"] <= 3])) if any(p["position"] <= 3 for p in ok) else None,
        "images_median": statistics.median([p["images"] for p in ok]) if ok else None,
        "with_table": sum(1 for p in ok if p["tables"]), "with_faq_headings": sum(1 for p in ok if p["questions_in_headings"] >= 3),
        "schema": Counter(t for p in ok for t in p["schema_types"]).most_common(12),
        "heading_terms_on_3plus_pages": [w for w, n in heads.most_common(60) if n >= 3],
    }
    write_json(d / "pages-summary.json", summary)
    print(json.dumps(summary, indent=1))


STOP = set("with from that this your what when where which best guide japan japanese about more have will their there they them into also than then here just like only most other some these those very".split())


# ---------- questions ----------

def cmd_questions(a):
    d = post_dir(a.slug)
    kw = a.keyword or (read_json(d / "brief-input.json", {}) or {}).get("target") or a.slug.replace("-", " ")
    seeds = [kw + " "] + [f"{w} {kw}" for w in ("how", "what", "is", "can", "best", "when", "where", "why", "do")] + [f"{kw} vs", f"{kw} or"]
    out = {}
    for s in seeds:
        try:
            r = get("https://suggestqueries.google.com/complete/search", ua=API_UA, timeout=15,
                    params={"client": "firefox", "q": s, "hl": "en", "gl": "us"})
            out[s.strip()] = r.json()[1]
        except Exception as e:
            out[s.strip()] = [f"ERROR {e}"]
        time.sleep(0.4)
    flat = sorted({q for v in out.values() for q in v if not q.startswith("ERROR")})
    write_json(d / "questions.json", {"keyword": kw, "by_seed": out, "all": flat})
    print(json.dumps(flat, indent=1, ensure_ascii=False))


# ---------- site index ----------

class Anchors(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.found, self.imgs = [], [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.stack.append([a["href"], "", ""])
        elif tag == "img":
            if self.stack and not self.stack[-1][2]:
                self.stack[-1][2] = a.get("alt", "")
            self.imgs.append({"src": a.get("src", ""), "alt": a.get("alt", "")})

    def handle_endtag(self, tag):
        if tag == "a" and self.stack:
            self.found.append(self.stack.pop())

    def handle_data(self, data):
        if self.stack:
            self.stack[-1][1] += data


def crawl_destination(slug):
    r = get(f"{SITE}/{slug}")
    rec = {"slug": slug, "url": f"{SITE}/{slug}", "status": r.status_code}
    if r.status_code != 200:
        return rec
    h = r.text
    p = Anchors()
    p.feed(h)
    inns = {}
    for href, text, alt in p.found:
        m = re.fullmatch(rf"/{re.escape(slug)}/([a-z0-9-]+)", href.split("?")[0].split("#")[0])
        if m:
            name = (alt.split(",")[0] if alt else "") or re.sub(r"\s+", " ", text).strip()[:80]
            if m.group(1) not in inns or (name and len(name) < len(inns[m.group(1)]["name"] or "x" * 999)):
                card = next((i["src"] for i in p.imgs if i["alt"] == alt and alt), "")
                inns[m.group(1)] = {"name": name, "url": f"{SITE}{href.split('?')[0]}", "card_photo": card}
    ld_desc = re.search(r'"@type":"CollectionPage".*?"name":"([^"]*)","description":"([^"]*)"', h)
    credits = re.search(r"Photo credits</summary>\s*<p[^>]*>(.*?)</p>", h, re.S)
    rec.update(
        title=strip_tags((re.search(r"<title>(.*?)</title>", h, re.S) or [None, ""])[1]),
        h1=strip_tags((re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S) or [None, ""])[1]),
        description=ld_desc.group(2) if ld_desc else "",
        site_photos=[{"src": urljoin(SITE, i["src"]), "alt": i["alt"]} for i in p.imgs if i["src"].startswith("/sites/")],
        photo_credits=strip_tags(credits.group(1)) if credits else "",
        inns=sorted(inns.values(), key=lambda x: x["name"]),
    )
    return rec


def site_index(refresh=False):
    path = OUT / "site-index.json"
    idx = read_json(path)
    if idx and not refresh:
        return idx
    sm = get(f"{SITE}/sitemap.xml").text
    locs = re.findall(r"<loc>(.*?)</loc>", sm)
    slugs = [u.rstrip("/").rsplit("/", 1)[-1] for u in locs if u.rstrip("/") != SITE]
    pages = []
    for s in slugs:
        try:
            pages.append(crawl_destination(s))
        except Exception as e:
            pages.append({"slug": s, "url": f"{SITE}/{s}", "error": str(e)[:200]})
        time.sleep(0.3)
    idx = {"built": time.strftime("%Y-%m-%d"), "pages": pages}
    write_json(path, idx)
    return idx


def cmd_site_index(a):
    idx = site_index(a.refresh)
    pages = idx["pages"]
    print(json.dumps({"built": idx["built"], "pages": len(pages),
                      "destinations_with_inns": sum(1 for p in pages if p.get("inns")),
                      "inn_pages": sum(len(p.get("inns", [])) for p in pages),
                      "index": str(OUT / "site-index.json")}, indent=1))


def cmd_links(a):
    idx = site_index()
    words = [w.lower() for w in a.words]
    hits = []
    for p in idx["pages"]:
        hay = " ".join([p["slug"], p.get("title", ""), p.get("h1", "")]).lower()
        if all(w in hay for w in words):
            hits.append({"page": p["url"], "title": p.get("title"), "description": p.get("description"),
                         "inns": len(p.get("inns", [])), "site_photos": len(p.get("site_photos", []))})
        for inn in p.get("inns", []):
            if all(w in (inn["name"] + " " + inn["url"]).lower() for w in words):
                hits.append({"inn": inn["name"], "page": inn["url"], "destination": p["url"]})
    print(json.dumps(hits[:60], indent=1, ensure_ascii=False))


# ---------- photos ----------

def norm_license(s):
    s = (s or "").lower().replace("cc ", "").replace("cc-", "").strip()
    if "public domain" in s or s in ("pd", "pdm"):
        return "pdm"
    if s.startswith("cc0") or s == "zero":
        return "cc0"
    s = re.sub(r"\s*\d(\.\d)?.*$", "", s).replace(" ", "-")
    return s


def commons(query, n):
    r = get("https://commons.wikimedia.org/w/api.php", ua=API_UA, params=dict(
        action="query", format="json", generator="search", gsrsearch=f"{query} filetype:bitmap", gsrnamespace=6,
        gsrlimit=min(n * 2, 50), prop="imageinfo", iiprop="url|size|extmetadata", iiurlwidth=1600))
    out = []
    for pg in (r.json().get("query", {}).get("pages", {}) or {}).values():
        ii = (pg.get("imageinfo") or [{}])[0]
        m = ii.get("extmetadata", {})
        lic_name = (m.get("LicenseShortName") or {}).get("value", "")
        lic = norm_license(lic_name)
        if lic not in OK_LICENSES or ii.get("width", 0) < 1200:
            continue
        artist = strip_tags((m.get("Artist") or {}).get("value", "")) or "Unknown author"
        out.append({"source": "Wikimedia Commons", "title": pg["title"].removeprefix("File:"),
                    "page": ii.get("descriptionurl"), "image": ii.get("thumburl") or ii.get("url"),
                    "width": ii.get("width"), "height": ii.get("height"), "license": lic_name,
                    "license_url": (m.get("LicenseUrl") or {}).get("value", ""),
                    "attribution": f"{artist}, {lic_name}, via Wikimedia Commons" if lic not in ("cc0", "pdm") else f"{artist}, {lic_name}, via Wikimedia Commons (no attribution required)",
                    "description": strip_tags((m.get("ImageDescription") or {}).get("value", ""))[:200]})
    return out


def openverse(query, n):
    r = get("https://api.openverse.org/v1/images/", ua=API_UA,
            params=dict(q=query, license_type="commercial,modification", page_size=min(n * 2, 40)))
    out = []
    for x in r.json().get("results", []):
        lic = norm_license(x.get("license"))
        if lic not in OK_LICENSES or x.get("source") == "wikimedia" or (x.get("width") or 0) < 1200:
            continue
        out.append({"source": f"Openverse ({x.get('source')})", "title": x.get("title"), "page": x.get("foreign_landing_url"),
                    "image": x.get("url"), "width": x.get("width"), "height": x.get("height"),
                    "license": f"CC {x.get('license', '').upper()} {x.get('license_version', '')}".strip(),
                    "license_url": x.get("license_url"), "attribution": x.get("attribution"), "description": ""})
    return out


def cmd_photos(a):
    d = post_dir(a.slug)
    found = []
    for fn in (commons, openverse):
        try:
            found += fn(a.query, a.n)
        except Exception as e:
            print(f"{fn.__name__} failed: {e}", file=sys.stderr)
    found = found[: a.n * 2]
    path = d / "photos-candidates.json"
    prev = read_json(path, {})
    prev[a.query] = found
    write_json(path, prev)
    for f in found:
        print(f"{f['width']}x{f['height']}  {f['license']:<14} {f['title'][:60]}\n    {f['page']}")


def cmd_serp_plan(a):
    d = post_dir(a.slug)
    kw = a.keyword or a.slug.replace("-", " ")
    print(json.dumps({"report": "phrase_organic", "params": {
        "phrase": kw, "database": "us", "display_limit": 10,
        "export_columns": ["position", "domain", "url"]},
        "save_response_to": str(d / "serp.json"), "cost_units": "about 100"}, indent=1))


def cmd_render(a):
    import render_post
    res = render_post.render(post_dir(a.slug), OUT, refresh=a.refresh_template)
    print(json.dumps(res, indent=1))
    print(f"Open: http://localhost:8787/{a.slug}/preview.html  (launch config 'ryokan-blog-preview')")


def cmd_render_author(a):
    import render_post
    res = render_post.render_author(OUT, a.author, refresh=a.refresh_template)
    print(json.dumps(res, indent=1))
    print(f"Open: http://localhost:8787/_authors/{a.author}/preview.html  (launch config 'ryokan-blog-preview')")


def cmd_site_package(a):
    import render_post
    render_post.render(post_dir(a.slug), OUT)
    print(json.dumps(render_post.site_package(post_dir(a.slug), OUT), indent=1))


def cmd_cannibal(a):
    """Booking-intent overlap: one post (front matter + H2s) or every calendar entry."""
    import render_post
    if a.calendar:
        cal = json.loads((REPO / "exports/ryokan-blog-keywords/calendar-data.json").read_text())
        rows = []
        for e in cal:
            tgt = render_post.booking_terms([e.get("k")])
            sec = render_post.booking_terms(e.get("sec") or [])
            if tgt or sec:
                rows.append({"order": e.get("o"), "title": e.get("t"), "target": e.get("k"),
                             "STOP_target_is_booking_intent": bool(tgt), "drop_secondaries": sec})
        print(json.dumps(rows, indent=1, ensure_ascii=False))
        print(f"{sum(r['STOP_target_is_booking_intent'] for r in rows)} targets are booking intent; "
              f"{sum(bool(r['drop_secondaries']) for r in rows)} posts have secondaries to drop.")
        return
    md = (post_dir(a.slug) / "post.md").read_text()
    meta, body = render_post.split_front_matter(md)
    rep = render_post.cannibal_report(meta, body)
    print(json.dumps(rep, indent=1, ensure_ascii=False) if rep else "OK: no booking-intent overlap.")
    if rep:
        raise SystemExit(1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("next")
    s = sub.add_parser("site-index"); s.add_argument("--refresh", action="store_true")
    s = sub.add_parser("links"); s.add_argument("words", nargs="+")
    s = sub.add_parser("serp-plan"); s.add_argument("slug"); s.add_argument("--keyword")
    s = sub.add_parser("pages"); s.add_argument("slug"); s.add_argument("--top", type=int, default=10)
    s = sub.add_parser("questions"); s.add_argument("slug"); s.add_argument("--keyword")
    s = sub.add_parser("photos"); s.add_argument("slug"); s.add_argument("query"); s.add_argument("--n", type=int, default=10)
    s = sub.add_parser("render"); s.add_argument("slug"); s.add_argument("--refresh-template", action="store_true")
    s = sub.add_parser("render-author"); s.add_argument("author"); s.add_argument("--refresh-template", action="store_true")
    s = sub.add_parser("site-package"); s.add_argument("slug")
    s = sub.add_parser("cannibal"); s.add_argument("slug", nargs="?"); s.add_argument("--calendar", action="store_true")
    a = ap.parse_args(argv)
    {"next": cmd_next, "site-index": cmd_site_index, "links": cmd_links, "serp-plan": cmd_serp_plan,
     "pages": cmd_pages, "questions": cmd_questions, "photos": cmd_photos,
     "render": cmd_render, "render-author": cmd_render_author,
     "site-package": cmd_site_package, "cannibal": cmd_cannibal}[a.cmd](a)


if __name__ == "__main__":
    main()
