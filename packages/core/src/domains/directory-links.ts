/**
 * Where else is this business listed?
 *
 * ==================== TWO KINDS OF LINK, NEVER MIXED ====================
 * `exact` links go to a specific record we hold an identifier for -- a Google
 * place_id or CID resolves to one profile and nothing else.
 *
 * `search` links are a query on a directory. They are useful and they are
 * guesses: a common business name in a big city returns a page of maybes.
 *
 * `confirmed` marks a directory the backlink index has actually seen linking to
 * this domain. That is evidence the listing exists; the link is still a search,
 * because the index gives us the referring DOMAIN and not the URL.
 *
 * The distinction is carried into the UI rather than flattened, because an
 * operator clicking "BBB" should know whether they are opening a record or a
 * search that may find nothing.
 * =======================================================================
 */

export type DirectoryLinkKind = 'exact' | 'search' | 'confirmed'

export interface DirectoryLink {
  label: string
  url: string
  kind: DirectoryLinkKind
  /** Shown on hover — says plainly what the link will and will not do. */
  hint: string
}

export interface DirectoryLinkInput {
  domain: string
  businessName?: string | null
  city?: string | null
  state?: string | null
  placeId?: string | null
  cid?: string | null
  /**
   * Citations the backlink index confirmed, with the page each one sits on.
   *
   * A bare host is still accepted for rows audited before `urlFrom` was
   * collected; those keep the old search behaviour rather than pretending to a
   * precision they do not have.
   */
  confirmedCitations?: Array<AuthorityCitationInput | string> | null
}

export interface AuthorityCitationInput {
  /** Referring host, e.g. 'bbb.org'. */
  domain: string
  /** The page the link is on. Null on rows audited before this was collected. */
  urlFrom?: string | null
  /** HTTP status the index last saw for that page. */
  pageStatus?: number | null
  /** The index no longer finds the link on that page. */
  isLost?: boolean | null
}

/**
 * A citation URL is offered as a clickable record only if it is likely to load.
 *
 * ==================== WHY THIS GATE EXISTS ====================
 * The complaint that prompted collecting URLs at all was "the links I click
 * don't work". Replacing an unreliable SEARCH with a confidently-wrong 404
 * would not fix that -- it would make it worse, because a link presented as an
 * exact record carries more authority than one presented as a guess.
 *
 * A citation whose page 404s, or that the index has since lost, still counts
 * toward the domain's history and stays visible in the profile. It just does
 * not get offered as somewhere to click.
 * ==============================================================
 */
