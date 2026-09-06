import { firstMatch, makeEvidence } from './evidence.js'
import type { HhtOppEligibility, HhtOppEvidence } from './types.js'

export interface EligibilityResult {
  eligibility: HhtOppEligibility
  reason: string
  evidence: HhtOppEvidence | null
  confidence: HhtOppEvidence['confidence']
}

const PASS_PATTERNS = [
  /brands? (?:are )?welcome/i,
  /businesses? (?:are )?welcome/i,
  /travel compan(?:y|ies) welcome/i,
  /industry experts? welcome/i,
  /founders? welcome/i,
  /agenc(?:y|ies) welcome/i,
  /tourism organizations? welcome/i,
  /hotels? welcome/i,
  /commercial websites? welcome/i,
  /we (?:accept|welcome) (?:brands?|businesses?|companies|industry experts|founders|hotels)/i,
  /open to (?:brands?|businesses?|companies|industry experts)/i,
  /company (?:authors?|contributors?) (?:are )?(?:welcome|accepted)/i,
]

const FAIL_PATTERNS = [
  /personal bloggers? only/i,
  /independent travelers? only/i,
  /businesses? (?:are )?(?:prohibited|not allowed|not accepted)/i,
  /content marketers? (?:are )?(?:prohibited|not allowed)/i,
  /no commercial websites?/i,
  /no seo submissions?/i,
  /companies must use paid advertising/i,
  /we do not accept (?:guest posts? from )?(?:brands?|businesses?|companies|agencies)/i,
  /not (?:open|accepting) (?:to )?commercial/i,
]

/**
 * PASS requires direct evidence that a business like HotelHotTubs.com may participate.
 * Silence is REVIEW. Explicit exclusion is FAIL.
 */
export function classifyCorporateEligibility(
  url: string,
  text: string,
  checkedAt = new Date(),
): EligibilityResult {
  const fail = firstMatch(text, FAIL_PATTERNS)
  if (fail?.[0]) {
    return {
      eligibility: 'FAIL',
      reason: 'Publisher rules explicitly exclude businesses or commercial contributors.',
      evidence: makeEvidence(url, text, fail[0], 'HIGH', checkedAt),
      confidence: 'HIGH',
    }
  }

  const pass = firstMatch(text, PASS_PATTERNS)
  if (pass?.[0]) {
    return {
      eligibility: 'PASS',
      reason: 'Publisher states that brands, businesses, or equivalent contributors may participate.',
      evidence: makeEvidence(url, text, pass[0], 'HIGH', checkedAt),
      confidence: 'HIGH',
    }
  }

  return {
    eligibility: 'REVIEW',
    reason: 'Corporate eligibility is not clearly stated. Do not infer PASS from the absence of a prohibition.',
    evidence: null,
    confidence: 'LOW',
  }
}
