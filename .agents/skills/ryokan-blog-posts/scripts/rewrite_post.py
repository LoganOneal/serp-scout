#!/usr/bin/env python3
"""Step 8a: rewrite a post's prose with DeepSeek V3.2 on Amazon Bedrock, then check nothing factual moved.

    python3 rewrite_post.py <slug>            # rewrite exports/ryokan-blog/<slug>/post.md
    python3 rewrite_post.py <slug> --dry-run  # write the prompt only, no API call
    python3 rewrite_post.py <slug> --check    # re-run the fact check on an existing rewrite

Credentials, read from the environment or the repo's .env (never printed):
  AWS_BEARER_TOKEN_BEDROCK   a Bedrock API key
  AWS_REGION                 default us-west-2
  REWRITE_MODEL              default deepseek.v3.2 (Qwen3 235B broke numbered lists and copied more)
  BEDROCK_JUDGE_MODEL        default us.anthropic.claude-sonnet-4-6 (verdicts only, never text)

Only prose goes to the model: paragraphs, list items and FAQ answers. Front matter, headings,
tables, images, captions, CTA lines and Photo credits stay as written. Links are swapped for
placeholders, so URLs and anchor text can't change. After the rewrite, every number and every
placeholder must come back exactly; a block that fails keeps its original text.
"""
import argparse, difflib, json, os, re, shutil, sys, threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests

LOCK = threading.Lock()
USAGE = {}
JUDGE_USAGE = {}
JUDGE_MODEL = os.environ.get("BEDROCK_JUDGE_MODEL", "us.anthropic.claude-sonnet-4-6")
BATCH = 6
RAW = ""
POST = ""
NOTES = {}
LOOSEN = [0.0]

REPO = Path(__file__).resolve().parents[4]
OUT = REPO / "exports/ryokan-blog"
LINK = re.compile(r"!?\[[^\]]*\]\([^)]*\)(\{w=\d+\})?")
NUM = re.compile(r"[$¥]?\d[\d,.]*(?:\s?%|°C)?")
QUANT = re.compile(r"\b(most|all|every|each|always|never|only|many|few|some|several|nearly|almost|usually|often|rarely|sometimes|none|any)\b", re.I)
FIRST = re.compile(r"\b(I|I've|I'd|I'm|I'll|me|my|mine|we|we've|we're|our|us)\b")
TIMES = re.compile(r"\b(\d+\s?(?:am|pm)|dawn|dusk|midnight|morning|mornings|evening|evenings|night|nights|noon|afternoon|hours?|years?|decades?|centur(?:y|ies)|spring|summer|autumn|fall|winter)\b", re.I)
LOADED = re.compile(r"\b(official|officially|guaranteed?|famous|popular|traditionally|historically|world-class|renowned|authentic|favorite|personally|seen|remember|visited|decades)\b", re.I)
STYLE = (REPO / ".agents/skills/ryokan-blog-posts/references/writing-standard.md").read_text()


