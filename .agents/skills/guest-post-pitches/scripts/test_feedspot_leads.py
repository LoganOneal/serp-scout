"""Offline tests for feedspot_leads.py: python3 test_feedspot_leads.py (fixtures only, no network)."""
import csv
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feedspot_leads as fs  # noqa: E402

LIST_A = """
<a class="ext text-blue wb-ba" href="https://www.nomadicmatt.com/">nomadicmatt.com</a>
<a href="https://www.facebook.com/nomadicmatt" class="ext">fb</a>
<a class="ext text-blue wb-ba" href="https://smallblog.blogspot.com/">blog</a>
<a class="ext text-blue wb-ba" href="https://www.travelpair.co.uk/blog/">blog</a>
<a href="https://bloggers.feedspot.com/other/">nav</a>
"""
LIST_B = """
<a class="ext text-blue wb-ba" href="https://travelpair.co.uk/">again</a>
<a class="ext text-blue wb-ba" href="https://otherblog.blogspot.com/">blog</a>
"""


class FeedspotLeadsTest(unittest.TestCase):
    def test_entries_keep_blogs_and_per_subdomain_hosts(self):
        leads, dropped = fs.build([("a", LIST_A), ("b", LIST_B)])
        self.assertEqual(list(leads), ["nomadicmatt.com", "smallblog.blogspot.com", "travelpair.co.uk",
                                       "otherblog.blogspot.com"])
        self.assertEqual(dropped["social_or_platform"], 1)
        self.assertEqual(leads["travelpair.co.uk"]["lists"], ["a", "b"])
        self.assertEqual(leads["travelpair.co.uk"]["best_rank"], 1)

    def test_csv_ranks_multi_list_blogs_first(self):
        leads, _ = fs.build([("a", LIST_A), ("b", LIST_B)])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "hht-guest-feedspot-test.csv"
            fs.write(leads, out)
            rows = list(csv.DictReader(out.open()))
        self.assertEqual(rows[0]["domain"], "travelpair.co.uk")
        self.assertEqual(rows[0]["source_query"], "feedspot:a,b")
        self.assertEqual(rows[0]["lead_type"], "guest_post")
        self.assertEqual(rows[0]["bucket"], "feedspot")

    def test_empty_list_is_counted(self):
        _, dropped = fs.build([("x", "<html>no entries</html>")])
        self.assertEqual(dropped["empty_list"], 1)


if __name__ == "__main__":
    unittest.main()
