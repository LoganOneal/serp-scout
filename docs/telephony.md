# Telephony — your Twilio numbers into Retell

The numbers belong to the business and stay in Twilio. Retell answers them over a
**Twilio Elastic SIP Trunk**. This is the supported path and Retell's docs call it the
recommended one.

There is no "connect your Twilio account" button that does this for you. The trunk is
a prerequisite, and `termination_uri` is a **required** field on Retell's import API —
so you cannot skip it even though this is an inbound-only use case.

```
 caller
   │
   ▼
 Twilio DID ──attached to──► Elastic SIP Trunk
                                  │
              origination ────────┤  sip:sip.retellai.com      (inbound: Twilio → Retell)
              termination ────────┤  yourtrunk.pstn.twilio.com (outbound: Retell → Twilio)
              disaster recovery ──┘  {PUBLIC_BASE_URL}/api/twilio/failover
                                  │
                                  ▼
                            Retell agent
                                  │
                    POST /api/retell/inbound  → dynamic_variables + metadata.site_id
```

Origination and termination are opposite directions and people mix them up constantly:

| | Direction | Who needs it | Needed for inbound HVAC? |
|---|---|---|---|
| **Origination** | Twilio → Retell | Twilio trunk config | **Yes** — this is the whole thing |
| **Termination** | Retell → Twilio | Retell import call | Required field regardless; only *used* for outbound |

---

## Read this before you touch a live number

**Attaching a number to a trunk removes it from Programmable Voice.** Whatever that
number's Voice configuration does today — forwards to the owner's cell, runs a Studio
flow, hits an answering service — stops the moment the number joins the trunk. These
are working business numbers, so:

1. **Print the current config before changing anything.** The provisioning script does
   this and refuses to continue without `--confirm`. If the number currently forwards
   to a cell, that cell number is both what you're about to route away *and* the right
   failover target.
2. **Configure the Disaster Recovery URL first** (next section). Not after.
3. **Do one number, off-hours, and place a real call before doing the rest.**

Retell's docs are blunt about why that last one matters: *"Retell will not be able to
know if the setup you provide works or not until a call is made."* Nothing validates
this configuration except a phone call, and the community has threads about trunks
that connect ~50% of the time from a single wrong field.

---

## The Disaster Recovery URL is a hard requirement, not a nice-to-have

Without it, a Retell outage or a SIP misconfiguration is a **dead phone line**. For an
HVAC business in July, that is the most expensive possible failure — and it fails
silently from the caller's side, who just hears nothing and calls a competitor.

Twilio's trunk-level **Disaster Recovery URL** fires when delivery to *all* configured
origination URIs fails, and it expects TwiML back. So point it at your own app:

```
Trunk → Disaster Recovery URL → POST {PUBLIC_BASE_URL}/api/twilio/failover
```

Twilio POSTs `To` and `From`, so one URL serves every site — resolve `To` →
`sites.tracking_number` → return a `<Dial>` to that site's `on_call_number`. Exactly
the same resolution shape as the Retell inbound webhook, over the same table.

```xml
<Response>
  <Say>One moment please, connecting you.</Say>
  <Dial timeout="25">+14145550199</Dial>
</Response>
```

Fall back to `<Say>` plus voicemail if the site has no `on_call_number` — and log a
`webhook_events` row with type `twilio_failover` every single time this fires. **A
failover that nobody notices is an outage you never learn about.**

**Know its limit.** The DR URL triggers on *delivery* failure. It does not fire when
Retell answers and the agent is broken — wrong greeting, dead air, a bad prompt deploy.
That class needs the call-level monitoring already in the CRM plan (abandon rate,
`disconnection_reason`, e2e p95). This is infrastructure failover only.

---

## Setup

### 1. One trunk, reused for every site

Elastic SIP Trunking → Create trunk. One trunk carries all sites; each site is a
number on it. Per-site behavior comes from the inbound webhook resolving `to_number`,
not from trunk topology.

### 2. Termination — pick the regional URI, it costs you latency

Twilio gives you `yourtrunk.pstn.twilio.com` plus **localized** variants
(`.pstn.us1.twilio.com`, etc.). Use the one nearest Retell's SBC region, not the
default. A mismatched region silently adds a cross-country hop to every single turn,
which is precisely the trap called out in `voice-agent-plan.md`.

**And you can now measure this rather than guess.** You're already persisting Retell's
per-call `latency_e2e_p50_ms` / `p95` on the `calls` row — so place ten calls on one
termination URI, ten on another, and compare. That is a real A/B test on a number most
people accept from a datasheet.

Gotchas from Retell's troubleshooting notes: **no spaces** in the URI, and the SIP
credential **username** is the credential's username, not its friendly display name.

### 3. Termination auth — credentials, not IP ACL

Two options: whitelist Retell's SBC CIDR `18.98.16.120/30`, or create a credential
list with a username and password.

**Use credentials.** Retell publishes several CIDRs across regions
(`18.98.16.120/30`, `3.42.144.0/23`, `153.57.128.0/18`) and an IP range change breaks
you silently and remotely. A username and password in your env is a dependency you
control.

This only gates *outbound* (Retell → Twilio), which you don't do yet. Set it anyway —
"we're on our way" callbacks are the obvious next feature, and doing it later means
re-touching a live trunk.

### 4. Origination — this is the inbound path

Origination URI: **`sip:sip.retellai.com`** (append `;transport=tcp` if you need to
pin transport). This is the line that makes calls reach Retell at all.

### 5. Attach the numbers

Trunk → Numbers → add your existing DIDs. This is the step that takes them off
Programmable Voice.

### 6. Import each number into Retell

