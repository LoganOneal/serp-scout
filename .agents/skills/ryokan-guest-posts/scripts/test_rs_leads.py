"""Tests for rs_leads.py. Run: python3 -m unittest discover -s .agents/skills/ryokan-guest-posts/scripts"""
import contextlib
import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rs_leads  # noqa: E402


class RsLeadsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.exports, self.handoff = self.tmp / "exports", self.tmp / "handoff"
        self.exports.mkdir()
        for name, val in (("EXPORTS", self.exports), ("HANDOFF", self.handoff),
                          ("QUEUE", self.exports / "keyword-queue.json"),
                          ("SCORES", self.exports / "authority-scores.json")):
            p = mock.patch.object(rs_leads, name, val)
            p.start()
            self.addCleanup(p.stop)
        (self.exports / "keyword-queue.json").write_text(json.dumps({"display_limit": 40, "keywords": [
            {"keyword": "things to do in yufuin", "shape": "townttd", "status": "pending"},
            {"keyword": "things to do in gero", "shape": "townttd", "status": "pending"},
            {"keyword": "things to do in nikko", "shape": "townttd", "status": "done"}]}))

    def run_cmd(self, fn, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            fn(*args)
        return buf.getvalue()

    def test_parse_serp_semicolon_and_www(self):
        rows = rs_leads.parse_serp("Position;Domain;Url\n1;www.blog.com;https://www.blog.com/a/\n2;sub.x.co.jp;https://sub.x.co.jp/")
        self.assertEqual([r["domain"] for r in rows], ["blog.com", "x.co.jp"])
        self.assertEqual(rows[0]["position"], 1)

    def test_classify_routes_platforms_boards_and_known(self):
        known = {"ryokanfinder.com": "link_insertion", "timeout.com": "outlet", "ryokansociety.com": "self"}
        self.assertEqual(rs_leads.classify("tripadvisor.com", known), "skip")
        self.assertEqual(rs_leads.classify("japan.travel", known), "skip")
        self.assertEqual(rs_leads.classify("hakone.lg.jp", known), "skip")
        self.assertEqual(rs_leads.classify("ryokanfinder.com", known), "link_insertion")
        self.assertEqual(rs_leads.classify("timeout.com", known), "outlet")
        self.assertEqual(rs_leads.classify("ryokansociety.com", known), "self")
        self.assertEqual(rs_leads.classify("japan-trip-blog.com", known), "guest_post")

    def test_plan_takes_pending_in_order(self):
        out = json.loads(self.run_cmd(rs_leads.plan, 1))
        self.assertEqual([r["keyword"] for r in out["requests"]], ["things to do in yufuin"])
        self.assertEqual(out["requests"][0]["params"]["display_limit"], 40)

    def test_ingest_writes_csvs_and_marks_queue(self):
        pulled = self.exports / "pulled.json"
        pulled.write_text(json.dumps({
            "things to do in yufuin": {"data": "Position;Domain;Url\n1;www.tripadvisor.com;https://www.tripadvisor.com/x\n"
                                               "2;myblog.com;https://myblog.com/yufuin/\n3;www.timeout.com;https://www.timeout.com/y\n",
                                       "units": 30},
            "things to do in gero": {"error": "no_data: No data found for this request."}}))
        summary = json.loads(self.run_cmd(rs_leads.ingest, pulled, "t1"))
        self.assertEqual(summary["units"], 30)
        rows = list(csv.DictReader(open(self.handoff / "ryokan-guest-serp-t1.csv")))
        self.assertEqual([r["domain"] for r in rows], ["myblog.com"])
        self.assertEqual(rows[0]["lead_type"], "guest_post")
        self.assertTrue((self.handoff / "ryokan-outlets-t1.csv").exists())
        q = {k["keyword"]: k for k in json.loads((self.exports / "keyword-queue.json").read_text())["keywords"]}
        self.assertEqual(q["things to do in yufuin"]["status"], "done")
        self.assertEqual(q["things to do in gero"]["status"], "no_data")
        with self.assertRaises(SystemExit):
            self.run_cmd(rs_leads.ingest, pulled, "t1")

    def test_report_uses_domain_records_and_overrides(self):
        dom_dir = self.exports / "RUN-B01" / "domains"
        dom_dir.mkdir(parents=True)
        (dom_dir / "a.com.json").write_text(json.dumps({"domain": "a.com", "verdict": "PURSUE", "pitch_url": "https://a.com/w"}))
        (dom_dir / "b.com.json").write_text(json.dumps({"domain": "b.com", "verdict": "PURSUE"}))
        (self.exports / "run-overrides.json").write_text(json.dumps({"b.com": {"final": "DOWNGRADE", "class": "journalist_outlet"}}))
        self.run_cmd(rs_leads.set_as, ["a.com=42"])
        out = json.loads(self.run_cmd(rs_leads.report))
        self.assertEqual(out["counts"], {"PURSUE": 1, "DOWNGRADED": 1})
        self.assertIn("| a.com | 42 |", (self.exports / "RS Guest Post Leads.md").read_text())


if __name__ == "__main__":
    unittest.main()
