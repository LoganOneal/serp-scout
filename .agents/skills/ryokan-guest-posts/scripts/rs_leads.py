"""Ryokan Society guest-post lead tooling: keyword queue, SERP ingest, Authority Scores, leads report.

Semrush is reached only through the Semrush MCP tools in the session (never an API key).
This script plans the pulls and ingests what the session saved; it never calls Semrush.

  rs_leads.py plan [--max N]
      Print the next N pending keywords from the queue as Semrush MCP requests
      (report phrase_organic) and save them to <exports>/serp-plan-<stamp>.json.
  rs_leads.py ingest <pulled.json> [--label L]
      Read saved MCP responses, {"<keyword>": {"data": "<csv>", "units": n} | {"error": "..."}},
      split domains into guest-post leads, link-insertion targets and outlets, write
      exports/handoff/ryokan/ryokan-guest-serp-<label>.csv (for run_tools.py prepare) plus the
      link-insertion and outlet CSVs, and mark each keyword done / no_data / failed in the queue.
  rs_leads.py missing-as
      Print PURSUE and NEEDS_REVIEW domains with no cached Authority Score (pull these next).
  rs_leads.py set-as <domain>=<score> ...
      Save Authority Scores pulled with backlinks_overview to the cache.
  rs_leads.py report
      Write "<exports>/RS Guest Post Leads.md" and .csv: every evaluated domain across all runs,
      with pilot/run overrides applied and Authority Scores joined, PURSUE first by score.

Paths come from env (see env.sh): HHT_EXPORTS (Ryokan exports dir) and RS_HANDOFF.
"""
import argparse
import csv
import io
import json
import os
import re
import sys
from collections import Counter, OrderedDict
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SKILL = Path(__file__).resolve().parent.parent
REPO = SKILL.parents[2]
EXPORTS = Path(os.environ.get("HHT_EXPORTS") or REPO / "exports" / "ryokan-guest-post")
HANDOFF = Path(os.environ.get("RS_HANDOFF") or REPO / "exports" / "handoff" / "ryokan")
KNOWN = SKILL / "references" / "known-domains.json"
QUEUE = EXPORTS / "keyword-queue.json"
SCORES = EXPORTS / "authority-scores.json"

PLATFORMS = re.compile(
    r"(^|\.)(booking|expedia|hotels|tripadvisor|trivago|kayak|agoda|airbnb|vrbo|trip|klook|viator|"
    r"getyourguide|japanican|jalan|rakuten|ikyu|relux|facebook|instagram|twitter|x|pinterest|linkedin|"
    r"youtube|tiktok|reddit|quora|medium|wikipedia|wikivoyage|blogspot|tumblr|issuu|yelp|google|bing|"
    r"yahoo|amazon|ebay|apple|threads)\.", re.I)
GOV_OR_BOARD = re.compile(r"(\.go\.jp|\.lg\.jp|\.or\.jp|\.gov)$|(^|\.)(visit|discover)[a-z-]*japan|tourism|"
                          r"(^|\.)japan\.travel$", re.I)
CSV_FIELDS = ["domain", "opportunity_url", "all_urls", "source_query", "bucket", "lead_type", "score",
              "best_position", "query_hits", "batch_id"]


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")


def host(url):
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def registrable(hostname):
    hostname = hostname.lower().removeprefix("www.")
    if hostname.endswith(".substack.com"):
        return hostname
    parts = hostname.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "ac", "or", "ne", "go"):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def known_classes():
    data = read_json(KNOWN, {})
    out = {}
    for cls in ("self", "skip", "link_insertion", "outlet"):
        for d in data.get(cls, []):
            out[registrable(d)] = cls
    return out


def classify(domain, known):
    if domain in known:
        return known[domain]
    if PLATFORMS.search(domain + ".") or PLATFORMS.search("." + domain):
        return "skip"
    if GOV_OR_BOARD.search(domain):
        return "skip"
    return "guest_post"


