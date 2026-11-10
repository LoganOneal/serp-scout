"""Run every batch of a guest-post run through the scripted research steps in parallel.

The per-batch chain used to run one batch at a time, and each step waited on the agent.
This runs the scripted parts for all batches at once and writes plans that let the
agent fan out the model work (web search, Haiku) in parallel.

  run_pipeline.py research <run>   seed, region, discover, variants and gated needs-search
                                   for every pending batch, --parallel batches at a time;
                                   writes <run>/search-plan.json (domains split into
                                   chunks for parallel search agents)
  run_pipeline.py prep <run>       classify_batch prep for every pending batch; writes
                                   <run>/haiku-plan.json (one entry per Haiku prompt)
  run_pipeline.py finish <run>     for every batch whose Haiku results are all present:
                                   null-route fix, merge, apply; prints PURSUE sites
  run_pipeline.py status <run>     one line per batch

<run> is a run id (HHT-serp-eval-2026-11-09g) or its directory.
"""
import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
EXPORTS = SCRIPTS.parents[3] / "exports" / "guest-post-outreach"
PY = sys.executable


def run_dir(value):
    path = Path(value)
    return path.resolve() if path.is_dir() else EXPORTS / value


def batches(run, include_completed=False):
    state = json.loads((run / "run.json").read_text())
    return [EXPORTS / b["id"] for b in state["batches"]
            if include_completed or b.get("status") != "completed"]


def sh(args, cwd, log):
    with open(cwd / log, "w") as handle:
        return subprocess.run(args, cwd=cwd, stdout=handle, stderr=subprocess.STDOUT).returncode


def research_one(batch, jobs):
    rt, cb = str(SCRIPTS / "research_tools.py"), str(SCRIPTS / "classify_batch.py")
    steps = [
        ([PY, rt, "seed", "--browser", "--jobs", str(jobs)], "seed.log"),
        ([PY, cb, "region", str(batch)], "region.log"),
        ([PY, rt, "discover", "--browser", "--jobs", str(jobs)], "discover.log"),
        ([PY, rt, "variants", "--browser", "--jobs", str(jobs)], "variants.log"),
        ([PY, rt, "needs-search"], "needs-search.log"),
    ]
    for args, log in steps:
        if (batch / "haiku" / "prep.json").exists():
            break
        code = sh(args, batch, log)
        if code and log not in ("seed.log", "discover.log", "variants.log"):
            return batch.name, f"failed at {log} (exit {code})"
    data = json.loads((batch / "needs-search.json").read_text())
    return batch.name, f"{len(data['domains'])} to search, {len(data.get('gated_out', []))} gated out"


def research(run, parallel, jobs, chunk):
    todo = batches(run)
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        for name, line in pool.map(lambda b: research_one(b, jobs), todo):
            print(name, line, flush=True)
    queue = []
    for batch in todo:
        path = batch / "needs-search.json"
        if path.exists():
            for row in json.loads(path.read_text())["domains"]:
                queue.append({"batch": str(batch), "domain": row["domain"]})
    chunks = [queue[i:i + chunk] for i in range(0, len(queue), chunk)]
    plan = {"total_domains": len(queue), "chunks": chunks}
    (run / "search-plan.json").write_text(json.dumps(plan, indent=1))
    print(f"search plan: {len(queue)} domains in {len(chunks)} chunks -> {run / 'search-plan.json'}")


def prep(run):
    prompts = []
    for batch in batches(run):
        code = sh([PY, str(SCRIPTS / "classify_batch.py"), "prep", str(batch)], batch, "prep.log")
        first = (batch / "prep.log").read_text().splitlines()[:1]
        print(batch.name, first[0] if first else f"exit {code}")
        prompts += sorted(str(p) for p in (batch / "haiku").glob("prompt-*.txt"))
    (run / "haiku-plan.json").write_text(json.dumps({"prompts": prompts}, indent=1))
    print(f"haiku plan: {len(prompts)} prompts -> {run / 'haiku-plan.json'}")


def results_ready(batch):
    haiku = batch / "haiku"
    if not (haiku / "prep.json").exists():
        return False
    report = json.loads((haiku / "prep.json").read_text())
    return all((haiku / "results" / f"batch-{nn}.jsonl").exists() for nn in report["batches"])


def finish(run):
    cb = str(SCRIPTS / "classify_batch.py")
    for batch in batches(run):
        if not results_ready(batch):
            print(batch.name, "waiting for Haiku results")
            continue
        for path in (batch / "haiku" / "results").glob("*.jsonl"):
            text = path.read_text()
            fixed = re.sub(r'"route":\s*null', '"route": "none"', text)
            if fixed != text:
                path.write_text(fixed)
        out = []
        for cmd in ("merge", "apply"):
            proc = subprocess.run([PY, cb, cmd, str(batch)], capture_output=True, text=True)
            out.append((proc.stdout + proc.stderr).strip().splitlines()[-1:] or [""])
            if proc.returncode:
                print(batch.name, cmd, "FAILED:", (proc.stdout + proc.stderr).strip()[-600:])
                break
        else:
            print(batch.name, " | ".join(line[0] for line in out))


def status(run):
    for batch in batches(run, include_completed=True):
        state = []
        for name in ("needs-search.json", "websearch_log.json", "haiku/prep.json", "haiku-results.json",
                     "tracker-rows.json"):
            state.append(("+" if (batch / name).exists() else "-") + name.split("/")[-1].split(".")[0])
        state.append("results-ready" if results_ready(batch) else "results-missing")
        print(batch.name, " ".join(state))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=("research", "prep", "finish", "status"))
    p.add_argument("run")
    p.add_argument("--parallel", type=int, default=6, help="batches researched at the same time")
    p.add_argument("--jobs", type=int, default=8, help="domains per batch fetched in parallel")
    p.add_argument("--chunk", type=int, default=40, help="domains per web-search agent")
    a = p.parse_args(argv)
    run = run_dir(a.run)
    if a.cmd == "research":
        research(run, a.parallel, a.jobs, a.chunk)
    elif a.cmd == "prep":
        prep(run)
    elif a.cmd == "finish":
        finish(run)
    else:
        status(run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