`POST /import-phone-number`:

```json
{
  "phone_number": "+14145550134",
  "termination_uri": "rnr-hvac.pstn.us1.twilio.com",
  "sip_trunk_auth_username": "...",
  "sip_trunk_auth_password": "...",
  "nickname": "kenoshaair.com — Kenosha WI / HVAC",
  "inbound_agents": [{ "agent_id": "agent_xxx", "weight": 1.0 }],
  "inbound_webhook_url": "https://yourhost/api/retell/inbound",
  "allowed_inbound_country_list": ["US"],
  "transport": "TCP"
}
```

Two fields deserve attention:

**`inbound_webhook_url` is settable here.** That is significant: the multi-tenant
webhook gets wired at provisioning time, in the same call that creates the number, so
the "forgot to paste the URL in the dashboard" failure mode is *structurally* gone.
The `sites.first_webhook_at` banner from the CRM plan drops from primary defense to
backstop — which is where a backstop belongs.

**`allowed_inbound_country_list: ["US"]`** is cheap toll-fraud protection on a number
you're about to point at a paid AI agent. Set it.

Note the same URL serves every site — resolution is by `to_number`, so there is
nothing per-number to configure.

---

## Provisioning script

`pnpm sites:provision <domain> --number +14145550134 [--confirm]`

1. Resolve the `sites` row by domain; refuse if missing.
2. **Fetch and print the number's current Twilio voice configuration.** Without
   `--confirm`, stop here — this is a live business number and you should read what
   you're about to overwrite.
3. Ensure the trunk exists (`TWILIO_TRUNK_SID`), verify origination URI and DR URL are
   set; refuse to continue if the DR URL is missing.
4. Attach the number to the trunk.
5. `POST /import-phone-number` with the site's nickname, agent, and inbound webhook URL.
6. Write `tracking_number`, `twilio_number_sid`, `retell_agent_id`,
   `retell_number_imported_at` onto the site row.
7. Print the verification checklist and the one manual step: **place a real call.**

Idempotent — re-running against an already-provisioned number reports state and
changes nothing. Step 3's refusal is deliberate: it makes the failover path impossible
to skip, in the same spirit as `runScan` refusing a non-`dataforseo` location code.

### Schema additions to `sites`

```ts
twilioNumberSid: text('twilio_number_sid'),
/** NULL = never imported into Retell. Another "not connected" signal, distinct
 *  from "imported but no webhook has ever arrived". */
retellNumberImportedAt: timestamp('retell_number_imported_at', { withTimezone: true }),
```

`on_call_number` (already in the plan) doubles as the Disaster Recovery target.

---

## SMS still works, and you want it on the same number

Elastic SIP Trunking is voice. Messaging on a trunk number stays available — it is
**not automatic**, you enable it explicitly per number where the market supports it —
and it does not route through the trunk.

That's a convenient outcome for `lead_deliveries`: send the contractor's lead-alert SMS
**from the same tracking number the customer dialed**. Their phone shows a text from
the number they already associate with the site, rather than from a random long code
that reads as spam.

So keep `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — you need the Messaging API for
lead delivery regardless of how voice is routed.

---

## Environment

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_TRUNK_SID=              # the one shared trunk
TWILIO_TERMINATION_URI=        # regional, e.g. rnr-hvac.pstn.us1.twilio.com
TWILIO_SIP_CRED_USERNAME=
TWILIO_SIP_CRED_PASSWORD=
RETELL_API_KEY=
RETELL_AGENT_ID=
PUBLIC_BASE_URL=               # ngrok/cloudflared in dev
```

`LIVE_CALLS_ENABLED` governs *spend*. Provisioning changes call routing on a live
business number, which is a different and arguably worse kind of irreversible — hence
the separate `--confirm` gate rather than reusing that flag.

---

## Verification, in order

1. `pnpm sites:provision` reports the number attached and imported.
2. **Call the number from a real cell phone.** Nothing before this proves anything.
3. `webhook_events` has a `call_inbound` row → the inbound webhook is wired.
4. The agent used the site's name → dynamic variables resolved.
5. `calls` reaches `ingest_state = 'analyzed'` and the recording is stored locally.
6. **Test the failover for real:** temporarily point origination at a bad URI, call,
   confirm you reach the on-call cell, then restore. Untested failover is not failover.
7. Compare `latency_e2e_p50_ms` against your termination-URI choice before rolling out
   the remaining numbers.

Only after step 7 do you provision site number two.

---

## Sources

[Retell — Connect to Twilio with elastic SIP trunking](https://docs.retellai.com/deploy/twilio) ·
[Retell — Custom telephony (SIP URIs, IP ranges)](https://docs.retellai.com/deploy/custom-telephony) ·
[Retell — Import Phone Number API](https://docs.retellai.com/api-references/import-phone-number) ·
[Twilio — Elastic SIP Trunking docs](https://www.twilio.com/docs/sip-trunking) ·
[Twilio — Configure a Disaster Recovery URL](https://support.twilio.com/hc/en-us/articles/14718831008795-How-to-Configure-a-Disaster-Recovery-URL-for-your-Elastic-SIP-Trunk) ·
[Twilio — Trunk resource API](https://www.twilio.com/docs/sip-trunking/api/trunk-resource) ·
[Twilio — Elastic SIP Trunking step-by-step setup](https://www.twilio.com/en-us/blog/elastic-sip-trunking-step-by-step-setup) ·
[Twilio — Test your Elastic SIP Trunk](https://www.twilio.com/docs/sip-trunking/trunk-verification) ·
[Twilio — Voice failover best practices](https://www.twilio.com/docs/voice/twilio-voice-failover-best-practices)