def parse_serp(text):
    text = (text or "").strip()
    if not text:
        return []
    first = text.splitlines()[0]
    delim = ";" if first.count(";") >= first.count(",") else ","
    rows = []
    for row in csv.DictReader(io.StringIO(text), delimiter=delim):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        url = row.get("url") or ""
        dom = row.get("domain") or host(url)
        if not dom:
            continue
        try:
            pos = int(row.get("position") or 0)
        except ValueError:
            pos = 0
        rows.append({"domain": registrable(dom), "url": url, "position": pos})
    return rows


# ---- queue -----------------------------------------------------------------------

def load_queue():
    q = read_json(QUEUE)
    if q is None:
        sys.exit(f"No keyword queue at {QUEUE}")
    return q


def plan(max_n):
    q = load_queue()
    pending = [k for k in q["keywords"] if k.get("status", "pending") == "pending"][:max_n]
    requests = [{"keyword": k["keyword"], "shape": k.get("shape"), "report": "phrase_organic",
                 "params": {"phrase": k["keyword"], "database": "us", "display_limit": q.get("display_limit", 40),
                            "export_columns": ["position", "domain", "url"]}} for k in pending]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    out = EXPORTS / f"serp-plan-{stamp}.json"
    write_json(out, {"created_at": stamp, "requests": requests,
                     "pending_left_after": sum(1 for k in q["keywords"] if k.get("status", "pending") == "pending") - len(requests)})
    print(json.dumps({"plan": str(out), "requests": requests}, indent=1))
    if not requests:
        print("Queue empty: add keywords to keyword-queue.json (see SKILL.md, 'Which keywords work').", file=sys.stderr)


