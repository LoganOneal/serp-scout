import { describe, expect, it } from 'vitest'
import { assessAcquisition } from './acquisition-value.js'

/**
 * The thresholds are asserted against the domains that produced them, so a
 * future change to a constant fails against real evidence rather than against
 * a made-up fixture.
 */
describe('assessAcquisition', () => {
  const full = {
    yearsOfContent: 10,
    referringDomains: 50,
    spamScore: 10,
  }

  it('never rates a live business', () => {
    const r = assessAcquisition({ ...full, status: 'LIVE' })
    expect(r.verdict).toBe('NEITHER')
    // Decided before any nullity check, so a live row with no measurements
    // must not land in UNKNOWN_VALUE and inflate that bucket.
    expect(
      assessAcquisition({
        status: 'LIVE',
        yearsOfContent: null,
        referringDomains: null,
        spamScore: null,
      }).verdict,
    ).toBe('NEITHER')
  })

  describe('the four AVAILABLE domains recovered from the 2013 YP archive', () => {
    it('mohrhusen.com — 14y, 34 refdom, spam 46 — is rejected on spam alone', () => {
      const r = assessAcquisition({
        status: 'AVAILABLE',
        yearsOfContent: 14,
        referringDomains: 34,
        spamScore: 46,
      })
      expect(r.verdict).toBe('NEITHER')
      expect(r.reason).toMatch(/spam score 46/i)
    })

    it('citysewercleanersservices.com — 4y but 0 refdom — equity did not survive', () => {
      const r = assessAcquisition({
        status: 'AVAILABLE',
        yearsOfContent: 4,
        referringDomains: 0,
        spamScore: 5,
      })
      expect(r.verdict).toBe('NEITHER')
      expect(r.reason).toMatch(/did not survive/i)
    })

    it('buildingwatersplumbers.com — 1y of content — no business existed', () => {
      const r = assessAcquisition({
        status: 'AVAILABLE',
        yearsOfContent: 1,
        referringDomains: 2,
        spamScore: 10,
      })
      expect(r.verdict).toBe('NEITHER')
      expect(r.reason).toMatch(/long enough/i)
    })

    it('a clean available domain with real history is a BUY', () => {
      const r = assessAcquisition({
        status: 'AVAILABLE',
        yearsOfContent: 8,
        referringDomains: 40,
        spamScore: 12,
      })
      expect(r.verdict).toBe('BUY')
    })
  })

  it('drainsruswi.com — UNKNOWN, 78 refdom, spam 15 — is the outreach case', () => {
    // The best asset the archive probe recovered. It is UNKNOWN because triage
    // never concluded, and excluding UNKNOWN from the outreach population would
    // have thrown it away.
    const r = assessAcquisition({
      status: 'UNKNOWN',
      yearsOfContent: 8,
      referringDomains: 78,
      spamScore: 15,
    })
    expect(r.verdict).toBe('OUTREACH')
  })

  it('an owned domain needs no archive history to be an outreach target', () => {
    const r = assessAcquisition({
      status: 'PARKED_DEAD',
      yearsOfContent: null,
      referringDomains: 60,
      spamScore: 8,
    })
    expect(r.verdict).toBe('OUTREACH')
  })

  it('holds owned domains to a higher link bar than obtainable ones', () => {
    const base = { yearsOfContent: 10, spamScore: 5 }
    // 10 refdom clears the BUY bar (5) but not the OUTREACH bar (20).
    expect(assessAcquisition({ ...base, status: 'AVAILABLE', referringDomains: 10 }).verdict).toBe(
      'BUY',
    )
    expect(
      assessAcquisition({ ...base, status: 'PARKED_DEAD', referringDomains: 10 }).verdict,
    ).toBe('NEITHER')
  })

  describe('missing signals are never treated as good ones', () => {
    it('an unmeasured spam score does not pass the ceiling', () => {
      const r = assessAcquisition({ ...full, status: 'AVAILABLE', spamScore: null })
      expect(r.verdict).toBe('UNKNOWN_VALUE')
      expect(r.missing).toContain('spamScore')
    })

    it('unmeasured links are not zero links', () => {
      const r = assessAcquisition({ ...full, status: 'AVAILABLE', referringDomains: null })
      expect(r.verdict).toBe('UNKNOWN_VALUE')
    })

    it('archive depth is required for BUY but not for OUTREACH', () => {
      expect(
        assessAcquisition({ ...full, status: 'AVAILABLE', yearsOfContent: null }).verdict,
      ).toBe('UNKNOWN_VALUE')
      expect(
        assessAcquisition({ ...full, status: 'PARKED_DEAD', yearsOfContent: null }).verdict,
      ).toBe('OUTREACH')
    })
  })
})
