#!/usr/bin/env python3
"""Cheap-model guest-post feasibility classifier.

Reads the evidence that research_tools.py already saved for a domain and asks a
model for a Part A verdict as structured JSON. Two backends:

  api  Anthropic Messages API (needs ANTHROPIC_API_KEY); forced tool call.
  cli  `claude -p` headless, using the local Claude Code login. Eval only.

This module never fetches the network for evidence: it only reads saved files.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
from datetime import date, timedelta
from pathlib import Path

VERDICTS = ["PURSUE", "SKIP", "PAID_ONLY", "NEEDS_REVIEW"]
CODES = [
    "SKIP_REGION_EXCLUDED",
    "SKIP_NOT_PUBLICATION",
    "SKIP_NO_INVITATION",
    "SKIP_CLOSED",
    "SKIP_STAFF_ROLE",
    "SKIP_NO_COMPANIES",
    "SKIP_MISALIGNED",
    "SKIP_DEAD",
    "SKIP_INACTIVE",
    "NO_ROUTE_FOUND",
    "INSUFFICIENT_EVIDENCE",
]

SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": VERDICTS},
        "code": {"type": ["string", "null"], "enum": CODES + [None]},
        "pitch_url": {"type": ["string", "null"]},
        "route": {"type": "string", "enum": ["email", "form", "email_or_form", "none"]},
        "contact": {"type": ["string", "null"]},
        "submission_stage": {"type": "string", "enum": ["pitch-first", "article-first", "unknown"]},
        "last_activity_date": {"type": ["string", "null"]},
        "evidence_quote": {"type": ["string", "null"]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["verdict", "code", "pitch_url", "route", "contact", "submission_stage",
                 "last_activity_date", "evidence_quote", "confidence"],
    "additionalProperties": False,
}

SYSTEM = """You judge whether a website is a realistic guest-post target for Claire Bennett, a U.S. travel blogger who runs hotelhottubs.com (a guide to hotels with in-room hot tubs). You get the text of pages already fetched from one domain. Decide from that text only. Quote exact wording; never infer an invitation that the text does not state.

Apply the gates in order and stop at the first failure:
G0 Region: the site primarily writes for an Indian or Pakistani audience, whatever its domain or where it is hosted, or is based in or run from India or Pakistan -> SKIP / SKIP_REGION_EXCLUDED. Audience signs: prices in INR/PKR, rupees, lakh or crore; trips planned from Indian or Pakistani cities; visa or packing advice for Indian or Pakistani passport holders; readers addressed as Indians or Pakistanis; Hinglish or Indian holiday planning for Indian families. Base signs: .in/.pk domains, Indian/Pakistani address, +91/+92 phone, Pvt Ltd. A Western site covering India as a destination, or an Indian author name, is not a hit.
G1 Publication: registry, store, gift list, forum index, app shell, booking or package seller with no real editorial blog -> SKIP / SKIP_NOT_PUBLICATION. A company with a real editorial blog passes.
G1b Invitation: some page or explicit sentence invites outside writers to submit guest posts, articles, pitches or story ideas (write for us, contribute, submission guidelines, freelance pitches welcome, guest author form). A plain contact page, advertise page, media kit, PR/press contact, or sponsored-post price list does NOT count -> SKIP / SKIP_NO_INVITATION. Wording traps: "contribute" may mean donations, "work with us" may mean advertising or careers, "collaborate" may mean brand sponsorships.
G2 Open: the invitation explicitly says closed, paused, not accepting, invite only -> SKIP / SKIP_CLOSED.
G3 Staff only: the route is recruiting staff/team writers, assigned topics only, or says not for guest posts -> SKIP / SKIP_STAFF_ROLE. An open freelance pitch to an editor is NOT a fail (lean PURSUE).
G4 Companies: explicitly excludes businesses, brands, PR or SEO agencies -> SKIP / SKIP_NO_COMPANIES, or PAID_ONLY (code null) when businesses are sent to a priced sponsored/advertising route. Restricting promotional links inside articles is not a fail.
G5 Fit: fail only when clearly no travel/lodging/lifestyle piece from Claire could serve the readers (unrelated subject, hostel backpackers in Asia only, video-only) -> SKIP / SKIP_MISALIGNED. Tone mismatch, regional focus, family or women audiences, company blogs are NOT failures.
G6 Dead: parked domain, errors, no content -> SKIP / SKIP_DEAD.
G6b Activity: use the "Activity check" line at the top, which code computed from dates printed on the pages. If it says the newest date is within 6 months of the triage date, the site is active; do not override it by reading dates yourself. Only when it says "no dates found" may you look for dated posts; if none are within 6 months -> SKIP / SKIP_INACTIVE. Ignore copyright years.
G7 Route: a route is ANY of these anywhere in the fetched pages: an email address, a masked or spelled-out email ("name (at) site (dot) com", "name [at] gmail.com", "[email protected]", "email me at"), a form, or a named editor to email. An email on the contact page counts as the route when the invitation page itself gives none. Only when an invitation exists and there is no route of any kind -> NEEDS_REVIEW / NO_ROUTE_FOUND.
INSUFFICIENT_EVIDENCE: only when the pages needed for the decision are absent (for example the homepage and invitation page both failed). If an invitation page's text is present, never use INSUFFICIENT_EVIDENCE; decide. Failed extra pages listed at the bottom do not matter when the pages above are enough.
Otherwise -> PURSUE (code null).