def load_env():
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            m = re.match(r"\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


def split(md):
    _, fm, body = md.split("---", 2)
    body, sep, credits = body.partition("\n## Photo credits")
    return fm, body, sep + credits


def is_prose(block):
    s = block.strip()
    if not s or s.startswith(("#", "|", "!", "[!", "*")) and not s.startswith(("* ", "**", "- **")):
        return False
    if re.fullmatch(r"\*\*\[[^\]]+\]\([^)]+\)\*\*", s):          # bold CTA line
        return False
    if re.fullmatch(r"\*[^*].*\*", s):                            # italic caption
        return False
    if re.fullmatch(r"\*\*[^*]+\*\*", s):                         # FAQ question line
        return False
    if s.startswith("**Baths:**"):                                # inn fact line
        return False
    words = re.findall(r"[A-Za-z]+", LINK.sub(" ", s))
    if len(words) < 4:                                            # link-only list line
        return False
    return True


def blocks(body):
    """Paragraph/list-item blocks with their index, so they can be put back in place."""
    parts = re.split(r"(\n\s*\n)", body)
    out = []
    for i, p in enumerate(parts):
        if i % 2:
            continue
        lines = p.split("\n")
        # list items are rewritten one by one
        if any(re.match(r"\s*(?:[-*]|\d+\.)\s", l) for l in lines if l.strip()) and len(lines) > 1:
            for j, l in enumerate(lines):
                if l.strip() and is_prose(re.sub(r"^\s*(?:[-*]|\d+\.)\s", "", l)):
                    out.append(((i, j), l))
        elif len(lines) > 1 and re.fullmatch(r"\*\*[^*]+\*\*", lines[0].strip()):
            # FAQ: the bold question stays, only the answer lines are rewritten
            for j, l in enumerate(lines[1:], 1):
                if is_prose(l):
                    out.append(((i, j), l))
        elif is_prose(p):
            out.append(((i, None), p))
    return parts, out


def protect(text):
    keep = []
    def sub(m):
        keep.append(m.group(0))
        return f"⟦L{len(keep)}⟧"
    return LINK.sub(sub, text), keep


def restore(text, keep):
    for n, v in enumerate(keep, 1):
        text = text.replace(f"⟦L{n}⟧", v)
    return text


def nums(t):
    return sorted(x.rstrip(".,") for x in NUM.findall(LINK.sub("", t)))


def prompt(items, fix="", careful=False, links=None):
    rules = (
        "You are editing a travel article written by Kai, founder of Ryokan Society. Rewrite each "
        "numbered passage so it reads naturally in Kai's voice, following the style guide below.\n"
        "Hard rules:\n"
        "- Change the wording, not the content. Every sentence must say the same thing as before, no more and no less.\n"
        "- Keep every fact, number, price, date and name exactly. Keep digits as digits.\n"
        "- Add nothing: no experiences, scenes or anecdotes, no opinions, no times, hours or seasons, no places, inns or "
        "people, no reasons or causes, no advice the passage doesn't already give, nothing about Kai's background.\n"
        "- Keep every qualifier exactly (most, some, usually, often, many, nearly, only, all, every, never, always). "
        "Don't widen or narrow a statement: 'most onsen' stays 'most onsen', not 'most baths' or 'onsen'.\n"
        "- Use I, my, we or our only where the passage already does. Never call a page 'official'.\n"
        "- Reword every sentence. Don't keep any run of more than four words from the original, except names, "
        "numbers and placeholders. Copying the original is a failure.\n"
        "- Each passage stays one passage: never merge or split passages, never add headings, bold labels or line breaks.\n"
        "- Keep every placeholder like ⟦L3⟧ exactly once, in a sensible place.\n"
        "- Keep any **bold** lead-in at the start of a passage.\n"
        "- American English. Never use em dashes or en dashes. Roughly the same length.\n"
        f"- Rewrite EVERY passage. Return JSON only, with exactly these {len(items)} keys: "
        f"{', '.join(items)}.\n"
    )
    if fix:
        rules += f"\nYour last attempt at these was rejected. Problems by passage: {fix}. Fix them.\n"
    if careful:
        rules += ("\nWork sentence by sentence. Keep each sentence's meaning and order; change its wording "
                  "with synonyms and a different sentence structure. Do not add or remove any information.\n")
    out = rules + f"\nSTYLE GUIDE\n{STYLE}\n\nPASSAGES\n" + json.dumps(items, ensure_ascii=False, indent=1)
    if links:
        out += ("\n\nLINK TEXT (each placeholder stands for this exact wording, so write the sentence around it "
                "grammatically and don't repeat its words)\n" + json.dumps(links, ensure_ascii=False, indent=1))
    return out


def call_qwen(text, temp=0.4, tries=3):
    for t in range(tries):
        try:
            return _call_qwen(text, temp)
        except json.JSONDecodeError:
            if t == tries - 1:
                return os.environ.get("REWRITE_MODEL", "deepseek.v3.2"), {}


def _call_qwen(text, temp=0.4, model=None, usage=None):
    key = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not key:
        sys.exit("No AWS_BEARER_TOKEN_BEDROCK in the environment or .env.")
    region = os.environ.get("AWS_REGION", "us-west-2")
    model = model or os.environ.get("REWRITE_MODEL", "deepseek.v3.2")
    usage = USAGE if usage is None else usage
    import time
    for wait in (0, 10, 30, 60, 120, 240):
        time.sleep(wait)
        r = requests.post(
            f"https://bedrock-runtime.{region}.amazonaws.com/model/{model}/converse",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"messages": [{"role": "user", "content": [{"text": text}]}],
                  "inferenceConfig": {"maxTokens": 16000, "temperature": temp}},
            timeout=600)
        if r.status_code not in (429, 500, 502, 503, 504):
            break
    if r.status_code != 200:
        if r.status_code in (429, 500, 502, 503, 504):
            raise json.JSONDecodeError(f"Bedrock {r.status_code}", "", 0)   # treated as a failed batch, retried later
        sys.exit(f"Bedrock {r.status_code}: {r.text[:500]}")
    resp = r.json()
    out = "".join(c.get("text", "") for c in resp["output"]["message"]["content"])
    out = re.sub(r"(?s)<think>.*?</think>", "", out)
    global RAW
    with LOCK:
        for k2, v in resp.get("usage", {}).items():
            if isinstance(v, int):
                usage[k2] = usage.get(k2, 0) + v
        if usage is USAGE:
            RAW += out + "\n\n"
    out = re.sub(r"^```(?:json)?|```$", "", out.strip(), flags=re.M).strip()
    return model, json.loads(out[out.find("{"): out.rfind("}") + 1])


