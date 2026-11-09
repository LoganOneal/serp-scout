#!/usr/bin/env python3
"""Replay saved research evidence through a cheaper model and score it
against the verdicts already recorded in each domain's research JSON.

  python3 eval_classifier.py sample  --out eval/sample.json [--seed 7]
  python3 eval_classifier.py run     --sample eval/sample.json --model claude-haiku-5-5 --backend api --jobs 8
  python3 eval_classifier.py score   --results eval/results-claude-haiku-5-5.jsonl

Run from exports/guest-post-outreach (or set HHT_OUTREACH_DIR).
Ground truth is the existing Opus-run verdict. Fetch-failure NEEDS_REVIEW rows
are excluded from the sample: they test fetching, not judgment.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import glob
import json
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classifier  # noqa: E402

ROOT = Path(os.environ.get("HHT_OUTREACH_DIR", ".")).resolve()

# Per-label sample sizes. PURSUE is oversampled because missing one is the costly error.
QUOTAS = {
    "PURSUE": 160,
    "SKIP_NO_INVITATION": 120,
    "SKIP_NOT_PUBLICATION": 30,
    "SKIP_CLOSED": 30,
    "SKIP_INACTIVE": 25,
    "SKIP_MISALIGNED": 20,
    "SKIP_STAFF_ROLE": 15,
    "SKIP_REGION_EXCLUDED": 10,
    "PAID_ONLY": 10,
    "SKIP_NO_COMPANIES": 10,
    "AMBIGUOUS_PAGE": 20,
}


def truth_label(record: dict) -> str | None:
    verdict = record.get("verdict")
    code = record.get("skip_code")
    if verdict == "PURSUE":
        return "PURSUE"
    if verdict == "PAID_ONLY":
        return "PAID_ONLY"
    if verdict == "NEEDS_REVIEW":
        return "AMBIGUOUS_PAGE" if record.get("review_reason") == "AMBIGUOUS_PAGE" else None
    if code and code.startswith("SKIP_"):
        return code
    if verdict and verdict.startswith("SKIP_"):
        return verdict
    return None


def latest_records() -> dict[str, tuple[Path, dict]]:
    latest: dict[str, tuple[str, Path, dict]] = {}
    for f in glob.glob(str(ROOT / "*" / "domains" / "*.json")):
        try:
            record = json.load(open(f))
        except (OSError, ValueError):
            continue
        domain = record.get("domain")
        date = record.get("triage_date") or ""
        if domain and (domain not in latest or date >= latest[domain][0]):
            latest[domain] = (date, Path(f).parent.parent, record)
    return {d: (b, r) for d, (_, b, r) in latest.items()}


def cmd_sample(args: argparse.Namespace) -> None:
    rng = random.Random(args.seed)
    by_label: dict[str, list[dict]] = collections.defaultdict(list)
    for domain, (batch_dir, record) in latest_records().items():
        label = truth_label(record)
        if label not in QUOTAS:
            continue
        evidence, pages = classifier.build_evidence(record, batch_dir)
        if pages == 0:
            continue
        by_label[label].append({
            "domain": domain,
            "batch_dir": str(batch_dir.relative_to(ROOT)),
            "triage_date": record.get("triage_date"),
            "truth": label,
            "truth_route": record.get("submission_mechanism"),
            "truth_stage": record.get("submission_stage"),
            "truth_pitch_url": record.get("pitch_url"),
            "pages": pages,
        })
    sample = []
    for label, quota in QUOTAS.items():
        pool = by_label.get(label, [])
        rng.shuffle(pool)
        sample.extend(pool[:quota])
        print(f"{label:24} available {len(pool):5}  sampled {min(quota, len(pool))}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(sample, open(args.out, "w"), indent=1)
    print(f"{len(sample)} domains -> {args.out}")


def cmd_run(args: argparse.Namespace) -> None:
    sample = json.load(open(args.sample))
    out_path = Path(args.out or Path(args.sample).with_name(f"results-{args.model}.jsonl"))
    done = set()
    if out_path.exists():
        for line in out_path.read_text().splitlines():
            row = json.loads(line)
            if "error" not in row:
                done.add(row["domain"])
    todo = [s for s in sample if s["domain"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(done)} already done, running {len(todo)} with {args.model} via {args.backend}")

    def work(item: dict) -> dict:
        batch_dir = ROOT / item["batch_dir"]
        record = json.load(open(batch_dir / "domains" / f"{item['domain']}.json"))
        evidence, _ = classifier.build_evidence(record, batch_dir)
        started = time.time()
        for attempt in range(3):
            try:
                pred = classifier.classify(item["domain"], item["triage_date"] or "", evidence,
                                           model=args.model, backend=args.backend)
                return {**item, "pred": pred, "seconds": round(time.time() - started, 1)}
            except Exception as exc:  # noqa: BLE001 - recorded, retried
                err = str(exc)
                time.sleep(5 * (attempt + 1))
        return {**item, "error": err}

    with open(out_path, "a") as fh, cf.ThreadPoolExecutor(args.jobs) as pool:
        for i, row in enumerate(pool.map(work, todo), 1):
            fh.write(json.dumps(row) + "\n")
            fh.flush()
            if i % 20 == 0:
                print(f"  {i}/{len(todo)}")
    print(f"results -> {out_path}")


def _route(text: str | None) -> str:
    t = (text or "").lower()
    has_email = "email" in t or "@" in t
    has_form = "form" in t
    if has_email and has_form:
        return "email_or_form"
    if has_form:
        return "form"
    if has_email:
        return "email"
    return "none"


def cmd_score(args: argparse.Namespace) -> None:
    rows = [json.loads(l) for l in Path(args.results).read_text().splitlines()]
    errors = [r for r in rows if "error" in r]
    rows = [r for r in rows if "pred" in r]
    pred_label = lambda r: "PURSUE" if r["pred"]["verdict"] == "PURSUE" else (
        "PAID_ONLY" if r["pred"]["verdict"] == "PAID_ONLY" else (r["pred"].get("code") or r["pred"]["verdict"]))

    tp = sum(1 for r in rows if r["truth"] == "PURSUE" and r["pred"]["verdict"] == "PURSUE")
    fn = [r for r in rows if r["truth"] == "PURSUE" and r["pred"]["verdict"] != "PURSUE"]
    fp = [r for r in rows if r["truth"] != "PURSUE" and r["pred"]["verdict"] == "PURSUE"]
    pos = tp + len(fn)
    neg = len(rows) - pos
    review = [r for r in rows if r["pred"]["verdict"] == "NEEDS_REVIEW"]
    fn_hard = [r for r in fn if r["pred"]["verdict"] != "NEEDS_REVIEW"]

    lines = [f"# Classifier eval: {Path(args.results).stem}", ""]
    lines.append(f"Scored {len(rows)} domains ({len(errors)} errors).")
    lines.append("")
    lines.append("| Metric | Value | Bar |")
    lines.append("|---|---|---|")
    lines.append(f"| PURSUE recall | {tp}/{pos} = {tp / pos:.1%} | ≥ 95% |" if pos else "| PURSUE recall | n/a | |")
    lines.append(f"| PURSUE recall, counting NEEDS_REVIEW as caught (escalated) | {(tp + len(fn) - len(fn_hard))}/{pos} = {(pos - len(fn_hard)) / pos:.1%} | ≥ 95% |" if pos else "")
    lines.append(f"| False PURSUE among true skips | {len(fp)}/{neg} = {len(fp) / neg:.1%} | ≤ 10% |" if neg else "")
    lines.append(f"| Sent to NEEDS_REVIEW (escalation load) | {len(review)}/{len(rows)} = {len(review) / len(rows):.1%} | |")
    both = [r for r in rows if r["truth"] == "PURSUE" and r["pred"]["verdict"] == "PURSUE"]
    if both:
        route_ok = sum(1 for r in both if _route(r["truth_route"]) == r["pred"]["route"]
                       or ({_route(r["truth_route"]), r["pred"]["route"]} & {"email_or_form"} and "none" not in {_route(r["truth_route"]), r["pred"]["route"]}))
        stage_ok = sum(1 for r in both if (r["truth_stage"] or "unknown") == r["pred"]["submission_stage"])
        lines.append(f"| Route agreement (email/form) on shared PURSUE | {route_ok}/{len(both)} = {route_ok / len(both):.1%} | ≥ 95% |")
        lines.append(f"| Stage agreement (pitch/article-first) on shared PURSUE | {stage_ok}/{len(both)} = {stage_ok / len(both):.1%} | ≥ 95% |")
    cost = sum((r["pred"].get("_cost_usd") or 0) for r in rows)
    usage = [r["pred"].get("_usage") or {} for r in rows]
    tin = sum(u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0) for u in usage)
    tout = sum(u.get("output_tokens", 0) for u in usage)
    lines.append(f"| Tokens in / out (total) | {tin:,} / {tout:,} | |")
    if cost:
        lines.append(f"| Reported cost | ${cost:.2f} (${cost / len(rows):.4f}/domain) | |")
    lines.append("")

    lines.append("## Per true label")
    lines.append("")
    lines.append("| Truth | n | Exact match | Predicted PURSUE | Predicted NEEDS_REVIEW |")
    lines.append("|---|---|---|---|---|")
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r["truth"]].append(r)
    for label, rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        exact = sum(1 for r in rs if pred_label(r) == label)
        p = sum(1 for r in rs if r["pred"]["verdict"] == "PURSUE")
        nr = sum(1 for r in rs if r["pred"]["verdict"] == "NEEDS_REVIEW")
        lines.append(f"| {label} | {len(rs)} | {exact} | {p} | {nr} |")
    lines.append("")

    def listing(title: str, items: list[dict]) -> None:
        lines.append(f"## {title} ({len(items)})")
        lines.append("")
        for r in items[:40]:
            q = (r["pred"].get("evidence_quote") or "").replace("\n", " ")[:160]
            lines.append(f"- {r['domain']}: truth {r['truth']}, predicted {pred_label(r)} ({r['pred']['confidence']}). \"{q}\"")
        lines.append("")

    listing("Missed PURSUE, predicted a skip", fn_hard)
    listing("Missed PURSUE, escalated to review", [r for r in fn if r not in fn_hard])
    listing("False PURSUE", fp)
    if errors:
        listing("Errors", [{**e, "pred": {"verdict": "ERROR", "code": e["error"][:80], "confidence": "-"}} for e in errors])

    report = "\n".join(l for l in lines if l is not None)
    out = Path(args.results).with_suffix(".md")
    out.write_text(report)
    print(report[:3000])
    print(f"\nreport -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--out", default="eval/sample.json")
    s.add_argument("--seed", type=int, default=7)
    r = sub.add_parser("run")
    r.add_argument("--sample", default="eval/sample.json")
    r.add_argument("--model", default="claude-haiku-5-5")
    r.add_argument("--backend", choices=["api", "cli"], default="api")
    r.add_argument("--jobs", type=int, default=8)
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--out")
    c = sub.add_parser("score")
    c.add_argument("--results", required=True)
    args = ap.parse_args()
    {"sample": cmd_sample, "run": cmd_run, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    main()
