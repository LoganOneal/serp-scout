/**
 * Emergency triage. Deterministic, keyword-driven, and NOT the model's decision.
 *
 * ==================== WHY THIS IS NOT LEFT TO THE LLM ====================
 * An LLM that classifies a gas leak correctly 99% of the time is not acceptable
 * when the 1% is a gas leak. The prompt still instructs the agent to escalate,
 * but the transcript is ALSO matched here on every turn's text, and a hit
 * overrides whatever the model concluded.
 *
 * Two independent paths to the same escalation is the point. The model can be
 * confused by phrasing, sarcasm, or a caller who buries "I smell gas" in the
 * middle of a sentence about their thermostat; a substring match cannot.
 * ========================================================================
 *
 * Pure functions over strings. Nothing here touches a database, so it is tested
 * exhaustively in triage.test.ts against real phrasings.
 */

/** Ordered by severity. The highest-severity hit wins. */
export type HazardKind = 'gas' | 'carbon_monoxide' | 'fire_electrical' | 'water' | 'no_heat' | 'no_cool'

export type TriageAction =
  /** Do NOT book. Say the safety script, get them out, hand to a human. */
  | 'evacuate_and_escalate'
  /** Book nothing yet; transfer to the on-call human now. */
  | 'escalate_now'
  /** Urgent but a normal booking conversation. */
  | 'book_urgent'
  /** Nothing matched. Normal intake. */
  | 'normal'

export interface TriageMatch {
  kind: HazardKind
  action: TriageAction
  /** The phrase that matched, for the audit trail on the lead row. */
  matched: string
  /** Severity rank, higher is worse. Only used to pick a winner. */
  severity: number
}

export interface TriageResult {
  action: TriageAction
  /** null when nothing matched. NOT 'normal' as a hazard -- absence of a hazard. */
  hazard: HazardKind | null
  /** Every phrase that fired, so a false positive is diagnosable. */
  matches: TriageMatch[]
  /**
   * True only for hazards where the correct behaviour is "stop selling and get
   * the caller to safety". Drives the hard-coded branch in the prompt.
   */
  lifeSafety: boolean
}

interface Pattern {
  kind: HazardKind
  action: TriageAction
  severity: number
  lifeSafety: boolean
  /**
   * Regexes, matched against normalised text (lowercased, punctuation collapsed
   * to single spaces, padded with a leading and trailing space).
   *
   * ==================== WHY NOT PLAIN SUBSTRINGS ====================
   * The first version of this file used phrase substrings and missed
   * "it's, uh, smelling like gas in the basement" -- a real sentence, caught by
   * the test suite. Callers put filler between the verb and the noun ("smell
   * something burning", "smells kind of like gas"), so the hazard verb and the
   * hazard noun need a bounded gap between them rather than adjacency.
   *
   * The gap is bounded (not `.*`) so the two halves must be in the same clause.
   * Unbounded, "no gas smell, the furnace is just loud" would evacuate the house.
   * =================================================================
   */
  patterns: readonly RegExp[]
}

/** Up to ~3 filler words between two required tokens, same clause. */
const GAP = '[a-z0-9 ]{0,18}'

