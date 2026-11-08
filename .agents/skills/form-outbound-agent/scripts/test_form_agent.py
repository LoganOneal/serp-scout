"""Offline tests for forms_api.py and form_browser.py: python3 test_form_agent.py

A fake outreach API and fake contact forms run on localhost. The browser cases need Google Chrome.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TMP = Path(tempfile.mkdtemp(prefix="form-agent-test-"))
os.environ.update({
    "GENERATOR_SECRET": "test-secret",
    "FORM_AGENT_DIR": str(TMP / "journal"),
    "FORM_BROWSER_PORT": "4338",
    "FORM_AGENT_NAME": "test-agent",
    "HHT_BROWSER_SETTLE_MS": "200",
})

FORM = {
    "id": "11111111-1111-4111-8111-111111111111",
    "domain": "example-blog.com",
    "form_url": "http://127.0.0.1:{port}/contact",
    "persona": "claire",
    "persona_name": "Claire Bennett",
    "site_rules": "No links.",
    "reviewer_note": None,
    "claim_token": "22222222-2222-4222-8222-222222222222",
    "fields": [
        {"label": "Name", "answer": "Claire Bennett", "required": True, "name": "name"},
        {"label": "Topic", "answer": "Travel", "required": True, "kind": "select", "options": ["Travel", "Other"]},
        {"label": "Message", "answer": "Hi; I'd love to pitch a post about hotel hot tubs.", "required": True,
         "max_chars": 500, "kind": "textarea"},
        {"label": "Website", "answer": "", "required": False},
    ],
}


class FakeApi(BaseHTTPRequestHandler):
    queue: list = []
    reports: list = []

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.headers.get("authorization") != "Bearer test-secret":
            return self.reply(401, {"error": "Unauthorized"})
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path == "/api/generator/forms/claim":
            return self.reply(200, {"form": FakeApi.queue.pop(0) if FakeApi.queue else None})
        if self.path.endswith("/outcome"):
            message = BytesParser(policy=email_policy).parsebytes(
                b"content-type: " + self.headers["content-type"].encode() + b"\r\n\r\n" + raw)
            fields, files = {}, {}
            for part in message.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if part.get_filename():
                    files[name] = part.get_content()
                else:
                    fields[name] = part.get_content()
            FakeApi.reports.append({"fields": fields, "files": files})
            status = fields["status"]
            return self.reply(200, {"duplicate": False, "form": {
                "domain": FORM["domain"], "status": status, "outcome_code": fields.get("outcome_code")}})
        self.reply(404, {"error": "not found"})


PAGES = {
    "/contact": """<form method=post action=/sent>
        <label for=n>Your name *</label><input id=n name=name required>
        <label for=t>Topic *</label><select id=t name=topic required><option value="">Pick</option><option>Travel</option><option>Other</option></select>
        <label for=m>Message *</label><textarea id=m name=message required></textarea>
        <label for=w>Website</label><input id=w name=website>
        <button type=submit>Send message</button></form>""",
    "/captcha": """<form method=post action=/sent><label for=n>Name</label><input id=n name=name>
        <div class="g-recaptcha" data-sitekey="x"></div><label><input type=checkbox name=r> I'm not a robot</label>
        <button type=submit>Send</button></form>""",
    "/login": """<p>You must be logged in to submit a pitch.</p><form><input name=user><input type=password name=pass>
        <button>Sign in</button></form>""",
    "/short": """<form method=post action=/sent><label for=m>Message</label><textarea id=m name=message maxlength=10></textarea>
        <button type=submit>Send</button></form>""",
}


class FakeSite(BaseHTTPRequestHandler):
    posts: list = []

    def log_message(self, *args):
        pass

    def page(self, body):
        data = f"<!doctype html><html><head><title>Fake</title></head><body>{body}</body></html>".encode()
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.page(PAGES.get(self.path, "<p>missing</p>"))

    def do_POST(self):
        FakeSite.posts.append(self.rfile.read(int(self.headers.get("content-length") or 0)).decode())
        self.page("<h1>Thank you!</h1><p>Your message has been sent.</p>")


def start(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


API_SERVER = start(FakeApi)
SITE_SERVER = start(FakeSite)
SITE = f"http://127.0.0.1:{SITE_SERVER.server_port}"
os.environ["OUTREACH_BASE"] = f"http://127.0.0.1:{API_SERVER.server_port}"

sys.path.insert(0, str(HERE))
import forms_api  # noqa: E402

BROWSER = [sys.executable, str(HERE / "form_browser.py")]


def run_api(*argv):
    out = io.StringIO()
    with redirect_stdout(out):
        code = forms_api.main(list(argv))
    return code, out.getvalue()


def browser(*argv):
    result = subprocess.run([*BROWSER, *argv], capture_output=True, text=True, timeout=120)
    try:
        return result.returncode, json.loads(result.stdout)
    except json.JSONDecodeError:
        return result.returncode, {"raw": result.stdout + result.stderr}


def claimed_journal():
    form = json.loads(json.dumps(FORM).replace("{port}", str(SITE_SERVER.server_port)))
    FakeApi.queue = [form]
    code, out = run_api("claim")
    assert code == 0, out
    return Path(out.splitlines()[0].split(": ", 1)[1])


def shot(path: Path) -> str:
    path.write_bytes(b"\xff\xd8\xff\xe0" + b"0" * 100)
    return str(path)


class ApiTests(unittest.TestCase):
    def setUp(self):
        FakeApi.reports.clear()
        shutil.rmtree(TMP / "journal", ignore_errors=True)

    def test_claim_journals_the_form_and_prints_the_brief(self):
        journal = claimed_journal()
        claim = json.loads((journal / "claim.json").read_text())
        self.assertEqual(claim["form"]["claim_token"], FORM["claim_token"])
        self.assertEqual(claim["agent"], "test-agent")
        _, out = run_api("pending")
        self.assertIn("example-blog.com", out)

    def test_empty_queue_exits_3(self):
        FakeApi.queue = []
        code, out = run_api("claim")
        self.assertEqual(code, 3)
        self.assertIn("Nothing to claim", out)

    def test_report_keeps_semicolons_and_sends_files_once(self):
        journal = claimed_journal()
        code, _ = run_api("report", str(journal), "needs_human", "--code", "form_error",
                          "--reason", "Too long; limit is 300", "--filled", shot(journal / "f.jpg"))
        self.assertEqual(code, 0)
        report = FakeApi.reports[-1]
        self.assertEqual(report["fields"]["reason"], "Too long; limit is 300")
        self.assertEqual(report["fields"]["claim_token"], FORM["claim_token"])
        self.assertIn("filled_screenshot", report["files"])
        # A second run does not call the API again.
        code, out = run_api("report", str(journal), "needs_human", "--code", "form_error", "--reason", "x")
        self.assertEqual(len(FakeApi.reports), 1)
        self.assertIn("Already reported", out)
        _, out = run_api("pending")
        self.assertIn("No unreported claims", out)

    def test_report_validates_before_calling(self):
        journal = claimed_journal()
        with self.assertRaises(SystemExit):
            run_api("report", str(journal), "submitted", "--filled", shot(journal / "f.jpg"))
        with self.assertRaises(SystemExit):
            run_api("report", str(journal), "needs_human", "--code", "captcha")
        self.assertEqual(FakeApi.reports, [])

    def test_pending_flags_a_clicked_submit(self):
        journal = claimed_journal()
        (journal / "submit-clicked.json").write_text("{}")
        code, out = run_api("pending")
        self.assertEqual(code, 4)
        self.assertIn("SUBMIT WAS CLICKED", out)


@unittest.skipUnless(Path("/Applications/Google Chrome.app").exists(), "needs Google Chrome")
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code, out = browser("start")
        assert code == 0, out

    @classmethod
    def tearDownClass(cls):
        browser("stop")

    def setUp(self):
        FakeSite.posts.clear()
        browser("reset")

    def test_fills_from_the_journal_and_submits_once(self):
        journal = claimed_journal()
        code, page = browser("open", f"{SITE}/contact")
        self.assertEqual(page["status"], 200)
        self.assertEqual(page["signals"], {"captcha": [], "login": [], "payment": []})
        _, found = browser("inspect")
        targets = {c["label"]: c["target"] for c in found["controls"]}
        self.assertEqual(targets["Message *"], "name=message")
        self.assertIn("Send message", found["buttons"])
        for target, index in (("name=name", 0), ("name=topic", 1), ("name=message", 2)):
            code, result = browser("fill", target, "--journal", str(journal), "--field", str(index))
            self.assertEqual(code, 0, result)
        code, result = browser("fill", "name=website", "--journal", str(journal), "--field", "3")
        self.assertIn("skipped", result)
        code, result = browser("screenshot", str(journal / "filled.jpg"))
        self.assertTrue((journal / "filled.jpg").stat().st_size > 1000)
        code, after = browser("submit", "Send message", "--journal", str(journal))
        self.assertEqual(code, 0, after)
        self.assertIn("Thank you", after["text"])
        self.assertTrue((journal / "submit-clicked.json").exists())
        self.assertEqual(len(FakeSite.posts), 1)
        self.assertIn("message=Hi%3B+I%27d+love", FakeSite.posts[0])
        code, again = browser("submit", "Send message", "--journal", str(journal))
        self.assertEqual(code, 1)
        self.assertIn("already clicked", again["error"])
        self.assertEqual(len(FakeSite.posts), 1)

    def test_flags_captcha_and_login(self):
        _, page = browser("open", f"{SITE}/captcha")
        self.assertTrue(page["signals"]["captcha"])
        _, page = browser("open", f"{SITE}/login")
        self.assertTrue(page["signals"]["login"])

    def test_reports_truncation_by_page_maxlength(self):
        journal = claimed_journal()
        browser("open", f"{SITE}/short")
        _, result = browser("fill", "name=message", "--journal", str(journal), "--field", "2")
        self.assertTrue(result["truncated_by_page"])


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
