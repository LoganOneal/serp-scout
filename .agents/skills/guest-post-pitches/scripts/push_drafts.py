"""Create step 1 drafts for one batch: python3 push_drafts.py <batch dir>

Reads <batch>/outreach-payload.json (array, Part C schema). Creates drafts only:
never sends, approves or retries. Journals the attempt before the POST and the
redacted response after it, then writes outreach-outcomes.json keyed by domain.
Refuses to run if a previous attempt exists for the batch (reconcile instead).
"""
import hashlib
import re
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests


BASE = "https://outreach-ten-plum.vercel.app"
CAMPAIGN = "8cc518fd-9635-41fe-a3a9-fc4e2e4f2a20"  # guest post outreach
# Experiment lane (SKILL.md "Experiment lane"): its own campaign so results stay separate.
EXPERIMENT_SOURCE = "hht-exp-noinvite"
EXPERIMENT_CAMPAIGN = "d39441ed-9da2-4098-a87f-6a22af45ace0"  # EXPERIMENT: add-to-article


def expected_campaign(draft):
    source = ((draft.get("contact") or {}).get("attributes") or {}).get("source")
    return EXPERIMENT_CAMPAIGN if source == EXPERIMENT_SOURCE else CAMPAIGN
# The one allowed fictional-experience note: exact text, last line of the body (Kai, 2026-11-09).
FICTION_NOTE = "Note: The personal travel experiences described in this email are fictional."
_FICTION_WORDS = re.compile(r"\b(fictional|fictitious|made up|invented)\b", re.I)


def fiction_note_error(body):
    """None if the body has no note, or exactly FICTION_NOTE as its last line; else the problem."""
    lines = [l.strip() for l in body.strip().splitlines() if l.strip()]
    flagged = [l for l in lines if _FICTION_WORDS.search(l) and re.search(r"experience|detail|stor|anecdot", l, re.I)]
    if not flagged:
        return None
    if flagged != [FICTION_NOTE] or lines[-1] != FICTION_NOTE:
        return f"fictional note must be exactly the last line: {FICTION_NOTE!r}"
    return None


SECRET_FILE = os.environ.get(
    "GENERATOR_SECRET_FILE",
    "/Users/kaisulkin/.copilot/session-state/29cffd99-5ecb-4d22-951b-24dc5eae350f/files/generator-secret")


def token():
    if os.environ.get("GENERATOR_SECRET"):
        return os.environ["GENERATOR_SECRET"]
    if stat.S_IMODE(os.stat(SECRET_FILE).st_mode) & 0o077:
        sys.exit("Credential file must be owner-only.")
    return Path(SECRET_FILE).read_text().strip()


def main(batch_dir=None):
    batch = Path(batch_dir or sys.argv[1]).resolve()
    attempt_path = batch / "outreach-post-attempt.json"
    if attempt_path.exists():
        sys.exit("An attempt is already journaled for this batch; reconcile, do not retry.")
    raw = (batch / "outreach-payload.json").read_bytes()
    payload = json.loads(raw)
    if not payload:
        (batch / "outreach-outcomes.json").write_text("{}\n")
        print("No eligible drafts; nothing pushed.")
        return {}
    if len(payload) > 100:
        sys.exit("The generator accepts at most 100 drafts per request; use push_run_drafts.py.")
    domains = [p["contact"]["attributes"]["domain"] for p in payload]
    emails = [p["contact"]["email"].lower() for p in payload]
    if len(set(domains)) != len(domains) or len(set(emails)) != len(emails):
        sys.exit("Duplicate domain or email in payload.")
    for p in payload:
        if p.get("campaign_id") != expected_campaign(p) or p.get("step_number") != 1:
            sys.exit(f"{p['contact']['attributes']['domain']}: wrong campaign or step.")
        if not p.get("subject") or not p.get("body") or not p.get("reviewer_note"):
            sys.exit(f"{p['contact']['attributes']['domain']}: subject, body and reviewer_note are required.")
        if fiction_note_error(p["body"]):
            sys.exit(f"{p['contact']['attributes']['domain']}: {fiction_note_error(p['body'])}")
        if "@" not in p["contact"]["email"]:
            sys.exit(f"{p['contact']['attributes']['domain']}: unreadable recipient.")
    credential = token()
    attempt = {"attempted_at": datetime.now(timezone.utc).isoformat(), "method": "POST",
               "url": BASE + "/api/generator/drafts", "mode": "create array", "count": len(payload),
               "domains_by_index": domains, "payload_sha256": hashlib.sha256(raw).hexdigest(),
               "retry_policy": "no retry on timeout; reconcile manually"}
    attempt_path.write_text(json.dumps(attempt, indent=2) + "\n")
    try:
        r = requests.post(attempt["url"], json=payload, timeout=90,
                          headers={"Authorization": "Bearer " + credential, "Content-Type": "application/json"})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"text": r.text[:500]}
        resp = {"received_at": datetime.now(timezone.utc).isoformat(), "http_status": r.status_code, "body": body}
    except Exception as exc:  # uncertain outcome: never retry blindly
        resp = {"received_at": datetime.now(timezone.utc).isoformat(), "uncertain": True, "error": type(exc).__name__}
    (batch / "outreach-post-response.json").write_text(json.dumps(resp, indent=2) + "\n")
    outcomes = {}
    results = (resp.get("body") or {}).get("results") if isinstance(resp.get("body"), dict) else None
    for i, domain in enumerate(domains):
        res = next((x for x in (results or []) if x.get("index") == i), None)
        if res is None:
            outcomes[domain] = {"ok": False, "outcome": "uncertain" if resp.get("uncertain") else "no_result",
                                "index": i, "http_status": resp.get("http_status")}
        elif res.get("ok") and res.get("outcome") == "created" and not res.get("email_id"):
            outcomes[domain] = {**res, "ok": False, "outcome": "uncertain",
                                "error": "Created response has no confirmed email_id; reconcile, do not retry."}
        else:
            outcomes[domain] = {**res, "notification": (resp.get("body") or {}).get("notification")}
    (batch / "outreach-outcomes.json").write_text(json.dumps(outcomes, indent=2) + "\n")
    print(json.dumps({d: (o.get("outcome"), o.get("email_id")) for d, o in outcomes.items()}, indent=1))
    return outcomes


if __name__ == "__main__":
    main()
