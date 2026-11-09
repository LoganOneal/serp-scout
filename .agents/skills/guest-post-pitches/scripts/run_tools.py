"""Run-level tooling for guest-post-pitches: exclusions, run setup, validation, commit.

  run_tools.py exclusions
      Write every tracked domain (both master tabs) to exports/handoff/exclusions/
      guest-post-master-tracker.csv so `pnpm hht:opp export-leads` never re-exports them.
  run_tools.py prepare <csv...> --run-id ID [--size 25] [--dry-run]
      Normalize and dedupe guest_post leads (link_insertion rows are ignored) against both
      master tabs, every batch already researched under exports/guest-post-outreach and every
      recorded outreach create/attempt; then create <run>/ and <run>-B01.. with batch-input.json,
      a rendered lane-contract.md, a master backup and the pre-run snapshot.
  run_tools.py validate <run dir> <batch id>     check a batch's outputs without committing
  run_tools.py commit <run dir> <batch id>       validate, then append its rows (sequential, locked)

openpyxl: imported normally, else from HHT_PYTHON_DEPS or the known session deps folder.
"""
import argparse
import collections
import copy
import csv
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

for candidate in (os.environ.get("HHT_PYTHON_DEPS"),
                  "/Users/kaisulkin/.copilot/session-state/5d4b88c2-d4b4-47ac-a621-3ddca4dd46ab/files/python-deps"):
    try:
        import openpyxl  # noqa: F401
        break
    except ImportError:
        if candidate and Path(candidate).is_dir():
            sys.path.insert(0, candidate)
from openpyxl import load_workbook  # noqa: E402

SKILL_DIR = Path(__file__).resolve().parent.parent
REPO = Path(os.environ.get("HHT_REPO", "/Users/kaisulkin/serp-scout"))
EXPORTS = Path(os.environ.get("HHT_EXPORTS", REPO / "exports/guest-post-outreach"))
MASTER = Path(os.environ.get("HHT_MASTER", EXPORTS / "Guest Post Master Tracker.xlsx"))
ORIGINAL = Path("/Users/kaisulkin/Downloads/Guest Post Master Tracker.xlsx")
EXCLUSIONS_CSV = REPO / "exports/handoff/exclusions/guest-post-master-tracker.csv"
PART_A = (
    "domain verdict skip_code review_reason region_check supplied_urls "
    "supplied_url_result pitch_url url_corrected submission_mechanism "
    "submission_stage article_delivery contact_route email_obfuscated payment "
    "link_policy corporate_stance requirements_summary last_post_date activity "
    "outside_contributors_seen restrictions fit_rationale suggested_angle "
    "evidence_quotes evidence_urls steps_completed search_log confidence notes"
).split()


# ---- shared helpers (from the validated 2026-10-23 guest_queue) ----------------

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalize(value):
    text = str(value or "").strip().lower()
    host = urlsplit(text if "://" in text else "//" + text).hostname or ""
    host = host.removeprefix("www.").rstrip(".")
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host):
        raise ValueError(f"Cannot normalize domain: {value!r}")
    return host


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=True, default=str) + "\n")
    os.replace(tmp, path)


def records(sheet):
    values = list(sheet.iter_rows(values_only=True))
    header = values[0]
    return [dict(zip(header, row)) for row in values[1:] if any(v is not None for v in row)]


def workbook_snapshot(workbook):
    return {
        sheet.title: [
            [[cell.value, list(cell._style) if cell._style is not None else [0] * 9] for cell in row]
            for row in sheet.iter_rows()
        ]
        for sheet in workbook
    }


def append_rows(sheet, rows):
    header = [cell.value for cell in sheet[1]]
    for row in rows:
        unknown = set(row).difference(header)
        if unknown:
            raise ValueError(f"Unexpected tracker columns: {sorted(unknown)}")
        previous = sheet.max_row
        sheet.append([row.get(key) for key in header])
        for cell in sheet[sheet.max_row]:
            cell._style = copy.copy(sheet.cell(previous, cell.column)._style)


def tracked_domains():
    wb = load_workbook(MASTER, read_only=True)
    out = set()
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header = next(rows)
        i = header.index("site")
        for r in rows:
            if r[i]:
                try:
                    out.add(normalize(r[i]))
                except ValueError:
                    pass
    return out


