"""Haiku classification step for one batch directory (decision D5, 2026-11-07).

Runs after research_tools.py seed / region / discover / variants. No network.

  classify_batch.py region <batch dir> [--force]
      Automatic Step 0 pre-screen from saved page text: .in/.pk ccTLD -> excluded,
      two or more strong India/Pakistan signals (+91, +92, rupee sign, INR, PKR,
      Pvt Ltd) -> unclear (Haiku's G0 decides), else clear. Writes region.json and
      region_check/region_note on each domain record. Keeps existing values unless --force.
  classify_batch.py prep <batch dir> [--size 18]
      Writes haiku/RULES.txt, haiku/sites/<domain>.txt (evidence), haiku/batch-NN.json
      (18 domains each), haiku/prompt-NN.txt (the exact subagent prompt) and
      haiku/prep.json. Sites with no page text or an excluded region are not batched.
  classify_batch.py merge <batch dir>
      Checks haiku/results/batch-NN.jsonl (exactly one valid line per batched domain),
      adds the forced rows (no page text -> NEEDS_REVIEW / INSUFFICIENT_EVIDENCE,
      excluded region -> SKIP / SKIP_REGION_EXCLUDED), writes haiku-results.json/.csv.
  classify_batch.py apply <batch dir>
      Writes the verdicts into domains/<domain>.json in the Part A shape run_tools.py
      validates, adds "Not pursued"/"Not pushed" tracker rows for non-PURSUE domains that
      have no row yet, and rebuilds research.json from the domain files. Safe to re-run:
      domains whose saved Haiku result is unchanged are not overwritten.
"""
import argparse
import csv
import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classifier  # noqa: E402

SKILL_DIR = Path(__file__).resolve().parent.parent
RULES = SKILL_DIR / "references" / "haiku-rules.txt"
BATCH_SIZE = 18
KEYS = ["domain", "verdict", "code", "pitch_url", "route", "contact", "submission_stage",
        "last_activity_date", "evidence_quote", "confidence"]
ROUTES = {"email", "form", "email_or_form", "none"}
STAGES = {"pitch-first", "article-first", "unknown"}
CONFIDENCE = {"high", "medium", "low"}
REVIEW_CODES = {"NO_ROUTE_FOUND", "INSUFFICIENT_EVIDENCE"}

STRONG_REGION = re.compile(r"\+91|\+92|₹|\bINR\b|\bPKR\b|pvt\.? ?ltd|private limited", re.I)
# Audience signals: a site written for Indian or Pakistani readers is excluded whatever its domain (Kai, 2026-11-08).
AUDIENCE_REGION = re.compile(r"\blakh\b|\bcrore\b|\brupees?\b|\bRs\.? ?\d|indian (?:travell?ers|passport|citizens|families|readers)|pakistani (?:travell?ers|passport|citizens|families|readers)|from (?:delhi|mumbai|bangalore|bengaluru|chennai|hyderabad|kolkata|pune|karachi|lahore|islamabad)\b|for indians\b|for pakistanis\b", re.I)
CC_TLD = re.compile(r"\.(?:co\.|net\.|org\.|firm\.|gen\.|ind\.)?in$|\.(?:com\.|org\.|net\.|edu\.|gov\.)?pk$", re.I)
REGION_NOTE = "automatic pre-screen (ccTLD / +91 / INR / Pvt Ltd signals)"

PROMPT = """You are classifying guest-post targets. Use only the Read and Write tools, no web access.
1. Read {haiku}/RULES.txt and follow it exactly.
2. Read {haiku}/batch-{nn}.json, a JSON list of {count} domains.
3. For each domain, read {haiku}/sites/<domain>.txt and decide from that file only.
4. Write {haiku}/results/batch-{nn}.jsonl: exactly one JSON object per line, one line per domain,
   in batch order, with exactly these keys: domain, verdict, code, pitch_url, route, contact,
   submission_stage, last_activity_date, evidence_quote, confidence. Use null where RULES.txt allows it.
   evidence_quote must be copied exactly from the site file. Write no other files.
Reply with only: done {count}"""


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=True, default=str) + "\n")
    tmp.replace(path)


