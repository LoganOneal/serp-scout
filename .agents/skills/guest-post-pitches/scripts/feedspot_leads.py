"""Turn Feedspot "Top N blogs" lists into guest-post leads (no Semrush).

Feedspot ranks active blogs per topic and place (bloggers.feedspot.com/<slug>/), and
every entry is a live blog: the kind of site that most often takes a guest post.

  feedspot_leads.py [<slug or list URL>...] [--defaults] [--html FILE...] [--out PATH]

  <slug>      e.g. travel_blogs, texas_travel_blogs, couple_travel_blogs
  --defaults  the curated travel/lifestyle list set in DEFAULT_LISTS
  --html      parse saved Feedspot pages instead of fetching (tests, blocked fetches)

Writes exports/handoff/hht-guest-feedspot-<date>.csv in the handoff format, ready for
`run_tools.py prepare` (which applies the prefilter and the tracker exclusions, so
blogs already evaluated are skipped there). Only the blog link of each entry is read
(Feedspot marks it `class="ext ..."`); the blog's social profiles are ignored.
Free blog hosts (blogspot, wordpress.com, substack) are kept per subdomain.
"""
import argparse
import csv
import re
import sys
import time
import urllib.request
from collections import Counter, OrderedDict
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

SCRIPTS = Path(__file__).resolve().parent
HANDOFF = SCRIPTS.parents[3] / "exports" / "handoff"
BASE = "https://bloggers.feedspot.com/{}/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124 Safari/537.36")

# Lists that match Claire's lane: U.S. travel, couples, romance, road trips, luxury and
# hotels, plus the travel lists for the states with the most hotel hot tub inventory.
# Checked 2026-11-10; a slug Feedspot does not have (404) is reported and skipped.
DEFAULT_LISTS = [
    "travel_blogs", "usa_travel_blogs", "couple_travel_blogs", "road_trip_blogs",
    "travel_lifestyle_blogs", "honeymoon_blogs", "glamping_blogs",
    "california_travel_blogs", "texas_travel_blogs", "florida_travel_blogs",
    "new_york_travel_blogs", "colorado_travel_blogs", "arizona_travel_blogs",
    "north_carolina_travel_blogs", "tennessee_travel_blogs", "michigan_travel_blogs",
    "oregon_travel_blogs", "virginia_travel_blogs", "hawaii_travel_blogs",
]

ENTRY = re.compile(r'<a[^>]*class="ext[^"]*"[^>]*href="(https?://[^"]+)"|<a[^>]*href="(https?://[^"]+)"[^>]*class="ext[^"]*"')
SOCIAL = re.compile(
    r"(^|\.)(feedspot|facebook|instagram|twitter|x|pinterest|linkedin|youtube|tiktok|threads|reddit|"
    r"amazon|apple|google|spotify)\.", re.I)
PER_SUBDOMAIN_HOSTS = ("substack.com", "blogspot.com", "wordpress.com")
# Tourism boards (visitX.com, Xtourism.org, iloveny.com) sit on the state lists but never
# take guest posts: 7 of the 57 pilot leads on 2026-11-10, all SKIP.
TOURISM_BOARD = re.compile(
    r"^visit[a-z-]+\.(com|org|net|us)$|tourism|cvb|\.gov$|^iloveny\.com$|"
    r"^(travel|explore|discover|see)(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|newhampshire|newjersey|newmexico|newyork|northcarolina|northdakota|ohio|oklahoma|oregon|pennsylvania|rhodeisland|southcarolina|southdakota|tennessee|texas|utah|vermont|virginia|washington|westvirginia|wisconsin|wyoming|monterey)\.(com|org|net|us)$", re.I)


def host(url):
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def registrable(hostname):
    if any(hostname.endswith("." + h) for h in PER_SUBDOMAIN_HOSTS):
        return hostname
    parts = hostname.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "ac", "gov"):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def slug_of(target):
    if target.startswith("http"):
        return urlsplit(target).path.strip("/").split("/")[0] or "feedspot"
    return target.strip("/")


def fetch(slug):
    req = urllib.request.Request(BASE.format(slug), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as resp:
        return resp.read().decode("utf-8", "replace")


def entries(html):
    """Blog URLs in rank order."""
    out = []
    for match in ENTRY.finditer(html):
        url = (match.group(1) or match.group(2)).strip()
        if url not in out:
            out.append(url)
    return out


def build(pages):
    """pages: [(slug, html)] -> (leads, dropped)."""
    leads, dropped = OrderedDict(), Counter()
    for slug, html in pages:
        urls = entries(html)
        if not urls:
            dropped["empty_list"] += 1
        for rank, url in enumerate(urls, 1):
            h = host(url)
            if not h or SOCIAL.search(h + "."):
                dropped["social_or_platform"] += 1
                continue
            domain = registrable(h)
            if TOURISM_BOARD.search(domain):
                dropped["tourism_board"] += 1
                continue
            lead = leads.setdefault(domain, {"domain": domain, "urls": [], "lists": [], "best_rank": rank})
            lead["urls"].append(url)
            lead["lists"].append(slug)
            lead["best_rank"] = min(lead["best_rank"], rank)
    return leads, dropped


def write(leads, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["domain", "opportunity_url", "all_urls", "source_query", "bucket", "lead_type", "score",
              "best_position", "query_hits", "batch_id"]
    with out.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        ranked = sorted(leads.values(), key=lambda x: (-len(set(x["lists"])), x["best_rank"]))
        for lead in ranked:
            urls = list(dict.fromkeys(lead["urls"]))
            lists = list(dict.fromkeys(lead["lists"]))
            writer.writerow({"domain": lead["domain"], "opportunity_url": urls[0], "all_urls": "|".join(urls[:5]),
                             "source_query": "feedspot:" + ",".join(lists[:3]), "bucket": "feedspot",
                             "lead_type": "guest_post", "score": max(1, 101 - lead["best_rank"]),
                             "best_position": lead["best_rank"], "query_hits": len(lists), "batch_id": out.stem})


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("lists", nargs="*")
    p.add_argument("--defaults", action="store_true")
    p.add_argument("--html", nargs="*", default=[])
    p.add_argument("--out")
    p.add_argument("--delay", type=float, default=2.0, help="seconds between Feedspot fetches")
    a = p.parse_args(argv)
    targets = list(dict.fromkeys(a.lists + (DEFAULT_LISTS if a.defaults else [])))
    if not targets and not a.html:
        p.error("name at least one list, --defaults or --html")
    pages, missing = [], []
    for path in a.html:
        pages.append((Path(path).stem, Path(path).read_text(errors="replace")))
    for i, target in enumerate(targets):
        slug = slug_of(target)
        if i:
            time.sleep(a.delay)
        try:
            pages.append((slug, fetch(slug)))
        except Exception as error:  # 404 for a list Feedspot does not have, or a block
            missing.append(f"{slug}: {error}")
    leads, dropped = build(pages)
    out = Path(a.out) if a.out else HANDOFF / f"hht-guest-feedspot-{date.today().isoformat()}.csv"
    write(leads, out)
    print({"lists": len(pages), "missing": missing, "leads": len(leads), "dropped": dict(dropped), "out": str(out)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