def outreach_touched():
    touched = collections.defaultdict(list)
    for p in EXPORTS.glob("*/outreach-outcomes.json"):
        for d, o in read_json(p).items():
            touched[normalize(d)].append(f"{p.parent.name}:{o.get('outcome')}")
    for p in EXPORTS.glob("*/outreach-post-attempt.json"):
        for d in read_json(p).get("domains_by_index", []):
            touched[normalize(d)].append(f"{p.parent.name}:attempt")
    return touched


# ---- exclusions ----------------------------------------------------------------

def exclusions():
    domains = sorted(tracked_domains())
    EXCLUSIONS_CSV.parent.mkdir(parents=True, exist_ok=True)
    with EXCLUSIONS_CSV.open("w", newline="") as handle:
        w = csv.writer(handle)
        w.writerow(["domain", "source"])
        for d in domains:
            w.writerow([d, "Guest Post Master Tracker"])
    print(f"wrote {len(domains)} tracked domains to {EXCLUSIONS_CSV}")


# ---- prepare -------------------------------------------------------------------

def lead_urls(row):
    urls = []
    for key in ("opportunity_url", "discovery_url", "submission_or_contact_url",
                "contact_email_source_url", "contact_form_url"):
        if row.get(key):
            urls.append(row[key].strip())
    for part in (row.get("all_urls") or "").split("|"):
        if part.strip():
            urls.append(part.strip())
    return [u for u in dict.fromkeys(urls) if u.startswith("http")]


def prepare(csv_paths, run_id, size, dry_run):
    run_dir = EXPORTS / run_id
    if not dry_run and run_dir.exists():
        sys.exit(f"{run_dir} exists; never overwrite a run.")
    tracked = tracked_domains()
    touched = outreach_touched()
    researched = {p.stem for p in EXPORTS.glob("*/domains/*.json")}
    leads = collections.OrderedDict()
    skipped = collections.Counter()
    for path in csv_paths:
        with open(path, newline="") as handle:
            for index, row in enumerate(csv.DictReader(handle), 2):
                if (row.get("lead_type") or "guest_post").strip() == "link_insertion":
                    skipped["link_insertion"] += 1
                    continue
                try:
                    domain = normalize(row.get("domain") or row.get("site") or row.get("url"))
                except ValueError:
                    skipped["bad_domain"] += 1
                    continue
                if domain in tracked:
                    skipped["in_master"] += 1
                    continue
                if domain in touched:
                    skipped["outreach_history"] += 1
                    continue
                if domain in researched:
                    skipped["researched_in_other_batch"] += 1
                    continue
                entry = leads.setdefault(domain, {"domain": domain, "source_rows": [], "supplied_urls": []})
                entry["source_rows"].append({"source_row": index, "source_sheet": Path(path).name, **row})
                entry["supplied_urls"] = list(dict.fromkeys(entry["supplied_urls"] + lead_urls(row)))
    selected = list(leads.values())
    batches = [selected[i:i + size] for i in range(0, len(selected), size)]
    summary = {"run_id": run_id, "inputs": [str(p) for p in csv_paths], "new_guest_post_domains": len(selected),
               "skipped": dict(skipped), "batches": len(batches)}
    print(json.dumps(summary, indent=2))
    if dry_run or not selected:
        return
    run_dir.mkdir(parents=True)
    for n, chunk in enumerate(batches, 1):
        bid = f"{run_id}-B{n:02d}"
        write_json(EXPORTS / bid / "batch-input.json", {
            "batch": bid, "source": summary["inputs"], "selected": chunk})
    template = (SKILL_DIR / "references" / "lane-contract-template.md").read_text()
    (run_dir / "lane-contract.md").write_text(template.replace("{RUN_DIR}", str(run_dir)))
    shutil.copy2(MASTER, run_dir / "master-before-run.xlsx")
    wb = load_workbook(MASTER)
    if wb.sheetnames != ["Untitled", "Full Articles"]:
        sys.exit(f"Unexpected sheets {wb.sheetnames}")
    write_json(run_dir / "initial-master-records.json", workbook_snapshot(wb))
    write_json(run_dir / "run.json", {
        "run_id": run_id, "created_at": now(), "canonical_workbook": str(MASTER),
        "initial_master_sha256": digest(MASTER),
        "original_sha256": digest(ORIGINAL) if ORIGINAL.exists() else None,
        "initial_record_counts": {s.title: len(records(s)) for s in wb},
        "prepare_summary": summary,
        "batches": [{"id": f"{run_id}-B{n:02d}", "status": "pending"} for n in range(1, len(batches) + 1)],
    })
    print("prepared", run_dir)


