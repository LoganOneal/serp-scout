"""Regenerate the master list of everything in guest-post outreach that needs Kai.

    python3 manual_queue.py [--offline]

Writes exports/guest-post-outreach/Manual Intervention Queue.md from three sources:
  1. the outreach app's Form outbound queue (/forms), read-only GETs (skipped with --offline)
  2. form-backlog runs: every exports/guest-post-outreach/*/sites/<domain>.json that is not_pushable
  3. the master tracker workbook: statuses and Full Articles rows that wait on a person

Read only, except for the output file. Run it at the end of every pitch run, form push or form-agent run.
"""
import json
import os
import re
import stat
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

for candidate in (os.environ.get("HHT_PYTHON_DEPS"),
                  "/Users/kaisulkin/.copilot/session-state/5d4b88c2-d4b4-47ac-a621-3ddca4dd46ab/files/python-deps"):
    try:
        import openpyxl  # noqa: F401
        break
    except ImportError:
        if candidate and Path(candidate).is_dir():
            sys.path.insert(0, candidate)
from openpyxl import load_workbook  # noqa: E402

REPO = Path(os.environ.get("HHT_REPO", "/Users/kaisulkin/serp-scout"))
EXPORTS = Path(os.environ.get("HHT_EXPORTS", REPO / "exports/guest-post-outreach"))
MASTER = EXPORTS / "Guest Post Master Tracker.xlsx"
OUT = EXPORTS / "Manual Intervention Queue.md"
BASE = os.environ.get("OUTREACH_BASE", "https://outreach-ten-plum.vercel.app").rstrip("/")
SECRET_FILE = os.environ.get(
    "GENERATOR_SECRET_FILE",
    "/Users/kaisulkin/.copilot/session-state/29cffd99-5ecb-4d22-951b-24dc5eae350f/files/generator-secret",
)

# Tracker statuses that wait on a person, grouped by what the person does.
TRACKER_GROUPS = [
    ("Decide: paid or sponsored routes", ("Paid route (human decides)", "Not pursued (paid route; human decision)")),
    ("Unblock: pitches waiting on materials", ("Blocked (requirements incomplete; not pushed)",
                                              "Drafted (article-first; needs 3 cleared images before sending)")),
    ("Review: sites the research could not settle", ("Needs review",)),
    ("Research blocked: check the site by hand", ("Not drafted (research blocked)", "Not drafted (research restricted)")),
    ("Articles written but not sent", ("Not sent",)),
]
FORM_ONLY = ("In Markdown (form only)", "In Doc (form only)", "Not pushed (form only)", "Form drafted (not submitted)")

# Not-pushable form reasons, matched in order. The first match decides the category.
FORM_CATEGORIES = [
    ("Site down or no form (recheck later)", r"does not resolve|dns|http 500|critical error|site is down|no submission form|unreachable"),
    ("Needs a file upload", r"upload"),
    ("Form changed or broken: needs a rewrite", r"does not fit|cannot be fitted|no longer have|broken|shortcode"),
    ("Needs an account or sign-in", r"sign-in|sign in|account registration|create an account|requires an account|log ?in\b"),
    ("Asks for credentials Claire does not have", r"association|muck ?rack|social handles"),
    ("Submit by hand: the site blocks automated browsers",
     r"cloudflare|just a moment|access denied|bot check|\b403\b|security verification"),
    ("Needs a real trip, residency or original photos (decision)",
     r"travel log|personally visited|personal experience|actually been|first-hand|own photos|original photos|made japan|invented trip"),
    ("Not worth pursuing (no action)", r"skip_inactive|inactive"),
]


def now() -> datetime:
    return datetime.now(timezone.utc)


def clean(text, limit=220) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip().replace("|", "/")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def secret():
    if os.environ.get("GENERATOR_SECRET"):
        return os.environ["GENERATOR_SECRET"]
    path = Path(SECRET_FILE)
    if not path.exists() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        return None
    return path.read_text().strip()