def selected_domains(batch):
    return [s["domain"] for s in read_json(batch / "batch-input.json")["selected"]]


def load_record(batch, domain):
    path = batch / "domains" / f"{domain}.json"
    return read_json(path) if path.exists() else None


def page_texts(batch, record):
    texts = []
    for entry in (record or {}).get("search_log") or []:
        if isinstance(entry, dict) and entry.get("text_file") and entry.get("result") == "ok":
            try:
                texts.append((batch / entry["text_file"]).read_text(errors="replace"))
            except OSError:
                pass
    return texts


# ---- region pre-screen ------------------------------------------------------------

def region_decision(domain, texts):
    if CC_TLD.search(domain):
        return "excluded"
    hits = sum(len(STRONG_REGION.findall(t)) for t in texts)
    audience = sum(len(AUDIENCE_REGION.findall(t)) for t in texts)
    # "unclear" sends the site to Haiku's G0 audience check rather than auto-clearing it.
    return "unclear" if hits >= 2 or audience >= 2 else "clear"


def region(batch, force=False):
    out = {"clear": [], "unclear": [], "excluded": [], "kept": [], "no_record": []}
    for domain in selected_domains(batch):
        record = load_record(batch, domain)
        if record is None:
            out["no_record"].append(domain)
            continue
        if record.get("region_check") and not force:
            out["kept"].append(domain)
            continue
        value = region_decision(domain, page_texts(batch, record))
        record["region_check"] = value
        record["region_note"] = REGION_NOTE
        write_json(batch / "domains" / f"{domain}.json", record)
        out[value].append(domain)
    write_json(batch / "region.json", out)
    print("region: " + ", ".join(f"{len(v)} {k}" for k, v in out.items()))
    return out


# ---- prep -------------------------------------------------------------------------

def prep(batch, size=BATCH_SIZE):
    haiku = batch / "haiku"
    (haiku / "sites").mkdir(parents=True, exist_ok=True)
    (haiku / "results").mkdir(exist_ok=True)
    shutil.copy(RULES, haiku / "RULES.txt")
    today = date.today().isoformat()
    batched, no_text, excluded, missing = [], [], [], []
    for domain in selected_domains(batch):
        record = load_record(batch, domain)
        if record is None:
            missing.append(domain)
            continue
        if record.get("region_check") == "excluded":
            excluded.append(domain)
            continue
        evidence, pages = classifier.build_evidence(record, batch)
        if pages == 0:
            no_text.append(domain)
            continue
        (haiku / "sites" / f"{domain}.txt").write_text(
            # Subagents read the rules separately; drop the API-only closing line so it is not mistaken for page text.
            classifier.user_prompt(domain, record.get("triage_date") or today, evidence)
            .removesuffix("\n\nReturn the verdict JSON.") + "\n=== End of fetched pages ===\n")
        batched.append(domain)
    if missing:
        raise SystemExit(f"no domains/<domain>.json for {missing}; run research_tools.py seed first")
    for old in haiku.glob("batch-*.json"):
        old.unlink()
    for old in haiku.glob("prompt-*.txt"):
        old.unlink()
    batches = []
    for n in range(0, len(batched), size):
        nn = f"{n // size + 1:02d}"
        chunk = batched[n:n + size]
        write_json(haiku / f"batch-{nn}.json", chunk)
        (haiku / f"prompt-{nn}.txt").write_text(PROMPT.format(haiku=haiku, nn=nn, count=len(chunk)))
        batches.append(nn)
    report = {"batched": len(batched), "batches": batches, "no_page_text": no_text,
              "region_excluded": excluded, "prepared": today}
    write_json(haiku / "prep.json", report)
    print(f"{len(batched)} sites in {len(batches)} batches of <= {size}; "
          f"no page text: {len(no_text)}; region excluded: {len(excluded)}")
    for domain in no_text:
        print("  no page text:", domain)
    return report


