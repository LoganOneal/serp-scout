#!/usr/bin/env python3
"""Step 8a, part 2: rewrite the non-prose text of a post with Qwen after rewrite_post.py.

    python3 rewrite_extras.py <slug>           # rewrite exports/ryokan-blog/<slug>/post.md in place
    python3 rewrite_extras.py <slug> --fresh   # ignore lines accepted on an earlier run

Covers section headings, the part of an inn H3 after its colon, FAQ questions, photo captions,
CTA button text, **Baths:** fact lines, descriptive table cells and the meta description.
Left as written, because the skill's linking and booking-page rules fix their wording: the
title and H1, the "Where to stay in …: our picks" and "Book your … ryokan" H2s, the FAQ H2, inn
names, "See rooms and rates at …" and "Compare all …" lines, table headers, and Photo credits.

Same guardrails as rewrite_post.py (numbers, qualifiers, added claims, minimum rewording, then
a meaning check by a Claude model that only returns verdicts), plus per-kind rules: headings,
questions and the meta description keep their keyword words.
Writes rewrite-extras-log.json; re-running reapplies accepted lines (rewrite_post.py rebuilds
post.md from the draft, so run this after it every time).
"""
import argparse, json, re, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import render_post
import rewrite_post as rp

STOP = {"in", "the", "a", "of", "to", "and", "for", "with", "vs", "near", "is", "it", "or", "from", "how", "what", "do", "does", "can", "much", "are", "you"}
KIND_RULE = {
    "heading": "a section heading. Keep it a heading in the same style (no full stop), about the same length, "
               "and keep these words: {kw}.",
    "inn_tag": "the short description after an inn's name in its heading. Keep it a short phrase, no full stop.",
    "faq": "a question a reader would type into Google. Keep it one question ending in '?', and keep these words: {kw}.",
    "caption": "a photo caption. Describe exactly the same thing in different words, one sentence.",
    "cta": "the text of a link button. Start with a verb, keep it under 14 words, and end with ' →'.",
    "baths": "a terse fact line about an inn. Keep every **Label:** exactly as written and in the same order; "
             "reword only the text after each label, keeping it terse.",
    "cell": "a short table cell. Keep it short, one or two sentences at most, and never use the | character.",
    "meta": "a search-result meta description. At most 155 characters, and keep these words: {kw}.",
}
FIXED_H2 = re.compile(r"^(where to stay|book your)|faq$", re.I)
FIXED_CTA = re.compile(r"^(see rooms and rates|compare all)", re.I)


def kw_words(fm):
    words = set()
    for key in ("target_keyword", "secondary_keywords"):
        m = re.search(rf"^{key}:\s*(.+)$", fm, re.M)
        if m:
            words |= {w for w in re.findall(r"[a-z]+", m.group(1).lower()) if w not in STOP}
    return words


def units(lines, fm_end, kws, target):
    """(kind, line index, original text, rebuild function) for every line part we rewrite."""
    out = []
    for i, line in enumerate(lines):
        if i < fm_end:
            m = re.match(r'^meta_description:\s*"(.*)"\s*$', line)
            if m:
                out.append(("meta", i, m.group(1), lambda t: f'meta_description: "{t}"', target))
            continue
        if line.startswith("## Photo credits"):
            break
        s = line.strip()
        if m := re.match(r"^(#{2,3}) (.+)$", s):
            lvl, text = m.groups()
            if lvl == "##" and not FIXED_H2.search(text):
                need = ", ".join(sorted(w for w in kws if re.search(rf"\b{w}\b", text.lower()))) or "none"
                out.append(("heading", i, text, lambda t, lvl=lvl: f"{lvl} {t}", need))
            elif lvl == "###" and ":" in text:
                name, tag = text.split(":", 1)
                out.append(("inn_tag", i, tag.strip(), lambda t, lvl=lvl, name=name: f"{lvl} {name}: {t}", ""))
        elif m := re.match(r"^\*\*([^*\[]+\?)\*\*$", s):
            need = ", ".join(sorted(w for w in kws if re.search(rf"\b{w}\b", m.group(1).lower()))) or "none"
            out.append(("faq", i, m.group(1), lambda t: f"**{t}**", need))
        elif m := re.match(r"^\*([^*].*[^*])\*$", s):
            out.append(("caption", i, m.group(1), lambda t: f"*{t}*", ""))
        elif m := re.match(r"^\*\*\[([^\]]+)\]\(([^)]+)\)\*\*$", s):
            if not FIXED_CTA.match(m.group(1)):
                out.append(("cta", i, m.group(1), lambda t, url=m.group(2): f"**[{t}]({url})**", ""))
        elif s.startswith("**Baths:**"):
            out.append(("baths", i, s, lambda t: t, ""))
        elif s.startswith("|") and not re.fullmatch(r"\|[\s|:-]+\|", s):
            is_header = i + 1 < len(lines) and re.fullmatch(r"\|[\s|:-]+\|", lines[i + 1].strip())
            if is_header:
                continue
            cells = [c.strip() for c in s.strip("|").split("|")]
            for j, c in enumerate(cells):
                plain = not re.search(r"[\[!]", c) and not re.fullmatch(r"\*\*[^*]+\*\*", c)
                if plain and len(re.findall(r"\b[a-z][a-z']*\b", c)) >= 3:
                    out.append(("cell", i, c, (j, len(cells)), ""))
    return out


