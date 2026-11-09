"""Real-browser steps for the form outbound agent. One Chrome page, kept between commands.

    python3 form_browser.py start [--headed]   start the browser daemon (no-op if running)
    python3 form_browser.py open URL           load a page; prints status, title, text, signals
    python3 form_browser.py inspect            list inputs (target, label, type, required, max) and buttons
    python3 form_browser.py fill TARGET --journal DIR --field N
                                               put draft field N's answer from DIR/claim.json into TARGET
    python3 form_browser.py screenshot PATH    JPEG, full page (falls back to viewport when too large)
    python3 form_browser.py submit "BUTTON TEXT" --journal DIR
                                               writes DIR/submit-clicked.json, clicks once, waits, prints result
    python3 form_browser.py text               current page text and signals
    python3 form_browser.py reset              fresh browser context (cookies cleared)
    python3 form_browser.py stop

TARGET is what `inspect` prints: name=..., id=..., or nth=N (Nth input on the page).

Rules this tool keeps (same as browser_fetch.py): installed Google Chrome with its own user agent,
no stealth plugins, no CAPTCHA solving. `fill` only types an answer from the approved draft, so the
agent cannot paraphrase. `submit` clicks exactly once and records that it did before clicking.

Environment: FORM_BROWSER_PORT (default 4330), HHT_BROWSER_CHANNEL (default chrome).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT = int(os.environ.get("FORM_BROWSER_PORT", 4330))
SETTLE_MS = int(os.environ.get("HHT_BROWSER_SETTLE_MS", 2500))
NAV_TIMEOUT_MS = int(os.environ.get("HHT_BROWSER_TIMEOUT_MS", 30000))
MAX_SHOT_BYTES = int(3.5 * 1024 * 1024)

# Read in the page. Signals are hints for the agent; the agent still decides.
SIGNALS_JS = r"""
() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = document.body ? document.body.innerText : "";
  const out = { captcha: [], login: [], payment: [] };
  for (const f of document.querySelectorAll("iframe")) {
    const src = f.src || "";
    if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(src)) out.captcha.push("iframe " + src.slice(0, 80));
  }
  if (document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]")) out.captcha.push("captcha widget element");
  const cap = text.match(/i'?m not a robot|verify you are human|are you a robot|captcha|select all (images|squares)|just a moment|checking your browser/i);
  if (cap) out.captcha.push("text: " + cap[0]);
  if ([...document.querySelectorAll("input[type=password]")].some(visible)) out.login.push("visible password input");
  const log = text.match(/(sign|log) ?in to (submit|continue|post|pitch|contribute)|must (be )?(signed|logged) in|create an account|register to (submit|post|contribute)/i);
  if (log) out.login.push("text: " + log[0]);
  const ccFields = [...document.querySelectorAll("input")].filter((i) =>
    /cc-|card|cvc|cvv|expir|^exp$|\bexp\b|security.?code/i.test((i.autocomplete || "") + " " + (i.name || "") + " " + (i.id || "")) && visible(i));
  if (ccFields.length) out.payment.push(ccFields.length + " card-like inputs");
  const pay = text.match(/(submission|publishing|review|processing) fee|pay \$?\d+|\$\d+(\.\d\d)? (fee|to submit)|checkout|sponsored post (price|rate)/i);
  if (pay) out.payment.push("text: " + pay[0]);
  return out;
}
"""

INSPECT_JS = r"""
() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.innerText.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.innerText.trim() || "").join(" ");
    return el.getAttribute("aria-label") || el.placeholder || "";
  };
  const all = [...document.querySelectorAll("input, textarea, select")];
  const controls = all.map((el, nth) => {
    const type = el.tagName === "INPUT" ? (el.type || "text") : el.tagName.toLowerCase();
    const target = el.name && document.getElementsByName(el.name).length === 1 ? `name=${el.name}`
      : el.id ? `id=${el.id}` : `nth=${nth}`;
    return {
      target, type, label: labelFor(el).replace(/\s+/g, " ").slice(0, 120),
      required: el.required || el.getAttribute("aria-required") === "true",
      maxlength: el.maxLength > 0 ? el.maxLength : null,
      options: el.tagName === "SELECT" ? [...el.options].map((o) => o.text.trim()) : undefined,
      visible: visible(el), name: el.name || null,
    };
  }).filter((c) => c.type !== "hidden" && (c.visible || c.type === "radio" || c.type === "checkbox"));
  const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button]")]
    .filter(visible).map((b) => (b.innerText || b.value || "").trim()).filter(Boolean);
  return { forms: document.forms.length, controls, buttons };
}
"""


# ---------------------------------------------------------------- daemon

class Browser:
    def __init__(self, headed: bool):
        from playwright.sync_api import sync_playwright

        self.pw = sync_playwright().start()
        channel = os.environ.get("HHT_BROWSER_CHANNEL", "chrome")
        self.browser = self.pw.chromium.launch(channel=channel or None, headless=not headed)
        self.status = None
        self._new_context()

    def _new_context(self):
        self.context = self.browser.new_context(viewport={"width": 1200, "height": 900})
        self.page = self.context.new_page()
        self.status = None
        self.page.on("response", self._on_response)

    def _on_response(self, response):
        if response.request.is_navigation_request() and response.frame == self.page.main_frame:
            self.status = response.status

    def state(self):
        try:
            text = self.page.inner_text("body", timeout=5000)
        except Exception:
            text = ""
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return {
            "status": self.status,
            "url": self.page.url,
            "title": self.page.title(),
            "text": text[:2000],
            "signals": self.page.evaluate(SIGNALS_JS),
        }

    def locate(self, target: str):
        kind, _, value = target.partition("=")
        if kind == "name":
            return self.page.locator(f'[name="{value}"]').first
        if kind == "id":
            return self.page.locator(f'[id="{value}"]').first
        if kind == "nth":
            return self.page.locator("input, textarea, select").nth(int(value))
        raise ValueError(f"target must be name=..., id=... or nth=N, got {target}")

    # commands
    def open(self, url):
        self.page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        self.page.wait_for_timeout(SETTLE_MS)
        return self.state()

    def inspect(self):
        return {**self.page.evaluate(INSPECT_JS), "signals": self.page.evaluate(SIGNALS_JS)}

    def fill(self, target, value, kind):
        el = self.locate(target)
        tag = el.evaluate("e => e.tagName.toLowerCase()")
        input_type = el.evaluate("e => (e.type || '').toLowerCase()")
        if tag == "select":
            el.select_option(label=value)
            return {"ok": True, "target": target, "selected": value}
        if input_type == "checkbox":
            want = value.strip().lower() in ("yes", "true", "1", "checked", "on", "x")
            el.set_checked(want)
            return {"ok": True, "target": target, "checked": want}
        if input_type == "radio":
            name = el.get_attribute("name")
            radios = self.page.locator(f'input[type=radio][name="{name}"]')
            for i in range(radios.count()):
                radio = radios.nth(i)
                label = radio.evaluate(
                    "e => (e.labels && e.labels[0] ? e.labels[0].innerText : e.value || '').trim()")
                if label.lower() == value.strip().lower() or (radio.get_attribute("value") or "") == value:
                    radio.check()
                    return {"ok": True, "target": target, "chose": label}
            raise ValueError(f"No radio option matches {value!r}")
        el.fill(value)
        stored = el.input_value()
        return {"ok": stored == value, "target": target, "chars": len(stored),
                "truncated_by_page": len(stored) < len(value)}

    def screenshot(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=path, full_page=True, type="jpeg", quality=80)
        if Path(path).stat().st_size > MAX_SHOT_BYTES:
            self.page.screenshot(path=path, full_page=False, type="jpeg", quality=70)
        return {"ok": True, "path": path, "bytes": Path(path).stat().st_size}

    def submit(self, button, journal):
        marker = Path(journal) / "submit-clicked.json"
        if marker.exists():
            raise RuntimeError("submit was already clicked for this claim; never click twice")
        locator = self.page.get_by_role("button", name=button, exact=True)
        if locator.count() == 0:
            locator = self.page.locator(f'input[type=submit][value="{button}"]')
        if locator.count() == 0:
            raise ValueError(f"No button named {button!r}")
        marker.write_text(json.dumps({"clicked_at": datetime.now(timezone.utc).isoformat(),
                                      "button": button, "url": self.page.url}, indent=2) + "\n")
        before = self.page.url
        locator.first.click()
        try:
            self.page.wait_for_load_state("load", timeout=NAV_TIMEOUT_MS)
        except Exception:
            pass
        self.page.wait_for_timeout(SETTLE_MS)
        return {**self.state(), "navigated": self.page.url != before}

    def reset(self):
        self.context.close()
        self._new_context()
        return {"ok": True}

    def close(self):
        try:
            self.browser.close()
        finally:
            self.pw.stop()


def serve(headed: bool) -> None:
    holder: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            command = self.path.strip("/")
            try:
                if command == "stop":
                    result = {"ok": True}
                elif command == "ping":
                    result = {"ok": True}
                else:
                    result = getattr(holder["browser"], command)(**body)
                status = 200
            except Exception as error:  # report to the caller, keep the daemon alive
                result, status = {"error": f"{type(error).__name__}: {error}"}, 500
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            if command == "stop":
                raise SystemExit

    # Bind before launching Chrome so a busy port fails fast. Single-threaded on purpose:
    # Playwright's sync API is not thread-safe.
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    holder["browser"] = Browser(headed)
    try:
        server.serve_forever()
    except SystemExit:
        pass
    finally:
        holder["browser"].close()


# ---------------------------------------------------------------- client

def call(command: str, **body):
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/{command}", data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=NAV_TIMEOUT_MS / 1000 + 30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        return json.loads(error.read() or b'{"error": "daemon error"}')


def running() -> bool:
    try:
        return call("ping").get("ok", False)
    except (urllib.error.URLError, ConnectionError, TimeoutError):
        return False


def answer_for(journal: str, index: int) -> tuple[str, dict]:
    claim = json.loads((Path(journal) / "claim.json").read_text())
    fields = claim["form"]["fields"]
    if not 0 <= index < len(fields):
        sys.exit(f"--field must be 0..{len(fields) - 1}")
    return fields[index]["answer"], fields[index]


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    command, rest = argv[0], argv[1:]

    if command == "serve":
        serve("--headed" in rest)
        return 0
    if command == "start":
        if running():
            print("browser already running")
            return 0
        log = open(Path(os.environ.get("TMPDIR", "/tmp")) / f"form_browser_{PORT}.log", "ab")
        subprocess.Popen([sys.executable, __file__, "serve", *rest], stdout=log, stderr=log, start_new_session=True)
        for _ in range(180):  # Chrome can take a while to launch on a busy machine
            if running():
                print("browser started")
                return 0
            time.sleep(0.5)
        print("browser did not start; see the log in $TMPDIR", file=sys.stderr)
        return 1
    if not running():
        print("browser is not running; run: python3 form_browser.py start", file=sys.stderr)
        return 1

    def opt(name: str):
        return rest[rest.index(name) + 1] if name in rest else None

    if command == "open":
        result = call("open", url=rest[0])
    elif command == "stop":
        call("stop")
        for _ in range(120):  # closing Chrome can take a while
            if not running():
                print("browser stopped")
                return 0
            time.sleep(0.5)
        print("browser is still shutting down", file=sys.stderr)
        return 1
    elif command in ("inspect", "reset"):
        result = call(command)
    elif command == "text":
        result = call("state")
    elif command == "fill":
        journal, field = opt("--journal"), opt("--field")
        if not journal or field is None:
            sys.exit("fill TARGET --journal DIR --field N")
        value, meta = answer_for(journal, int(field))
        if value == "":
            print(json.dumps({"ok": True, "skipped": "empty answer, left blank"}))
            return 0
        result = call("fill", target=rest[0], value=value, kind=meta.get("kind"))
    elif command == "screenshot":
        result = call("screenshot", path=str(Path(rest[0]).resolve()))
    elif command == "submit":
        journal = opt("--journal")
        if not journal:
            sys.exit('submit "BUTTON TEXT" --journal DIR')
        result = call("submit", button=rest[0], journal=str(Path(journal).resolve()))
    else:
        print(__doc__)
        return 1
    print(json.dumps(result, indent=1))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