def forms_queue():
    """Live rows from /forms, or an error string."""
    import requests

    token = secret()
    if not token:
        return None, "no generator secret available"
    rows = {}
    try:
        for status in ("draft", "approved", "claimed", "needs_human"):
            response = requests.get(f"{BASE}/api/generator/forms", params={"status": status, "limit": 200},
                                    headers={"Authorization": f"Bearer {token}"}, timeout=60)
            response.raise_for_status()
            rows[status] = response.json()["forms"]
    except Exception as error:  # read-only report: never fail the whole doc on the API
        return None, f"{type(error).__name__}: {clean(error, 120)}"
    return rows, None


def latest_form_sites():
    """The newest site JSON per domain across form-backlog runs (first-pass copies ignored)."""
    latest = {}
    for path in sorted(EXPORTS.glob("*/sites/*.json")):
        if path.name.endswith(".first-pass.json"):
            continue
        site = json.loads(path.read_text())
        domain = site.get("domain") or path.stem
        stamp = site.get("checked_at") or ""
        if domain not in latest or stamp >= latest[domain][0]:
            latest[domain] = (stamp, site, path)
    return {domain: (site, path) for domain, (_, site, path) in latest.items()}


def categorize(reason: str) -> str:
    for name, pattern in FORM_CATEGORIES:
        if re.search(pattern, reason, re.I):
            return name
    return "Other: read the reason"


