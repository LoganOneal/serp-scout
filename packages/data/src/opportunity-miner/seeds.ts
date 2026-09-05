import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIRST_RUN_FAMILIES, SEED_PATTERNS, type SeedPattern } from './config/patterns.js'

export interface Dictionaries {
  personas: string[]
  industries: string[]
  workflows: string[]
  businessFunctions: string[]
  consumerTasks: string[]
  creatorTasks: string[]
  documentTypes: string[]
  mediaTypes: string[]
  financialActivities: string[]
  homeLifestyle: string[]
  healthWellness: string[]
  professionalServices: string[]
  ecommerceWorkflows: string[]
  marketingWorkflows: string[]
  salesWorkflows: string[]
  hrWorkflows: string[]
  operationsWorkflows: string[]
  objects: string[]
  companies: string[]
}

export interface MaterializedSeed {
  keyword: string
  family: string
  pattern: string
  priority: number
}

let cached: Dictionaries | null = null

export function loadDictionaries(): Dictionaries {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(join(here, 'config/dictionaries.json'), 'utf8')
  cached = JSON.parse(raw) as Dictionaries
  return cached
}

export function xSlotValues(dict: Dictionaries): string[] {
  return unique([
    ...dict.objects,
    ...dict.workflows,
    ...dict.consumerTasks,
    ...dict.creatorTasks,
    ...dict.documentTypes,
    ...dict.mediaTypes,
    ...dict.financialActivities,
    ...dict.homeLifestyle,
    ...dict.industries,
  ])
}

export function materializeSeeds(opts: {
  families?: string[]
  firstRunOnly?: boolean
  extraConcepts?: string[]
} = {}): MaterializedSeed[] {
  const dict = loadDictionaries()
  const families = new Set(opts.families ?? (opts.firstRunOnly === false ? SEED_PATTERNS.map((p) => p.family) : [...FIRST_RUN_FAMILIES]))
  const patterns = SEED_PATTERNS.filter((p) => families.has(p.family) && (opts.firstRunOnly === false || p.firstRun || opts.families))
  const x = unique([...xSlotValues(dict), ...(opts.extraConcepts ?? [])])
  const out: MaterializedSeed[] = []
  for (const pattern of patterns) {
    for (const value of valuesFor(pattern, dict, x)) {
      out.push({
        keyword: fill(pattern.template, value),
        family: pattern.family,
        pattern: pattern.template,
        priority: pattern.priority,
      })
    }
  }
  return dedupeSeeds(out)
}

function valuesFor(pattern: SeedPattern, dict: Dictionaries, x: string[]): string[] {
  switch (pattern.slot) {
    case 'persona':
      return dict.personas
    case 'workflow':
      return dict.workflows
    case 'company':
      return dict.companies
    case 'industry':
      return dict.industries
    default:
      return x
  }
}

function fill(template: string, value: string): string {
  return template
    .replace('{x}', value)
    .replace('{persona}', value)
    .replace('{workflow}', value)
    .replace('{company}', value)
    .replace('{industry}', value)
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))]
}

function dedupeSeeds(seeds: MaterializedSeed[]): MaterializedSeed[] {
  const best = new Map<string, MaterializedSeed>()
  for (const s of seeds) {
    const k = s.keyword.toLowerCase()
    const prev = best.get(k)
    if (!prev || s.priority > prev.priority) best.set(k, s)
  }
  return [...best.values()].sort((a, b) => b.priority - a.priority)
}
