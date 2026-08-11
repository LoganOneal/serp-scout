import { describe, expect, it } from 'vitest'
import {
  ACQUIRABLE_STATUSES,
  classifyDomain,
  scoreDomain,
  type RdapFacts,
} from './classify.js'

const NOW = new Date('2026-08-06T00:00:00Z')
const daysFromNow = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000)

const rdap = (over: Partial<RdapFacts> = {}): RdapFacts => ({
  registered: true,
  createdAt: new Date('2010-01-01T00:00:00Z'),
  expiresAt: daysFromNow(400),
  registrar: 'Example Registrar',
  statuses: [],
  ...over,
})

describe('classifyDomain', () => {
  it('calls a domain serving real content LIVE', () => {
    const c = classifyDomain({ http: { outcome: 'live' }, rdap: rdap(), now: NOW })
    expect(c.status).toBe('LIVE')
  })

  it('keeps a live site out of EXPIRING_SOON even when renewal is close', () => {
    // The false-positive guard: a business about to renew is not a candidate.
    const c = classifyDomain({
      http: { outcome: 'live' },
      rdap: rdap({ expiresAt: daysFromNow(10) }),
      now: NOW,
    })
    expect(c.status).toBe('LIVE')
  })

  it('calls an unregistered domain AVAILABLE', () => {
    const c = classifyDomain({
      http: { outcome: 'dead' },
      rdap: rdap({ registered: false }),
      now: NOW,
    })
    expect(c.status).toBe('AVAILABLE')
  })

  it('never infers AVAILABLE when RDAP did not answer', () => {
    // A rate-limited registry is not a yes.
    const c = classifyDomain({
      http: { outcome: 'dead' },
      rdap: rdap({ registered: null, createdAt: null, expiresAt: null }),
      now: NOW,
    })
    expect(c.status).not.toBe('AVAILABLE')
    // HTTP still proved nothing is served, so this is a real dead domain.
    expect(c.status).toBe('PARKED_DEAD')
  })

  it('lets the registrar API override an RDAP miss', () => {
    const c = classifyDomain({
      http: { outcome: 'dead' },
      rdap: rdap({ registered: null }),
      registrarAvailable: true,
      now: NOW,
    })
    expect(c.status).toBe('AVAILABLE')
  })

  it('does not call a domain AVAILABLE when the registrar says it is taken', () => {
    const c = classifyDomain({
      http: { outcome: 'dead' },
      rdap: rdap({ registered: false }),
      registrarAvailable: false,
      now: NOW,
    })
    expect(c.status).not.toBe('AVAILABLE')
  })

  it('reads the EPP drop and grace codes', () => {
    expect(
      classifyDomain({
        http: { outcome: 'dead' },
        rdap: rdap({ statuses: ['pending delete'] }),
        now: NOW,
      }).status,
    ).toBe('PENDING_DELETE')

    expect(
      classifyDomain({
        http: { outcome: 'dead' },
        rdap: rdap({ statuses: ['redemption period'] }),
        now: NOW,
      }).status,
    ).toBe('REDEMPTION')
  })

  it('normalises camel/underscore status spellings', () => {
    const c = classifyDomain({
      http: { outcome: 'dead' },
      rdap: rdap({ statuses: ['redemption_period'] }),
      now: NOW,
    })
    expect(c.status).toBe('REDEMPTION')
  })

  it('flags a dead domain expiring inside the window', () => {
    const c = classifyDomain({
      http: { outcome: 'parked' },
      rdap: rdap({ expiresAt: daysFromNow(30) }),
      now: NOW,
    })
    expect(c.status).toBe('EXPIRING_SOON')
    expect(c.daysToExpiry).toBe(30)
  })

  it('does not call an UNREADABLE site expiring-soon', () => {
    // tesla.com returned 403 to the probe, so LIVE could not fire, and the
    // expiry date alone then claimed an opportunity on a domain that plainly
    // renews. Every domain expires; almost every domain renews.
    const c = classifyDomain({
      http: { outcome: 'unknown' },
      rdap: rdap({ expiresAt: daysFromNow(88) }),
      now: NOW,
    })
    expect(c.status).toBe('UNKNOWN')
    expect(c.status).not.toBe('EXPIRING_SOON')
    // The date is still recorded — it is the CLAIM that was wrong, not the fact.
    expect(c.daysToExpiry).toBe(88)
  })

  it('does not call a registry-locked domain expiring-soon', () => {
    // serverDeleteProhibited is set on domains nobody is letting go.
    const c = classifyDomain({
      http: { outcome: 'parked' },
      rdap: rdap({ expiresAt: daysFromNow(30), statuses: ['server delete prohibited'] }),
      now: NOW,
    })
    expect(c.status).not.toBe('EXPIRING_SOON')
  })

  it('flags an off-domain redirect as already acquired', () => {
    const c = classifyDomain({
      http: { outcome: 'redirect', redirectedTo: 'bigrollup.com' },
      rdap: rdap(),
      now: NOW,
    })
    expect(c.status).toBe('ACQUIRED_301')
  })

  it('puts a parked, comfortably-renewed domain in PARKED_DEAD', () => {
    const c = classifyDomain({ http: { outcome: 'parked' }, rdap: rdap(), now: NOW })
    expect(c.status).toBe('PARKED_DEAD')
    expect(c.ageYears).toBeCloseTo(16.6, 0)
  })

  it('says UNKNOWN rather than calling an unreadable site dead', () => {
    // quixservice.com: 3 A records, 2 nameservers, expiry 402 days out, and an
    // HTTP probe that returned nothing. Calling that PARKED_DEAD put a live
    // business at the top of an acquisition list.
    const c = classifyDomain({ http: { outcome: 'unknown' }, rdap: rdap(), now: NOW })
    expect(c.status).toBe('UNKNOWN')
    expect(c.status).not.toBe('PARKED_DEAD')
    expect(c.reason).toMatch(/did not complete/i)
    expect(c.conclusive).toBe(false)
  })

  it('keeps UNKNOWN out of the candidate shortlist', () => {
    expect(ACQUIRABLE_STATUSES).not.toContain('UNKNOWN')
  })

  it('does not call a 5xx host a dead domain', () => {
    // 247manhattanplumbingnyc.com: HTTP 500 from a broken WordPress install,
    // expiry 748 days out, DNS on live hosting. A server that runs and fails
    // is a server somebody is paying for.
    const c = classifyDomain({ http: { outcome: 'broken' }, rdap: rdap(), now: NOW })
    expect(c.status).toBe('BROKEN')
    expect(c.status).not.toBe('PARKED_DEAD')
    expect(ACQUIRABLE_STATUSES).not.toContain('BROKEN')
  })

  // ---- False-negative guards: do not lose a genuinely expired domain ----

  it('calls a redemption-period domain expired even while a page is served', () => {
    // Registrars keep serving parking pages on expired domains. If the page
    // outranked the registry, this domain would be dropped as a live business.
    const c = classifyDomain({
      http: { outcome: 'live' },
      rdap: rdap({ statuses: ['redemption period'] }),
      now: NOW,
    })
    expect(c.status).toBe('REDEMPTION')
    expect(c.status).not.toBe('LIVE')
  })

  it('calls a pending-delete domain expired even while a page is served', () => {
    const c = classifyDomain({
      http: { outcome: 'live' },
      rdap: rdap({ statuses: ['pending delete'] }),
      now: NOW,
    })
    expect(c.status).toBe('PENDING_DELETE')
  })

  it('calls an unregistered domain AVAILABLE even if something answered on it', () => {
    const c = classifyDomain({
      http: { outcome: 'live' },
      rdap: rdap({ registered: false }),
      now: NOW,
    })
    expect(c.status).toBe('AVAILABLE')
  })

  it('treats a redirect to a marketplace as for-sale, not already acquired', () => {
    // aaatotal.com -> hugedomains.com is a broker inviting offers, which is a
    // live lead; ACQUIRED_301 reads as "a competitor owns this now".
    const c = classifyDomain({
      http: { outcome: 'redirect', redirectedTo: 'hugedomains.com' },
      rdap: rdap(),
      now: NOW,
    })
    expect(c.status).toBe('PARKED_DEAD')
    expect(c.reason).toMatch(/for sale/i)
  })

  it('still flags a redirect to an unrelated brand as acquired', () => {
    const c = classifyDomain({
      http: { outcome: 'redirect', redirectedTo: 'bigrollup.com' },
      rdap: rdap(),
      now: NOW,
    })
    expect(c.status).toBe('ACQUIRED_301')
  })

  it('still calls a 404 host dead', () => {
    const c = classifyDomain({ http: { outcome: 'dead' }, rdap: rdap(), now: NOW })
    expect(c.status).toBe('PARKED_DEAD')
  })

  it('trusts an organic ranking over a blocked probe', () => {
    // merriam-webster.com sat in UNKNOWN while ranked #4. Google does not rank
    // domains that serve nothing, so a blocked probe is about US, not the site.
    const c = classifyDomain({
      http: { outcome: 'unknown' },
      rdap: rdap(),
      serpRank: 4,
      now: NOW,
    })
    expect(c.status).toBe('LIVE')
    expect(c.reason).toMatch(/ranked #4/i)
  })

  it('does not let mail or an archive snapshot decide on their own', () => {
    // Mail outlives websites, and Wayback counts a parking page as content.
    // Both are recorded, neither may call a domain live.
    const c = classifyDomain({
      http: { outcome: 'unknown' },
      rdap: rdap(),
      hasMx: true,
      lastContentSnapshotAt: new Date(NOW.getTime() - 9 * 86_400_000),
      now: NOW,
    })
    expect(c.status).toBe('UNKNOWN')
    expect(c.reason).toMatch(/mail configured/)
    expect(c.reason).toMatch(/archived 9d ago/)
  })

  it('marks a proven-dead domain conclusive', () => {
    expect(classifyDomain({ http: { outcome: 'dead' }, rdap: rdap(), now: NOW }).conclusive).toBe(
      true,
    )
    expect(classifyDomain({ http: { outcome: 'parked' }, rdap: rdap(), now: NOW }).conclusive).toBe(
      true,
    )
  })
})

describe('scoreDomain', () => {
  const base = {
    status: 'PARKED_DEAD' as const,
    ageYears: null,
    trustFlow: null,
    citationFlow: null,
    referringDomains: null,
    referringSubnets: null,
    topicalRelevancePct: null,
    yearsOfContent: null,
    businessCount: 1,
  }

  it('reports which signals were missing so a low score is not misread', () => {
    const s = scoreDomain(base)
    expect(s.missing).toContain('age')
    expect(s.missing).toContain('trustFlow')
    expect(s.total).toBeGreaterThanOrEqual(0)
  })

  it('ranks an old, well-linked domain above a young bare one', () => {
    const strong = scoreDomain({
      ...base,
      ageYears: 18,
      trustFlow: 30,
      citationFlow: 35,
      referringSubnets: 45,
      topicalRelevancePct: 55,
      yearsOfContent: 11,
    })
    const weak = scoreDomain({ ...base, ageYears: 1, trustFlow: 2, citationFlow: 3, referringSubnets: 1, topicalRelevancePct: 5, yearsOfContent: 1 })
    expect(strong.total).toBeGreaterThan(weak.total)
    expect(strong.missing).toHaveLength(0)
  })

  it('penalises a link profile whose trust lags far behind its citations', () => {
    const spammy = scoreDomain({ ...base, ageYears: 10, trustFlow: 3, citationFlow: 40, referringSubnets: 20 })
    const clean = scoreDomain({ ...base, ageYears: 10, trustFlow: 20, citationFlow: 25, referringSubnets: 20 })
    expect(spammy.components['trustRatio']).toBeLessThan(0)
    expect(clean.components['trustRatio']).toBe(0)
    expect(clean.total).toBeGreaterThan(spammy.total)
  })

  it('does not rank an unproven domain alongside a confirmed dead one', () => {
    // The kohler.com case: a live site that merely timed out scored 42 and
    // ranked second in a real run against a real market.
    const shape = { ...base, ageYears: 30, yearsOfContent: 13 }
    const proven = scoreDomain({ ...shape, conclusiveTriage: true })
    const unproven = scoreDomain({ ...shape, conclusiveTriage: false })
    expect(unproven.total).toBeLessThan(proven.total)
    expect(unproven.missing).toContain('triage')
    expect(proven.missing).not.toContain('triage')
  })

  it('stays inside 0-100', () => {
    const maxed = scoreDomain({
      ...base,
      status: 'AVAILABLE',
      ageYears: 40,
      trustFlow: 90,
      citationFlow: 90,
      referringSubnets: 500,
      topicalRelevancePct: 100,
      yearsOfContent: 30,
    })
    expect(maxed.total).toBeLessThanOrEqual(100)
    expect(maxed.total).toBeGreaterThan(80)
  })
})
