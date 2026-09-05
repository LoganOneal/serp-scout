import { PRODUCT_ARCHETYPES, type ExtractedConcept } from './types.js'
import { normalizeKeyword, tokenize } from './normalize.js'

const COMMERCIAL_HINTS = [
  'software',
  'app',
  'tool',
  'platform',
  'pricing',
  'cost',
  'price',
  'buy',
  'subscription',
  'crm',
  'alternative',
  'reviews',
  'template',
  'automation',
  'automate',
]

const ONE_OFF_OBJECTS = [
  'name',
  'baby name',
  'headshot',
  'logo',
  'avatar',
  'meme',
  'quiz',
  'horoscope',
  'caption',
]

const BUSINESS_WORKFLOWS = [
  'estimating',
  'estimate',
  'quoting',
  'quote',
  'proposal',
  'invoicing',
  'invoice',
  'scheduling',
  'booking',
  'payroll',
  'crm',
  'dispatch',
  'inventory',
  'accounting',
  'bookkeeping',
  'onboarding',
  'billing',
  'collections',
]

/**
 * Deterministic concept extraction.
 *
 * An LLM may refine this later, but Semrush keywords already encode grammar.
 * Rule extraction is the source of cluster keys so clustering stays testable
 * and does not depend on a model being available.
 */
export function extractConcepts(keyword: string): ExtractedConcept {
  const n = normalizeKeyword(keyword)
  const tokens = tokenize(keyword)
  const archetype = detectArchetype(n)
  const object = detectObject(n, archetype)
  const industry = detectIndustry(n)
  const persona = detectPersona(n)
  const workflow = detectWorkflow(n, object)

  const commercial = commercialIntentScore(n, archetype)
  const recurring = recurringUsageScore({ n, archetype, object, workflow, industry, persona })

  return {
    workflow,
    industry,
    persona,
    object,
    productArchetype: archetype,
    commercialIntent: commercial,
    recurringUsageLikelihood: recurring,
    confidence: archetype || industry || workflow ? 'strongly_inferred' : 'weakly_inferred',
  }
}

export function detectArchetype(normalized: string): string | null {
  for (const a of PRODUCT_ARCHETYPES) {
    if (normalized.includes(a)) return a
  }
  if (/\bai\b/.test(normalized) && /\bfor\b/.test(normalized)) return 'tool'
  if (normalized.includes('automat')) return 'automation'
  return null
}

function detectObject(normalized: string, archetype: string | null): string | null {
  if (!archetype) return null
  const idx = normalized.lastIndexOf(archetype)
  if (idx > 0) {
    const before = normalized
      .slice(0, idx)
      .replace(/\b(ai|best|free|online|automatic)\b/g, '')
      .trim()
    if (before) return before
  }
  const after = normalized
    .replace(new RegExp(`.*\\b${archetype}\\b`), '')
    .replace(/\b(for|to|online|free|software|app|tool)\b/g, '')
    .trim()
  return after || null
}

function detectWorkflow(normalized: string, object: string | null): string | null {
  for (const w of BUSINESS_WORKFLOWS) {
    if (normalized.includes(w)) return canonicalizeWorkflow(w)
  }
  if (object && BUSINESS_WORKFLOWS.some((w) => object.includes(w))) {
    return canonicalizeWorkflow(object)
  }
  if (normalized.includes('automat')) {
    const m = normalized.match(/automat(?:e|ic|ion)\s+(.+)/)
    if (m?.[1]) return m[1]!.trim()
  }
  return object
}

function canonicalizeWorkflow(w: string): string {
  if (w === 'estimate' || w === 'estimating') return 'estimating'
  if (w === 'quote' || w === 'quoting') return 'quoting'
  if (w === 'invoice' || w === 'invoicing') return 'invoicing'
  if (w === 'proposal') return 'proposal generation'
  return w
}

const INDUSTRY_HINTS: Array<[string, string]> = [
  ['roofing', 'roofing'],
  ['roofer', 'roofing'],
  ['landscap', 'landscaping'],
  ['hvac', 'hvac'],
  ['plumber', 'plumbing'],
  ['plumbing', 'plumbing'],
  ['electrician', 'electrical'],
  ['contractor', 'contracting'],
  ['dentist', 'dental'],
  ['dental', 'dental'],
  ['lawyer', 'legal'],
  ['attorney', 'legal'],
  ['legal', 'legal'],
  ['real estate', 'real estate'],
  ['realtor', 'real estate'],
  ['restaurant', 'restaurant'],
  ['salon', 'salon'],
  ['gym', 'fitness'],
  ['fitness', 'fitness'],
  ['accounting', 'accounting'],
  ['bookkeep', 'bookkeeping'],
  ['ecommerce', 'ecommerce'],
  ['shopify', 'ecommerce'],
  ['truck', 'trucking'],
  ['construction', 'construction'],
  ['cleaning', 'cleaning'],
  ['maid', 'cleaning'],
  ['pest', 'pest control'],
  ['pool', 'pool'],
  ['solar', 'solar'],
  ['insurance', 'insurance'],
  ['mortgage', 'mortgage'],
  ['interior design', 'interior design'],
  ['room design', 'interior design'],
  ['room designer', 'interior design'],
  ['home design', 'interior design'],
]