def judge(pairs):
    """Fact-check pass by a stronger model (Claude Sonnet on Bedrock by default). It only returns verdicts;
    none of its words go into the post, so the published wording stays the rewrite model's."""
    text = (
        "You are a strict fact checker for a travel article. For each key, compare NEW with OLD. Link text is "
        "shown in [brackets]. NEW must say exactly what OLD says in different words. Report a problem if NEW:\n"
        "- adds any fact, claim, opinion, superlative, experience, scene, time, place, reason or advice OLD doesn't have "
        "(e.g. 'iconic', 'peaceful', 'widely considered', 'for most visitors');\n"
        "- drops or changes any detail, however small (e.g. 'lukewarm' to 'warm', 'their own baths' to 'private baths', "
        "'castle town' to 'town', 'we list' to 'we researched');\n"
        "- widens or narrows a statement, or changes who did or said something;\n"
        "- is ungrammatical, has a comma splice, or repeats or mangles link text.\n"
        "Wording, tone and sentence order may change freely, and plain synonyms that keep the meaning are fine "
        "(quieter/less crowded, rewarding/satisfying, book/reserve, trip/getaway). Only report real changes in meaning, "
        "added content or broken grammar. A NOTE points at something to check closely.\n"
        "Return JSON only: each key mapped to \"OK\" or a one-sentence description of the problem.\n\n"
        + json.dumps(pairs, ensure_ascii=False, indent=1))
    for t in range(3):
        try:
            _, out = _call_qwen(text, temp=0.0, model=JUDGE_MODEL, usage=JUDGE_USAGE)
            return out
        except json.JSONDecodeError:
            pass
    return {}


def readable(t):
    """Text for the fact checker: links shown as [anchor], URLs dropped."""
    return re.sub(r"!?\[([^\]]*)\]\([^)]*\)(\{w=\d+\})?", r"[\1]", t)


