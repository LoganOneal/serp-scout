"""Offline tests for research_tools.py: python3 test_research_tools.py

Each case serves a fake site on localhost and checks which URLs the helper fetches.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import research_tools as rt  # noqa: E402

DOMAIN = "localhost"
NAV = "<nav><a href='/'>Home</a><a href='/about'>About</a><a href='/contact'>Contact</a>{extra}</nav>"
FOOTER = "<footer><p>Copyright 2026 Example Travels</p><p>Write for us | Privacy</p></footer>"
FILLER = " ".join(["We travel slowly and write about small hotels, coastal food and long train rides."] * 4)


def page(body, extra_nav=""):
    return "<html><body>" + NAV.format(extra=extra_nav) + "<main>" + body + "</main>" + FOOTER + "</body></html>"


HOME = page("<h1>Example Travels</h1><p>" + FILLER + "</p>")
GUIDE = page(
    "<h1>Write for us</h1><p>We accept guest posts from travel writers. Read the guidelines below and "
    "send your pitch to editor@example.test with two writing samples.</p><p>Posts must be 1,200 words, "
    "original, and include your own photos. We reply within two weeks.</p><p>" + FILLER + "</p>")
CLOSED = page(
    "<h1>Guest posts</h1><p>We no longer accept guest posts or unsolicited pitches. Thank you for your "
    "interest in writing for Example Travels; please do not email submissions.</p><p>" + FILLER + "</p>")


class Site:
    def __init__(self, routes):
        self.routes = routes
        self.hits = []
        site = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                site.hits.append(self.path)
                status, body, ctype = site.routes.get(self.path, (404, page("<p>Not found</p>"), "text/html"))
                data = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = "http://localhost:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ResearchToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        rt.ROOT = Path(self.tmp.name)
        rt._INPUT = None
        rt.HOST_SPACING_SECONDS = 0
        self.site = None

    def tearDown(self):
        if self.site:
            self.site.close()
        os.environ.pop("HHT_ORIGIN", None)
        self.tmp.cleanup()

    def serve(self, routes, supplied=()):
        base = {"/robots.txt": (200, "User-agent: *\nAllow: /\n", "text/plain"), "/": (200, HOME, "text/html")}
        base.update(routes)
        self.site = Site(base)
        os.environ["HHT_ORIGIN"] = self.site.origin
        (rt.ROOT / "batch-input.json").write_text(json.dumps(
            {"selected": [{"domain": DOMAIN, "supplied_urls": [self.site.origin + p for p in supplied]}]}))

    def run_all(self, full=False, thorough=False, budget=0):
        r = rt.Research(DOMAIN, thorough=thorough, budget=budget)
        r.seed()
        r.region("clear")
        r.research(full=full)
        return rt.Research(DOMAIN)

    def test_nav_link_invitation_stops_before_path_probing(self):
        self.serve({"/write-for-us": (200, GUIDE, "text/html")})
        self.site.routes["/"] = (200, page("<p>" + FILLER + "</p>", "<a href='/write-for-us'>Write for us</a>"), "text/html")
        r = self.run_all()
        self.assertEqual(r.site["invitation_candidates"][0]["url"], self.site.origin + "/write-for-us")
        self.assertIsNotNone(r.site["invitation_search"]["early_stop"])
        self.assertNotIn("/guest-post", self.site.hits)
        self.assertFalse(any("sitemap" in h for h in self.site.hits))
        self.assertIsNone(r.needs_search())

    def test_path_probe_stops_at_first_confirmed_page(self):
        self.serve({"/guest-post": (200, GUIDE, "text/html")})
        r = self.run_all()
        self.assertIn("/write-for-us", self.site.hits)
        self.assertIn("/guest-post", self.site.hits)
        self.assertNotIn("/guestpost", self.site.hits)
        self.assertFalse(any("sitemap" in h for h in self.site.hits))
        stop = r.site["invitation_search"]["early_stop"]
        self.assertEqual(stop["skipped_paths"][0], "guestpost")

    def test_soft_404_and_footer_text_do_not_count(self):
        # /write-for-us renders the homepage; footer says "Write for us" on every page.
        self.serve({"/write-for-us": (200, HOME, "text/html")})
        r = self.run_all()
        self.assertEqual(r.site["invitation_candidates"], [])
        for p in ("/contact", "/work-with-us", "/sitemap.xml", "/sitemap_index.xml", "/page-sitemap.xml"):
            self.assertIn(p, self.site.hits)
        self.assertNotIn("/press", self.site.hits)  # light policy: top paths only
        self.assertTrue(r.site["invitation_search"]["full"])
        self.assertIn("light", r.site["invitation_search"]["policy"])
        self.assertEqual(r.needs_search(), "no confirmed invitation on-site")

    def test_thorough_mode_probes_every_playbook_path(self):
        self.serve({})
        r = self.run_all(thorough=True)
        for p in ("/press", "/advertise", "/wp-sitemap.xml"):
            self.assertIn(p, self.site.hits)
        self.assertIn("thorough", r.site["invitation_search"]["policy"])

    def test_light_policy_stops_after_first_readable_root_sitemap(self):
        smap = ('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                "<url><loc>{o}/about</loc></url></urlset>")
        self.serve({})
        self.site.routes["/sitemap.xml"] = (200, smap.replace("{o}", self.site.origin), "application/xml")
        r = self.run_all()
        self.assertIn("/sitemap.xml", self.site.hits)
        self.assertNotIn("/wp-sitemap.xml", self.site.hits)
        self.assertTrue(r.site["invitation_search"]["full"])

    def test_slow_site_is_capped_and_not_a_completed_search(self):
        self.serve({"/robots.txt": (200, "User-agent: *\nCrawl-delay: 3\nAllow: /\n", "text/plain")})
        r = rt.Research(DOMAIN, budget=0)
        r.seed()
        r.region("clear")
        r.discover()
        capped = rt.Research(DOMAIN, budget=1)
        capped.start_stage()
        capped.variants()
        r = rt.Research(DOMAIN)
        self.assertFalse(r.site["invitation_search"]["full"])
        self.assertIn("time cap", r.site["invitation_search"]["stopped"])
        self.assertIn("time cap", r.needs_search())
        self.assertTrue(any(e["result"] == "not_attempted_time_cap" for e in r.site["search_log"]))
        # The first request needs no wait; the second would wait 3s and exceed the 1s cap.
        self.assertIn("/write-for-us", self.site.hits)
        self.assertNotIn("/guest-post", self.site.hits)

    def test_closed_page_is_flagged_not_counted(self):
        self.serve({"/guest-post": (200, CLOSED, "text/html")})
        r = self.run_all()
        self.assertEqual(r.site["invitation_candidates"], [])
        self.assertEqual(r.site["closed_signals"][0]["url"], self.site.origin + "/guest-post")
        self.assertIn("/contact", self.site.hits)

    def test_full_flag_disables_early_stop(self):
        self.serve({"/write-for-us": (200, GUIDE, "text/html")})
        r = self.run_all(full=True)
        self.assertTrue(r.site["invitation_candidates"])
        self.assertIn("/work-with-us", self.site.hits)
        self.assertIn("/sitemap.xml", self.site.hits)
        self.assertIsNone(r.site["invitation_search"]["early_stop"])

    def test_robots_block_is_respected(self):
        self.serve({"/robots.txt": (200, "User-agent: *\nDisallow: /\n", "text/plain")})
        r = rt.Research(DOMAIN)
        r.seed()
        r.region("clear")
        r.research()
        self.assertEqual(self.site.hits, ["/robots.txt"])
        self.assertTrue(r.site["site_access_blocked"])
        self.assertIn("blocked", rt.Research(DOMAIN).needs_search())

    def test_supplied_url_logged_and_excluded_region_skips_research(self):
        self.serve({"/guest-post": (200, GUIDE, "text/html")}, supplied=("/guest-post",))
        r = rt.Research(DOMAIN)
        r.seed()
        r.region("excluded", "Address in Jaipur")
        r.research()
        self.assertNotIn("/guest-post", self.site.hits)
        self.assertIsNone(rt.Research(DOMAIN).needs_search())

    def test_sitemap_custom_slug_found_and_stops(self):
        app = page("<h1>Guest Post Application</h1><p>Does Example accept guest posters? Sort of. Fill in the "
                   "application below with your idea and links to published work.</p><p>Posts must be original.</p>"
                   "<p>We read every application and reply within a month if it is a fit for our readers.</p>")
        smap = ('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                + "".join("<url><loc>{o}/%s</loc></url>" % p for p in
                          ["about", "contact", "press-kit", "partner", "write-for-examplemom"]) + "</urlset>")
        self.serve({"/write-for-examplemom": (200, app, "text/html")})
        self.site.routes["/page-sitemap.xml"] = (200, smap.replace("{o}", self.site.origin), "application/xml")
        r = self.run_all()
        self.assertEqual(r.site["invitation_candidates"][0]["url"], self.site.origin + "/write-for-examplemom")
        self.assertEqual(r.site["invitation_search"]["early_stop"]["confirmed_invitation_url"],
                         self.site.origin + "/write-for-examplemom")
        self.assertNotIn("/press-kit", self.site.hits)
        self.assertIsNone(r.needs_search())

    def test_redirect_loop_is_logged_not_raised(self):
        import types
        self.serve({})
        r = rt.Research(DOMAIN, budget=0)
        r.seed()
        r.region("clear")
        real_raw = r.raw

        def looping_raw(self_, url, purpose):
            entry = real_raw(url, purpose)
            if url.endswith("/write-for-us"):
                entry.update(result="redirect", location=url)
            return entry
        r.raw = types.MethodType(looping_raw, r)
        entry = r.fetch(self.site.origin + "/write-for-us", "loop test")
        self.assertEqual(entry["result"], "redirect_loop")

    def test_cli_parallel_and_needs_search(self):
        self.serve({})
        rt.main(["seed", "--jobs", "4"])
        rt.main(["region", DOMAIN, "--set", "clear"])
        rt.main(["research", "--budget", "60"])
        rt.main(["needs-search"])
        data = json.loads((rt.ROOT / "needs-search.json").read_text())
        self.assertEqual(data["domains"][0]["domain"], DOMAIN)
        self.assertEqual(len(data["domains"][0]["queries"]), 1)
        rt.main(["needs-search", "--thorough"])
        data = json.loads((rt.ROOT / "needs-search.json").read_text())
        self.assertEqual(len(data["domains"][0]["queries"]), 2)


class SitemapScopeTest(unittest.TestCase):
    """Ported from the batch fixture: archives are skipped, invitation pages fetched, cap respected."""

    def test_targeted_sitemap_scope(self):
        tmp = tempfile.TemporaryDirectory()
        rt.ROOT = Path(tmp.name)
        D, O = "fixture.test", "https://fixture.test"

        def urlset(urls):
            return ('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    + "".join(f"<url><loc>{u}</loc></url>" for u in urls) + "</urlset>")
        fx = {
            O + "/sitemap.xml": '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + "".join(f"<sitemap><loc>{O}/{n}</loc></sitemap>" for n in [
                "page-sitemap.xml", "contributor-sitemap.xml", "post-sitemap1.xml", "post-sitemap2.xml",
                "category-sitemap.xml", "news-sitemap.xml"]) + "</sitemapindex>",
            O + "/page-sitemap.xml": urlset([O + "/about", O + "/write-for-us", O + "/contact", O + "/privacy-policy"]),
            O + "/contributor-sitemap.xml": urlset([O + "/guest-post-guidelines"]),
        }
        for n in ("post-sitemap1.xml", "post-sitemap2.xml", "category-sitemap.xml", "news-sitemap.xml"):
            fx[O + "/" + n] = urlset([f"{O}/2025/01/post-{i}-press-trip" for i in range(500)])
        calls = []

        class Stub(rt.Research):
            def __init__(self):
                self.domain = D
                self.blocked = False
                self.capped = False
                self.thorough = True
                self.site = {"search_log": [], "fetched_text_references": []}

            def checkpoint(self):
                pass

            def fetch(self, url, purpose):
                calls.append(url)
                if url not in fx:
                    return {"url": url, "result": "404"}
                p = rt.ROOT / (str(abs(hash(url))) + ".xml")
                p.write_text(fx[url])
                return {"url": url, "result": "ok", "raw_file": p.name}

        Stub().crawl_sitemaps(O)
        fetched = set(calls)
        self.assertIn(O + "/page-sitemap.xml", fetched)
        self.assertIn(O + "/contributor-sitemap.xml", fetched)
        self.assertFalse(any(k in u for u in fetched for k in ("post-sitemap", "category-sitemap", "news-sitemap", "/2025/01/")))
        for u in ("/about", "/write-for-us", "/contact", "/guest-post-guidelines"):
            self.assertIn(O + u, fetched)
        self.assertNotIn(O + "/privacy-policy", fetched)
        self.assertLessEqual(len(calls), 12)
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
