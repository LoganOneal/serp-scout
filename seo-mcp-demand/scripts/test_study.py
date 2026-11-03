import csv
import unittest
from unittest.mock import patch

import study
import prepare
from scoring import group_keywords, normalize, score_tasks, sensitivity, trend_growth


class ScoringTests(unittest.TestCase):
    def test_semrush_docs_are_not_report_rows(self):
        snapshots = [
            {"label": "semrush:phrase-docs", "status": 200, "body": "<html>Not a report</html>"},
            {"label": 'semrush:phrase_this:{"phrase":"keyword search volume"}', "status": 200, "body": "Keyword;Search Volume;CPC\nkeyword search volume;100;2.5", "cache_file": "fixture", "fetched_at": "2026-10-29"},
        ]
        with patch.object(prepare, "records", return_value=iter(snapshots)):
            keywords, candidates, pages = prepare.semrush_rows()
        self.assertEqual(len(keywords), 1)
        self.assertEqual(keywords[0]["volume_us"], "100")
        self.assertEqual(keywords[0]["task_ids"], "kw_volume")

    def test_oauth_row_objects_are_parsed(self):
        snapshots = [{"label": 'semrush:phrase_related:{"phrase":"keyword search volume"}', "status": 200, "data": [{"Ph": "Keyword Volume Tool", "Nq": "320", "Kd": "41"}], "cache_file": "fixture", "fetched_at": "2026-10-29"}]
        with patch.object(prepare, "records", return_value=iter(snapshots)):
            keywords, candidates, pages = prepare.semrush_rows()
        self.assertEqual((keywords[0]["keyword"], keywords[0]["volume_us"], keywords[0]["keyword_difficulty"]), ("keyword volume tool", "320", "41"))

    def test_log_normalization_preserves_unknown_and_observed_zero(self):
        self.assertEqual(normalize([None, 0, 9, 99]), [None, 0.0, 0.5, 1.0])

    def test_duplicate_parent_and_shared_tasks_do_not_inflate_volume(self):
        rows = [
            {"keyword": "keyword checker", "parent_topic": "keyword tool", "task_ids": "first", "volume_us": 100},
            {"keyword": "free keyword checker", "parent_topic": "keyword tool", "task_ids": "second", "volume_us": 80},
        ]
        grouped = group_keywords(rows + rows)
        self.assertEqual(len(grouped), 2)
        self.assertEqual(sum(row["volume_us"] for row in grouped), 100)

    def test_missing_demand_cannot_generate_a_final_score(self):
        rows = [{"task_id": "first", "dimension": 5, "volume": None, "usage": 100}]
        scored = score_tasks(rows, {"volume": 0.8, "usage": 0.2}, ["dimension"])
        self.assertIsNone(scored[0]["score"])
        self.assertAlmostEqual(scored[0]["observed_weight"], 0.2)
        self.assertEqual(sensitivity(rows, {"volume": 0.8, "usage": 0.2}, ["dimension"])[0]["scenario"], "blocked")

    def test_formula_and_sensitivity(self):
        rows = [{"task_id": "first", "dimension": 4, "volume": 99, "usage": 9}]
        scored = score_tasks(rows, {"volume": 0.8, "usage": 0.2}, ["dimension"])
        self.assertAlmostEqual(scored[0]["score"], 0.8)
        self.assertEqual(len(sensitivity(rows, {"volume": 0.8, "usage": 0.2}, ["dimension"])), 3)

    def test_trend_requires_24_months_and_preserves_decline(self):
        self.assertIsNone(trend_growth([10] * 12))
        self.assertAlmostEqual(trend_growth([100] * 21 + [50] * 3), -0.5)

    def test_first_party_weight_floor(self):
        with self.assertRaises(ValueError):
            score_tasks([], {"first_party_calls": 0.2, "volume": 0.8}, [])


class TaxonomyTests(unittest.TestCase):
    def test_seed_coverage(self):
        study.generate()
        with (study.ROOT / "data/taxonomy.csv").open() as handle:
            taxonomy = list(csv.DictReader(handle))
        with (study.ROOT / "data/seeds.csv").open() as handle:
            seeds = list(csv.DictReader(handle))
        task_ids = {row["task_id"] for row in taxonomy}
        self.assertEqual(len(task_ids), 30)
        self.assertEqual(len({row["cluster"] for row in taxonomy}), 10)
        self.assertEqual({row["task_id"] for row in seeds}, task_ids)
        for task_id in task_ids:
            selected = [row for row in seeds if row["task_id"] == task_id]
            self.assertTrue(5 <= len(selected) <= 15)
            self.assertTrue({"free_checker", "free_tool", "check", "checker", "how_to", "api", "mcp"}.issubset(
                {row["pattern"] for row in selected}))


if __name__ == "__main__":
    unittest.main()

class RevisionTwoTests(unittest.TestCase):
    def test_recent_volume_uses_last_three_months(self):
        self.assertEqual(prepare.recent_volume("1000", "1,1,1,1,1,1,1,1,1,0.5,0.5,0.2"), (400, True))
        self.assertEqual(prepare.recent_volume("1000", ""), ("1000", False))

    def test_spike_then_collapse(self):
        self.assertTrue(prepare.spike_collapse("1.00,1.00,0.07,0.00,0.00,0.00,0.00,0.00,0.00,0.01,0.00,0.00"))
        self.assertFalse(prepare.spike_collapse("0.54,0.66,0.81,0.44,0.66,0.54,0.66,0.66,1.00,0.81,0.81,1.00"))
        self.assertFalse(prepare.spike_collapse("1.0,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2"))

    def test_navigational_and_brand(self):
        import re
        for keyword in ("google search console", "search console", "search console login", "backlink checker example. com", "brandrank.ai visibility"):
            self.assertTrue(re.search(prepare.NAVIGATIONAL, keyword), keyword)
        for keyword in ("search console api", "crawled currently not indexed", "backlink checker"):
            self.assertFalse(re.search(prepare.NAVIGATIONAL, keyword), keyword)
        self.assertEqual(prepare.brand_of("ahrefs keyword difficulty"), "ahrefs")
        self.assertEqual(prepare.brand_of("keyword difficulty"), "")

    def test_smithery_cap(self):
        import build
        signals = [
            {"usage_metric": "m", "usage_count": "10000", "task_ids": "a", "name": "big"},
            {"usage_metric": "m", "usage_count": "10", "task_ids": "a", "name": "small"},
        ]
        usage, raw, top = build.mcp_usage(signals, "m")
        self.assertLessEqual(usage["a"], raw["a"])
        self.assertAlmostEqual(usage["a"], 0.5 * raw["a"] + __import__("math").log1p(10))