Also report: pitch_url (the page holding the invitation), route (email, form, email_or_form, none), contact (email address or form URL), submission_stage (article-first only if the site explicitly asks for the complete, finished article in the first submission; otherwise pitch-first, including when it asks for an idea, outline, query, topic or a draft only after approval), last_activity_date (newest dated post seen, YYYY-MM-DD), evidence_quote (the exact sentence that decided the verdict, under 300 characters), confidence."""

STRONG_INVITE_PATH = re.compile(
    r"write-?for|guest|contribut|writer|freelance|pitch|guideline|submission|submit-(?:a-)?(?:post|story|article|idea)"
    r"|publish|editorial|policies", re.I)
INVITE_PATH = re.compile(r"submit|work-?with|collaborat|join|author", re.I)
CONTACT_PATH = re.compile(r"contact|about|advertis|press|media-?kit|partner", re.I)
SKIP_URL = re.compile(r"robots\.txt$|sitemap[^/]*\.xml$", re.I)


INVITE_TEXT = re.compile(
    r"write for us|guest[- ]post|guest (?:blogg?er|author|writer|contributor)s?|contributor guidelines|submission guidelines|"
    r"writers?'? guidelines|freelanc(?:e|ers?)\b|pitch (?:us|your|an? )|(?:accept|accepting|welcome|welcomes|open to)\s+(?:guest|outside|freelance|new)?\s*"
    r"(?:posts|submissions|contributions|contributors|writers|pitches|articles|story ideas)|become a (?:contributor|writer)|"
    r"submit (?:a|your) (?:guest post|post|article|pitch|story|idea)", re.I)


def _page_rank(entry: dict, candidates: set[str], text: str = "") -> int:
    url = entry.get("url") or ""
    path = re.sub(r"^https?://[^/]+", "", url)
    if url in candidates:
        return 0
    hits = len(INVITE_TEXT.findall(text)) if text else 0
    if hits >= 2:
        return 0
    if hits == 1:
        return 1
    if STRONG_INVITE_PATH.search(path):
        return 1
    if path in ("", "/"):
        return 2
    if CONTACT_PATH.search(path):
        return 3
    if INVITE_PATH.search(path):
        return 4
    return 5


def build_evidence(record: dict, batch_dir: Path, *, page_chars: int = 5000, total_chars: int = 40000) -> tuple[str, int]:
    """Concatenate saved page text for one domain, invitation pages first."""
    candidates = {c.get("url") for c in record.get("invitation_candidates") or [] if c.get("url")}
    seen: set[str] = set()
    entries = []
    for entry in record.get("search_log") or []:
        if not isinstance(entry, dict) or not entry.get("text_file"):
            continue
        if SKIP_URL.search(entry.get("url") or ""):
            continue
        if entry.get("result") != "ok" or not entry.get("text_characters"):
            continue
        url = entry.get("url")
        if url in seen:
            continue
        seen.add(url)
        try:
            body = (batch_dir / entry["text_file"]).read_text(errors="replace")
        except OSError:
            continue
        entries.append((entry, body))
    entries.sort(key=lambda pair: _page_rank(pair[0], candidates, pair[1]))
    parts: list[str] = [activity_line(record, [b for _, b in entries])]
    used = 0
    pages = 0
    for entry, text in entries:
        limit = page_chars * 2 if _page_rank(entry, candidates, text) == 0 else page_chars
        text = re.sub(r"\n{3,}", "\n\n", text).strip()[:limit]
        block = f"=== {entry['url']} (HTTP {entry.get('status')}) ===\n{text}\n"
        if used + len(block) > total_chars:
            continue
        parts.append(block)
        used += len(block)
        pages += 1
    failed = [e.get("url") for e in record.get("search_log") or []
              if isinstance(e, dict) and e.get("result") not in (None, "ok", "redirect")
              and not SKIP_URL.search(e.get("url") or "")]
    if failed:
        parts.append("=== Other pages that failed to load (ignore if the pages above are enough) ===\n" + "\n".join(str(u) for u in failed[:25]))
    return "\n".join(parts), pages


MONTHS = "january february march april may june july august september october november december".split()
_MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
DATE_PATTERNS = [
    re.compile(_MON + r"\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)", re.I),
    re.compile(r"(\d{1,2})(?:st|nd|rd|th)?\s+" + _MON + r",?\s+(20\d\d)", re.I),
    re.compile(r"\b(20\d\d)-(\d{2})-(\d{2})\b"),
    re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d\d)\b"),
]


def _month(name: str) -> int:
    return next(i + 1 for i, m in enumerate(MONTHS) if m.startswith(name.lower()[:3]))


def page_dates(text: str) -> list[date]:
    out = []
    for line in text.splitlines():
        if re.search(r"©|copyright|all rights reserved", line, re.I):
            continue
        for m in DATE_PATTERNS[0].finditer(line):
            out.append((int(m.group(3)), _month(m.group(1)), int(m.group(2))))
        for m in DATE_PATTERNS[1].finditer(line):
            out.append((int(m.group(3)), _month(m.group(2)), int(m.group(1))))
        for m in DATE_PATTERNS[2].finditer(line):
            out.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
        for m in DATE_PATTERNS[3].finditer(line):
            out.append((int(m.group(3)), int(m.group(1)), int(m.group(2))))
    dates = []
    for y, mo, d in out:
        try:
            dates.append(date(y, mo, d))
        except ValueError:
            pass
    return dates


def activity_line(record: dict, texts: list[str]) -> str:
    try:
        triage = date.fromisoformat((record.get("triage_date") or "")[:10])
    except ValueError:
        triage = date.today()
    found = sorted({d for t in texts for d in page_dates(t) if d <= triage + timedelta(days=2)}, reverse=True)
    if not found:
        return "=== Activity check (computed by code) ===\nno dates found on the fetched pages\n"
    newest = found[0]
    days = (triage - newest).days
    verdict = "within 6 months: ACTIVE" if days <= 183 else "older than 6 months"
    shown = ", ".join(d.isoformat() for d in found[:5])
    return (f"=== Activity check (computed by code) ===\nnewest date printed on the pages: {newest.isoformat()} "
            f"({days} days before triage), {verdict}. Newest dates seen: {shown}\n")


def user_prompt(domain: str, triage_date: str, evidence: str) -> str:
    return (f"Domain: {domain}\nTriage date: {triage_date}\n\n"
            f"Fetched pages:\n\n{evidence or '(no page text was retrieved)'}\n\n"
            "Return the verdict JSON.")


def classify(domain: str, triage_date: str, evidence: str, *, model: str, backend: str, timeout: int = 180) -> dict:
    prompt = user_prompt(domain, triage_date, evidence)
    if backend == "api":
        return _classify_api(prompt, model=model, timeout=timeout)
    return _classify_cli(prompt, model=model, timeout=timeout)


def _classify_api(prompt: str, *, model: str, timeout: int) -> dict:
    key = os.environ["ANTHROPIC_API_KEY"]
    body = {
        "model": model,
        "max_tokens": 1024,
        "system": SYSTEM,
        "tools": [{"name": "record_verdict", "description": "Record the verdict.", "input_schema": SCHEMA}],
        "tool_choice": {"type": "tool", "name": "record_verdict"},
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    out = next(b["input"] for b in data["content"] if b.get("type") == "tool_use")
    out["_usage"] = data.get("usage")
    return out


def _classify_cli(prompt: str, *, model: str, timeout: int) -> dict:
    cmd = [
        "claude", "-p",
        "--model", model,
        "--system-prompt", SYSTEM,
        "--tools", "",
        "--json-schema", json.dumps(SCHEMA),
        "--output-format", "json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources", "",
    ]
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout,
                          cwd="/", env={**os.environ, "CLAUDE_CODE_SIMPLE": os.environ.get("CLAUDE_CODE_SIMPLE", "")})
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p exited {proc.returncode}: {proc.stderr[-500:]}")
    data = json.loads(proc.stdout)
    out = data.get("structured_output")
    if out is None:
        text = data.get("result") or ""
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise RuntimeError(f"no JSON in result: {text[:300]}")
        out = json.loads(match.group(0))
    out["_usage"] = data.get("usage")
    out["_cost_usd"] = data.get("total_cost_usd")
    return out
