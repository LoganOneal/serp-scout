export interface FeasibilityFlags {
  regulated: boolean
  payments: boolean
  marketplaceColdStart: boolean
  medicalLegal: boolean
  licensedData: boolean
  hardIntegrations: boolean
  networkEffects: boolean
  physicalOps: boolean
}

export interface FeasibilityResult {
  /** 1 = weekend utility … 5 = capital-intensive / regulated / marketplace. */
  complexity: number
  flags: FeasibilityFlags
}

export function estimateBuildFeasibility(args: {
  keywords: string[]
  archetype: string | null
  industry: string | null
  monetization: string | null
}): FeasibilityResult {
  const blob = `${args.keywords.join(' ')} ${args.industry ?? ''} ${args.archetype ?? ''}`.toLowerCase()
  const flags: FeasibilityFlags = {
    regulated: /(bank|fintech|lending|insurance|pharmac|hipaa|fda)/.test(blob),
    payments: /(payment|checkout|stripe|invoice|billing|payroll)/.test(blob),
    marketplaceColdStart: /(marketplace|two-sided|directory of)/.test(blob) || args.monetization === 'transaction_fee',
    medicalLegal: /(medical|hipaa|diagnos|prescript|attorney|legal advice|lawyer)/.test(blob),
    licensedData: /(mls|lis[tc]ing data|credit report|background check)/.test(blob),
    hardIntegrations: /(quickbooks|salesforce|xero|service titan|qbo)/.test(blob),
    networkEffects: /(marketplace|community|network|two-sided)/.test(blob),
    physicalOps: /(delivery|warehouse|fleet hardware|iot sensor)/.test(blob),
  }

  let complexity = 2
  if (['generator', 'checker', 'calculator', 'converter', 'finder'].includes(args.archetype ?? '')) {
    complexity = 1
  }
  if (['software', 'app', 'planner', 'tracker', 'scheduler'].includes(args.archetype ?? '')) complexity = 2
  if (['platform', 'crm', 'automation', 'estimator'].includes(args.archetype ?? '')) complexity = 3
  if (args.industry) complexity = Math.max(complexity, 3)
  if (flags.payments) complexity = Math.max(complexity, 3)
  if (flags.hardIntegrations) complexity = Math.max(complexity, 3)
  if (flags.licensedData || flags.medicalLegal || flags.regulated) complexity = Math.max(complexity, 4)
  if (flags.marketplaceColdStart || flags.networkEffects || flags.physicalOps) complexity = 5

  return { complexity, flags }
}