def overlap(orig, new):
    """Share of the original's wording that survives (0 = all new words, 1 = unchanged)."""
    w = lambda t: re.findall(r"[a-z0-9']+", LINK.sub(" ", t).lower())
    return difflib.SequenceMatcher(None, w(orig), w(new), autojunk=False).ratio()


def max_overlap(orig):
    # count ordinary words only: names, times and numbers can't be reworded
    n = len(re.findall(r"\b[a-z][a-z']*\b", LINK.sub(" ", orig)))
    return 0.85 if n < 15 else 0.7 if n < 25 else 0.6


def guard(orig, new, post=""):
    """Cheap word-level guardrails; returns a reason or ''."""
    lo = orig.lower()
    cls = {"all": "u", "every": "u", "each": "u", "always": "u", "any": "u", "none": "u", "never": "u",
           "most": "m", "usually": "m", "often": "m", "nearly": "m", "almost": "m", "many": "m",
           "some": "s", "several": "s", "few": "s", "sometimes": "s", "rarely": "s", "only": "o"}
    q = lambda t: {cls[w.lower()] for w in QUANT.findall(t)}
    if q(orig) != q(new):
        NOTES[id(new)] = (f"qualifiers differ (OLD: {sorted(set(w.lower() for w in QUANT.findall(orig)))}, "
                          f"NEW: {sorted(set(w.lower() for w in QUANT.findall(new)))}); check the scope didn't change")
    if not FIRST.search(orig) and FIRST.search(new):
        return "it added first person (I, my, we, our) where the original has none"
    for rx, what in ((TIMES, "a time or period"), (LOADED, "a claim word")):
        extra = {w.lower() for w in rx.findall(new)} - {w.lower() for w in rx.findall(orig)}
        if extra:
            return f"it added {what}: {', '.join(sorted(extra))}"
    for m in re.finditer(r"\b[A-Z][a-zA-Z'’-]+", new):
        before = new[:m.start()].rstrip(" *_\"(“")
        if not before or before[-1] in ".!?:⟧" or m.group(0) in ("I", "I'm", "I've", "I'd", "I'll"):
            continue
        w = re.sub(r"'s$", "", m.group(0).replace("’", "'"))
        if re.fullmatch(r"I'\w+", w) or all(x.lower() in lo or x.lower() in post for x in w.split("-")):
            continue
        if w.lower() not in lo and w.lower() not in post:
            return f"it added a name: {m.group(0)}"
    return ""