def ingest(path, label):
    pulled = read_json(path)
    known = known_classes()
    q = load_queue()
    by_kw = {k["keyword"]: k for k in q["keywords"]}
    leads = {"guest_post": OrderedDict(), "link_insertion": OrderedDict(), "outlet": OrderedDict()}
    stats, total_units = [], 0
    for keyword, resp in pulled.items():
        entry = by_kw.setdefault(keyword, {"keyword": keyword, "shape": "adhoc"})
        if keyword not in [k["keyword"] for k in q["keywords"]]:
            q["keywords"].append(entry)
        err = resp.get("error") if isinstance(resp, dict) else None
        if err:
            entry["status"] = "no_data" if "no_data" in err.lower() or "nothing found" in err.lower() else "failed"
            entry["error"] = err[:200]
            entry["date"] = str(date.today())
            stats.append({"keyword": keyword, "status": entry["status"], "error": err[:120]})
            continue
        rows = parse_serp(resp.get("data"))
        units = resp.get("units") or 10 * len(rows)
        total_units += units
        counts = Counter()
        for r in rows:
            cls = classify(r["domain"], known)
            counts[cls] += 1
            if cls not in leads:
                continue
            lead = leads[cls].setdefault(r["domain"], {"domain": r["domain"], "urls": [], "queries": [],
                                                      "best": None})
            if r["url"] and r["url"] not in lead["urls"]:
                lead["urls"].append(r["url"])
            if keyword not in lead["queries"]:
                lead["queries"].append(keyword)
            if r["position"] and (lead["best"] is None or r["position"] < lead["best"]):
                lead["best"] = r["position"]
        entry.update(status="done", date=str(date.today()), units=units, rows=len(rows),
                     guest_post_domains=counts["guest_post"], link_insertion=counts["link_insertion"],
                     outlet=counts["outlet"], skipped=counts["skip"] + counts["self"], label=label)
        stats.append({"keyword": keyword, "status": "done", "rows": len(rows), "units": units, **dict(counts)})
    HANDOFF.mkdir(parents=True, exist_ok=True)
    files = {}
    for cls, name in (("guest_post", "ryokan-guest-serp"), ("link_insertion", "ryokan-link-insertion"),
                      ("outlet", "ryokan-outlets")):
        if not leads[cls]:
            continue
        out = HANDOFF / f"{name}-{label}.csv"
        if out.exists():
            sys.exit(f"{out} exists; use a new --label")
        with open(out, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
            w.writeheader()
            for lead in leads[cls].values():
                w.writerow({"domain": lead["domain"], "opportunity_url": (lead["urls"] or [""])[0],
                            "all_urls": "|".join(lead["urls"]), "source_query": " | ".join(lead["queries"]),
                            "bucket": "ryokan-serp", "lead_type": cls, "score": len(lead["queries"]),
                            "best_position": lead["best"] or "", "query_hits": len(lead["queries"]),
                            "batch_id": f"ryokan-{name.split('-', 1)[1]}-{label}"})
        files[cls] = str(out)
    write_json(QUEUE, q)
    summary = {"label": label, "keywords": stats, "units": total_units,
               "new_rows": {k: len(v) for k, v in leads.items()}, "files": files}
    log = EXPORTS / "keyword-log.jsonl"
    with open(log, "a") as fh:
        fh.write(json.dumps({"date": str(date.today()), **summary}) + "\n")
    print(json.dumps(summary, indent=1))


# ---- authority scores --------------------------------------------------------------

def load_scores():
    return read_json(SCORES, {"scores": {}})


def set_as(pairs):
    data = load_scores()
    for pair in pairs:
        dom, _, val = pair.partition("=")
        data["scores"][registrable(dom.strip())] = {"as": int(val), "date": str(date.today())}
    write_json(SCORES, data)
    print(f"saved {len(pairs)} scores to {SCORES}")


# ---- report ------------------------------------------------------------------------

def overrides():
    merged = {}
    for p in sorted(EXPORTS.glob("*overrides*.json")):
        for dom, v in read_json(p, {}).items():
            if not dom.startswith("_") and isinstance(v, dict):
                merged[dom] = v
    return merged


def final_verdict(row, ov):
    if not ov:
        return row.get("verdict"), row.get("code"), row.get("lead_class") or "guest_post", ""
    final = str(ov.get("final", "")).upper()
    cls = ov.get("class") or "guest_post"
    if final.startswith("PURSUE"):
        verdict = "PURSUE"
    elif final.startswith("DOWNGRADE"):
        verdict = "DOWNGRADED"
    elif final.startswith("SKIP"):
        verdict = "SKIP"
    else:
        verdict = final or row.get("verdict")
    return verdict, ov.get("final") if verdict != "PURSUE" else row.get("code"), cls, ov.get("why", "")


def all_rows():
    """One row per evaluated domain. domains/<d>.json holds the verdict (PURSUE sites get no
    tracker row until their pitch is written); tracker rows and batch inputs add the source query."""
    rows = OrderedDict()
    queries = {}
    for p in sorted(EXPORTS.glob("*/batch-input.json")):
        for sel in read_json(p, {}).get("selected", []):
            qs = [r.get("source_query") for r in sel.get("source_rows", []) if r.get("source_query")]
            queries[registrable(sel["domain"])] = " | ".join(dict.fromkeys(qs))
    for p in sorted(EXPORTS.glob("*/tracker-rows.json")):
        data = read_json(p, {})
        for row in data.get("main", []) if isinstance(data, dict) else data:
            dom = registrable(row.get("site") or "")
            if dom:
                rows[dom] = dict(row)
    for p in sorted(EXPORTS.glob("*/domains/*.json")):
        rec = read_json(p, {})
        dom = registrable(rec.get("domain") or p.stem)
        row = rows.setdefault(dom, {"site": dom, "batch": p.parent.parent.name})
        if rec.get("verdict"):
            row["verdict"] = rec["verdict"]
            row["code"] = rec.get("skip_code") or rec.get("review_reason") or row.get("code")
        for key, src in (("pitch_url", "pitch_url"), ("submission_mechanism", "submission_mechanism"),
                         ("contact_route", "contact_route"), ("submission_stage", "submission_stage")):
            if not row.get(key) and rec.get(src):
                row[key] = rec[src]
        row.setdefault("date_triaged", rec.get("triage_date"))
        if not row.get("source_query"):
            row["source_query"] = queries.get(dom, "")
    return rows


def evaluated():
    scores = load_scores()["scores"]
    ovs = overrides()
    out = []
    for dom, row in all_rows().items():
        verdict, code, cls, why = final_verdict(row, ovs.get(dom))
        out.append({"domain": dom, "verdict": verdict, "code": code or "", "class": cls,
                    "authority_score": (scores.get(dom) or {}).get("as", ""),
                    "pitch_url": row.get("pitch_url") or "", "route": row.get("submission_mechanism") or "",
                    "contact": row.get("contact_route") or "", "stage": row.get("submission_stage") or "",
                    "source_query": row.get("source_query") or "", "batch": row.get("batch") or "",
                    "date": row.get("date_triaged") or "", "note": why or (row.get("notes") or "")[:200]})
    return out


def missing_as():
    missing = [r["domain"] for r in evaluated()
               if r["verdict"] in ("PURSUE", "NEEDS_REVIEW") and r["authority_score"] == ""]
    print("\n".join(missing))
    print(f"{len(missing)} domains without an Authority Score (40 Semrush units each)", file=sys.stderr)


def sort_key(r):
    return -(r["authority_score"] if isinstance(r["authority_score"], int) else -1), r["domain"]


def report():
    rows = evaluated()
    csv_path = EXPORTS / "RS Guest Post Leads.csv"
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["domain"])
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["verdict"] != "PURSUE", sort_key(r))):
            w.writerow(r)
    counts = Counter(r["verdict"] for r in rows)
    pursue = sorted([r for r in rows if r["verdict"] == "PURSUE"], key=sort_key)
    review = sorted([r for r in rows if r["verdict"] == "NEEDS_REVIEW"], key=sort_key)
    lines = [f"# Ryokan Society guest-post leads (generated {date.today()})", "",
             "Generated by `rs_leads.py report`; do not edit by hand. Overrides live in "
             "`*overrides*.json`, scores in `authority-scores.json`.", "",
             "Verdicts: " + ", ".join(f"{k} {v}" for k, v in counts.most_common()) + f" ({len(rows)} evaluated)", "",
             "## PURSUE (by Authority Score)", "", "| Site | AS | Route | Stage | Pitch page | Found via | Note |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in pursue:
        lines.append(f"| {r['domain']} | {r['authority_score'] or '?'} | {r['route'] or '?'} | {r['stage'] or '?'} | "
                     f"{r['pitch_url'] or '-'} | {r['source_query'][:60]} | {r['note'][:140].replace('|', '/')} |")
    lines += ["", "## Needs review (by Authority Score)", "", "| Site | AS | Code | Found via |", "| --- | --- | --- | --- |"]
    for r in review:
        lines.append(f"| {r['domain']} | {r['authority_score'] or '?'} | {r['code']} | {r['source_query'][:60]} |")
    md = EXPORTS / "RS Guest Post Leads.md"
    md.write_text("\n".join(lines) + "\n")
    print(json.dumps({"markdown": str(md), "csv": str(csv_path), "counts": dict(counts),
                      "pursue": len(pursue), "missing_as": sum(1 for r in pursue + review if r['authority_score'] == '')},
                     indent=1))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    pl = sub.add_parser("plan")
    pl.add_argument("--max", type=int, default=8)
    ing = sub.add_parser("ingest")
    ing.add_argument("pulled")
    ing.add_argument("--label", default=datetime.now().strftime("%Y-%m-%d-%H%M"))
    sub.add_parser("missing-as")
    sa = sub.add_parser("set-as")
    sa.add_argument("pairs", nargs="+")
    sub.add_parser("report")
    a = p.parse_args(argv)
    if a.cmd == "plan":
        plan(a.max)
    elif a.cmd == "ingest":
        ingest(a.pulled, a.label)
    elif a.cmd == "missing-as":
        missing_as()
    elif a.cmd == "set-as":
        set_as(a.pairs)
    elif a.cmd == "report":
        report()


if __name__ == "__main__":
    main()
