# Contract fixtures

Captured provider payloads, used by `contracts.test.ts` to prove that the
adapter reads the fields the API actually returns.

Each file wraps its payload:

```json
{
  "__meta": {
    "verified": false,
    "capturedAt": null,
    "source": "transcribed from DataForSEO documentation -- NOT verified against the live API"
  },
  "payload": { ... }
}
```

## Why `verified` matters

The files currently in this directory were **hand-transcribed from documentation**,
not captured from the live API. That means they encode *what we believe the API
returns*, which is exactly the belief that produced Trap 1 — reading
`referring_domains` off `bulk_ranks`, where it does not exist, and getting `null`
for every domain for months without an error.

A test written against a transcribed fixture agrees with whatever we already
believe. It cannot catch the case where the belief is wrong. So
`contracts.test.ts` contains one test that **fails while `verified` is false**.
That failure is not a broken build — it is the suite refusing to claim Trap 1 is
guarded when it isn't.

## Making them real

```
# add DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD to .env first
pnpm probe:dfs
```

The probe checks the free `/appendix/user_data` endpoint for balance and account
status, prints an itemised cost estimate (~$0.08), waits for you to confirm, then
overwrites every file here with a real response and flips `verified` to true.

If a field assertion breaks at that point, **that is the mechanism working.**
Fix the adapter, not the fixture.
