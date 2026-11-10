"""Drop guest-post leads that almost never take outside writers, before any research.

Evidence (Kai, 2026-11-09): of 1,787 SERP leads evaluated 2026-11-08..09, the `weddings`
bucket plus business-type domain names (photographers, venues, hotels, tours, rentals,
studios) were 491 leads and produced zero PURSUE verdicts. Publication-looking names
(mag, news, journal, post, press, guide...) are always kept.

Used by `run_tools.py prepare` (skip with --no-prefilter). Standalone:
  prefilter.py <csv>...      print what would be dropped and why
"""
import csv
import re
import sys
from collections import Counter

BUSINESS_NAME = re.compile(
    r"photo|wedding|elope|venue|resort|hotel|lodge|tours?\b|cabins?|rental|chapel|events?\b|studio|realty|homes\b",
    re.I)
PUBLICATION_NAME = re.compile(
    r"mag\b|magazine|news|journal|times|post\b|press|gazette|tribune|herald|weekly|daily|citypaper|guide",
    re.I)
DROP_BUCKETS = {"weddings"}


def reason(domain, row=None):
    """Return why `domain` should be dropped, or None to keep it."""
    domain = (domain or "").lower()
    if PUBLICATION_NAME.search(domain):
        return None
    bucket = ((row or {}).get("bucket") or "").strip().lower()
    if bucket in DROP_BUCKETS:
        return "prefilter_bucket_" + bucket
    if BUSINESS_NAME.search(domain):
        return "prefilter_business_name"
    return None


def main(argv):
    counts, dropped = Counter(), []
    for path in argv:
        with open(path, newline="") as handle:
            for row in csv.DictReader(handle):
                why = reason(row.get("domain"), row)
                counts[why or "kept"] += 1
                if why:
                    dropped.append((row.get("domain"), why))
    for domain, why in dropped:
        print(domain, why)
    print(dict(counts))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
