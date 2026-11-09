---
name: form-outbound-agent
description: "Use when Kai asks to submit approved contact-form pitches (\"run form outbound\", \"submit the approved forms\"). Claims forms Kai approved in the outreach app's Form outbound section, fills them in a real Chrome as Claire Bennett, screenshots before and after, submits once, and reports the outcome. Sets aside CAPTCHAs, logins, payments and mismatched forms as needs_human and moves on. Never approves, never resubmits, never solves CAPTCHAs."
---

# Form outbound agent

Kai approves contact-form pitches in the outreach app at `/forms`. This skill is the browser
agent that submits them. The API contract is `docs/FORMS.md` in the outreach repo; this file is
the procedure. Every form is submitted as **Claire Bennett**, using the approved answers exactly.

Two scripts do the mechanical parts, so answers are never retyped and submit is never clicked twice:

- `scripts/forms_api.py`: claim, report, pending, list. Keeps a journal per claim under
  `exports/form-outbound/<domain>/<time>/` (gitignored): `claim.json`, screenshots,
  `submit-clicked.json`, `report-response.json`.
- `scripts/form_browser.py`: one headless Chrome (installed Chrome, its own user agent, no stealth)
  behind `start`, `open`, `inspect`, `fill`, `screenshot`, `submit`, `text`, `reset`, `stop`.

Needs Python 3.10+, Google Chrome, and `pip install requests playwright` (the browser uses the
installed Chrome, so `playwright install` is not needed).

Run both from the repo root as `python3 .agents/skills/form-outbound-agent/scripts/<script> ...`.
Below, `API` and `BR` stand for those two commands.

## Hard rules

Stop working on a form and report `needs_human` instead of working around any of these:

| Situation | Code |
|---|---|
| Any CAPTCHA or human check: reCAPTCHA, hCaptcha, Turnstile, "I'm not a robot", image grids, Cloudflare "just a moment" | `captcha` |
| Sign in, sign up, register, or an account needed to reach or send the form | `account_required` |
| A fee, card fields, checkout, "pay to submit", sponsored-post pricing | `payment_required` |
| A required input no draft field answers, or labels that clearly do not match the draft (wrong form, advertising form) | `form_changed` |
| The site rejects the submission with a validation message the approved answers cannot satisfy (e.g. a lower length limit) | `form_error` |
| 403, WAF block page, form missing, page will not load | `blocked` |
| Anything ambiguous after clicking submit: 5xx page, blank page, no message, timeout | `other` |

Never solve or bypass a CAPTCHA. Never create an account or sign in. Never pay or type card
details. Never invent an answer, paraphrase, or shorten one; `fill` only types approved answers.
Click submit at most once per claim (`submit` refuses a second click). One form at a time:
claim, finish, report, then claim the next. A failed form never stops the run.

`signals` in `open`, `inspect` and `submit` output flag likely CAPTCHA, login and payment
elements. They are hints. Look at the page text and inputs and decide; when in doubt, it is
`needs_human`.

## Procedure

### 0. Setup

```bash
export OUTREACH_BASE=https://outreach-ten-plum.vercel.app   # local test: http://127.0.0.1:3000
# GENERATOR_SECRET from the environment, or the owner-only file push_drafts.py uses.
BR start
API pending
```

If `pending` lists anything, resolve it before claiming new work:

- `SUBMIT WAS CLICKED`: the previous run may have sent it. Never open the form again or resubmit.
  If the journal has `confirmation.jpg`, look at it: when it clearly shows the site's success
  message, report `submitted` with `filled.jpg` and `confirmation.jpg`, the message as
  `--confirmation-text`, and `--reason "Recovered after an agent restart"`. Otherwise report
  `needs_human --code other --reason "Agent stopped after clicking submit on <time>; outcome
  unknown. Check the site before retrying."` with whatever screenshots the journal has.
- `not submitted`: report `needs_human --code other --reason "Agent stopped before submitting."`
  so Kai can send it back. (Kai can also release it from `/forms`.)

### 1. Claim

```bash
API claim
```