def check(draft, post):
    """What must survive both rewrite steps: front matter (except the meta description), heading levels,
    table shape, every link URL, every image, Photo credits, and every number in the body."""
    fm_d, body_d, cr_d = split(draft)
    fm_p, body_p, cr_p = split(post)
    nometa = lambda fm: re.sub(r"^meta_description:.*$", "", fm, flags=re.M)
    issues = []
    if nometa(fm_d) != nometa(fm_p): issues.append("front matter changed")
    if cr_d != cr_p: issues.append("photo credits changed")
    lv = lambda b: re.findall(r"^(#{2,4}) ", b, re.M)
    if lv(body_d) != lv(body_p): issues.append("heading levels changed")
    rows = lambda b: [r.count("|") for r in re.findall(r"^\|.+$", b, re.M)]
    if rows(body_d) != rows(body_p): issues.append("table shape changed")
    urls = lambda b: sorted(re.findall(r"\]\(([^)]+)\)", b))
    if urls(body_d) != urls(body_p): issues.append("link URLs changed")
    imgs = lambda b: sorted(re.findall(r"!\[[^\]]*\]\([^)]+\)(?:\{w=\d+\})?", b))
    if imgs(body_d) != imgs(body_p): issues.append("images changed")
    if nums(body_d) != nums(body_p):
        from collections import Counter
        a, b = Counter(nums(body_d)), Counter(nums(body_p))
        issues.append(f"numbers changed: missing {dict(a - b)}, added {dict(b - a)}")
    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--resume", action="store_true", help="keep passages accepted last run, redo the rest")
    ap.add_argument("--apply", action="store_true", help="rebuild post.md from accepted passages, no API calls")
    a = ap.parse_args()
    a.resume = a.resume or a.apply
    d = OUT / a.slug
    post, draft = d / "post.md", d / "post.draft.md"
    if a.check:
        issues = check(draft.read_text(), post.read_text())
        print(json.dumps({"ok": not issues, "issues": issues}, indent=1))
        return
    if not draft.exists():
        shutil.copy(post, draft)
    md = draft.read_text()
    fm, body, credits = split(md)
    global POST
    POST = md.lower()
    parts, items = blocks(body)
    sent, keeps, marks = {}, {}, {}
    for n, (_, text) in enumerate(items, 1):
        m = re.match(r"\s*(?:[-*]|\d+\.)\s+", text)
        marks[str(n)] = m.group(0) if m else ""
        sent[str(n)], keeps[str(n)] = protect(text[len(marks[str(n)]):])
    keys = list(sent)
    batch = lambda ks: [{k: sent[k] for k in ks[i:i + BATCH]} for i in range(0, len(ks), BATCH)]
    batches = batch(keys)
    (d / "rewrite-prompt.txt").write_text(prompt(batches[0]))
    if a.dry_run:
        print(f"{len(items)} passages in {len(batches)} calls; first prompt in {d / 'rewrite-prompt.txt'}")
        return
    load_env()

    def verdict(k, orig, new):
        if not new:
            return None, "missing"
        # if the model wrote a link's words instead of its placeholder, put the placeholder back
        for i, v in enumerate(keeps[k], 1):
            tag, anchor = f"⟦L{i}⟧", re.sub(r"^!?\[([^\]]*)\].*", r"\1", v)
            if tag not in new and anchor and anchor in new:
                new = new.replace(anchor, tag, 1)
        # drop link markers the passage doesn't have (the model copies the example from the rules)
        new = re.sub(r"\s*⟦L(\d+)⟧", lambda m: m.group(0) if int(m.group(1)) <= len(keeps[k]) else "", new).strip()
        if not all(new.count(f"⟦L{x}⟧") == 1 for x in range(1, len(keeps[k]) + 1)) \
                or "⟦L" in re.sub(r"⟦L\d+⟧", "", new):
            return None, "placeholders changed"
        for c in "—–":
            if new.count(c) > orig.count(c):
                new = re.sub(rf"\s*{c}\s*([^{c}.!?]+?)\s*{c}\s*", r", \1, ", new)
                new = re.sub(rf"\s*{c}\s*", ": ", new)
        full = marks[k] + restore(new, keeps[k])
        if nums(full) != nums(orig):
            return None, (f"the numbers must be exactly {nums(orig)}, written as digits in the same form "
                          f"(you had {nums(full)})")
        if full.count("**") != orig.count("**") or full.count("\n") != orig.count("\n"):
            return None, "bold text or line breaks changed (keep **bold** spans and line breaks exactly)"
        if any(full.count(c) > orig.count(c) for c in "—–"):
            return None, "it used an em or en dash"
        if overlap(orig, full) > max_overlap(orig) + LOOSEN[0]:
            return None, ("too close to the original wording: reword every sentence with a new structure "
                          "and different words, keeping only names, numbers and placeholders")
        g = guard(orig, full, POST)
        if g:
            return None, g
        return full, ""

    done, why, model, best = {}, {}, "", {}
    last = {}
    if a.resume and (d / "rewrite-log.json").exists():
        prev = json.loads((d / "rewrite-log.json").read_text()).get("accepted", {})
        done.update({str(n): prev[o] for n, (_, o) in enumerate(items, 1) if o in prev})
        print(f"resuming with {len(done)} accepted passages", file=sys.stderr)
    for attempt in range(0 if a.apply else 8):
        todo = [k for k in keys if k not in done]
        if not todo:
            break
        careful = attempt >= 3
        LOOSEN[0] = 0.05 if attempt >= 4 else 0.0
        size = BATCH if attempt < 3 else 2
        def run(b):
            nonlocal model
            fix = "; ".join(f"{k}: {why[k]}" + (f" (your rejected text: {last[k]})" if last.get(k) else "")
                            for k in b if why.get(k))
            links = {k: {f"⟦L{i}⟧": re.sub(r"^!?\[([^\]]*)\].*", r"\1", v) for i, v in enumerate(keeps[k], 1)}
                     for k in b if keeps[k]}
            model, part = call_qwen(prompt({k: sent[k] for k in b}, fix, careful, links), temp=0.2 if careful else 0.5)
            cand = {}
            for k in b:
                orig = items[int(k) - 1][1]
                last[k] = part.get(k, "")
                full, why[k] = verdict(k, orig, last[k])
                if full:
                    cand[k] = full
                    if id(full) in NOTES:
                        why[k] = NOTES.pop(id(full))
            if cand:
                res = judge({k: {"OLD": readable(items[int(k) - 1][1]), "NEW": readable(v), **({"NOTE": why[k]} if why.get(k) else {})}
                             for k, v in cand.items()})
                for k, v in cand.items():
                    r = str(res.get(k, "the fact checker gave no verdict")).strip()
                    if r.upper().startswith("OK"):
                        done[k] = v
                    elif "gave no verdict" in r:
                        best[k] = v
                    else:
                        why[k] = "fact checker: " + r

        with ThreadPoolExecutor(3) as ex:
            list(ex.map(run, [todo[i:i + size] for i in range(0, len(todo), size)]))
        print(f"attempt {attempt + 1}: {len(done)}/{len(keys)} passed", file=sys.stderr)
    (d / "rewrite-raw.txt").write_text(RAW)
    kept_original = []
    for n, ((i, j), orig) in enumerate(items, 1):
        new = done.get(str(n))
        if new is None:
            # never fall back to the original silently: keep Qwen's best rule-passing attempt for review
            new = best.get(str(n), orig)
            kept_original.append({"passage": n, "why": why.get(str(n)),
                                  "using": "qwen, needs review" if str(n) in best else "original"})
        if j is None:
            parts[i] = new
        else:
            lines = parts[i].split("\n"); lines[j] = new; parts[i] = "\n".join(lines)
    post.write_text("---" + fm + "---" + "".join(parts) + credits)
    shutil.copy(post, d / "post.prose.md")   # base for rewrite_extras.py
    final = {**best, **done}
    review = [f"## Passage {n}{'  (NEEDS REVIEW: ' + str(why.get(str(n))) + ')' if str(n) not in done else ''}"
              f"\n\nOLD: {items[n - 1][1]}\n\nNEW: {final[str(n)]}\n"
              for n in range(1, len(items) + 1) if str(n) in final]
    (d / "rewrite-review.md").write_text(
        "# Review every changed passage\n\nRevert any NEW that adds a claim, a first-hand "
        "experience or an opinion the OLD didn't have, or that changes a fact without a number.\n\n"
        + "\n".join(review))
    issues = check(md, post.read_text())
    log = {"model": model, "date": date.today().isoformat(), "passages": len(items),
           "input_tokens": USAGE.get("inputTokens"), "output_tokens": USAGE.get("outputTokens"),
           "judge_model": JUDGE_MODEL, "judge_input_tokens": JUDGE_USAGE.get("inputTokens"),
           "judge_output_tokens": JUDGE_USAGE.get("outputTokens"),
           "rewritten": len(done), "accepted": {items[int(k) - 1][1]: v for k, v in done.items()}, "needs_review": kept_original, "check_ok": not issues, "issues": issues}
    (d / "rewrite-log.json").write_text(json.dumps(log, indent=1))
    print(json.dumps(log, indent=1))


if __name__ == "__main__":
    main()
