"""Consolidate all ready lanes into the minimum number of draft-create requests.

Usage: python3 push_run_drafts.py <run dir>
No prospect sending, approvals, replacements or automatic retries.
"""
import json
import re
import sys
from pathlib import Path

import push_drafts
import run_tools as tools

PENDING = "Awaiting consolidated push"


def collect(run):
    manifest = tools.read_json(run / "run.json")
    lanes, payloads, domains, emails = [], [], set(), set()
    for batch in manifest["batches"]:
        directory, expected = tools.batch_paths(run, batch["id"])
        if (directory / "outreach-post-attempt.json").exists():
            raise ValueError(f"{batch['id']}: prior lane attempt; reconcile instead.")
        progress = tools.read_json(directory / "progress.json")
        if progress["current_stage"] != "ready_for_run_push":
            raise ValueError(f"{batch['id']}: not ready for consolidated upload.")
        rows, _ = tools.validate(directory, batch["id"], expected)
        for filename in ("summary.json", "timing.json"):
            if not isinstance(tools.read_json(directory / filename), dict):
                raise ValueError(f"{batch['id']}: {filename} must be an object.")
        if tools.read_json(directory / "outreach-outcomes.json"):
            raise ValueError(f"{batch['id']}: existing outcomes; reconcile instead.")
        sites = {s["domain"]: s for s in tools.read_json(directory / "research.json")["sites"]}
        by_domain = {row["site"]: row for row in rows}
        payload = tools.read_json(directory / "outreach-payload.json")
        markdown = (directory / "drafts.md").read_text()
        for draft in payload:
            domain = draft["contact"]["attributes"]["domain"]
            email = draft["contact"]["email"].strip().lower()
            site, row = sites[domain], by_domain[domain]
            if domain in domains or email in emails:
                raise ValueError(f"{domain}: cross-lane duplicate domain or email.")
            if (site["verdict"] != "PURSUE" or site["submission_stage"] != "pitch-first"
                    or site["region_check"] == "excluded" or site.get("push_blockers")
                    or site.get("hotel_operator") or row["outreach_status"] != PENDING
                    or row.get("outreach_email_id")):
                raise ValueError(f"{domain}: ineligible staged draft.")
            note = draft.get("reviewer_note")
            if (draft.get("campaign_id") != push_drafts.expected_campaign(draft) or draft.get("step_number") != 1
                    or "@" not in email or not isinstance(note, str) or not 0 < len(note.strip()) <= 4000
                    or note != row["requirements_note"] or not draft.get("subject") or not draft.get("body")
                    or push_drafts.fiction_note_error(draft["body"])
                    or draft["subject"] not in markdown or draft["body"] not in markdown):
                raise ValueError(f"{domain}: invalid payload or local-copy mismatch.")
            section = next((s for s in re.split(r"(?m)(?=^## )", markdown)
                            if s.startswith(f"## {domain}\n")), "")
            if f"Routing status: {PENDING}" not in section:
                raise ValueError(f"{domain}: missing staged Markdown routing line.")
            domains.add(domain)
            emails.add(email)
        if {row["site"] for row in rows if row["outreach_status"] == PENDING} != {
                draft["contact"]["attributes"]["domain"] for draft in payload}:
            raise ValueError(f"{batch['id']}: staged rows and payload disagree.")
        lanes.append((directory, rows, payload))
        payloads.extend(payload)
    return lanes, payloads


