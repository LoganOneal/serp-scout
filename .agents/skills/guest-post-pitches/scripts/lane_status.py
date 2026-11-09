"""Summarize lane progress for a parallel run (parent session uses this instead of messages).

  lane_status.py <batch dir or glob> [...]
  e.g. lane_status.py exports/guest-post-outreach/HHT-run-2026-10-24-B*

Reads each batch's progress.json and flags lanes whose updated_at is older
than --stale minutes (default 20) and not finished.
"""
import argparse
import glob
import json
from datetime import datetime, timezone
from pathlib import Path

DONE = {"ready_for_run_push", "committed", "complete", "completed", "done"}


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("paths", nargs="+")
    p.add_argument("--stale", type=float, default=20)
    a = p.parse_args(argv)
    dirs = sorted({Path(x).resolve() for pat in a.paths for x in (glob.glob(pat) or [pat]) if Path(x).is_dir()})
    now = datetime.now(timezone.utc)
    totals = {"finalized_domains": 0, "pitches_drafted": 0, "outreach_created": 0}
    for d in dirs:
        f = d / "progress.json"
        if not f.exists():
            print(f"{d.name}: no progress.json yet")
            continue
        pr = json.loads(f.read_text())
        for k in totals:
            totals[k] += int(pr.get(k) or 0)
        age = None
        if pr.get("updated_at"):
            age = (now - datetime.fromisoformat(pr["updated_at"]).astimezone(timezone.utc)).total_seconds() / 60
        stage = pr.get("current_stage", "?")
        flag = ""
        if stage not in DONE and age is not None and age > a.stale:
            flag = f"  STALE ({age:.0f} min since update)"
        if pr.get("blocker"):
            flag += "  BLOCKER: " + str(pr["blocker"])
        print(f"{d.name}: stage={stage} finalized={pr.get('finalized_domains', 0)}/{pr.get('total_domains', '?')} "
              f"pitches={pr.get('pitches_drafted', 0)} outreach={pr.get('outreach_created', 0)}"
              + (f" updated={age:.0f}m ago" if age is not None else "") + flag)
    print("TOTAL", json.dumps(totals))


if __name__ == "__main__":
    main()
