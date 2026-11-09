"""Outreach Form outbound API client for the browser agent.

    python3 forms_api.py claim [--id UUID]           claim one approved form, journal it, print the brief
    python3 forms_api.py report DIR submitted --filled F --confirmation C [--confirmation-text T]
    python3 forms_api.py report DIR needs_human --code CODE --reason R [--filled F] [--confirmation C]
    python3 forms_api.py pending                     local claims with no recorded report (crash recovery)
    python3 forms_api.py list [--status approved]
    python3 forms_api.py push FILE [--dry-run]       create form drafts for review (never approves)

Never submits a form and never approves anything. Contract: outreach repo docs/FORMS.md.

Each claim gets a journal directory, FORM_AGENT_DIR/<domain>/<claim time>/, holding claim.json
(with the claim_token), the screenshots, submit-clicked.json (written by form_browser.py right
before the submit click), and report-response.json. `pending` reads those journals so a restarted
agent knows which forms it may have already submitted.

Environment:
    OUTREACH_BASE      default https://outreach-ten-plum.vercel.app
    GENERATOR_SECRET   bearer token (or GENERATOR_SECRET_FILE, owner-only file)
    FORM_AGENT_DIR     default <repo>/exports/form-outbound
    FORM_AGENT_NAME    default claude-form-agent
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE = os.environ.get("OUTREACH_BASE", "https://outreach-ten-plum.vercel.app").rstrip("/")
SECRET_FILE = os.environ.get(
    "GENERATOR_SECRET_FILE",
    "/Users/kaisulkin/.copilot/session-state/29cffd99-5ecb-4d22-951b-24dc5eae350f/files/generator-secret",
)
REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_DIR = Path(os.environ.get("FORM_AGENT_DIR", REPO_ROOT / "exports" / "form-outbound"))
AGENT = os.environ.get("FORM_AGENT_NAME", "claude-form-agent")
CODES = ("captcha", "account_required", "payment_required", "form_error", "form_changed", "blocked", "other")
MAX_SHOT_BYTES = 4 * 1024 * 1024


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def token() -> str:
    if os.environ.get("GENERATOR_SECRET"):
        return os.environ["GENERATOR_SECRET"]
    if stat.S_IMODE(os.stat(SECRET_FILE).st_mode) & 0o077:
        sys.exit("Credential file must be owner-only.")
    return Path(SECRET_FILE).read_text().strip()


def headers() -> dict:
    return {"Authorization": "Bearer " + token()}


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def read_json(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def journal_dir(form: dict) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe = re.sub(r"[^a-z0-9.-]", "_", form["domain"].lower())
    path = RUN_DIR / safe / stamp
    path.mkdir(parents=True, exist_ok=False)
    return path


def brief(form: dict, path: Path) -> str:
    lines = [
        f"journal: {path}",
        f"id: {form['id']}",
        f"domain: {form['domain']}",
        f"form_url: {form['form_url']}",
        f"persona: {form['persona_name']}",
    ]
    if form.get("site_rules"):
        lines.append(f"site_rules: {form['site_rules']}")
    if form.get("reviewer_note"):
        lines.append(f"reviewer_note: {form['reviewer_note']}")
    lines.append("fields (fill by index with form_browser.py fill):")
    for index, field in enumerate(form["fields"]):
        meta = [field.get("kind") or "text"]
        if field.get("required"):
            meta.append("required")
        if field.get("max_chars"):
            meta.append(f"max {field['max_chars']}")
        if field.get("name"):
            meta.append(f"name={field['name']}")
        if field.get("options"):
            meta.append("options=" + " | ".join(field["options"]))
        answer = field["answer"]
        shown = answer if len(answer) <= 80 else answer[:77] + "..."
        lines.append(f"  [{index}] {field['label']} ({', '.join(meta)}): {json.dumps(shown)} ({len(answer)} chars)")
    return "\n".join(lines)


def cmd_claim(args) -> int:
    body = {"agent": AGENT}
    if args.id:
        body["id"] = args.id
    response = requests.post(f"{BASE}/api/generator/forms/claim", json=body, headers=headers(), timeout=60)
    if response.status_code != 200:
        print(f"claim failed: HTTP {response.status_code} {response.text[:300]}", file=sys.stderr)
        return 1
    form = response.json().get("form")
    if not form:
        print("Nothing to claim. Stop.")
        return 3
    path = journal_dir(form)
    write_json(path / "claim.json", {"claimed_at": now(), "base": BASE, "agent": AGENT, "form": form})
    print(brief(form, path))
    return 0


def check_shot(path: str | None, name: str) -> Path | None:
    if not path:
        return None
    file = Path(path)
    if not file.is_file():
        sys.exit(f"{name}: {file} does not exist")
    if file.stat().st_size > MAX_SHOT_BYTES:
        sys.exit(f"{name}: {file} is over 4 MB. Retake it as a viewport screenshot.")
    return file


def cmd_report(args) -> int:
    path = Path(args.dir).resolve()
    claim = read_json(path / "claim.json")
    if not claim:
        sys.exit(f"No claim.json in {path}")
    previous = read_json(path / "report-response.json")
    if previous and previous.get("http_status") == 200:
        print(f"Already reported: {previous['body']['form']['status']}. Nothing to do.")
        return 0
    if read_json(path / "submit-clicked.json") and args.status == "needs_human" and args.code in (
        "captcha", "account_required", "payment_required", "form_changed"):
        print("warning: submit was already clicked for this form; make sure the reason says so.", file=sys.stderr)

    filled = check_shot(args.filled, "--filled")
    confirmation = check_shot(args.confirmation, "--confirmation")
    data = {"claim_token": claim["form"]["claim_token"], "status": args.status}
    if args.status == "submitted":
        if not filled or not confirmation:
            sys.exit("submitted needs --filled and --confirmation screenshots")
        if args.code:
            sys.exit("--code is only for needs_human")
    else:
        if args.code not in CODES:
            sys.exit(f"needs_human needs --code, one of: {', '.join(CODES)}")
        if not (args.reason or "").strip():
            sys.exit("needs_human needs --reason")
        data["outcome_code"] = args.code
    if args.reason:
        data["reason"] = args.reason
    if args.confirmation_text:
        data["confirmation_text"] = args.confirmation_text

    files = {}
    for name, file in (("filled_screenshot", filled), ("confirmation_screenshot", confirmation)):
        if file:
            kind = "image/png" if file.suffix.lower() == ".png" else "image/jpeg"
            files[name] = (file.name, file.read_bytes(), kind)

    write_json(path / "report-attempt.json", {"attempted_at": now(), **{k: v for k, v in data.items() if k != "claim_token"}})
    # Text goes in `data`, files in `files`: requests encodes both as multipart, so a ";" in the
    # reason is safe (unlike curl -F). Re-running the same report after a lost response is safe:
    # the API answers 200 with duplicate=true.
    try:
        response = requests.post(
            f"{BASE}/api/generator/forms/{claim['form']['id']}/outcome",
            data=data,
            files=files or None,
            headers=headers(),
            timeout=120,
        )
    except requests.RequestException as error:
        write_json(path / "report-response.json", {"received_at": now(), "uncertain": True, "error": type(error).__name__})
        print(f"Report uncertain ({type(error).__name__}). Run the same report command again; it is safe to repeat.")
        return 2
    body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {"text": response.text[:500]}
    write_json(path / "report-response.json", {"received_at": now(), "http_status": response.status_code, "body": body})
    if response.status_code != 200:
        print(f"Report refused: HTTP {response.status_code} {body.get('error', body)}")
        return 1
    form = body["form"]
    note = " (duplicate, already recorded)" if body.get("duplicate") else ""
    print(f"Reported {form['domain']}: {form['status']}{' / ' + form['outcome_code'] if form.get('outcome_code') else ''}{note}")
    return 0


def pending_journals() -> list[dict]:
    rows = []
    for claim_file in sorted(RUN_DIR.glob("*/*/claim.json")):
        path = claim_file.parent
        response = read_json(path / "report-response.json")
        if response and response.get("http_status") == 200:
            continue
        claim = read_json(claim_file)
        rows.append({
            "dir": str(path),
            "domain": claim["form"]["domain"],
            "claimed_at": claim["claimed_at"],
            "submit_clicked": (path / "submit-clicked.json").exists(),
            "last_report": response,
        })
    return rows


def cmd_pending(_args) -> int:
    rows = pending_journals()
    if not rows:
        print("No unreported claims.")
        return 0
    for row in rows:
        state = "SUBMIT WAS CLICKED: do not resubmit" if row["submit_clicked"] else "not submitted"
        print(f"{row['domain']}  claimed {row['claimed_at']}  {state}\n  {row['dir']}")
    return 4


def cmd_list(args) -> int:
    response = requests.get(f"{BASE}/api/generator/forms", params={"status": args.status, "limit": args.limit},
                            headers=headers(), timeout=60)
    if response.status_code != 200:
        print(f"list failed: HTTP {response.status_code} {response.text[:300]}", file=sys.stderr)
        return 1
    for form in response.json()["forms"]:
        extra = f" {form['outcome_code']}" if form.get("outcome_code") else ""
        print(f"{form['status']:<12} {form['domain']:<40} {form['id']}{extra}")
    return 0


def draft_problems(form: dict) -> list[str]:
    problems = []
    for key in ("campaign_id", "domain", "form_url", "fields"):
        if not form.get(key):
            problems.append(f"missing {key}")
    if form.get("persona") not in (None, "claire"):
        problems.append("persona must be claire")
    fields = form.get("fields") or []
    if len(fields) > 40:
        problems.append("more than 40 fields")
    for index, field in enumerate(fields):
        answer = field.get("answer")
        if not isinstance(answer, str) or not field.get("label"):
            problems.append(f"field {index}: needs label and string answer")
            continue
        if field.get("required") and not answer.strip():
            problems.append(f"field {index} ({field['label']}): required answer is empty")
        if field.get("max_chars") and len(answer) > field["max_chars"]:
            problems.append(f"field {index} ({field['label']}): {len(answer)} chars over {field['max_chars']}")
        if "shelby" in answer.lower():
            problems.append(f"field {index} ({field['label']}): mentions Shelby")
    for key in ("reviewer_note", "site_rules"):
        if form.get(key) and len(form[key]) > 4000:
            problems.append(f"{key} over 4000 chars")
    return problems


def cmd_push(args) -> int:
    """Create form drafts from a JSON list. One attempt per file: never re-posts after an attempt."""
    path = Path(args.file).resolve()
    forms = json.loads(path.read_text())
    if not isinstance(forms, list) or not forms:
        sys.exit("FILE must hold a non-empty JSON list of form drafts")
    bad = {f.get("domain") or i: p for i, f in enumerate(forms) if (p := draft_problems(f))}
    for key, problems in bad.items():
        print(f"{key}: {'; '.join(problems)}")
    if bad:
        print("Nothing pushed. Fix the drafts above.")
        return 1
    domains = [f["domain"] for f in forms]
    if len(set(domains)) != len(domains):
        sys.exit("Duplicate domains in FILE")
    print(f"{len(forms)} drafts valid.")
    if args.dry_run:
        return 0
    attempt = path.with_name(path.stem + "-push-attempt.json")
    result_file = path.with_name(path.stem + "-push-result.json")
    if attempt.exists():
        sys.exit(f"{attempt.name} exists: this file was already pushed. Read {result_file.name} or check /forms; do not re-post.")
    results = []
    for start in range(0, len(forms), 100):
        chunk = forms[start:start + 100]
        write_json(attempt, {"attempted_at": now(), "count": len(forms), "next_chunk_start": start})
        try:
            response = requests.post(f"{BASE}/api/generator/forms", json={"mode": "create", "forms": chunk},
                                     headers=headers(), timeout=120)
        except requests.RequestException as error:
            write_json(result_file, {"received_at": now(), "uncertain": True, "error": type(error).__name__, "results": results})
            print(f"Push uncertain ({type(error).__name__}). Check /forms before doing anything else.")
            return 2
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {"text": response.text[:500]}
        if response.status_code != 200:
            write_json(result_file, {"received_at": now(), "http_status": response.status_code, "body": body, "results": results})
            print(f"Push refused: HTTP {response.status_code} {body}")
            return 1
        for item in body["results"]:
            item["index"] += start
            results.append(item)
        notification = body.get("notification")
    write_json(result_file, {"received_at": now(), "http_status": 200, "notification": notification, "results": results})
    for item in results:
        state = f"{item['outcome']} {item.get('form_id', '')}" if item["ok"] else f"skipped: {item['error']}"
        print(f"{forms[item['index']]['domain']:<36} {state}")
    print(f"created {sum(1 for i in results if i['ok'])}, skipped {sum(1 for i in results if not i['ok'])}, notification {notification}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    claim = sub.add_parser("claim")
    claim.add_argument("--id")
    report = sub.add_parser("report")
    report.add_argument("dir")
    report.add_argument("status", choices=["submitted", "needs_human"])
    report.add_argument("--code", choices=CODES)
    report.add_argument("--reason")
    report.add_argument("--confirmation-text")
    report.add_argument("--filled")
    report.add_argument("--confirmation")
    sub.add_parser("pending")
    listing = sub.add_parser("list")
    listing.add_argument("--status", default="approved")
    listing.add_argument("--limit", type=int, default=50)
    push = sub.add_parser("push")
    push.add_argument("file")
    push.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return {"push": cmd_push, "claim": cmd_claim, "report": cmd_report, "pending": cmd_pending, "list": cmd_list}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