def prompt(batch, fix=""):
    rules = (
        "You are editing a travel article by Kai, founder of Ryokan Society. Reword each numbered item below. "
        "Each item has a KIND that says what it is and its own rules.\n"
        "Hard rules for every item:\n"
        "- Change the wording, not the content. Same meaning, no more and no less.\n"
        "- Keep every number, price, name and Japanese word exactly; digits stay digits.\n"
        "- Add nothing: no claims, opinions, superlatives, times or places that aren't there.\n"
        "- Keep qualifiers (most, some, usually, only, all, every) exactly in meaning.\n"
        "- American English. Never use em dashes or en dashes.\n"
        "- The new wording must differ from the original; copying it is a failure.\n"
        f"Return JSON only, mapping each key ({', '.join(batch)}) to the new text alone.\n"
    )
    if fix:
        rules += f"\nYour last attempt was rejected. Problems by item: {fix}. Fix them.\n"
    def rule(kind, kw):
        r = KIND_RULE[kind]
        if kw in ("", "none"):
            r = re.sub(r",? and keep these words: \{kw\}\.", ".", r)
        return r.format(kw=kw)
    items = {k: {"KIND": rule(v[0], v[2]), "TEXT": v[1]} for k, v in batch.items()}
    return rules + "\nITEMS\n" + json.dumps(items, ensure_ascii=False, indent=1)