function detectIndustry(normalized: string): string | null {
  for (const [hint, label] of INDUSTRY_HINTS) {
    if (normalized.includes(hint)) return label
  }
  return null
}

const PERSONA_HINTS: Array<[string, string]> = [
  ['contractor', 'contractor'],
  ['roofer', 'roofing contractor'],
  ['freelancer', 'freelancer'],
  ['creator', 'creator'],
  ['youtuber', 'creator'],
  ['realtor', 'realtor'],
  ['agent', 'agent'],
  ['dentist', 'dentist'],
  ['lawyer', 'lawyer'],
  ['accountant', 'accountant'],
  ['bookkeeper', 'bookkeeper'],
  ['teacher', 'teacher'],
  ['student', 'student'],
  ['parent', 'parent'],
  ['photographer', 'photographer'],
  ['designer', 'designer'],
  ['marketer', 'marketer'],
  ['recruiter', 'recruiter'],
  ['coach', 'coach'],
]

function detectPersona(normalized: string): string | null {
  const forMatch = normalized.match(/\bfor\s+([a-z0-9 ]+?)(?:\s+(?:software|app|tool|online|free)|$)/)
  if (forMatch?.[1] && forMatch[1].trim().length > 2) return forMatch[1].trim()
  for (const [hint, label] of PERSONA_HINTS) {
    if (normalized.includes(hint)) return label
  }
  return null
}

function commercialIntentScore(normalized: string, archetype: string | null): number {
  let score = 1
  if (archetype) score += 1
  if (COMMERCIAL_HINTS.some((h) => normalized.includes(h))) score += 1
  if (/\b(pricing|cost|buy|subscription|software)\b/.test(normalized)) score += 1
  if (BUSINESS_WORKFLOWS.some((w) => normalized.includes(w))) score += 1
  if (INDUSTRY_HINTS.some(([hint]) => normalized.includes(hint)) && archetype) score += 1
  if (/\b(what is|how to|meaning|definition|wikipedia)\b/.test(normalized)) score -= 2
  return clampInt(score, 1, 5)
}

function recurringUsageScore(args: {
  n: string
  archetype: string | null
  object: string | null
  workflow: string | null
  industry: string | null
  persona: string | null
}): number {
  const blob = `${args.n} ${args.object ?? ''} ${args.workflow ?? ''}`
  if (ONE_OFF_OBJECTS.some((o) => blob.includes(o))) return 1
  if (args.workflow && BUSINESS_WORKFLOWS.some((w) => args.workflow!.includes(w))) {
    return args.industry || args.persona ? 5 : 4
  }
  if (['tracker', 'planner', 'scheduler', 'monitor', 'crm'].includes(args.archetype ?? '')) return 4
  if (['software', 'platform', 'app', 'automation'].includes(args.archetype ?? '')) return 4
  if (['generator', 'maker', 'creator', 'checker', 'calculator', 'converter'].includes(args.archetype ?? '')) {
    return 2
  }
  return 2
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function isProductShaped(keyword: string): boolean {
  const n = normalizeKeyword(keyword)
  return detectArchetype(n) !== null || /\b(software|app|tool|platform|automat)\b/.test(n)
}

export function revealsNewConcept(keyword: string, known: Set<string>): boolean {
  const c = extractConcepts(keyword)
  const keys = [c.industry, c.persona, c.workflow, c.object].filter(Boolean) as string[]
  return keys.some((k) => !known.has(k))
}

export function jobFamily(workflow: string | null | undefined): string | null {
  if (!workflow) return null
  if (/(estimat|quot|proposal)/.test(workflow)) return 'estimating-proposals'
  if (/(invoic|billing|collect)/.test(workflow)) return 'billing'
  if (/(schedul|dispatch|rout|book)/.test(workflow)) return 'scheduling'
  if (/(interior|room design)/.test(workflow)) return 'interior-visualization'
  return workflow
}

export function clusterKey(concept: ExtractedConcept): string | null {
  const vertical = concept.industry ?? concept.persona
  const job = jobFamily(concept.workflow) ?? jobFamily(concept.object) ?? concept.object
  if (vertical && job) return `${vertical}::${job}`
  if (vertical) return vertical
  if (job && concept.productArchetype) return `${concept.productArchetype}::${job}`
  return null
}
