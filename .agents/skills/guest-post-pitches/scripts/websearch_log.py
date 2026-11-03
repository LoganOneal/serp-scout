"""Record Step 1.6 web-search outcomes in <batch>/websearch_log.json.

  websearch_log.py add <domain> [same-domain URLs...] [--note TEXT] [--site-operator-failed]
  websearch_log.py skipped <domain> --invitation URL

`skipped` documents that the searches were not run because research_tools.py
confirmed an invitation page on-site (early stop). Only same-domain result URLs
are recorded as citations.
"""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(os.environ.get("HHT_BATCH_DIR") or os.getcwd()).resolve()
LOG = ROOT / "websearch_log.json"


def queries(domain, thorough=False):
    q = [f"site:{domain} write for us OR guest post OR contribute OR submissions"]
    return q + [f"{domain} guest post guidelines"] if thorough else q


def write(domain, record):
    data = json.loads(LOG.read_text()) if LOG.exists() else {}
    record["recorded_at"] = datetime.now().astimezone().isoformat()
    data[domain] = record
    tmp = LOG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(LOG)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=("add", "skipped"))
    p.add_argument("domain")
    p.add_argument("urls", nargs="*")
    p.add_argument("--note")
    p.add_argument("--invitation")
    p.add_argument("--site-operator-failed", action="store_true")
    p.add_argument("--thorough", action="store_true", help="both playbook queries were run")
    a = p.parse_args(argv)
    if a.action == "skipped":
        if not a.invitation:
            p.error("skipped requires --invitation URL")
        write(a.domain, {"status": "not_run_invitation_confirmed_on_site",
                         "invitation_url": a.invitation, "note": a.note})
    else:
        cited = [u for u in a.urls
                 if (urlsplit(u).hostname or "").lower().removeprefix("www.") == a.domain
                 or (urlsplit(u).hostname or "").lower().endswith("." + a.domain)]
        write(a.domain, {"status": "run", "tool": "web_search", "queries": queries(a.domain, a.thorough),
                         "same_domain_citations": cited,
                         "site_operator_failed": a.site_operator_failed, "note": a.note})
    print(a.domain, a.action)


if __name__ == "__main__":
    main()