const PATTERNS: readonly Pattern[] = [
  {
    kind: 'gas',
    action: 'evacuate_and_escalate',
    severity: 100,
    lifeSafety: true,
    patterns: [
      // smell/odor ... gas   |   gas ... smell
      new RegExp(`\\b(smell|smells|smelling|smelt|odor|odour|whiff)\\b${GAP}\\b(gas|propane)\\b`),
      new RegExp(`\\b(gas|propane)\\b${GAP}\\b(smell|smells|smelling|odor|odour)\\b`),
      // leak wording, either order
      new RegExp(`\\b(gas|propane)\\b${GAP}\\b(leak|leaks|leaking)\\b`),
      new RegExp(`\\b(leak|leaks|leaking)\\b${GAP}\\b(gas|propane)\\b`),
      /\brotten eggs?\b/,
      /\bsulfur\b|\bsulphur\b/,
    ],
  },
  {
    kind: 'carbon_monoxide',
    action: 'evacuate_and_escalate',
    severity: 95,
    lifeSafety: true,
    patterns: [
      /\bcarbon monoxide\b/,
      /\bmonoxide\b/,
      // Callers say "co2" and mean CO. Treated as CO -- the cost of being wrong
      // in this direction is a wasted callback; the other direction is a death.
      /\b(co|co2|c o)\b[a-z ]{0,6}\b(alarm|alarms|detector|detectors)\b/,
      new RegExp(`\\b(alarm|alarms|detector|detectors)\\b${GAP}\\b(going off|beeping|chirping|sounding)\\b`),
    ],
  },
  {
    kind: 'fire_electrical',
    action: 'evacuate_and_escalate',
    severity: 90,
    lifeSafety: true,
    patterns: [
      // "smell something burning", "smells like burning", "burning smell"
      new RegExp(`\\b(smell|smells|smelling|smelt|odor|odour)\\b${GAP}\\b(burn|burning|burnt|smoke|electrical)\\b`),
      new RegExp(`\\b(burning|burnt|smoke|electrical)\\b${GAP}\\b(smell|smells|odor|odour)\\b`),
      /\bburning (plastic|rubber|wire|wires|insulation)\b/,
      /\b(smoke|smoking)\b[a-z ]{0,12}\b(coming|from|out of|in the)\b/,
      /\bthere('| i)?s smoke\b|\bseeing smoke\b|\bsmoke everywhere\b/,
      /\bspark|\bsparks\b|\bsparking\b|\barcing\b/,
      /\b(caught|on) fire\b|\bfire\b[a-z ]{0,8}\bfurnace\b/,
      /\bmelted\b|\bmelting\b|\bscorched\b|\bcharred\b/,
    ],
  },
  {
    kind: 'water',
    action: 'escalate_now',
    severity: 70,
    lifeSafety: false,
    patterns: [
      /\bflood|\bflooding\b|\bflooded\b/,
      /\bwater (everywhere|all over|pouring|running|coming)\b/,
      /\b(burst|broke|broken|cracked)\b[a-z ]{0,10}\bpipe/,
      /\bpipe\b[a-z ]{0,10}\b(burst|broke|broken|leaking)\b/,
      /\bgushing\b|\bpouring (out|water)\b|\bspraying water\b/,
      /\b(ceiling|wall|floor)\b[a-z ]{0,10}\bleak/,
      /\bwater damage\b/,
    ],
  },
  {
    kind: 'no_heat',
    action: 'book_urgent',
    severity: 50,
    lifeSafety: false,
    patterns: [
      // \bno\b does not match "not" (word boundary), so "not heating" is handled
      // by its own pattern below rather than firing here.
      new RegExp(`\\bno\\b[a-z ]{0,10}\\b(heat|heating|hot air|hot water)\\b`),
      /\b(without|lost|losing)\b[a-z ]{0,8}\bheat\b/,
      new RegExp(`\\b(furnace|heater|boiler|heat|heat pump)\\b${GAP}\\b(is|are|went|stopped|quit|died)?\\s?\\b(out|dead|off|down|broken|not working|stopped|quit|died)\\b`),
      /\b(isn t|isnt|is not|aint|ain t)\b[a-z ]{0,10}\b(heating|heat)\b/,
      /\bnot heating\b|\bwon t heat\b|\bwont heat\b/,
      /\bblowing cold\b|\bcold air\b[a-z ]{0,10}\bheat\b/,
      /\bfreezing\b[a-z ]{0,12}\b(in here|inside|in my|in the|house|home)\b/,
    ],
  },
  {
    kind: 'no_cool',
    action: 'book_urgent',
    severity: 45,
    lifeSafety: false,
    patterns: [
      new RegExp(`\\bno\\b[a-z ]{0,10}\\b(ac|a c|air|air conditioning|air conditioner|cool air|cold air)\\b`),
      new RegExp(`\\b(ac|a c|air conditioner|air conditioning|condenser|heat pump)\\b${GAP}\\b(out|dead|off|down|broken|not working|stopped|quit|died|frozen)\\b`),
      /\bnot cooling\b|\bwon t cool\b|\bwont cool\b|\bisn t cooling\b|\bisnt cooling\b/,
      /\bblowing (hot|warm)\b/,
      /\bsweltering\b|\bboiling in here\b|\bso hot in (here|the house)\b/,
    ],
  },
]

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * Transcripts arrive with commas and apostrophes in unpredictable places
 * ("it's, uh, smelling like gas") and phrase matching on raw text misses them.
 */
export function normalizeUtterance(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

/**
 * Triage a transcript, an utterance, or a free-text problem description.
 *
 * Safe to call with the whole running transcript on every turn: matching is
 * substring-based and idempotent, so re-detecting a hazard already handled costs
 * nothing and forgetting one costs a lot.
 */
export function triage(text: string | null | undefined): TriageResult {
  if (!text || text.trim() === '') {
    return { action: 'normal', hazard: null, matches: [], lifeSafety: false }
  }

  const hay = normalizeUtterance(text)
  const matches: TriageMatch[] = []

  for (const p of PATTERNS) {
    for (const re of p.patterns) {
      const hit = re.exec(hay)
      if (hit) {
        // The matched text, not the pattern source: the audit trail on the lead
        // row should show what the caller said, not a regex.
        matches.push({ kind: p.kind, action: p.action, matched: hit[0].trim(), severity: p.severity })
        break // one hit per hazard is enough; the list is for coverage.
      }
    }
  }

  if (matches.length === 0) {
    return { action: 'normal', hazard: null, matches: [], lifeSafety: false }
  }

  matches.sort((a, b) => b.severity - a.severity)
  const worst = matches[0]!
  const pattern = PATTERNS.find((p) => p.kind === worst.kind)!

  return {
    action: worst.action,
    hazard: worst.kind,
    matches,
    lifeSafety: pattern.lifeSafety,
  }
}

/**
 * Is this lead an emergency?
 *
 * Returns `null` when there is nothing to judge -- no transcript, no problem
 * text. `leads.is_emergency` is nullable for exactly this case, and the reason
 * is in the schema comment: rendering "never established" as "routine" is how a
 * no-heat call at 11pm in January gets queued for Tuesday.
 */
export function isEmergencyFrom(text: string | null | undefined): boolean | null {
  if (!text || text.trim() === '') return null
  const t = triage(text)
  if (t.hazard === null) return false
  return t.action !== 'normal'
}

/**
 * The exact words for a life-safety hazard.
 *
 * Kept here rather than in the prompt so it is (a) testable and (b) identical
 * whichever path fires. Both the prompt and the post-hoc branch read from this.
 */
export const SAFETY_SCRIPT: Record<'gas' | 'carbon_monoxide' | 'fire_electrical', string> = {
  gas:
    'Please stop what you are doing and leave the building now. Do not turn any lights or ' +
    'switches on or off, and do not use anything electrical. Once you are outside, call 911 or ' +
    'your gas utility right away. I am going to have someone call you back immediately.',
  carbon_monoxide:
    'Please get everyone outside into fresh air right now, and leave the door open behind you. ' +
    'Once you are outside, call 911. Do not go back inside. I am having someone call you back ' +
    'immediately.',
  fire_electrical:
    'Please leave the building now and call 911 from outside. Do not try to shut anything off ' +
    'yourself. I am having someone call you back immediately.',
}

export function safetyScriptFor(hazard: HazardKind | null): string | null {
  if (hazard === 'gas') return SAFETY_SCRIPT.gas
  if (hazard === 'carbon_monoxide') return SAFETY_SCRIPT.carbon_monoxide
  if (hazard === 'fire_electrical') return SAFETY_SCRIPT.fire_electrical
  return null
}