# ---- validate / commit ---------------------------------------------------------

def validate(directory, batch_id, expected):
    research = read_json(directory / "research.json")
    sites = research["sites"]
    if collections.Counter(s["domain"] for s in sites) != collections.Counter(expected):
        raise ValueError("research.json must hold exactly one record per selected domain.")
    for site in sites:
        missing = set(PART_A).difference(site)
        if missing:
            raise ValueError(f"{site['domain']}: missing Part A fields {sorted(missing)}")
        if not site["search_log"] or not site["evidence_urls"] or not site["evidence_quotes"]:
            raise ValueError(f"{site['domain']}: missing auditable evidence.")
        if read_json(directory / "domains" / (site["domain"] + ".json")) != site:
            raise ValueError(f"{site['domain']}: per-domain file differs from research.json.")
        if site["verdict"] == "SKIP_NO_INVITATION" or site.get("skip_code") == "SKIP_NO_INVITATION":
            search = site.get("invitation_search") or {}
            if search.get("early_stop") or not search.get("full"):
                raise ValueError(f"{site['domain']}: SKIP_NO_INVITATION without a completed on-site search.")
    validation = read_json(directory / "draft-validation.json")
    if validation.get("passed") is not True or validation.get("editorial_readthrough_passed") is not True:
        raise ValueError("Programmatic validation and editorial read-through are required.")
    rows = read_json(directory / "tracker-rows.json")
    main, articles = rows["main"], rows["full_articles"]
    if collections.Counter(normalize(r["site"]) for r in main) != collections.Counter(expected):
        raise ValueError("Exactly one main row per evaluated domain is required.")
    by_domain = {s["domain"]: s for s in sites}
    article_domains = {s["domain"] for s in sites
                       if s["verdict"] == "PURSUE" and s["submission_stage"] == "article-first"}
    if collections.Counter(normalize(r["site"]) for r in articles) != collections.Counter(article_domains):
        raise ValueError("Full Articles rows do not match article-first pursuits.")
    markdown = (directory / "drafts.md").read_text()
    outcomes = read_json(directory / "outreach-outcomes.json")
    payloads = read_json(directory / "outreach-payload.json")
    payload_by_domain = {p["contact"]["attributes"]["domain"]: p for p in payloads}
    for row in main:
        domain = normalize(row["site"])
        site = by_domain[domain]
        if row["batch"] != batch_id or row["verdict"] != site["verdict"]:
            raise ValueError(f"{domain}: tracker/research disagreement.")
        if not row.get("code"):
            raise ValueError(f"{domain}: code column must not be empty.")
        if row.get("draft") and f"## {domain}\n" not in markdown:
            raise ValueError(f"{domain}: missing stable Markdown section.")
        if domain in article_domains and row["outreach_status"] != "Article for review (not pushed)":
            raise ValueError(f"{domain}: invalid article routing.")
        if row["outreach_status"] == "Draft in outreach tool":
            result = outcomes.get(domain, {})
            payload = payload_by_domain[domain]
            if (result.get("ok") is not True or result.get("outcome") != "created"
                    or not result.get("email_id") or result["email_id"] != row.get("outreach_email_id")):
                raise ValueError(f"{domain}: missing confirmed create response.")
            if (site["verdict"] != "PURSUE" or site["submission_stage"] != "pitch-first"
                    or site.get("push_blockers") or site["region_check"] == "excluded"):
                raise ValueError(f"{domain}: ineligible outreach push.")
            if payload["body"] not in markdown or payload["subject"] not in markdown:
                raise ValueError(f"{domain}: Markdown does not preserve exact pushed copy.")
            if row["requirements_note"] != payload["reviewer_note"]:
                raise ValueError(f"{domain}: reviewer note mismatch.")
        elif row.get("outreach_email_id"):
            raise ValueError(f"{domain}: ID without a confirmed created status.")
    for domain, result in outcomes.items():
        if result.get("outcome") == "created":
            row = next(r for r in main if normalize(r["site"]) == domain)
            if row.get("outreach_email_id") != result.get("email_id"):
                raise ValueError(f"{domain}: created draft not recorded in tracker row.")
    for row in articles:
        if row["status"] != "Drafted" or "drafts.md#" not in (row.get("doc_link") or ""):
            raise ValueError("Invalid Full Articles status or local document reference.")
    if not (directory / "report.md").is_file() or not (directory / "summary.json").is_file():
        raise ValueError("report.md and summary.json are required.")
    return main, articles