def distribute(lanes, outcomes):
    for directory, rows, payload in lanes:
        local = {draft["contact"]["attributes"]["domain"]: outcomes[
            draft["contact"]["attributes"]["domain"]] for draft in payload}
        statuses = {}
        for row in rows:
            domain = row["site"]
            if domain not in local:
                continue
            result = local[domain]
            if result.get("ok") and result.get("outcome") == "created" and result.get("email_id"):
                status = "Draft in outreach tool"
                row["outreach_email_id"] = result["email_id"]
            elif result.get("error") in ("Already has a live draft for this step", "Already enrolled in this campaign"):
                status = "Duplicate (live draft already in outreach tool; not overwritten)"
            else:
                status = "Not pushed (tool unreachable)" if result.get("outcome") in ("uncertain", "no_result", "not_attempted") else "Not pushed"
                row["notes"] = (row.get("notes") or "") + f" Consolidated upload: {result.get('error') or result.get('outcome')}."
            row["outreach_status"] = status
            statuses[domain] = status
        markdown = (directory / "drafts.md").read_text()
        sections = re.split(r"(?m)(?=^## )", markdown)
        for index, section in enumerate(sections):
            domain = section.splitlines()[0][3:] if section.startswith("## ") else None
            if domain in statuses:
                sections[index] = section.replace(f"Routing status: {PENDING}", f"Routing status: {statuses[domain]}", 1)
        (directory / "drafts.md").write_text("".join(sections))
        staged = tools.read_json(directory / "tracker-rows.json")
        staged["main"] = rows
        tools.write_json(directory / "tracker-rows.json", staged)
        tools.write_json(directory / "outreach-outcomes.json", local)
        progress = tools.read_json(directory / "progress.json")
        progress.update(current_stage="ready_to_commit", outreach_created=sum(
            status == "Draft in outreach tool" for status in statuses.values()), updated_at=tools.now())
        tools.write_json(directory / "progress.json", progress)
        summary = tools.read_json(directory / "summary.json")
        summary["created"] = {domain: result["email_id"] for domain, result in local.items()
                              if statuses[domain] == "Draft in outreach tool"}
        tools.write_json(directory / "summary.json", summary)
        timing = tools.read_json(directory / "timing.json")
        timing.update(pushed=tools.now(), ready_to_commit=tools.now())
        tools.write_json(directory / "timing.json", timing)
        with (directory / "report.md").open("a") as stream:
            stream.write("\n## Consolidated routing\n\n" + (
                "\n".join(f"- {domain}: {status}." for domain, status in statuses.items())
                or "No eligible email drafts.") + "\n")


def main(run_dir=None):
    run = Path(run_dir or sys.argv[1]).resolve()
    with tools.locked(run):
        attempt = run / "outreach-post-attempt.json"
        if attempt.exists():
            raise ValueError("A run upload is already journaled; reconcile saved results, do not retry.")
        lanes, payloads = collect(run)
        chunks = [payloads[i:i + 100] for i in range(0, len(payloads), 100)]
        if chunks:
            push_drafts.token()
        tools.write_json(run / "outreach-payload.json", payloads)
        tools.write_json(attempt, {"attempted_at": tools.now(), "count": len(payloads),
                                 "requests_planned": len(chunks),
                                 "domains_by_index": [p["contact"]["attributes"]["domain"] for p in payloads],
                                 "payload_sha256": tools.digest(run / "outreach-payload.json"),
                                 "retry_policy": "Never retry; reconcile saved responses."})
        outcomes, responses = {}, []
        for index, chunk in enumerate(chunks, 1):
            directory = run / f"outreach-push-{index:02d}"
            directory.mkdir()
            tools.write_json(directory / "outreach-payload.json", chunk)
            outcomes.update(push_drafts.main(directory))
            response = tools.read_json(directory / "outreach-post-response.json")
            body = response.get("body")
            responses.append({"request": index, "count": len(chunk),
                              "http_status": response.get("http_status"),
                              "notification": body.get("notification") if isinstance(body, dict) else None,
                              "uncertain": response.get("uncertain", False)})
            tools.write_json(run / "outreach-outcomes.json", outcomes)
            if any(outcomes[p["contact"]["attributes"]["domain"]].get("outcome") in ("uncertain", "no_result")
                   for p in chunk):
                break
        for draft in payloads:
            domain = draft["contact"]["attributes"]["domain"]
            if domain not in outcomes:
                outcomes[domain] = {"ok": False, "outcome": "not_attempted",
                                    "error": "Stopped after an unresolved preceding request; reconcile before routing."}
        tools.write_json(run / "outreach-outcomes.json", outcomes)
        tools.write_json(run / "outreach-consolidated-result.json", {
            "completed_at": tools.now(), "drafts_staged": len(payloads), "requests": responses,
            "created": sum(o.get("ok") is True and o.get("outcome") == "created"
                           and bool(o.get("email_id")) for o in outcomes.values())})
        distribute(lanes, outcomes)
        for directory, _, _ in lanes:
            tools.validate(directory, directory.name, [s["domain"] for s in tools.read_json(
                directory / "batch-input.json")["selected"]])
        print(json.dumps({"drafts_staged": len(payloads), "requests": len(responses),
                          "created": sum(bool(o.get("email_id")) and o.get("outcome") == "created"
                                         for o in outcomes.values())}))


if __name__ == "__main__":
    main()
