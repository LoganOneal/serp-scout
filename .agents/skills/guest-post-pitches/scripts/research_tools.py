"""Part A Step 0-1.5 fetch helper for guest-post-pitches.

Run from (or point HHT_BATCH_DIR at) a batch directory that contains
batch-input.json with {"selected": [{"domain": ..., "supplied_urls": [...]}]}.

Modes (all accept several domains and run them in parallel with --jobs):
  seed          homepage, about, contact (Step 0 inputs)
  region        record region_check: --set clear|unclear|excluded [--note TEXT]
  discover      supplied URLs plus nav/footer/about/contact/work/advertise candidates
  variants      top invitation paths, then the first readable root sitemap; stops early
                once a confirmed invitation page is found unless --full is given
  research      discover then variants
  needs-search  list domains that still need the Step 1.6 web search

Default is the light policy (Kai, 2026-10-24); --thorough restores every playbook path,
all root sitemaps and both web searches. Each stage is capped per domain by --budget
seconds (default 90); a capped domain is never a completed search.
  fetch         fetch one explicit --url for a domain
  overview      print the search log and matching evidence lines
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import requests


ROOT = Path(os.environ.get("HHT_BATCH_DIR") or os.getcwd()).resolve()
UA = "GuestPostResearch/1.0"
HOST_SPACING_SECONDS = 2.0
TIMEOUT = (
    float(os.environ.get("HHT_CONNECT_TIMEOUT", 6)),
    float(os.environ.get("HHT_READ_TIMEOUT", 12)),
)
SEARCH_POLICY = (
    "v6 light (Kai, 2026-10-24): canonical host; top invitation paths, first readable root "
    "sitemap and up to 2 page/contributor child maps; one web search; per-stage time cap; "
    "probing stops once a confirmed invitation page is found."
)
SEARCH_POLICY_THOROUGH = (
    "v5 thorough: canonical host, every playbook path once, all root sitemaps; two web searches."
)
PATHS = [
    "write-for-us", "guest-post", "guestpost", "guest-posts", "guest-blog",
    "contribute", "contributors", "submissions", "submit", "pitch", "writers",
    "writers-guidelines", "contributor-guidelines", "become-a-contributor",
    "work-with-us", "work-with-me", "collaborate", "advertise", "partner-with-us",
    "press", "contact",
]
PATHS_LIGHT = [
    "write-for-us", "guest-post", "guestpost", "contribute", "contributors",
    "submissions", "contributor-guidelines", "work-with-us",
]
MAX_DISCOVER_CANDIDATES = 10
STAGE_BUDGET_SECONDS = float(os.environ.get("HHT_STAGE_BUDGET", 90))
SITEMAP_ROOTS = ("sitemap.xml", "sitemap_index.xml", "wp-sitemap.xml", "page-sitemap.xml")
KEYWORDS = re.compile(
    r"write.for.us|guest.?post|guest.?blog|contribut|submission|submit|pitch|"
    r"writer|become.a.blog|work.with|collaborat|partner|advertis|media.kit|press|contact|about",
    re.I,
)
FIELDS = (
    "domain verdict skip_code review_reason region_check supplied_urls "
    "supplied_url_result pitch_url url_corrected submission_mechanism "
    "submission_stage article_delivery contact_route email_obfuscated payment "
    "link_policy corporate_stance requirements_summary last_post_date activity "
    "outside_contributors_seen restrictions fit_rationale suggested_angle "
    "evidence_quotes evidence_urls steps_completed search_log confidence notes"
).split()

MAX_SITEMAP_CANDIDATES = 12
MAX_SITEMAP_CANDIDATES_LIGHT = 6
MAX_CHILD_MAPS_LIGHT = 2
ARCHIVE_MAP = re.compile(r"post|tag|categor|news|product|image|attachment|archive|author|video|\d{2,}|-\d+\.xml|\bgallery|recipe|destination|hotel|review|article|story|stories|blog|listing|location", re.I)
PAGE_MAP = re.compile(r"page|static|misc|contribut|submission|writer|team|about|landing|custom", re.I)
CANDIDATE_PAGE = re.compile(
    r"write-?for|guest-?(post|blog|author|writer|contribut)|contribut|submission|submit|pitch|"
    r"(become|be)-a-|writers?(-|/|$)|work-?with|collaborat|partner|advertis|media-?kit|press|"
    r"contact|about|sponsor|freelanc|join-?us|careers?|guidelines", re.I)

# Early-stop detection. A page only counts when its path looks like a dedicated
# invitation page and its own text (navigation/footer lines shared with the
# homepage removed) invites outside writers, gives a route, and is not closed.
INVITE_PATH = re.compile(
    r"write-?for|guest|contribut|submi|pitch|writers?(?:[-/_.]|$)|become-a|join-?us|work-?with|freelanc|"
    r"(?:editorial|writing|writer|submission|contributor)-?guidelines", re.I)
POSITIVE = re.compile(
    r"write for us|guest[- ]post(?:ing)? (?:guidelines|policy|submissions?|application)|guest posts? (?:are )?welcome|"
    r"(?:accept|accepts|accepting|welcome|welcomes|are open to|open to)\s+(?:guest|outside|freelance|new)?\s*"
    r"(?:posts|submissions|contributions|contributors|writers|pitches|articles)|"
    r"guest (?:blogg?ers?|authors?|writers?|contributors?|posts?|posters?)|contributor guidelines|submission guidelines|"
    r"writers?'? guidelines|become a (?:contributor|writer)|submit (?:a|your) (?:guest post|post|article|pitch|story|idea)|"
    r"pitch (?:us|your (?:idea|story|article))|(?:story|stories|idea|ideas) to pitch|"
    r"(?:looking for|seeking)\s+(?:talented |new |freelance |guest )?(?:writers|contributors|stories)|"
    r"freelanc(?:e|ers?) (?:guidelines|opportunities|submissions|writers?)|guidelines for (?:freelancers|writers|contributors)",
    re.I)
NEGATIVE = re.compile(
    r"(?:do not|don't|does not|doesn't|no longer|not currently|are not|aren't|is not|isn't|cannot|can't)\s+"
    r"(?:currently\s+)?(?:accept|accepting|take|taking|publish|publishing|open (?:to|for)|consider|considering)\s+"
    r"(?:any\s+)?(?:new\s+)?(?:guest|unsolicited|outside|freelance|submissions|contribut|pitches|articles)|"
    r"guest (?:posts?|post submissions|blogging|contributions) (?:are|is) (?:currently )?(?:closed|paused|on hold|not accepted)|"
    r"(?:submissions|pitches) (?:are|is) (?:currently )?(?:closed|paused|on hold)",
    re.I)
ROUTE = re.compile(r"@|\[at\]|\(at\)|e-?mail|form\b|send (?:us|your|it)|submit|contact us|reach out|apply|application", re.I)
MIN_UNIQUE_TEXT = 200

_INPUT = None


def batch_input():
    global _INPUT
    if _INPUT is None:
        _INPUT = json.loads((ROOT / "batch-input.json").read_text())
    return _INPUT


def safe_join(base, link):
    try:
        return urljoin(base, link)
    except ValueError:
        return None


def same_site(host, domain):
    host = (host or "").lower()
    return host.removeprefix("www.") == domain or host.endswith("." + domain)


def relevant_child_map(url):
    name = urlsplit(url).path.rsplit("/", 1)[-1]
    if re.search(r"contribut|submission|writer", name, re.I) or re.search(r"posts-page-|(^|[-_])pages?[-_.\d]", name, re.I):
        return not re.search(r"posts-post-|post-sitemap", name, re.I)
    return bool(PAGE_MAP.search(name)) and not ARCHIVE_MAP.search(name)


def relevant_page(url):
    parts = urlsplit(url)
    segs = [x for x in parts.path.split("/") if x]
    if not segs or len(segs) > 2 or parts.query or re.search(r"\.(jpg|jpeg|png|gif|webp|pdf|xml)$", parts.path, re.I):
        return False
    if re.search(r"/(19|20)\d{2}/", parts.path):
        return False
    return bool(CANDIDATE_PAGE.search(segs[-1])) and len(segs[-1]) <= 45


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def body_lines(text):
    """Lines of a saved .txt evidence file, without the URL/HTTP header."""
    return [line for line in text.split("\n\n", 1)[-1].splitlines() if line.strip()]


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text = []
        self.links = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden += 1
        if tag in ("a", "link") and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag in ("p", "div", "h1", "h2", "h3", "li", "br", "footer", "section"):
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self.hidden:
            self.hidden -= 1
        if tag in ("p", "div", "h1", "h2", "h3", "li", "footer", "section"):
            self.text.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.text.append(data)

    def content(self):
        return "\n".join(
            line for line in (
                re.sub(r"\s+", " ", line).strip()
                for line in "".join(self.text).splitlines()
            ) if line
        )


class Research:
    def __init__(self, domain, thorough=False, budget=None):
        self.thorough = thorough
        self.budget = STAGE_BUDGET_SECONDS if budget is None else budget
        self.deadline = None
        self.capped = False
        self.lead = next(s for s in batch_input()["selected"] if s["domain"] == domain)
        self.domain = domain
        self.path = ROOT / "domains" / (domain + ".json")
        if self.path.exists():
            self.site = json.loads(self.path.read_text())
        else:
            self.site = dict.fromkeys(FIELDS)
            self.site.update(
                domain=domain, supplied_urls=self.lead.get("supplied_urls", []),
                supplied_url_result=[], url_corrected=False,
                email_obfuscated=False, evidence_quotes=[], evidence_urls=[],
                steps_completed=[], search_log=[], rules=[], example_posts=[],
                candidate_angles=[], checks={}, fetched_text_references=[],
                push_blockers=[], triage_date=datetime.now().astimezone().date().isoformat(),
                research_status="in_progress",
            )
        self.site.setdefault("invitation_candidates", [])
        self.http = requests.Session()
        self.http.headers["User-Agent"] = UA
        self.policies = {}
        self.last_request = {}
        self.blocked = self.site.get("site_access_blocked", False)
        self.unavailable_hosts = {
            urlsplit(e["url"]).netloc
            for e in self.site["search_log"]
            if "NameResolutionError" in e.get("error", "")
        }
        access_failures = [
            e for e in self.site["search_log"]
            if e["result"] in ("access_denied", "challenge", "error")
        ]
        if self.blocked and access_failures and all(
                "NameResolutionError" in e.get("error", "") for e in access_failures):
            self.blocked = False
            self.site["site_access_blocked"] = False
            self.site["host_resolution_note"] = (
                "A DNS-nonexistent www host was not treated as a denial of the live bare host. "
                "No inaccessible content was retrieved; failed host variants are logged without repeated network calls."
            )
            self.checkpoint()

    def checkpoint(self):
        save(self.path, self.site)

    def start_stage(self):
        self.capped = False
        self.deadline = time.monotonic() + self.budget if self.budget and self.budget > 0 else None

    def over_budget(self, wait=0.0):
        if self.deadline is not None and time.monotonic() + wait > self.deadline:
            self.capped = True
        return self.capped

    def capped_entry(self, url, purpose):
        entry = {"url": url, "purpose": purpose, "result": "not_attempted_time_cap",
                 "note": "stage time cap of %.0fs reached (slow host or crawl delay)" % self.budget}
        self.site["search_log"].append(entry)
        self.checkpoint()
        return entry

    def raw(self, url, purpose):
        host = urlsplit(url).netloc
        time.sleep(max(0, self.last_request.get(host, 0) + HOST_SPACING_SECONDS - time.monotonic()))
        entry = {
            "url": url, "purpose": purpose,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            response = self.http.get(url, timeout=TIMEOUT, allow_redirects=False)
        except requests.RequestException as exc:
            entry.update(result="error", error=str(exc))
            self.last_request[host] = time.monotonic()
            self.site["search_log"].append(entry)
            self.checkpoint()
            return entry
        self.last_request[host] = time.monotonic()
        entry.update(status=response.status_code, content_type=response.headers.get("Content-Type"))
        if response.encoding is None or response.encoding == "ISO-8859-1":
            response.encoding = "utf-8"
        raw = response.text
        parser = Page()
        parser.feed(raw)
        text = parser.content()
        key = hashlib.sha256(url.encode()).hexdigest()[:16]
        directory = ROOT / "evidence" / self.domain
        directory.mkdir(parents=True, exist_ok=True)
        html_path = directory / (key + ".html")
        text_path = directory / (key + ".txt")
        html_path.write_text(raw)
        text_path.write_text("URL: " + url + "\nHTTP: " + str(response.status_code) + "\n\n" + text)
        entry.update(
            raw_file=str(html_path.relative_to(ROOT)),
            text_file=str(text_path.relative_to(ROOT)),
            text_characters=len(text),
            links=list(dict.fromkeys(u for u in (safe_join(url, link) for link in parser.links) if u)),
        )
        if response.is_redirect:
            entry.update(result="redirect", location=urljoin(url, response.headers["Location"]))
        elif response.status_code in (401, 403, 429, 451):
            entry["result"] = "access_denied"
        elif response.status_code in (404, 410):
            entry["result"] = "404"
        elif response.status_code >= 400:
            entry["result"] = "error"
        elif re.search(r"just a moment|verify you are human|verifying that you|enable javascript and cookies to continue|checking your browser", text, re.I):
            entry["result"] = "challenge"
        else:
            entry["result"] = "ok"
        self.site["search_log"].append(entry)
        self.site["fetched_text_references"].append(entry["text_file"])
        self.checkpoint()
        return entry

    def policy(self, url):
        origin = urlsplit(url).scheme + "://" + urlsplit(url).netloc
        if origin in self.policies:
            return self.policies[origin]
        robots_url = origin + "/robots.txt"
        prior = next((e for e in self.site["search_log"] if e["url"] == robots_url and e["result"] not in ("local_tool_error", "error")), None)
        entry = prior or self.raw(robots_url, "robots policy")
        if entry["result"] == "error" and not prior:
            entry = self.raw(robots_url, "robots policy (one same-URL transient-error retry)")
        for _ in range(5):
            if entry.get("result") != "redirect":
                break
            target = entry["location"]
            if (urlsplit(target).hostname or "").removeprefix("www.") != self.domain:
                self.policies[origin] = None
                return None
            entry = self.raw(target, "redirected robots policy")
        parser = RobotFileParser()
        if entry.get("status") in (404, 410):
            parser.parse([])
        elif entry.get("result") == "ok":
            raw = (ROOT / entry["raw_file"]).read_text()
            if "<html" in raw.lower() or "<!doctype html" in raw.lower():
                self.policies[origin] = None
                return None
            parser.parse(raw.splitlines())
        else:
            self.policies[origin] = None
            return None
        self.policies[origin] = parser
        return parser

    def fetch(self, url, purpose):
        if urlsplit(url).netloc in self.unavailable_hosts:
            entry = {"url": url, "purpose": purpose, "result": "host_dns_nonexistent"}
            self.site["search_log"].append(entry)
            self.checkpoint()
            return entry
        prior = next((e for e in reversed(self.site["search_log"]) if e.get("url") == url and e.get("purpose") != "robots policy" and e["result"] not in ("local_tool_error", "deferred_by_local_tool_error", "not_attempted_time_cap")), None)
        if prior:
            if prior["result"] == "redirect" and not prior.get("redirect_not_followed"):
                return self.fetch(prior["location"], purpose)
            return prior
        if self.blocked:
            entry = {"url": url, "purpose": purpose, "result": "not_attempted_site_access_blocked"}
            self.site["search_log"].append(entry)
            self.checkpoint()
            return entry
        if self.over_budget():
            return self.capped_entry(url, purpose)
        for _ in range(8):
            policy = self.policy(url)
            if policy is None or not policy.can_fetch(UA, url):
                dns_failed = any(
                    urlsplit(e["url"]).netloc == urlsplit(url).netloc
                    and "NameResolutionError" in e.get("error", "")
                    for e in self.site["search_log"]
                )
                entry = {
                    "url": url, "purpose": purpose,
                    "result": "host_dns_nonexistent" if dns_failed else
                              "robots_unavailable" if policy is None else "robots_blocked",
                }
                self.site["search_log"].append(entry)
                if dns_failed:
                    self.unavailable_hosts.add(urlsplit(url).netloc)
                elif policy is None or not policy.can_fetch(UA, urlsplit(url).scheme + "://" + urlsplit(url).netloc + "/"):
                    self.blocked = True
                    self.site["site_access_blocked"] = True
                self.checkpoint()
                return entry
            delay = policy.crawl_delay(UA) or policy.crawl_delay("*")
            if delay:
                host = urlsplit(url).netloc
                wait = max(0, self.last_request.get(host, 0) + float(delay) - time.monotonic())
                if self.over_budget(wait):
                    return self.capped_entry(url, purpose)
                time.sleep(wait)
            entry = self.raw(url, purpose)
            if entry["result"] == "error":
                entry = self.raw(url, purpose + " (one same-URL transient-error retry)")
            if entry["result"] in ("access_denied", "challenge", "error"):
                self.blocked = True
                self.site["site_access_blocked"] = True
                self.checkpoint()
                return entry
            if entry["result"] != "redirect":
                return entry
            url = entry["location"]
            if not same_site(urlsplit(url).hostname, self.domain):
                entry["redirect_not_followed"] = "external host; requires explicit inspection"
                self.checkpoint()
                return entry
        entry = {"url": url, "purpose": purpose, "result": "redirect_loop",
                 "error": "Redirect chain exceeded safe limit (8 hops)"}
        self.site["search_log"].append(entry)
        self.checkpoint()
        return entry

    # ---- invitation detection -------------------------------------------------

    def homepage_lines(self):
        home = next((e for e in self.site["search_log"]
                     if e.get("purpose") == "Step 0 homepage and footer" and e.get("result") == "ok"
                     and e.get("text_file")), None)
        if not home:
            return None
        return set(body_lines((ROOT / home["text_file"]).read_text()))

    def invitation_signal(self, entry):
        """Return evidence when `entry` is a confirmed invitation page, else None.

        Only used to stop probing early; the verdict is still made by reading the page."""
        if entry.get("result") != "ok" or not entry.get("text_file"):
            return None
        path = urlsplit(entry["url"]).path
        if path.strip("/") == "" or not INVITE_PATH.search(path):
            return None
        boilerplate = self.homepage_lines()
        if boilerplate is None:
            return None
        unique = "\n".join(l for l in body_lines((ROOT / entry["text_file"]).read_text()) if l not in boilerplate)
        negative = NEGATIVE.search(unique)
        if negative:
            self.site.setdefault("closed_signals", [])
            note = {"url": entry["url"], "quote": unique[max(0, negative.start() - 80):negative.end() + 80]}
            if note not in self.site["closed_signals"]:
                self.site["closed_signals"].append(note)
                self.checkpoint()
            return None
        if len(unique) < MIN_UNIQUE_TEXT:
            return None
        positive = POSITIVE.search(unique)
        if not positive or not ROUTE.search(unique):
            return None
        return {"url": entry["url"],
                "quote": unique[max(0, positive.start() - 120):positive.end() + 160],
                "unique_text_characters": len(unique)}

    def note_invitation(self, entry):
        signal = self.invitation_signal(entry)
        if signal and all(c["url"] != signal["url"] for c in self.site["invitation_candidates"]):
            self.site["invitation_candidates"].append(signal)
            self.checkpoint()
        return signal

    def scan_logged_pages(self):
        for entry in list(self.site["search_log"]):
            self.note_invitation(entry)

    # ---- stages ---------------------------------------------------------------

    def seed(self):
        origin0 = os.environ.get("HHT_ORIGIN") or "https://" + self.domain
        home = self.fetch(origin0 + "/", "Step 0 homepage and footer")
        for kind in ("about", "contact"):
            candidates = [
                u for u in home.get("links", [])
                if urlsplit(u).hostname and urlsplit(u).hostname.removeprefix("www.") == self.domain
                and re.search(r"/" + kind + r"(?:[-/.]|$)", urlsplit(u).path, re.I)
            ]
            url = min(candidates, key=len) if candidates else origin0 + "/" + kind
            self.fetch(url, "Step 0 " + kind)
            if self.blocked or self.capped:
                break
        if self.capped:
            self.site["seed_capped"] = True
        self.checkpoint()

    def region(self, value, note=None):
        if value not in ("clear", "unclear", "excluded"):
            raise ValueError("region must be clear, unclear or excluded")
        self.site["region_check"] = value
        if note:
            self.site["region_note"] = note
        self.checkpoint()

    def discover(self):
        if not self.site.get("region_check"):
            raise RuntimeError("Manually finish region pre-screen before invitation research")
        if self.site["region_check"] == "excluded":
            return
        for url in self.lead.get("supplied_urls", []):
            entry = self.fetch(url, "Step 1.1 supplied URL")
            if all(r["url"] != url for r in self.site["supplied_url_result"]):
                self.site["supplied_url_result"].append({"url": url, "result": entry["result"]})
            if self.blocked or self.capped:
                break
        if self.blocked or self.capped:
            self.site["discover_capped"] = self.capped
            self.checkpoint()
            return
        candidates = []
        for entry in list(self.site["search_log"]):
            for url in entry.get("links", []):
                parts = urlsplit(url)
                if (same_site(parts.hostname, self.domain) and KEYWORDS.search(parts.path)
                        and not parts.query and not re.search(r"/feed/|wp-json|wp-content", parts.path)):
                    candidates.append(url.split("#")[0])
        candidates = list(dict.fromkeys(candidates))
        if not self.thorough:
            # Invitation-looking links first, then short nav-style paths; long post slugs last.
            candidates.sort(key=lambda u: (0 if INVITE_PATH.search(urlsplit(u).path) else 1,
                                           len(urlsplit(u).path)))
            self.site["discover_candidates_skipped"] = candidates[MAX_DISCOVER_CANDIDATES:]
            candidates = candidates[:MAX_DISCOVER_CANDIDATES]
        for url in candidates:
            self.fetch(url, "Step 1.2-3 navigation/about/contact/work/advertise candidate")
            if self.blocked or self.capped:
                break
        self.site["discover_capped"] = self.capped
        self.scan_logged_pages()
        self.checkpoint()

    def record_early_stop(self, found_url, skipped_paths, sitemaps_skipped):
        self.site["invitation_search"] = {
            "policy": self.policy_label(),
            "early_stop": {
                "confirmed_invitation_url": found_url,
                "skipped_paths": skipped_paths,
                "sitemaps_skipped": sitemaps_skipped,
                "web_search": "not required while this invitation stands; run it if the page is rejected",
            },
        }
        self.checkpoint()

    def policy_label(self):
        return SEARCH_POLICY_THOROUGH if self.thorough else SEARCH_POLICY

    def variants(self, full=False):
        if not self.site.get("region_check"):
            raise RuntimeError("Region check required")
        if self.site["region_check"] == "excluded" or self.blocked:
            return
        home = next(
            (e for e in self.site["search_log"]
             if e.get("purpose") == "Step 0 homepage and footer" and e["result"] == "ok"), None)
        if home is None:
            self.site["invitation_search"] = {"policy": self.policy_label(),
                                              "stopped": "homepage not readable (error, login or external redirect)"}
            self.checkpoint()
            return
        origin = urlsplit(home["url"]).scheme + "://" + urlsplit(home["url"]).netloc
        paths = PATHS if self.thorough else PATHS_LIGHT
        self.site["canonical_origin"] = origin
        self.site["search_policy"] = self.policy_label()
        self.scan_logged_pages()
        if not full and self.site["invitation_candidates"]:
            self.record_early_stop(self.site["invitation_candidates"][0]["url"], list(paths), True)
            return
        for i, path in enumerate(paths):
            entry = self.fetch(origin + "/" + path, "Step 1.4 canonical meaningful path")
            if self.blocked:
                return
            if self.capped:
                break
            if self.note_invitation(entry) and not full:
                self.record_early_stop(entry["url"], paths[i + 1:], True)
                return
        scope = {} if self.capped else self.crawl_sitemaps(origin, stop_on_invitation=not full)
        self.scan_logged_pages()
        if self.capped:
            self.site["invitation_search"] = {
                "policy": self.policy_label(), "early_stop": None, "full": False,
                "stopped": "time cap %.0fs reached (slow host or robots crawl delay); not a completed search"
                           % self.budget,
            }
            self.checkpoint()
            return
        stopped = scope.get("stopped_at_invitation")
        self.site["invitation_search"] = {
            "policy": self.policy_label(), "early_stop": None, "full": True,
            "sitemap_candidates_fetched": len(scope.get("candidates_fetched", [])),
        }
        if stopped:
            self.site["invitation_search"].update(full=False, early_stop={
                "confirmed_invitation_url": stopped, "skipped_paths": [], "sitemaps_skipped": False,
                "skipped_sitemap_candidates": scope.get("candidates_not_fetched", []),
                "web_search": "not required while this invitation stands; run it if the page is rejected",
            })
        self.checkpoint()

    def research(self, full=False):
        self.discover()
        self.start_stage()
        self.variants(full=full)

    def sitemap_entries(self, entry):
        raw = (ROOT / entry["raw_file"]).read_text()
        if "<html" in raw.lower() or "<!doctype html" in raw.lower():
            entry["sitemap_result"] = "HTML page, not a sitemap"
            return None, []
        try:
            tree = ElementTree.fromstring(raw)
        except ElementTree.ParseError as exc:
            entry["sitemap_parse_error"] = str(exc)
            return None, []
        kind = tree.tag.split("}")[-1]
        urls = [
            urljoin(entry["url"], unescape(node.text.strip()))
            for parent in tree
            if parent.tag.split("}")[-1] in ("url", "sitemap")
            for node in parent
            if node.tag.split("}")[-1] == "loc" and node.text
        ]
        return kind, urls

    def crawl_sitemaps(self, origin, stop_on_invitation=False):
        """Targeted sitemap scan: root endpoints, page/static child maps and
        contributor-related maps only; archives are never enqueued. Only candidate pages
        that look like invitation/contact/about/work pages are fetched, capped per domain."""
        scope = {"roots": [], "followed_child_maps": [], "skipped_child_maps": [],
                 "urls_scanned": 0, "candidates_fetched": [], "candidates_over_cap": 0}
        pending = [origin + "/" + p for p in SITEMAP_ROOTS]
        roots = set(pending)
        seen = set()
        while pending:
            url = pending.pop(0)
            if url in seen:
                continue
            seen.add(url)
            entry = self.fetch(url, "Step 1.5 sitemap" if url in roots else "Step 1.5 targeted child sitemap")
            if url in roots and self.blocked and entry.get("result") == "error" and entry.get("status") == 400:
                # A missing sitemap endpoint answering 400 is not a site-wide denial.
                for e in self.site["search_log"]:
                    if e["url"] == url and e["result"] == "error":
                        e["result"] = "400_endpoint_absent"
                self.blocked = False
                self.site["site_access_blocked"] = False
                self.checkpoint()
                continue
            if self.blocked:
                scope["stopped_blocked"] = True
                break
            if self.capped:
                scope["stopped_time_cap"] = True
                break
            if url in roots:
                scope["roots"].append({"url": url, "result": entry.get("result")})
            if entry.get("result") != "ok":
                continue
            kind, urls = self.sitemap_entries(entry)
            if kind is None:
                continue
            if url in roots and not self.thorough:
                # Light policy: the first readable root sitemap is enough.
                skipped = [p for p in pending if p in roots]
                pending = [p for p in pending if p not in roots]
                scope["roots_skipped"] = skipped
            for u in urls:
                if (urlsplit(u).hostname or "").removeprefix("www.") != self.domain:
                    continue
                if kind == "sitemapindex":
                    limit = None if self.thorough else MAX_CHILD_MAPS_LIGHT
                    if relevant_child_map(u) and (limit is None or len(scope["followed_child_maps"]) < limit):
                        pending.append(u)
                        scope["followed_child_maps"].append(u)
                    else:
                        scope["skipped_child_maps"].append(u)
                else:
                    scope["urls_scanned"] += 1
                    if relevant_page(u) and u not in scope["candidates_fetched"]:
                        scope["candidates_fetched"].append(u)
        # Most specific invitation slugs first, then cap, so an early stop happens as soon as possible.
        cap = MAX_SITEMAP_CANDIDATES if self.thorough else MAX_SITEMAP_CANDIDATES_LIGHT
        ranked = sorted(scope["candidates_fetched"], key=lambda u: 0 if INVITE_PATH.search(urlsplit(u).path) else 1)
        scope["candidates_over_cap"] = max(0, len(ranked) - cap)
        scope["candidates_fetched"] = ranked[:cap]
        for i, u in enumerate(scope["candidates_fetched"]):
            if self.blocked or self.capped:
                break
            entry = self.fetch(u, "Step 1.5 sitemap candidate")
            if stop_on_invitation and self.note_invitation(entry):
                scope["stopped_at_invitation"] = entry["url"]
                scope["candidates_not_fetched"] = scope["candidates_fetched"][i + 1:]
                scope["candidates_fetched"] = scope["candidates_fetched"][:i + 1]
                break
        scope["policy"] = ("targeted sitemap scope: archive/post/tag/category/news/product/numbered child maps and "
                           "non-invitation URLs are scanned or skipped, never fetched.")
        self.site["sitemap_scope"] = scope
        return scope

    # ---- reporting ------------------------------------------------------------

    def needs_search(self):
        """Why the Step 1.6 web searches are still required, or None."""
        if self.site.get("region_check") == "excluded":
            return None
        if self.site["invitation_candidates"] and not self.blocked:
            return None
        if self.blocked:
            return "site access blocked; searches may surface the route"
        search = self.site.get("invitation_search") or {}
        if search.get("stopped"):
            return "on-site probing stopped (%s); searches may surface the route" % search["stopped"]
        if not search.get("full"):
            return "no invitation confirmed yet; path/sitemap probing (variants) not finished"
        return "no confirmed invitation on-site"

    def summary(self, elapsed=None):
        log = self.site["search_log"]
        ok = sum(1 for e in log if e.get("result") == "ok")
        inv = self.site["invitation_candidates"][0]["url"] if self.site["invitation_candidates"] else "-"
        stop = (self.site.get("invitation_search") or {}).get("early_stop")
        parts = [
            self.domain,
            "region=" + str(self.site.get("region_check")),
            "blocked=" + str(bool(self.blocked)),
            "fetched_ok=%d/%d" % (ok, len(log)),
            "invitation=" + inv,
            "early_stop=" + ("yes" if stop else "no"),
        ]
        if self.site.get("closed_signals"):
            parts.append("closed_signal=" + self.site["closed_signals"][0]["url"])
        if elapsed is not None:
            parts.append("%.0fs" % elapsed)
        return " ".join(parts)

    def overview(self):
        print("\nDOMAIN", self.domain, "blocked", self.blocked)
        for entry in self.site["search_log"]:
            print(entry["result"], entry.get("status", ""), entry["url"], entry.get("text_file", ""))
            if entry.get("text_file") and entry.get("result") == "ok":
                text = (ROOT / entry["text_file"]).read_text()
                for line in text.splitlines():
                    if re.search(r"based|live in|living in|born|india|pakistan|guest|contribut|submiss|pitch|accept|not accept|2026|@|closed", line, re.I):
                        print("  ", line[:1100])


def run_one(domain, args):
    start = time.monotonic()
    research = Research(domain, thorough=args.thorough, budget=args.budget)
    research.start_stage()
    if args.mode == "fetch":
        entry = research.fetch(args.url, "Explicit source verification")
        research.note_invitation(entry)
    elif args.mode == "region":
        research.region(args.set, args.note)
    elif args.mode in ("variants", "research"):
        getattr(research, args.mode)(full=args.full)
    elif args.mode in ("seed", "discover"):
        getattr(research, args.mode)()
    return research, time.monotonic() - start


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("seed", "region", "discover", "variants", "research",
                                         "needs-search", "fetch", "overview"))
    parser.add_argument("domains", nargs="*", help="defaults to every domain in batch-input.json")
    parser.add_argument("--url")
    parser.add_argument("--set", choices=("clear", "unclear", "excluded"))
    parser.add_argument("--note")
    parser.add_argument("--full", action="store_true", help="disable early stop (required before SKIP_NO_INVITATION if a candidate was rejected)")
    parser.add_argument("--jobs", type=int, default=8, help="domains processed in parallel (each host is still spaced)")
    parser.add_argument("--thorough", action="store_true", help="every playbook path, all root sitemaps, two web searches")
    parser.add_argument("--budget", type=float, default=STAGE_BUDGET_SECONDS,
                        help="seconds per domain per stage before the slow-site cap (0 disables)")
    args = parser.parse_args(argv)
    if args.mode == "fetch" and not args.url:
        parser.error("fetch requires --url")
    if args.mode == "region" and not args.set:
        parser.error("region requires --set")
    domains = args.domains or [s["domain"] for s in batch_input()["selected"]]

    if args.mode == "overview":
        for d in domains:
            Research(d).overview()
        return 0
    if args.mode == "needs-search":
        rows = []
        for d in domains:
            reason = Research(d).needs_search()
            if reason:
                queries = ["site:%s write for us OR guest post OR contribute OR submissions" % d]
                if args.thorough:
                    queries.append("%s guest post guidelines" % d)
                rows.append({"domain": d, "reason": reason, "queries": queries})
                print(d, "|", reason)
        save(ROOT / "needs-search.json", {"generated_at": datetime.now().astimezone().isoformat(), "domains": rows})
        print("%d of %d domains need the Step 1.6 web search" % (len(rows), len(domains)))
        return 0

    failures = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(run_one, d, args): d for d in domains}
        for future in as_completed(futures):
            domain = futures[future]
            try:
                research, elapsed = future.result()
                print(research.summary(elapsed), flush=True)
            except Exception as exc:  # report per domain, keep the batch going
                failures += 1
                print("%s ERROR %s: %s" % (domain, type(exc).__name__, exc), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
