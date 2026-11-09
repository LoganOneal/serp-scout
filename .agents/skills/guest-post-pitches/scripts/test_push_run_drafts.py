"""Offline tests: python3 -m unittest discover -s scripts -p test_push_run_drafts.py"""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import push_drafts
import push_run_drafts as routing
import run_tools as tools
import lane_status


class ConsolidatedRoutingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.run = self.root / "run"
        self.run.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def prepare(self, sizes):
        batches = []
        number = 0
        for index, size in enumerate(sizes, 1):
            bid = f"run-B{index:02d}"
            directory = self.root / bid
            directory.mkdir()
            (directory / "domains").mkdir()
            selected, sites, rows, payloads, sections = [], [], [], [], []
            for _ in range(size):
                number += 1
                domain = f"blog{number}.example"
                selected.append({"domain": domain, "source_rows": [{"source_query": "weekend itinerary"}]})
                site = dict.fromkeys(tools.PART_A)
                site.update(domain=domain, verdict="PURSUE", region_check="clear",
                            submission_stage="pitch-first", push_blockers=[], hotel_operator=False,
                            search_log=[{"url": f"https://{domain}/write/"}],
                            evidence_urls=[f"https://{domain}/write/"],
                            evidence_quotes=["We accept travel pitches."])
                sites.append(site)
                tools.write_json(directory / "domains" / f"{domain}.json", site)
                payload = {
                    "campaign_id": push_drafts.CAMPAIGN, "step_number": 1,
                    "contact": {"email": f"editor@{domain}", "attributes": {"domain": domain, "batch": bid}},
                    "subject": f"Pitch {domain}", "body": "Hi Editor,\n\nA travel pitch.\n\nBest regards,",
                    "reviewer_note": "Verified site requirements.",
                }
                payloads.append(payload)
                rows.append({"site": domain, "batch": bid, "verdict": "PURSUE", "code": "PURSUE",
                             "draft": f"{bid}/drafts.md#{domain}", "outreach_email_id": None,
                             "outreach_status": routing.PENDING, "requirements_note": payload["reviewer_note"],
                             "notes": "", "source_query": "weekend itinerary"})
                sections.append(f"## {domain}\n\nRouting status: {routing.PENDING}\n\n"
                                f"{payload['subject']}\n\n{payload['body']}\n")
            for name, value in {
                "batch-input.json": {"selected": selected},
                "research.json": {"sites": sites},
                "tracker-rows.json": {"main": rows, "full_articles": []},
                "draft-validation.json": {"passed": True, "editorial_readthrough_passed": True},
                "outreach-payload.json": payloads, "outreach-outcomes.json": {},
                "progress.json": {"current_stage": "ready_for_run_push"},
                "summary.json": {}, "timing.json": {},
            }.items():
                tools.write_json(directory / name, value)
            (directory / "drafts.md").write_text("\n".join(sections))
            (directory / "report.md").write_text("Research complete.\n")
            batches.append({"id": bid, "status": "pending"})
        tools.write_json(self.run / "run.json", {"batches": batches})

    @staticmethod
    def response(url, *, json, **kwargs):
        class Response:
            status_code = 200
            headers = {"content-type": "application/json"}

            def json(self):
                return {"notification": "failed", "results": [
                    {"index": i, "ok": True, "outcome": "created",
                     "email_id": item["contact"]["attributes"]["domain"]}
                    for i, item in enumerate(json)]}
        return Response()

    def route(self, response=None):
        with patch.object(push_drafts, "token", return_value="offline-test"), patch.object(
                push_drafts.requests, "post", side_effect=response or self.response) as post, contextlib.redirect_stdout(io.StringIO()):
            routing.main(self.run)
            return post

    def test_combines_lanes_and_preserves_real_notification_and_local_copies(self):
        self.prepare([1, 2])
        post = self.route()
        self.assertEqual(post.call_count, 1)
        self.assertEqual(len(post.call_args.kwargs["json"]), 3)
        self.assertEqual({p["contact"]["attributes"]["batch"] for p in post.call_args.kwargs["json"]},
                         {"run-B01", "run-B02"})
        result = tools.read_json(self.run / "outreach-consolidated-result.json")
        self.assertEqual(result["requests"][0]["notification"], "failed")
        self.assertEqual(result["created"], 3)
        for bid in ("run-B01", "run-B02"):
            directory = self.root / bid
            self.assertNotIn(routing.PENDING, (directory / "drafts.md").read_text())
            self.assertIn("Routing status: Draft in outreach tool", (directory / "drafts.md").read_text())
            for outcome in tools.read_json(directory / "outreach-outcomes.json").values():
                self.assertEqual(outcome["notification"], "failed")

    def test_chunks_at_exact_api_limit(self):
        self.prepare([51, 50])
        post = self.route()
        self.assertEqual([len(call.kwargs["json"]) for call in post.call_args_list], [100, 1])

    def test_cross_lane_email_duplicate_rejected_before_attempt(self):
        self.prepare([1, 1])
        path = self.root / "run-B02/outreach-payload.json"
        payload = tools.read_json(path)
        payload[0]["contact"]["email"] = "EDITOR@BLOG1.EXAMPLE"
        tools.write_json(path, payload)
        with self.assertRaisesRegex(ValueError, "duplicate"), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()
        self.assertFalse((self.run / "outreach-post-attempt.json").exists())

    def test_all_lanes_must_be_ready(self):
        self.prepare([1, 1])
        tools.write_json(self.root / "run-B02/progress.json", {"current_stage": "research"})
        with self.assertRaisesRegex(ValueError, "not ready"), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()

    def test_prior_run_attempt_blocks_repeat(self):
        self.prepare([1])
        tools.write_json(self.run / "outreach-post-attempt.json", {"count": 1})
        with self.assertRaisesRegex(ValueError, "already journaled"), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()

    def test_uncertain_first_request_stops_remaining_chunks(self):
        self.prepare([101])
        post = self.route(response=push_drafts.requests.Timeout("offline"))
        self.assertEqual(post.call_count, 1)
        outcomes = tools.read_json(self.run / "outreach-outcomes.json")
        self.assertEqual(outcomes["blog1.example"]["outcome"], "uncertain")
        self.assertEqual(outcomes["blog101.example"]["outcome"], "not_attempted")
        self.assertFalse(tools.read_json(self.root / "run-B01/tracker-rows.json")["main"][0]["outreach_email_id"])

    def test_empty_lanes_send_no_request(self):
        self.prepare([0])
        post = self.route()
        post.assert_not_called()

    def test_pending_rows_cannot_be_committed(self):
        self.prepare([1])
        with self.assertRaisesRegex(ValueError, "Consolidate"):
            tools.commit(self.run, "run-B01")

    def test_prior_lane_attempt_blocks_consolidation(self):
        self.prepare([1])
        tools.write_json(self.root / "run-B01/outreach-post-attempt.json", {"count": 1})
        with self.assertRaisesRegex(ValueError, "prior lane attempt"), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()

    def test_material_holds_and_hotel_operators_cannot_be_uploaded(self):
        self.prepare([1])
        directory = self.root / "run-B01"
        original = tools.read_json(directory / "research.json")["sites"][0]
        for change in ({"push_blockers": ["Genuine clip missing"]}, {"hotel_operator": True}):
            with self.subTest(change=change):
                site = {**original, **change}
                tools.write_json(directory / "research.json", {"sites": [site]})
                tools.write_json(directory / "domains" / "blog1.example.json", site)
                with self.assertRaisesRegex(ValueError, "ineligible"), patch.object(push_drafts.requests, "post") as post:
                    routing.main(self.run)
                post.assert_not_called()

    def test_created_without_id_is_uncertain_not_success(self):
        self.prepare([1])

        def malformed(*args, **kwargs):
            response = self.response(*args, **kwargs)
            response.json = lambda: {"notification": "sent", "results": [
                {"index": 0, "ok": True, "outcome": "created"}]}
            return response

        self.route(response=malformed)
        outcome = tools.read_json(self.run / "outreach-outcomes.json")["blog1.example"]
        self.assertEqual(outcome["outcome"], "uncertain")
        self.assertFalse(outcome["ok"])

    def test_staged_lanes_waiting_for_other_research_are_not_stale(self):
        self.prepare([0])
        directory = self.root / "run-B01"
        tools.write_json(directory / "progress.json", {
            "current_stage": "ready_for_run_push", "updated_at": "2000-01-01T00:00:00+00:00"})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            lane_status.main([str(directory)])
        self.assertNotIn("STALE", output.getvalue())

    def test_missing_routing_files_fail_before_any_post(self):
        self.prepare([1])
        (self.root / "run-B01/timing.json").unlink()
        with self.assertRaises(FileNotFoundError), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()
        self.assertFalse((self.run / "outreach-post-attempt.json").exists())

    def test_article_first_payload_is_rejected_even_with_valid_article_tracking(self):
        self.prepare([1])
        directory = self.root / "run-B01"
        site = tools.read_json(directory / "research.json")["sites"][0]
        site["submission_stage"] = "article-first"
        tools.write_json(directory / "research.json", {"sites": [site]})
        tools.write_json(directory / "domains/blog1.example.json", site)
        rows = tools.read_json(directory / "tracker-rows.json")
        rows["main"][0]["outreach_status"] = "Article for review (not pushed)"
        rows["full_articles"] = [{
            "site": "blog1.example", "status": "Drafted", "doc_link": "run-B01/drafts.md#blog1"}]
        tools.write_json(directory / "tracker-rows.json", rows)
        with self.assertRaisesRegex(ValueError, "ineligible"), patch.object(push_drafts.requests, "post") as post:
            routing.main(self.run)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