@contextmanager
def locked(run_dir):
    with (run_dir / ".commit.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def batch_paths(run_dir, batch_id):
    directory = run_dir.parent / batch_id
    expected = [s["domain"] for s in read_json(directory / "batch-input.json")["selected"]]
    return directory, expected


def commit(run_dir, batch_id):
    directory, expected = batch_paths(run_dir, batch_id)
    main, articles = validate(directory, batch_id, expected)
    if any(row.get("outreach_status") == "Awaiting consolidated push" for row in main):
        raise ValueError("Consolidate the run's staged drafts before committing this batch.")
    with locked(run_dir):
        state = read_json(run_dir / "run.json")
        entry = next(b for b in state["batches"] if b["id"] == batch_id)
        if entry["status"] == "completed":
            sys.exit("Already committed.")
        if state.get("original_sha256") and ORIGINAL.exists() and digest(ORIGINAL) != state["original_sha256"]:
            raise ValueError("The original download changed.")
        wb = load_workbook(MASTER)
        before = workbook_snapshot(wb)
        original = read_json(run_dir / "initial-master-records.json")
        for title, old_rows in original.items():
            current = json.loads(json.dumps(before[title][:len(old_rows)], default=str))
            if current != old_rows:
                raise ValueError(f"Pre-run workbook records or formatting changed: {title}")
        known = {normalize(r["site"]) for s in wb for r in records(s)}
        if known.intersection(expected):
            raise ValueError(f"Already in master; reconcile: {sorted(known.intersection(expected))}")
        append_rows(wb["Untitled"], main)
        append_rows(wb["Full Articles"], articles)
        tmp = MASTER.with_name(MASTER.stem + "." + batch_id + ".tmp.xlsx")
        wb.save(tmp)
        after = workbook_snapshot(load_workbook(tmp))
        if list(before) != list(after):
            raise ValueError("Workbook tabs changed.")
        for title, old_rows in before.items():
            if after[title][:len(old_rows)] != old_rows:
                raise ValueError(f"Prior rows/styles not preserved in {title}.")
        if len(after["Untitled"]) != len(before["Untitled"]) + len(main):
            raise ValueError("Main tab row count mismatch.")
        if len(after["Full Articles"]) != len(before["Full Articles"]) + len(articles):
            raise ValueError("Full Articles row count mismatch.")
        tmp.replace(MASTER)
        proof = {"batch": batch_id, "validated_at": now(), "passed": True,
                 "prior_records_and_styles_preserved": True, "both_tabs_preserved": True,
                 "exactly_one_main_row_per_domain": True, "main_rows_appended": len(main),
                 "article_rows_appended": len(articles), "master_after_sha256": digest(MASTER)}
        write_json(directory / "workbook-validation.json", proof)
        entry.update(status="completed", completed_at=now(), master_after_sha256=proof["master_after_sha256"])
        write_json(run_dir / "run.json", state)
        progress = directory / "progress.json"
        if progress.exists():
            p = read_json(progress)
            p.update(current_stage="committed",
                     updated_at=datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
            write_json(progress, p)
        print(json.dumps(proof))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("exclusions")
    pr = sub.add_parser("prepare")
    pr.add_argument("csv", nargs="+")
    pr.add_argument("--run-id", required=True)
    pr.add_argument("--size", type=int, default=25)
    pr.add_argument("--dry-run", action="store_true")
    for name in ("validate", "commit"):
        s = sub.add_parser(name)
        s.add_argument("run_dir")
        s.add_argument("batch_id")
    a = p.parse_args(argv)
    if a.cmd == "exclusions":
        exclusions()
    elif a.cmd == "prepare":
        prepare(a.csv, a.run_id, a.size, a.dry_run)
    elif a.cmd == "validate":
        directory, expected = batch_paths(Path(a.run_dir).resolve(), a.batch_id)
        main_rows, art = validate(directory, a.batch_id, expected)
        print(f"valid: {len(main_rows)} main rows, {len(art)} article rows")
    else:
        commit(Path(a.run_dir).resolve(), a.batch_id)


if __name__ == "__main__":
    main()
