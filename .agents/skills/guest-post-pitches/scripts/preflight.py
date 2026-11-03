"""Read-only outreach preflight: GET campaigns and confirm "guest post outreach" step 1.

Credential: GENERATOR_SECRET, or a file named by GENERATOR_SECRET_FILE that is
readable only by its owner (mode 0600). The token is never printed or saved.
Writes <batch>/outreach-preflight.json.
"""
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(os.environ.get("HHT_BATCH_DIR") or os.getcwd()).resolve()
BASE = "https://outreach-ten-plum.vercel.app"


def token():
    if os.environ.get("GENERATOR_SECRET"):
        return os.environ["GENERATOR_SECRET"], "env"
    path = os.environ.get("GENERATOR_SECRET_FILE")
    if not path:
        sys.exit("No GENERATOR_SECRET or GENERATOR_SECRET_FILE; push nothing and report the blocker.")
    if stat.S_IMODE(os.stat(path).st_mode) & 0o077:
        sys.exit("GENERATOR_SECRET_FILE must not be group/world readable.")
    return Path(path).read_text().strip(), "protected file"


def main():
    tok, source = token()
    r = requests.get(BASE + "/api/generator/campaigns?include=paused",
                     headers={"Authorization": "Bearer " + tok}, timeout=30)
    pre = {"checked_at": datetime.now(timezone.utc).isoformat(), "credential_source": source,
           "http_status": r.status_code, "matches": []}
    if r.status_code == 200:
        body = r.json()
        campaigns = body.get("campaigns", body) if isinstance(body, dict) else body
        for c in campaigns:
            if str(c.get("name", "")).strip().lower() == "guest post outreach":
                steps = [(s.get("step_number") or s.get("step")) for s in c.get("steps", [])]
                pre["matches"].append({"id": c["id"], "name": c["name"], "status": c.get("status"),
                                       "steps": steps, "step1_present": any(str(s) == "1" for s in steps)})
    pre["ready"] = any(m["step1_present"] for m in pre["matches"])
    (ROOT / "outreach-preflight.json").write_text(json.dumps(pre, indent=2) + "\n")
    print(json.dumps(pre))
    return 0 if pre["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