Exit code 3 / "Nothing to claim" means the queue is empty: go to step 8. Otherwise it prints the
journal directory (`J` below), the form URL, site rules, the reviewer note, and the draft fields
by index with their answers, limits and options. Read the site rules and reviewer note; they
can tell you which button to use or what to leave alone.

### 2. Open and look

```bash
BR open "<form_url>"
BR inspect
```

If the page shows any hard-rule situation, take `BR screenshot J/blocked.jpg`, report it (step 7)
and go back to step 1. A cookie banner is not a blocker: if it covers the form and has a
"Reject"/"Necessary only" button, prefer that; otherwise close it if possible. Never accept
marketing consent on Kai's behalf.

### 3. Map draft fields to inputs

Match each draft field to an input from `inspect` by label first, then `name`. Every required
input on the page must get a draft field. Optional inputs with no draft field stay empty.
A newsletter or marketing opt-in checkbox stays unchecked unless a draft field answers it.
If a required input has no draft field, or the draft has a required field the page lacks,
that is `form_changed`.

### 4. Fill

```bash
BR fill name=message --journal J --field 5
```

One call per field. `fill` prints `truncated_by_page: true` if the page's own maxlength cut the
answer: that is `form_error` (do not submit a truncated pitch). For selects and radios the answer
is the visible option text; checkboxes take yes/no.

### 5. Screenshot, submit once, screenshot

```bash
BR screenshot J/filled.jpg
BR submit "Send message" --journal J
BR screenshot J/confirmation.jpg
```

Use the exact button text from `inspect`. Read the `submit` output (status, title, text,
signals). Decide:

- Clear success ("thank you", "message sent", "we'll be in touch"): `submitted`.
- A validation message (field errors, "too long", "invalid email"): `form_error`, quoting it.
- A CAPTCHA or login that appeared only after clicking: its code, and say submit was clicked.
- 4xx/5xx page, blank page, no visible change, or anything you are unsure about: `other`.
  Do not click again; Kai decides whether to retry.

### 6. Report

```bash
API report J submitted --filled J/filled.jpg --confirmation J/confirmation.jpg \
  --confirmation-text "<the site's confirmation message, verbatim>"
API report J needs_human --code form_error --reason "<one or two sentences Kai can act on>" \
  --filled J/filled.jpg [--confirmation J/confirmation.jpg]
```

Reasons say what you saw and what Kai should do (for example: "Site says the message must be 300
characters or fewer; ours is 450. Shorten it and send it back."). If `report` prints "uncertain",
run the same command again: repeating a report is safe. A 409 means the claim was released or
taken over: stop on that form, mention it in the summary, and do not submit it.

### 7. Next

`BR reset` between sites (fresh cookies), then back to step 1.

### 8. Finish

`BR stop`, then regenerate the master list of everything waiting on Kai, from the serp-scout
repo root: `python3 .agents/skills/guest-post-pitches/scripts/manual_queue.py`. That writes
`exports/guest-post-outreach/Manual Intervention Queue.md`. Then give Kai one summary table: domain, outcome, code, and reason. Note anything
that needs his decision (every `needs_human`, and any `other` where submit was clicked).

## Parallel runs

Several agents can run this loop at once against the same queue; claims never overlap. Give each
one its own `FORM_AGENT_NAME` and `FORM_BROWSER_PORT` (for example 4330, 4331). The journal
directory can be shared.

## Testing without real sites

The outreach repo has practice forms (`scripts/form-sandbox/` there; see "Testing locally with the
form sandbox" in its `docs/FORMS.md`). Point `OUTREACH_BASE` at the local app with a local
`GENERATOR_SECRET`, approve the seeded drafts at `/forms`, and run this procedure. Expected:
`normal` submitted; `captcha`, `login`, `fee`, `changed` needs_human with no POST to the site;
`error` form_error; `flaky` other, each submitted at most once.

`python3 .agents/skills/form-outbound-agent/scripts/test_form_agent.py` runs the offline tests
(needs Google Chrome for the browser cases).
