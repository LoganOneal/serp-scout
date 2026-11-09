"""Offline tests for classify_batch.py: python3 test_classify_batch.py (fixtures only, no network)."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classifier  # noqa: E402
import classify_batch as cb  # noqa: E402
import run_tools as tools  # noqa: E402

FILLER = "We write about small hotels with hot tubs and slow weekends away. " * 5
PAGES = {
    "guestblog.example": {"/": "Guest Blog home. Posted October 2, 2026. " + FILLER,
                          "/write-for-us/": "Write for us. We accept guest posts. Email editor@guestblog.example. " + FILLER},
    "noinvite.example": {"/": "No Invite home. Posted September 9, 2026. " + FILLER},
    "capped.example": {"/": "Capped home. Posted August 1, 2026. " + FILLER},
    "regional.example": {"/": "Call +91 98765 43210. Rooms from ₹4,000. " + FILLER},
    "shop.in": {"/": "Indian shop. " + FILLER},
    "blank.example": {},
}


def quiet(fn, *args):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args)


class ClassifyBatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.batch = Path(self.tmp.name) / "HHT-test-B01"
        (self.batch / "domains").mkdir(parents=True)
        selected = []
        for domain, pages in PAGES.items():
            selected.append({"domain": domain, "supplied_urls": [],
                             "source_rows": [{"source_sheet": "leads.csv", "score": "40", "source_query": "hot tub weekend"}]})
            log = []
            for i, (path, text) in enumerate(pages.items()):
                rel = f"evidence/{domain}/{i}.txt"
                (self.batch / rel).parent.mkdir(parents=True, exist_ok=True)
                (self.batch / rel).write_text(text)
                log.append({"url": f"https://{domain}{path}", "result": "ok", "status": 200,
                            "text_file": rel, "text_characters": len(text)})
            if not pages:
                log.append({"url": f"https://{domain}/", "result": "access_denied", "status": 403})
            record = dict.fromkeys(tools.PART_A)
            record.update(domain=domain, search_log=log, triage_date="2026-11-08", evidence_quotes=[],
                          evidence_urls=[], steps_completed=[], notes=None,
                          invitation_search={"full": True, "early_stop": None})
            if domain == "capped.example":
                record["invitation_search"] = {"full": False, "early_stop": None, "stopped": "slow-site cap"}
            (self.batch / "domains" / f"{domain}.json").write_text(json.dumps(record))
        (self.batch / "batch-input.json").write_text(json.dumps({"batch": "HHT-test-B01", "selected": selected}))

    def tearDown(self):
        self.tmp.cleanup()

    def record(self, domain):
        return json.loads((self.batch / "domains" / f"{domain}.json").read_text())

    def write_results(self, rows_by_batch):
        for nn, rows in rows_by_batch.items():
            (self.batch / "haiku" / "results" / f"batch-{nn}.jsonl").write_text(
                "\n".join(json.dumps(r) for r in rows) + "\n")

    def row(self, domain, verdict="SKIP", code="SKIP_NO_INVITATION", **extra):
        out = dict.fromkeys(cb.KEYS)
        out.update(domain=domain, verdict=verdict, code=code, route="none", submission_stage="unknown",
                   confidence="high", last_activity_date="2026-09-09")
        out.update(extra)
        return out

    def good_rows(self):
        return [
            self.row("guestblog.example", "PURSUE", None, pitch_url="https://guestblog.example/write-for-us/",
                     route="email", contact="editor@guestblog.example", submission_stage="pitch-first",
                     last_activity_date="2026-10-02", evidence_quote="We accept   guest posts."),
            self.row("noinvite.example"),
            self.row("capped.example"),
            self.row("regional.example", "SKIP", "SKIP_REGION_EXCLUDED", evidence_quote="Rooms from ₹4,000."),
        ]

    def run_through_merge(self, size=18):
        quiet(cb.region, self.batch)
        prep = quiet(cb.prep, self.batch, size)
        rows = {r["domain"]: r for r in self.good_rows()}
        self.write_results({nn: [rows[d] for d in json.loads((self.batch / "haiku" / f"batch-{nn}.json").read_text())]
                            for nn in prep["batches"]})
        return quiet(cb.merge, self.batch)

    def test_rules_file_is_the_classifier_prompt(self):
        self.assertTrue(cb.RULES.read_text().startswith(classifier.SYSTEM))

    def test_region_prescreen(self):
        rec = self.record("guestblog.example")
        rec["region_check"] = "unclear"
        (self.batch / "domains" / "guestblog.example.json").write_text(json.dumps(rec))
        out = quiet(cb.region, self.batch)
        self.assertEqual(out["excluded"], ["shop.in"])
        self.assertEqual(out["unclear"], ["regional.example"])
        self.assertEqual(out["kept"], ["guestblog.example"])
        self.assertEqual(self.record("noinvite.example")["region_check"], "clear")
        self.assertEqual(self.record("guestblog.example")["region_check"], "unclear")
        quiet(cb.region, self.batch, True)
        self.assertEqual(self.record("guestblog.example")["region_check"], "clear")
        self.assertEqual(json.loads((self.batch / "region.json").read_text())["excluded"], ["shop.in"])

    def test_prep_batches_and_reports(self):
        quiet(cb.region, self.batch)
        prep = quiet(cb.prep, self.batch, 3)
        haiku = self.batch / "haiku"
        self.assertEqual(prep["no_page_text"], ["blank.example"])
        self.assertEqual(prep["region_excluded"], ["shop.in"])
        self.assertEqual(prep["batches"], ["01", "02"])
        self.assertEqual(json.loads((haiku / "batch-01.json").read_text()),
                         ["guestblog.example", "noinvite.example", "capped.example"])
        self.assertEqual(json.loads((haiku / "batch-02.json").read_text()), ["regional.example"])
        self.assertEqual((haiku / "RULES.txt").read_text(), cb.RULES.read_text())
        site = (haiku / "sites" / "guestblog.example.txt").read_text()
        self.assertIn("Domain: guestblog.example", site)
        self.assertIn("We accept guest posts", site)
        self.assertIn("Activity check", site)
        prompt = (haiku / "prompt-02.txt").read_text()
        self.assertIn(f"{haiku}/batch-02.json", prompt)
        self.assertIn(f"{haiku}/results/batch-02.jsonl", prompt)
        self.assertIn("done 1", prompt)
        self.assertFalse((haiku / "sites" / "blank.example.txt").exists())

    def test_merge_writes_results_and_forced_rows(self):
        rows = {r["domain"]: r for r in self.run_through_merge()}
        self.assertEqual(len(rows), len(PAGES))
        self.assertTrue(rows["guestblog.example"]["quote_found"])
        self.assertTrue(rows["regional.example"]["quote_found"])
        self.assertFalse(rows["noinvite.example"]["quote_found"])
        self.assertEqual((rows["blank.example"]["verdict"], rows["blank.example"]["code"]),
                         ("NEEDS_REVIEW", "INSUFFICIENT_EVIDENCE"))
        self.assertEqual(rows["shop.in"]["code"], "SKIP_REGION_EXCLUDED")
        self.assertTrue((self.batch / "haiku-results.csv").read_text().startswith("domain,verdict,code"))

    def test_merge_rejects_missing_duplicate_and_invalid_lines(self):
        quiet(cb.region, self.batch)
        quiet(cb.prep, self.batch)
        good = self.good_rows()
        cases = {
            "missing": good[:-1],
            "duplicate": good + [good[1]],
            "bad enum": good[:-1] + [dict(good[-1], route="phone")],
            "pursue with code": [dict(good[0], code="SKIP_DEAD")] + good[1:],
            "extra key": good[:-1] + [dict(good[-1], note="x")],
        }
        for name, rows in cases.items():
            with self.subTest(name):
                self.write_results({"01": rows})
                with self.assertRaises(SystemExit):
                    quiet(cb.merge, self.batch)
        self.assertFalse((self.batch / "haiku-results.json").exists())

    def test_apply_writes_part_a_records_and_tracker_rows(self):
        self.run_through_merge()
        out = quiet(cb.apply, self.batch)
        self.assertEqual(out["pursue"], ["guestblog.example"])
        research = json.loads((self.batch / "research.json").read_text())
        self.assertEqual(research["batch"], "HHT-test-B01")
        for site in research["sites"]:
            self.assertFalse(set(tools.PART_A) - set(site), site["domain"])
            self.assertTrue(site["search_log"] and site["evidence_urls"] and site["evidence_quotes"])
            self.assertEqual(site, self.record(site["domain"]))
        g = self.record("guestblog.example")
        self.assertEqual((g["verdict"], g["skip_code"], g["submission_stage"], g["contact_route"], g["activity"]),
                         ("PURSUE", None, "pitch-first", "editor@guestblog.example", "active"))
        self.assertTrue(g["evidence_quotes"][0]["found_in_fetched_text"])
        self.assertEqual((self.record("noinvite.example")["skip_code"]), "SKIP_NO_INVITATION")
        capped = self.record("capped.example")
        self.assertEqual((capped["verdict"], capped["review_reason"]), ("NEEDS_REVIEW", "SLOW_SITE_CAPPED"))
        blank = self.record("blank.example")
        self.assertEqual((blank["verdict"], blank["review_reason"]), ("NEEDS_REVIEW", "INSUFFICIENT_EVIDENCE"))
        self.assertEqual(blank["evidence_urls"], ["https://blank.example/"])
        main = json.loads((self.batch / "tracker-rows.json").read_text())["main"]
        by_site = {r["site"]: r for r in main}
        self.assertNotIn("guestblog.example", by_site)
        self.assertEqual(len(main), len(PAGES) - 1)
        self.assertEqual(by_site["capped.example"]["code"], "SLOW_SITE_CAPPED")
        self.assertEqual(by_site["capped.example"]["outreach_status"], "Not pushed")
        self.assertEqual(by_site["noinvite.example"]["outreach_status"], "Not pursued")
        self.assertEqual((by_site["noinvite.example"]["sheet_score"], by_site["noinvite.example"]["source_query"]),
                         ("40", "hot tub weekend"))
        self.assertTrue(by_site["regional.example"]["needs_human_input"])
        self.assertTrue(all(r["code"] for r in main))

    def test_apply_is_safe_to_rerun_after_writing_step_edits(self):
        self.run_through_merge()
        quiet(cb.apply, self.batch)
        rec = self.record("guestblog.example")
        rec.update(verdict="SKIP", skip_code="SKIP_CLOSED", suggested_angle="checked live page")
        (self.batch / "domains" / "guestblog.example.json").write_text(json.dumps(rec))
        out = quiet(cb.apply, self.batch)
        self.assertEqual(out["changed"], [])
        self.assertEqual(self.record("guestblog.example")["skip_code"], "SKIP_CLOSED")
        research = json.loads((self.batch / "research.json").read_text())
        self.assertEqual(next(s for s in research["sites"] if s["domain"] == "guestblog.example")["verdict"], "SKIP")


if __name__ == "__main__":
    unittest.main()