def verdict(kind, orig, new, need):
    if not new or "\n" in new.strip():
        return None, "missing, or it has line breaks"
    new = new.strip().strip('"')
    for c in "—–":
        if new.count(c) > orig.count(c):
            new = re.sub(rf"\s*{c}\s*([^{c}.!?]+?)\s*{c}\s*", r", \1, ", new)
            new = re.sub(rf"\s*{c}\s*", ": ", new)
    if rp.nums(new) != rp.nums(orig):
        return None, f"the numbers must be exactly {rp.nums(orig)} (you had {rp.nums(new)})"
    if new.strip().lower() == orig.strip().lower():
        return None, "unchanged: reword it"
    words = len(re.findall(r"[a-z']+", orig.lower()))
    if words >= 8 and rp.overlap(orig, new) > rp.max_overlap(orig) + 0.05:
        return None, "too close to the original wording"
    if new.count("**") != orig.count("**"):
        return None, "bold labels changed"
    if kind in ("heading", "faq") and need != "none":
        missing = [w for w in need.split(", ") if not re.search(rf"\b{w}\b", new.lower())]
        if missing:
            return None, f"it must keep these words: {', '.join(missing)}"
    if kind in ("heading", "faq", "meta") and render_post.booking_terms([new]) and not render_post.booking_terms([orig]):
        return None, f"it uses a booking-page phrase ({', '.join(render_post.booking_terms([new]))}); avoid it"
    if kind == "heading" and orig.rstrip().endswith("?") and not new.rstrip().endswith("?"):
        return None, "the heading is a question people search for; keep it a question"
    if kind == "faq" and not new.endswith("?"):
        return None, "it must stay a question ending in ?"
    if kind in ("heading", "inn_tag") and new.endswith("."):
        new = new[:-1]
    if kind == "cta" and not new.endswith("→"):
        new = new.rstrip(" →") + " →"
    if kind == "cell" and "|" in new:
        return None, "it used |"
    if kind == "meta" and (len(new) > 155 or any(not re.search(rf"\b{w}\b", new.lower()) for w in need.split())):
        return None, f"it must be at most 155 characters and contain the words {need}"
    if kind == "baths":
        if re.findall(r"\*\*[^*]+:\*\*", new) != re.findall(r"\*\*[^*]+:\*\*", orig):
            return None, "the **Label:** parts must stay exactly the same, in the same order"
    g = rp.guard(orig, new, rp.POST)
    if g:
        return None, g
    return new, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--fresh", action="store_true")
    a = ap.parse_args()
    d = rp.OUT / a.slug
    post, logf = d / "post.md", d / "rewrite-extras-log.json"
    md = (d / "post.prose.md").read_text()
    lines = md.split("\n")
    fm_end = [i for i, l in enumerate(lines) if l.strip() == "---"][1]
    fm = "\n".join(lines[:fm_end])
    target = re.search(r"^target_keyword:\s*(.+)$", fm, re.M).group(1).strip().strip('"')
    rp.POST = (d / "post.draft.md").read_text().lower()
    rp.load_env()
    us = units(lines, fm_end, kw_words(fm), target)
    keys = {str(n): (u[0], u[2], u[4]) for n, u in enumerate(us, 1)}
    prev = {} if a.fresh or not logf.exists() else json.loads(logf.read_text()).get("accepted", {})
    done = {k: prev[f"{v[0]}\t{v[1]}"] for k, v in keys.items() if f"{v[0]}\t{v[1]}" in prev}
    why, last = {}, {}
    print(f"{len(keys)} items, {len(done)} accepted earlier", file=sys.stderr)
    # recheck earlier acceptances against the original (rules + meaning), so nothing drifts across runs
    for k in list(done):
        kind, orig, need = keys[k]
        ok, why[k] = verdict(kind, orig, done[k], need)
        if not ok:
            last[k] = done.pop(k)
    ks = list(done)
    def recheck(b):
        res = rp.judge({k: {"KIND": keys[k][0], "OLD": rp.readable(keys[k][1]), "NEW": rp.readable(done[k])} for k in b})
        for k in b:
            r = str(res.get(k, "no verdict")).strip()
            if not r.upper().startswith("OK"):
                why[k], last[k] = "fact checker: " + r, done.pop(k)
    with ThreadPoolExecutor(3) as ex:
        list(ex.map(recheck, [ks[i:i + 10] for i in range(0, len(ks), 10)]))
    print(f"{len(done)} still pass against the original", file=sys.stderr)

    def run(b):
        fix = "; ".join(f"{k}: {why[k]}" + (f" (your rejected text: {last[k]})" if last.get(k) else "")
                        for k in b if why.get(k))
        _, part = rp.call_qwen(prompt({k: keys[k] for k in b}, fix), temp=0.5)
        cand = {}
        for k in b:
            kind, orig, need = keys[k]
            last[k] = str(part.get(k, ""))
            new, why[k] = verdict(kind, orig, last[k], need)
            if new:
                cand[k] = new
        if cand:
            res = rp.judge({k: {"KIND": keys[k][0], "OLD": rp.readable(keys[k][1]), "NEW": rp.readable(v)}
                            for k, v in cand.items()})
            for k, v in cand.items():
                r = str(res.get(k, "no verdict")).strip()
                if r.upper().startswith("OK"):
                    done[k] = v
                else:
                    why[k] = "fact checker: " + r

    for attempt in range(6):
        todo = [k for k in keys if k not in done]
        if not todo:
            break
        size = 8 if attempt < 2 else 3
        with ThreadPoolExecutor(3) as ex:
            list(ex.map(run, [todo[i:i + size] for i in range(0, len(todo), size)]))
        print(f"attempt {attempt + 1}: {len(done)}/{len(keys)} passed", file=sys.stderr)

    # apply, last unit first per line so table cells on one row combine
    rows = {}
    for n, u in enumerate(us, 1):
        new = done.get(str(n))
        if not new:
            continue
        kind, i, orig, how, _ = u
        if kind == "cell":
            j, ncell = how
            cells = rows.setdefault(i, [c.strip() for c in lines[i].strip().strip("|").split("|")])
            cells[j] = new
        else:
            lines[i] = how(new)
    for i, cells in rows.items():
        lines[i] = "| " + " | ".join(cells) + " |"
    post.write_text("\n".join(lines))
    left = [{"item": k, "kind": keys[k][0], "text": keys[k][1], "why": why.get(k)} for k in keys if k not in done]
    issues = rp.check((d / "post.draft.md").read_text(), post.read_text())
    log = {"date": date.today().isoformat(), "items": len(keys), "rewritten": len(done),
           "qwen_input_tokens": rp.USAGE.get("inputTokens"), "qwen_output_tokens": rp.USAGE.get("outputTokens"),
           "judge_model": rp.JUDGE_MODEL, "judge_input_tokens": rp.JUDGE_USAGE.get("inputTokens"),
           "judge_output_tokens": rp.JUDGE_USAGE.get("outputTokens"),
           "accepted": {f"{keys[k][0]}\t{keys[k][1]}": v for k, v in done.items()},
           "left_as_written": left, "check_ok": not issues, "issues": issues}
    logf.write_text(json.dumps(log, indent=1, ensure_ascii=False))
    print(json.dumps({k: v for k, v in log.items() if k != "accepted"}, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
