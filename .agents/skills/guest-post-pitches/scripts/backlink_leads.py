"""Turn a competitor's Semrush backlinks export into guest-post leads.

Sites that already link to a successful travel site from an article are proven
publishers in the niche, and the linking article is good evidence for the pitch.
Pull the rows through the Semrush MCP only (`execute_report("backlinks", {"target":
<competitor>, "target_type": "root_domain", "export_columns": ["page_authority_score",
"source_url", "source_title", "anchor", "nofollow"], ...})`) and save each response's
`data` CSV text to a file. Then:

  backlink_leads.py <competitor> <saved.csv>... [--min-ascore 10] [--out PATH]

Writes exports/handoff/hht-guest-backlinks-<competitor>-<date>.csv in the handoff
format, ready for `run_tools.py prepare` (which also applies the prefilter and the
tracker exclusions). Dropped here, with counts printed:
  - the competitor itself and its subdomains
  - OTAs, review platforms, social and link-farm hosts
  - homepage or sitewide links (hotel "as featured in" badges, footers)
  - hotel/booking pages (titles or paths about rooms, rates, booking, a property)
  - pages under --min-ascore
  - nofollow links (Kai, 2026-11-09: only dofollow links have value; a dofollow link to a
    competitor is the best evidence a site gives dofollow links). Pull with
    display_filter [{"field": "type", "operation": "", "value": "follow", "sign": "+"}]
    so nofollow rows are never paid for; --keep-nofollow disables this check.
"""
import argparse
import csv
import io
import re
import sys
from collections import Counter, OrderedDict
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

SCRIPTS = Path(__file__).resolve().parent
HANDOFF = SCRIPTS.parents[3] / "exports" / "handoff"

PLATFORMS = re.compile(
    r"(^|\.)(booking|expedia|hotels|laterooms|tripadvisor|trivago|kayak|agoda|snaptrip|airbnb|vrbo|"
    r"facebook|instagram|twitter|x|pinterest|linkedin|youtube|tiktok|reddit|quora|medium|wikipedia|"
    r"blogspot|wordpress|tumblr|issuu|scribd|slideshare|yelp|google|bing|yahoo|amazon|ebay)\.",
    re.I)
HOTEL_PAGE = re.compile(
    r"\b(book (now|direct)|rooms? (&|and) suites|our rooms|room rates|check availability|bed (&|and) breakfast|"
    r"b&b|boutique hotel\b|hotel & spa|resort & spa|self[- ]catering|holiday cottages?|accommodation in)\b|"
    r"/(rooms?|suites?|booking|book|reservations?|hotels?/[^/]+-[a-z]\d+)/", re.I)


def host(url):
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


# Hosts where each subdomain is its own publication (a Substack newsletter is not substack.com).
PER_SUBDOMAIN_HOSTS = ("substack.com",)


def registrable(hostname):
    if any(hostname.endswith("." + h) for h in PER_SUBDOMAIN_HOSTS):
        return hostname
    parts = hostname.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "ac", "gov"):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def rows_from(path):
    text = Path(path).read_text()
    delim = ";" if text.splitlines()[0].count(";") >= text.splitlines()[0].count(",") else ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delim))


def drop_reason(row, competitor, min_ascore, keep_nofollow=False):
    url = (row.get("source_url") or "").strip()
    if not url.startswith("http"):
        return "no_source_url"
    if not keep_nofollow and str(row.get("nofollow", "")).strip().lower() in ("true", "1", "yes"):
        return "nofollow"
    h = host(url)
    if h == competitor or h.endswith("." + competitor):
        return "competitor_itself"
    if PLATFORMS.search(h + "."):
        return "platform"
    path = urlsplit(url).path.strip("/")
    if not path:
        return "homepage_or_sitewide"
    if HOTEL_PAGE.search((row.get("source_title") or "") + " /" + path + "/"):
        return "hotel_or_booking_page"
    try:
        score = int(float(row.get("page_ascore") or row.get("page_authority_score") or 0))
    except ValueError:
        score = 0
    if score < min_ascore:
        return "low_page_ascore"
    return None


def build(competitor, paths, min_ascore, keep_nofollow=False):
    competitor = competitor.lower().removeprefix("www.")
    leads, dropped = OrderedDict(), Counter()
    for path in paths:
        for row in rows_from(path):
            why = drop_reason(row, competitor, min_ascore, keep_nofollow)
            if why:
                dropped[why] += 1
                continue
            domain = registrable(host(row["source_url"]))
            score = int(float(row.get("page_ascore") or row.get("page_authority_score") or 0))
            lead = leads.setdefault(domain, {"domain": domain, "urls": [], "score": 0, "hits": 0})
            lead["urls"].append(row["source_url"].strip())
            lead["score"] = max(lead["score"], score)
            lead["hits"] += 1
    return leads, dropped


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("competitor")
    p.add_argument("exports", nargs="+")
    p.add_argument("--min-ascore", type=int, default=10)
    p.add_argument("--out")
    p.add_argument("--keep-nofollow", action="store_true")
    a = p.parse_args(argv)
    leads, dropped = build(a.competitor, a.exports, a.min_ascore, a.keep_nofollow)
    slug = re.sub(r"[^a-z0-9]+", "-", a.competitor.lower()).strip("-")
    out = Path(a.out) if a.out else HANDOFF / f"hht-guest-backlinks-{slug}-{date.today().isoformat()}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["domain", "opportunity_url", "all_urls", "source_query", "bucket", "lead_type", "score",
              "best_position", "query_hits", "batch_id"]
    with out.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for lead in sorted(leads.values(), key=lambda x: -x["score"]):
            urls = list(dict.fromkeys(lead["urls"]))
            writer.writerow({"domain": lead["domain"], "opportunity_url": urls[0], "all_urls": "|".join(urls[:5]),
                             "source_query": f"backlink:{a.competitor}", "bucket": "backlinks",
                             "lead_type": "guest_post", "score": lead["score"], "best_position": "",
                             "query_hits": lead["hits"], "batch_id": out.stem})
    print({"leads": len(leads), "dropped": dict(dropped), "out": str(out)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
