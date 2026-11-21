"""Offline tests for blog_tools.py. Run: python3 -m unittest discover -s .agents/skills/ryokan-blog-posts/scripts"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blog_tools as bt  # noqa: E402

PAGE = """<html><head><title> Kinosaki guide </title><meta name="description" content="Seven baths">
<script type="application/ld+json">{"@type":"Article","datePublished":"2025-04-01","dateModified":"2025-05-02","author":{"name":"Chris"}}</script>
</head><body><nav><h2>Menu</h2><a href="/x">x</a></nav>
<h1>Kinosaki Onsen</h1><p>One two three four five.</p><h2>How to get there?</h2><p>Six seven.</p>
<h3>From Kyoto</h3><img src="a.jpg"><table><tr><td>1</td></tr></table><ul><li>a</li></ul>
<a href="https://www.example.com/a">in</a><a href="https://other.com">out</a><footer>ignored words here</footer></body></html>"""


class BlogToolsTest(unittest.TestCase):
    def test_dissect_counts_main_content_only(self):
        p = bt.Dissect("https://example.com/guide")
        p.feed(PAGE)
        self.assertEqual(p.title.strip(), "Kinosaki guide")
        self.assertEqual(p.heads, [("h1", "Kinosaki Onsen"), ("h2", "How to get there?"), ("h3", "From Kyoto")])
        self.assertEqual((p.imgs, p.tables, p.lists, p.links_in, p.links_out), (1, 1, 1, 1, 1))
        types, dates, authors = bt.ld_types_and_dates(p.ld)
        self.assertEqual((types, dates["dateModified"], authors), (["Article"], "2025-05-02", ["Chris"]))
        self.assertNotIn("Menu", [t for _, t in p.heads])

    def test_parse_serp_csv(self):
        rows = bt.parse_serp_csv("Position;Domain;Url\n1;a.com;https://a.com/x\n2;b.com;https://b.com/y\n")
        self.assertEqual([r["position"] for r in rows], [1, 2])
        self.assertEqual(rows[1]["url"], "https://b.com/y")

    def test_kind_of(self):
        self.assertEqual(bt.kind_of("https://www.reddit.com/r/x"), "forum")
        self.assertEqual(bt.kind_of("https://www.klook.com/en-US/x"), "reviews/OTA")
        self.assertEqual(bt.kind_of("https://en.wikipedia.org/wiki/K"), "encyclopedia")
        self.assertEqual(bt.kind_of("https://kitakinki.gr.jp/x"), "official/tourism board")
        self.assertEqual(bt.kind_of("https://www.japan-guide.com/e/e3525.html"), "big guide site")
        self.assertEqual(bt.kind_of("https://www.insidekyoto.com/kinosaki"), "blog/editorial")

    def test_norm_license_keeps_only_commercial_ok(self):
        ok = {bt.norm_license(s) for s in ("CC BY-SA 4.0", "CC BY 2.5", "CC0", "Public domain", "by-sa")}
        self.assertTrue(ok <= bt.OK_LICENSES)
        for bad in ("CC BY-NC 2.0", "CC BY-ND 4.0", "CC BY-NC-SA 3.0"):
            self.assertNotIn(bt.norm_license(bad), bt.OK_LICENSES)


if __name__ == "__main__":
    unittest.main()
