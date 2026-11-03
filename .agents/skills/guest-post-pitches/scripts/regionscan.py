"""Print region-signal snippets (Step 0) from fetched evidence for each domain.

Run from the batch directory or set HHT_BATCH_DIR. Hits are hints for the
region decision, never a verdict on their own.
"""
import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("HHT_BATCH_DIR") or os.getcwd()).resolve()
PAT = re.compile(r"india|pakistan|mumbai|delhi|bengal|bangalore|bengaluru|\+91|\+92|₹|\bINR\b|\bPKR\b|\bRs\.? ?\d|pvt|"
                 r"private limited|\bLLP\b|karachi|lahore|islamabad|kerala|karnataka|jaipur|\bgoa\b", re.I)
CC_TLD = re.compile(r"\.(?:co\.|net\.|org\.|firm\.|gen\.|ind\.)?in$|\.(?:com\.|org\.|net\.|edu\.|gov\.)?pk$", re.I)

for f in sorted((ROOT / "domains").glob("*.json")):
    d = json.loads(f.read_text())
    counts, hits = {}, []
    for e in d["search_log"]:
        counts[e["result"]] = counts.get(e["result"], 0) + 1
        if e.get("text_file") and e["result"] == "ok":
            t = (ROOT / e["text_file"]).read_text()
            for m in PAT.finditer(t):
                hits.append(t[max(0, m.start() - 50):m.end() + 50].replace("\n", " "))
    flags = []
    if CC_TLD.search(d["domain"]):
        flags.append("EXCLUDED_TLD")
    if d.get("site_access_blocked"):
        flags.append("blocked")
    print(d["domain"], "region=" + str(d.get("region_check")), counts, " ".join(flags))
    for h in hits[:3]:
        print("   REGION?", h)