def main() -> int:
    offline = "--offline" in sys.argv
    lines = [
        "# Manual Intervention Queue",
        "",
        f"Everything in guest-post outreach that is waiting on a person. Generated {now():%Y-%m-%d %H:%M} UTC by "
        "`.agents/skills/guest-post-pitches/scripts/manual_queue.py`; do not edit by hand, rerun the script.",
        "",
        "Claire's form details (phone, Seattle WA, Delaware postal address) are in "
        "`.agents/skills/guest-post-pitches/references/asset-kit.md`.",
        "",
    ]
    summary = []
    body = []

    # 1. Live /forms queue.
    in_forms = set()
    if offline:
        body += ["## /forms queue", "", "Skipped (--offline).", ""]
    else:
        rows, error = forms_queue()
        body += ["## /forms queue", ""]
        if error:
            body += [f"Could not read /forms: {error}.", ""]
        else:
            for status_rows in rows.values():
                in_forms.update(r["domain"] for r in status_rows)
            drafts = rows["draft"]
            captcha_drafts = [r for r in drafts if (r.get("attributes") or {}).get("captcha")]
            approved_captcha = [r for r in rows["approved"] if (r.get("attributes") or {}).get("captcha")]
            stale = [r for r in rows["claimed"] if r.get("claimed_at")
                     and (now() - datetime.fromisoformat(r["claimed_at"].replace("Z", "+00:00"))).total_seconds() > 1800]
            summary.append(f"/forms: {len(drafts)} drafts to review, {len(rows['needs_human'])} needs-human, "
                           f"{len(approved_captcha)} approved CAPTCHA forms to submit by hand, {len(stale)} stale claims")
            body += [f"Open {BASE}/forms.", ""]
            body += [f"### Review and approve ({len(drafts)} drafts)", ""]
            body += ["Approve, edit or reject each one. The agent submits approved forms without a CAPTCHA.",
                     f"{len(captcha_drafts)} of them have a CAPTCHA: once approved, the agent will set them aside "
                     "and they need submitting by hand.", ""]
            if drafts:
                body += ["| Site | CAPTCHA | Form |", "|---|---|---|"]
                body += [f"| {r['domain']} | {'yes' if (r.get('attributes') or {}).get('captcha') else ''} | {r['form_url']} |"
                         for r in sorted(drafts, key=lambda r: r["domain"])]
                body += [""]
            body += [f"### Needs human ({len(rows['needs_human'])})", ""]
            if rows["needs_human"]:
                body += ["| Site | Code | Reason |", "|---|---|---|"]
                body += [f"| {r['domain']} | {r.get('outcome_code') or ''} | {clean(r.get('outcome_reason'))} |"
                         for r in rows["needs_human"]]
            else:
                body += ["None."]
            body += [""]
            if approved_captcha:
                body += [f"### Approved, with a CAPTCHA: submit by hand ({len(approved_captcha)})", "",
                         "Submit on the site, then use Mark submitted in /forms.", ""]
                body += [f"- {r['domain']}: {r['form_url']}" for r in approved_captcha] + [""]
            if stale:
                body += [f"### Claims older than 30 minutes ({len(stale)})", "",
                         "The agent may have crashed. Check the site before using Release claim.", ""]
                body += [f"- {r['domain']} (claimed by {r.get('claimed_by')} at {r['claimed_at']})" for r in stale] + [""]

    # 2. Form sites that could not go to /forms.
    groups = defaultdict(list)
    for domain, (site, path) in sorted(latest_form_sites().items()):
        if site.get("status") == "ready" or domain in in_forms:
            continue
        reason = site.get("not_pushable_reason") or "no reason recorded"
        groups[categorize(reason)].append((domain, reason, path))
    total = sum(len(v) for name, v in groups.items() if not name.startswith("Not worth"))
    summary.append(f"form sites not in /forms: {total} need a person")
    body += ["## Form sites that could not go to /forms", ""]
    for name, _ in FORM_CATEGORIES + [("Other: read the reason", "")]:
        if name not in groups:
            continue
        body += [f"### {name} ({len(groups[name])})", "", "| Site | Reason | Details |", "|---|---|---|"]
        body += [f"| {d} | {clean(reason)} | `{path.relative_to(EXPORTS)}` |" for d, reason, path in groups[name]]
        body += [""]

    # 3. Tracker rows waiting on a person.
    workbook = load_workbook(MASTER, read_only=True)
    rows = list(workbook["Untitled"].iter_rows(values_only=True))
    head = rows[0]
    col = {name: index for index, name in enumerate(head)}
    tracker = [dict(zip(head, r)) for r in rows[1:] if r[0]]
    form_sites = latest_form_sites()
    body += ["## From the master tracker", ""]
    for title, statuses in TRACKER_GROUPS:
        found = [r for r in tracker if r["outreach_status"] in statuses]
        if not found:
            continue
        summary.append(f"{title.split(':')[0].lower()}: {len(found)}")
        body += [f"### {title} ({len(found)})", "", "| Site | Status | Note |", "|---|---|---|"]
        for r in sorted(found, key=lambda r: str(r["site"])):
            note = r.get("requirements_note") or r.get("notes") or r.get("code") or ""
            body += [f"| {r['site']} | {r['outreach_status']} | {clean(note)} |"]
        body += [""]
    leftover = [r for r in tracker if r["outreach_status"] in FORM_ONLY and r["site"] not in form_sites
                and r["site"] not in in_forms]
    if leftover:
        summary.append(f"form-only pitches never checked against a live form: {len(leftover)}")
        body += [f"### Form-only pitches not yet checked against the live form ({len(leftover)})", "",
                 "Run them through the form backlog step so they reach /forms or get a reason.", "",
                 "| Site | Status | Draft |", "|---|---|---|"]
        body += [f"| {r['site']} | {r['outreach_status']} | {clean(r.get('draft'), 120)} |" for r in leftover] + [""]

    articles = list(workbook["Full Articles"].iter_rows(values_only=True))
    ahead = articles[0]
    article_rows = [dict(zip(ahead, r)) for r in articles[1:] if r[0]]
    for status, title, action in (
        ("Draft pushed in error (full article); reject in /review", "Reject in /review: full articles pushed by mistake",
         "Reject each in the outreach app's /review."),
        ("Drafted", "Full articles to review", "Read and approve each article before it is routed."),
    ):
        found = [r for r in article_rows if r["status"] == status]
        if not found:
            continue
        summary.append(f"{title.lower()}: {len(found)}")
        body += [f"### {title} ({len(found)})", "", action, "", "| Site | Title | File |", "|---|---|---|"]
        body += [f"| {r['site']} | {clean(r.get('title'), 90)} | {clean(r.get('doc_link'), 120)} |" for r in found]
        body += [""]

    lines += ["## Summary", ""] + [f"- {s}" for s in summary] + [""] + body
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT}")
    for s in summary:
        print(" ", s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