# ---- merge ------------------------------------------------------------------------

def norm_domain(value):
    return str(value or "").strip().lower().removeprefix("www.")


def squash(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def check_row(row):
    problems = []
    if set(row) != set(KEYS):
        problems.append(f"keys {sorted(set(row) ^ set(KEYS))} wrong")
    verdict, code = row.get("verdict"), row.get("code")
    if verdict not in classifier.VERDICTS:
        problems.append(f"verdict {verdict!r}")
    elif verdict in ("PURSUE", "PAID_ONLY") and code is not None:
        problems.append(f"{verdict} must have code null, got {code!r}")
    elif verdict == "SKIP" and not (code in classifier.CODES and str(code).startswith("SKIP_")):
        problems.append(f"SKIP code {code!r}")
    elif verdict == "NEEDS_REVIEW" and code not in REVIEW_CODES:
        problems.append(f"NEEDS_REVIEW code {code!r}")
    for key, allowed in (("route", ROUTES), ("submission_stage", STAGES), ("confidence", CONFIDENCE)):
        if row.get(key) not in allowed:
            problems.append(f"{key} {row.get(key)!r}")
    if row.get("last_activity_date"):
        try:
            date.fromisoformat(row["last_activity_date"])
        except (TypeError, ValueError):
            problems.append(f"last_activity_date {row['last_activity_date']!r}")
    return problems


def forced(domain, verdict, code, quote):
    row = dict.fromkeys(KEYS)
    row.update(domain=domain, verdict=verdict, code=code, route="none", submission_stage="unknown",
               confidence="high", evidence_quote=quote)
    return row


def merge(batch):
    haiku = batch / "haiku"
    prep_report = read_json(haiku / "prep.json")
    results, problems = {}, []
    for nn in prep_report["batches"]:
        expected = read_json(haiku / f"batch-{nn}.json")
        path = haiku / "results" / f"batch-{nn}.jsonl"
        if not path.exists():
            problems.append(f"batch-{nn}: results file missing")
            continue
        seen = {}
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                problems.append(f"batch-{nn} line {number}: bad JSON ({exc.msg})")
                continue
            if not isinstance(row, dict):
                problems.append(f"batch-{nn} line {number}: not an object")
                continue
            domain = norm_domain(row.get("domain"))
            if domain not in expected:
                problems.append(f"batch-{nn} line {number}: unexpected domain {row.get('domain')!r}")
                continue
            if domain in seen:
                problems.append(f"batch-{nn}: {domain} appears more than once")
                continue
            row["domain"] = domain
            bad = check_row(row)
            if bad:
                problems.append(f"batch-{nn} {domain}: " + "; ".join(bad))
            seen[domain] = row
        for domain in expected:
            if domain not in seen:
                problems.append(f"batch-{nn}: {domain} has no line")
        results.update(seen)
    if problems:
        for p in problems:
            print("PROBLEM", p)
        raise SystemExit(f"{len(problems)} problems; re-run the affected Haiku batches, then merge again")
    for domain, row in results.items():
        site_text = (haiku / "sites" / f"{domain}.txt").read_text(errors="replace")
        quote = squash(row.get("evidence_quote"))
        row["quote_found"] = bool(quote) and quote in squash(site_text)
    for domain in prep_report["no_page_text"]:
        results[domain] = forced(domain, "NEEDS_REVIEW", "INSUFFICIENT_EVIDENCE", None)
        results[domain]["quote_found"] = False
        results[domain]["forced"] = "no page text"
    for domain in prep_report["region_excluded"]:
        results[domain] = forced(domain, "SKIP", "SKIP_REGION_EXCLUDED", None)
        results[domain]["quote_found"] = False
        results[domain]["forced"] = "region excluded"
    order = {d: i for i, d in enumerate(selected_domains(batch))}
    rows = sorted(results.values(), key=lambda r: order.get(r["domain"], len(order)))
    write_json(batch / "haiku-results.json", rows)
    with (batch / "haiku-results.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=KEYS + ["quote_found", "forced"])
        writer.writeheader()
        writer.writerows(rows)
    counts = {}
    for row in rows:
        key = row["verdict"] + ("/" + row["code"] if row["code"] else "")
        counts[key] = counts.get(key, 0) + 1
    print(f"{len(rows)} results: " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
    unquoted = [r["domain"] for r in rows if r["verdict"] == "PURSUE" and not r["quote_found"]]
    if unquoted:
        print("PURSUE without an exact quote in the evidence (check while drafting):", ", ".join(unquoted))
    return rows


# ---- apply ------------------------------------------------------------------------

def activity(last, triage):
    if not last:
        return "unverified"
    try:
        days = (date.fromisoformat(triage[:10]) - date.fromisoformat(last)).days
    except ValueError:
        return "unverified"
    return "active" if days <= 183 else "dormant"


def search_complete(record):
    search = record.get("invitation_search") or {}
    return bool(search.get("full")) and not search.get("early_stop")


def as_list(value):
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def apply_result(record, row, today):
    verdict, code = row["verdict"], row["code"]
    note = "Haiku classification (classify_batch.py, references/haiku-rules.txt)"
    if verdict == "SKIP" and code == "SKIP_NO_INVITATION" and not search_complete(record):
        capped = bool((record.get("invitation_search") or {}).get("stopped") or record.get("seed_capped"))
        verdict, code = "NEEDS_REVIEW", "SLOW_SITE_CAPPED" if capped else "INVITATION_SEARCH_INCOMPLETE"
        note += (f"; Haiku said SKIP_NO_INVITATION but the on-site search was not full, so {code}"
                 " (run research_tools.py variants <domain> --full, re-prep and re-classify)")
    if row.get("forced"):
        note += f"; forced: {row['forced']}"
    triage = record.get("triage_date") or today
    ok_urls = [e["url"] for e in record.get("search_log") or []
               if isinstance(e, dict) and e.get("result") == "ok" and e.get("url")]
    tried = [e["url"] for e in record.get("search_log") or [] if isinstance(e, dict) and e.get("url")]
    quote_url = row.get("pitch_url") or (ok_urls[0] if ok_urls else (tried[0] if tried else None))
    if row.get("evidence_quote"):
        quotes = [{"url": quote_url, "quote": row["evidence_quote"], "source": "haiku",
                   "found_in_fetched_text": bool(row.get("quote_found"))}]
    else:
        quotes = [{"url": quote_url, "quote": None, "source": "haiku",
                   "note": "verdict rests on what the fetched pages lack" if ok_urls else "no page text retrieved"}]
    contact = row.get("contact")
    record.update(
        verdict=verdict,
        skip_code=code if verdict == "SKIP" else None,
        review_reason=code if verdict == "NEEDS_REVIEW" else None,
        pitch_url=row.get("pitch_url"),
        submission_mechanism=None if row.get("route") == "none" else row.get("route"),
        submission_stage=None if row.get("submission_stage") == "unknown" else row.get("submission_stage"),
        contact_route=contact,
        email_obfuscated=bool(record.get("email_obfuscated")) or bool(
            contact and re.search(r"\(at\)|\[at\]|\bat\b.*\bdot\b|email.protected", contact, re.I)),
        last_post_date=row.get("last_activity_date"),
        activity=activity(row.get("last_activity_date"), triage),
        evidence_quotes=quotes,
        evidence_urls=list(dict.fromkeys(ok_urls or tried[:5])),
        confidence=row.get("confidence"),
        steps_completed=record.get("steps_completed") or "0,1 (helper fetch) + Haiku classification",
        notes=as_list(record.get("notes")) + [note],
        classification_source="haiku",
        haiku_classification={k: row.get(k) for k in KEYS + ["quote_found", "forced"]},
        research_status="classified",
    )
    return record


def tracker_row(record, batch_id, lead, today):
    source = (lead.get("source_rows") or [{}])[0]
    verdict = record["verdict"]
    code = verdict if verdict in ("PURSUE", "PAID_ONLY") else (record.get("skip_code") or record.get("review_reason"))
    quote = (record.get("evidence_quotes") or [{}])[0].get("quote")
    return {
        "site": record["domain"], "source_sheet": source.get("source_sheet"), "batch": batch_id,
        "sheet_score": source.get("score"), "verdict": verdict, "code": code,
        "confidence": record.get("confidence"), "pitch_url": record.get("pitch_url"),
        "submission_mechanism": record.get("submission_mechanism"), "contact_route": record.get("contact_route"),
        "needs_human_input": verdict in ("NEEDS_REVIEW", "PAID_ONLY") or record.get("region_check") == "unclear",
        "draft": None, "outreach_status": "Not pushed" if verdict == "NEEDS_REVIEW" else "Not pursued",
        "date_triaged": (record.get("triage_date") or today)[:10],
        "notes": "Haiku classification." + (f' Evidence: "{quote}"' if quote else ""),
        "outreach_email_id": None, "source_query": source.get("source_query"),
        "submission_stage": record.get("submission_stage"), "requirements_note": None,
    }


def apply(batch):
    today = date.today().isoformat()
    data = read_json(batch / "batch-input.json")
    batch_id = data.get("batch") or batch.name
    leads = {s["domain"]: s for s in data["selected"]}
    results = {r["domain"]: r for r in read_json(batch / "haiku-results.json")}
    missing = [d for d in leads if d not in results]
    if missing:
        raise SystemExit(f"no Haiku result for {missing}; prep/merge again")
    rows_path = batch / "tracker-rows.json"
    staged = read_json(rows_path) if rows_path.exists() else {"main": [], "full_articles": []}
    have_row = {r["site"] for r in staged["main"]}
    changed, added, sites = [], [], []
    for domain in leads:
        path = batch / "domains" / f"{domain}.json"
        record = read_json(path)
        row = results[domain]
        saved = record.get("haiku_classification")
        if saved != {k: row.get(k) for k in KEYS + ["quote_found", "forced"]}:
            apply_result(record, row, today)
            write_json(path, record)
            changed.append(domain)
        if record["verdict"] != "PURSUE" and domain not in have_row:
            staged["main"].append(tracker_row(record, batch_id, leads[domain], today))
            added.append(domain)
        sites.append(record)
    write_json(rows_path, staged)
    write_json(batch / "research.json", {"batch": batch_id, "sites": sites})
    pursue = [s["domain"] for s in sites if s["verdict"] == "PURSUE"]
    incomplete = [s["domain"] for s in sites if s.get("review_reason") == "INVITATION_SEARCH_INCOMPLETE"]
    print(f"applied {len(changed)} records, {len(added)} tracker rows added; research.json has {len(sites)} sites")
    print("PURSUE for the writing step:", ", ".join(pursue) or "none")
    if incomplete:
        print("needs variants --full before SKIP_NO_INVITATION:", ", ".join(incomplete))
    return {"changed": changed, "rows_added": added, "pursue": pursue, "search_incomplete": incomplete}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cmd", choices=("region", "prep", "merge", "apply"))
    parser.add_argument("batch_dir")
    parser.add_argument("--size", type=int, default=BATCH_SIZE, help="domains per Haiku subagent (prep)")
    parser.add_argument("--force", action="store_true", help="overwrite existing region_check (region)")
    args = parser.parse_args(argv)
    batch = Path(args.batch_dir).resolve()
    if args.cmd == "region":
        region(batch, args.force)
    elif args.cmd == "prep":
        prep(batch, args.size)
    elif args.cmd == "merge":
        merge(batch)
    else:
        apply(batch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