export function isLinkableCitation(c: AuthorityCitationInput): boolean {
  if (!c.urlFrom || !/^https?:\/\//i.test(c.urlFrom)) return false
  if (c.isLost === true) return false
  if (c.pageStatus != null && (c.pageStatus < 200 || c.pageStatus >= 400)) return false
  return true
}

function normaliseCitations(
  input: Array<AuthorityCitationInput | string> | null | undefined,
): AuthorityCitationInput[] {
  return (input ?? []).map((c) => (typeof c === 'string' ? { domain: c } : c))
}

const q = (v: string): string => encodeURIComponent(v.trim())

const locality = (city?: string | null, state?: string | null): string =>
  [city, state].filter(Boolean).join(', ')

/**
 * Directories worth checking for a local business, with a search template.
 *
 * `host` is matched against confirmed citations so a directory the index has
 * already seen is promoted from a guess to evidence.
 */
const DIRECTORIES: Array<{
  label: string
  host: string
  build: (name: string, loc: string) => string
}> = [
  {
    label: 'BBB',
    host: 'bbb.org',
    build: (name, loc) => `https://www.bbb.org/search?find_text=${q(name)}&find_loc=${q(loc)}`,
  },
  {
    label: 'YellowPages',
    host: 'yellowpages.com',
    build: (name, loc) =>
      `https://www.yellowpages.com/search?search_terms=${q(name)}&geo_location_terms=${q(loc)}`,
  },
  {
    label: 'Yelp',
    host: 'yelp.com',
    build: (name, loc) => `https://www.yelp.com/search?find_desc=${q(name)}&find_loc=${q(loc)}`,
  },
  {
    label: 'Angi',
    host: 'angi.com',
    build: (name, loc) => `https://www.google.com/search?q=site:angi.com+${q(name)}+${q(loc)}`,
  },
  {
    label: 'Houzz',
    host: 'houzz.com',
    build: (name, loc) => `https://www.google.com/search?q=site:houzz.com+${q(name)}+${q(loc)}`,
  },
  {
    label: 'Manta',
    host: 'manta.com',
    build: (name, loc) => `https://www.google.com/search?q=site:manta.com+${q(name)}+${q(loc)}`,
  },
  {
    label: 'Chamber',
    host: 'chamber',
    build: (name, loc) => `https://www.google.com/search?q=${q(name)}+${q(loc)}+chamber+of+commerce`,
  },
  {
    label: 'Facebook',
    host: 'facebook.com',
    build: (name, loc) => `https://www.facebook.com/search/top?q=${q(`${name} ${loc}`)}`,
  },
]

/**
 * Every place worth looking for this business, best evidence first.
 *
 * The citation searches at the end are the most useful ones for an acquisition:
 * searching the bare DOMAIN finds pages that reference it, which is how you
 * discover listings nobody could have guessed the name of.
 */
export function buildDirectoryLinks(input: DirectoryLinkInput): DirectoryLink[] {
  const links: DirectoryLink[] = []
  const name = (input.businessName ?? '').trim()
  const loc = locality(input.city, input.state)
  const citations = normaliseCitations(input.confirmedCitations)
  const confirmed = new Set(citations.map((c) => c.domain.trim().toLowerCase()))
  /** Best linkable citation per host — the one the directory chip will open. */
  const linkableByHost = new Map<string, AuthorityCitationInput>()
  for (const c of citations) {
    if (!isLinkableCitation(c)) continue
    const host = c.domain.trim().toLowerCase()
    if (!linkableByHost.has(host)) linkableByHost.set(host, c)
  }

  // ---- Exact records, where an identifier resolves one profile ----
  if (input.placeId) {
    links.push({
      label: 'Google Business Profile',
      url: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(input.placeId)}`,
      kind: 'exact',
      hint: 'Opens this exact profile by place_id',
    })
  }
  if (input.cid) {
    links.push({
      label: 'Maps (CID)',
      url: `https://maps.google.com/?cid=${encodeURIComponent(input.cid)}`,
      kind: 'exact',
      hint: 'Opens this exact listing by Google CID',
    })
  }

  // ---- Citation discovery: search the DOMAIN, not the name ----
  links.push({
    label: 'Cited by',
    url: `https://www.google.com/search?q=${q(`"${input.domain}"`)}+-site:${q(input.domain)}`,
    kind: 'search',
    hint: 'Pages that mention this domain, excluding the domain itself — finds listings you would never guess the name of',
  })
  links.push({
    label: 'Indexed pages',
    url: `https://www.google.com/search?q=site:${q(input.domain)}`,
    kind: 'search',
    hint: 'What Google still has indexed for this domain',
  })

  // ---- Directory searches, name + locality ----
  for (const d of DIRECTORIES) {
    const hit = [...linkableByHost.entries()].find(([host]) => host.includes(d.host))
    if (hit) {
      // The index told us the exact page. No searching, no guessing at the name.
      links.push({
        label: d.label,
        url: hit[1].urlFrom!,
        kind: 'exact',
        hint: `Opens the ${d.label} page that links to ${input.domain}`,
      })
      continue
    }
    if (!name) continue
    const isConfirmed = [...confirmed].some((c) => c.includes(d.host))
    links.push({
      label: d.label,
      url: d.build(name, loc),
      kind: isConfirmed ? 'confirmed' : 'search',
      hint: isConfirmed
        ? `${d.host} links to this domain, but the citation page was not recorded — this searches for it instead`
        : `Searches ${d.label} for "${name}"${loc ? ` in ${loc}` : ''} — may return nothing`,
    })
  }

  // ---- Any other confirmed citation we hold a real URL for ----
  for (const [host, c] of linkableByHost) {
    if (DIRECTORIES.some((d) => host.includes(d.host))) continue
    links.push({
      label: host.replace(/^www\./, ''),
      url: c.urlFrom!,
      kind: 'exact',
      hint: `Opens the page on ${host} that links to ${input.domain}`,
    })
  }

  // ---- Archive, which is the one place a DEAD listing still survives ----
  links.push({
    label: 'Wayback',
    url: `https://web.archive.org/web/*/${encodeURIComponent(input.domain)}`,
    kind: 'exact',
    hint: 'Archived snapshots — the only place a dead site can still be read',
  })

  return links
}
