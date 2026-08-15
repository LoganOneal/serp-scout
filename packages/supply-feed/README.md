# @rnr/supply-feed

Publish your directory site's supply — hotel rooms, product listings, whatever
you have inventory of — as a read-only HTTP feed.

**Zero runtime dependencies.** Node ≥ 18. Works under Next.js, Express, Hono,
Remix, Deno, Bun, Cloudflare Workers and Vercel Edge, because the core is a
plain `(Request) => Response` function.

---

## Why this exists

The system that consumes this feed generates keyword targets from a grid: 195
localities × 5 patterns = **975 keywords** for a hotel directory — produced with
no knowledge of whether you have one listing in Boise or none.

Without this feed it will decide to **build a page** for a locality with no
inventory, and **buy Google Ads clicks** that land on an empty result set.

So supply is not a display feature here. It is a gate, and this package is what
opens and closes it.

---

## Install

```sh
npm install @rnr/supply-feed                                    # npm private registry
npm install git+https://github.com/<org>/rank-and-rent.git#path:/packages/supply-feed
```

Either route works. `dist/` is not committed; the `prepare` script builds it on
install, which is why TypeScript is a **dev**Dependency here — dev dependencies
are not installed transitively, so nothing lands in your runtime tree.

## Write one function

```ts
// lib/supply-feed.ts
import { createSupplyFeed } from '@rnr/supply-feed'

export const feed = createSupplyFeed({
  token: process.env.SUPPLY_FEED_TOKEN,

  async fetchPage({ cursor, limit, since }) {
    const rows = await db.room.findMany({
      where: since ? { updatedAt: { gt: new Date(since) } } : {},
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { property: true },
    })

    return {
      items: rows.map((r) => ({
        id: r.id,                                   // stable, and YOURS
        supplierId: r.property.id,
        supplierName: r.property.name,
        title: r.name,
        url: `https://hotelhottubs.com/hotels/${r.property.slug}#${r.id}`,
        affiliateUrl: r.bookingUrl,
        location: { city: r.property.city, region: r.property.state, country: 'US' },
        attributes: { in_room_hot_tub: r.hasInRoomHotTub, occupancy: r.maxOccupancy },
        priceMicros: r.nightlyRateCents * 10_000,   // INTEGER micros. 1_000_000 = $1.00
        currency: 'USD',
        available: r.active,
        updatedAt: r.updatedAt.toISOString(),
      })),
      // null means "last page". Return the last row's cursor otherwise.
      nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    }
  },

  async counts() {
    return {
      totalItems: await db.room.count(),
      totalSuppliers: await db.property.count(),
    }
  },
})
```

## Mount it

**Next.js App Router** — one file, three lines:

```ts
// app/api/supply/[endpoint]/route.ts
import { toRouteHandlers } from '@rnr/supply-feed'
import { feed } from '@/lib/supply-feed'

export const { GET, HEAD, POST } = toRouteHandlers(feed)
```

**Express:**

```ts
import { toExpressHandler } from '@rnr/supply-feed'
app.use('/api/supply', toExpressHandler(feed))
```

**Anything else** — `feed.handler` is a `(Request) => Promise<Response>`.

Then set `SUPPLY_FEED_TOKEN` to a long random string and give the same value to
the consumer. Routing is by the **last path segment**, so any mount point works.

## Verify

```sh
curl -H "Authorization: Bearer $SUPPLY_FEED_TOKEN" https://yoursite.com/api/supply/manifest
```

```jsonc
{
  "schemaVersion": 1,
  "totalItems": 5231,
  "totalSuppliers": 418,
  "invalidItems": 3,
  "invalidSamples": [{ "id": "rm_991", "problem": "missing url" }]
}
```

---

## The three endpoints

| Endpoint | Returns |
|---|---|
| `GET /manifest` | Counts, schema version, and the validation report |
| `GET /items?cursor=&limit=&since=` | A cursor-paginated page of items |
| `GET /health` | Liveness plus an auth check. No data. |

There is no fourth, and there is no write path. Your site owns supply; the
consumer holds a read model. A second writable copy of a catalogue is two
catalogues that disagree.

### `/manifest` is the important one

Without a total count, a sync that pulls 4,000 of your 5,231 items is
**indistinguishable from a catalogue that shrank to 4,000** — and the consumer
would mark 1,231 listings as gone, dropping their localities out of coverage and
flipping "build this page" into "no supply here" overnight.

`invalidItems` is served rather than hidden for the same reason: those are your
rows that failed validation and were **not** served. Three listings nobody can
find is worth knowing about.

### Cursors, not offsets

`?offset=200` is only stable if nothing is written between pages. A catalogue
being edited while the consumer walks it shifts rows across the offset boundary —
some returned twice, some never returned — and nothing announces either. Order by
`(updatedAt, id)` and return the last row's id as `nextCursor`.

**`nextCursor: null` is the only stop signal.** An empty `items` array with a
live cursor is legal (every row in that page failed validation) and the walk
continues.

---

## Rules this package follows

**Reject, never repair.** A listing missing a `url` could be given one by
convention; a `priceMicros` of `29.99` could be multiplied by a million. Both
repairs produce rows that look correct and are wrong — a 404 for a searcher, a
$0.00003 median order value that goes on to authorise ad spend. Malformed items
are excluded and **counted in the manifest**.

**Fail closed.** No `token` configured means every endpoint returns **503**, not
an open catalogue. An open endpoint returns 200 exactly like a working one, so
the mistake would never surface on its own.

**`id` is yours.** The consumer never mints one. A synthesised key creates
duplicates the moment your ordering changes, and they look exactly like new
inventory.

**Money is integer micros.** `1_000_000` = $1.00. Never a float — `29.99` in
binary floating point is not $29.99, and a catalogue's worth of those rounds into
a median that is quietly wrong.

---

## Item shape

```ts
interface SupplyItem {
  id: string                 // stable, yours, never synthesised
  supplierId: string         // hotel property / vendor
  supplierName: string
  title: string
  url: string                // absolute http(s)
  affiliateUrl?: string      // the monetising link, when it differs
  location?: {               // omit entirely for a non-geographic catalogue
    city: string
    region?: string          // "NV"
    country: string          // ISO-3166 alpha-2
    lat?: number
    lon?: number
  }
  attributes?: Record<string, string | number | boolean>
  priceMicros?: number       // integer micros; requires `currency`
  currency?: string          // ISO-4217
  available?: boolean        // omitted = UNKNOWN, which is not false
  images?: string[]
  updatedAt: string          // ISO 8601; drives the cursor and `since`
}
```

`attributes` is free-form on purpose. What makes an item findable here is an
in-room hot tub; on the next site it is a peptide's form and dosage. A fixed
column set would be wrong for both within a month.

`available` omitted means unknown, and the consumer counts items and *available*
items separately. Do not send `false` to mean "we didn't check".

## Config

| Option | Default | Notes |
|---|---|---|
| `token` | — | **Required.** Unset ⇒ 503 on every endpoint |
| `fetchPage` | — | **Required.** `{cursor, limit, since}` → `{items, nextCursor}` |
| `counts` | — | **Required.** Powers the manifest |
| `defaultLimit` | `200` | Page size when the caller does not ask |
| `maxLimit` | `1000` | Hard ceiling; a clamp sets `x-supply-limit-clamped` |
| `rateLimitPerMinute` | `120` | Per token, per instance. `0` disables |

## Build

```sh
node ./scripts/build.mjs     # -> dist/{esm,cjs,types}
```

Uses the TypeScript already in the repo — no bundler, no build-tool dependency.
