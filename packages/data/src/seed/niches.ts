/**
 * The niche corpus. 40 high-intent local service categories.
 *
 * EVERY NUMBER HERE IS A PRIOR AWAITING CALIBRATION.
 *
 * `demandPerCapitaPer1k` -- monthly searches per 1,000 residents. Reasoned from
 * how often a household needs the service and what share of those needs begin
 * with a local search. Emergency and damage categories skew high relative to
 * their frequency because almost every instance starts with a search; routine
 * categories skew low because of repeat relationships and word of mouth.
 *
 * `valuePerSearchMicros` -- modelled monthly rent per monthly search, in micros.
 * Tracks job value and lead value: one water-damage job is worth two hundred
 * lawn cuts, so a single search is worth far more even where volume is similar.
 *
 * Floors and ceilings clamp the arithmetic at both ends: a tiny town should not
 * model a $12/mo site (nobody rents that) and a big city should not model
 * $40,000/mo from population alone.
 *
 * `domainStems` -- curated substrings meaning "this domain is about this niche",
 * used for exact-match detection. Explicit rather than stemmed: `plumber` and
 * `plumbing` share no whole word, so the stem must be `plumb`; and a naive 4-char
 * prefix of `heating` would also match `heather` and `heathrow`.
 */

export interface NicheSeed {
  slug: string
  label: string
  keywordNoun: string
  emdToken: string
  domainStems: string[]
  category: string
  demandPerCapitaPer1k: number
  valuePerSearchMicros: bigint
  rentFloorMicros: bigint
  rentCeilingMicros: bigint
  /**
   * PRIOR avg job ticket (USD). Used for lead-sell economics, not site rent.
   * Calibrate later from lead_outcomes.job_value_micros.
   */
  avgTicketUsd: number
  /**
   * PRIOR lead commission rate 0–1 (what we keep / charge when selling the lead).
   * leadValueUsd ≈ avgTicketUsd × leadCommissionRate unless flat CPA override.
   */
  leadCommissionRate: number
}

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000))

/** Category defaults when a niche is missing explicit ticket/commission. */
function categoryEconomics(category: string): { ticket: number; commission: number } {
  switch (category) {
    case 'restoration':
      return { ticket: 6500, commission: 0.1 }
    case 'structural':
      return { ticket: 8000, commission: 0.1 }
    case 'trades':
      return { ticket: 450, commission: 0.12 }
    case 'outdoor':
      return { ticket: 350, commission: 0.15 }
    case 'exterior':
      return { ticket: 4500, commission: 0.1 }
    case 'interior':
      return { ticket: 2800, commission: 0.12 }
    case 'cleaning':
      return { ticket: 220, commission: 0.15 }
    case 'hauling':
      return { ticket: 380, commission: 0.14 }
    case 'automotive':
      return { ticket: 280, commission: 0.15 }
    default:
      return { ticket: 400, commission: 0.12 }
  }
}

/**
 * Explicit ticket / commission overrides (USD ticket, rate 0–1).
 * Missing slugs fall back to categoryEconomics.
 */
const LEAD_ECO: Record<string, { ticket: number; commission: number }> = {
  'water-damage-restoration': { ticket: 8500, commission: 0.1 },
  'mold-remediation': { ticket: 4500, commission: 0.1 },
  'fire-damage-restoration': { ticket: 12000, commission: 0.09 },
  'foundation-repair': { ticket: 9500, commission: 0.1 },
  plumber: { ticket: 420, commission: 0.13 },
  electrician: { ticket: 450, commission: 0.12 },
  'hvac-repair': { ticket: 550, commission: 0.12 },
  roofing: { ticket: 6500, commission: 0.1 },
  'garage-door-repair': { ticket: 380, commission: 0.14 },
  'appliance-repair': { ticket: 220, commission: 0.15 },
  locksmith: { ticket: 180, commission: 0.16 },
  'septic-service': { ticket: 650, commission: 0.12 },
  'well-drilling': { ticket: 5500, commission: 0.1 },
  'chimney-sweep': { ticket: 280, commission: 0.14 },
  'tree-service': { ticket: 750, commission: 0.14 },
  landscaping: { ticket: 1200, commission: 0.12 },
  'lawn-care': { ticket: 85, commission: 0.18 },
  'snow-removal': { ticket: 120, commission: 0.16 },
  fencing: { ticket: 2800, commission: 0.12 },
  'concrete-contractor': { ticket: 3500, commission: 0.11 },
  'asphalt-paving': { ticket: 4200, commission: 0.1 },
  'pressure-washing': { ticket: 280, commission: 0.15 },
  'gutter-cleaning': { ticket: 180, commission: 0.16 },
  'pool-service': { ticket: 220, commission: 0.14 },
  'siding-contractor': { ticket: 7200, commission: 0.1 },
  'window-replacement': { ticket: 5500, commission: 0.1 },
  'solar-installation': { ticket: 18000, commission: 0.08 },
  'painting-contractor': { ticket: 1800, commission: 0.13 },
  'drywall-repair': { ticket: 450, commission: 0.14 },
  'flooring-installation': { ticket: 3200, commission: 0.12 },
  'kitchen-remodeling': { ticket: 14000, commission: 0.09 },
  'bathroom-remodeling': { ticket: 9500, commission: 0.1 },
  'house-cleaning': { ticket: 160, commission: 0.16 },
  'carpet-cleaning': { ticket: 220, commission: 0.15 },
  'window-cleaning': { ticket: 180, commission: 0.16 },
  'pest-control': { ticket: 280, commission: 0.14 },
  'junk-removal': { ticket: 350, commission: 0.15 },
  'dumpster-rental': { ticket: 450, commission: 0.14 },
  'moving-company': { ticket: 900, commission: 0.12 },
  towing: { ticket: 150, commission: 0.15 },
  'auto-glass-repair': { ticket: 320, commission: 0.14 },
}

type NicheSeedCore = Omit<NicheSeed, 'avgTicketUsd' | 'leadCommissionRate'>

const NICHE_SEED_CORE: NicheSeedCore[] = [
  // --- Emergency / high-ticket restoration -------------------------------
  // Highest rent per search anywhere in local services: one job is five figures
  // and the searcher is buying today.
  {
    slug: 'water-damage-restoration',
    label: 'Water Damage Restoration',
    keywordNoun: 'water damage restoration',
    emdToken: 'waterdamage',
    domainStems: ['waterdamage', 'restoration', 'floodclean'],
    category: 'restoration',
    demandPerCapitaPer1k: 1.1,
    valuePerSearchMicros: usd(22),
    rentFloorMicros: usd(300),
    rentCeilingMicros: usd(6000),
  },
  {
    slug: 'mold-remediation',
    label: 'Mold Remediation',
    keywordNoun: 'mold remediation',
    emdToken: 'moldremoval',
    domainStems: ['mold', 'remediation'],
    category: 'restoration',
    demandPerCapitaPer1k: 0.7,
    valuePerSearchMicros: usd(18),
    rentFloorMicros: usd(250),
    rentCeilingMicros: usd(4500),
  },
  {
    slug: 'fire-damage-restoration',
    label: 'Fire Damage Restoration',
    keywordNoun: 'fire damage restoration',
    emdToken: 'firedamage',
    domainStems: ['firedamage', 'firerestoration', 'smokedamage'],
    category: 'restoration',
    demandPerCapitaPer1k: 0.3,
    valuePerSearchMicros: usd(24),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(4000),
  },
  {
    slug: 'foundation-repair',
    label: 'Foundation Repair',
    keywordNoun: 'foundation repair',
    emdToken: 'foundationrepair',
    domainStems: ['foundation', 'basementwaterproof'],
    category: 'structural',
    demandPerCapitaPer1k: 0.9,
    valuePerSearchMicros: usd(20),
    rentFloorMicros: usd(275),
    rentCeilingMicros: usd(5000),
  },

  // --- Core trades -------------------------------------------------------
  {
    slug: 'plumber',
    label: 'Plumber',
    keywordNoun: 'plumber',
    emdToken: 'plumbing',
    // 'plumb' covers plumber, plumbing, plumbers.
    domainStems: ['plumb', 'drain', 'rooter'],
    category: 'trades',
    demandPerCapitaPer1k: 6.5,
    valuePerSearchMicros: usd(6),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(4000),
  },
  {
    slug: 'electrician',
    label: 'Electrician',
    keywordNoun: 'electrician',
    emdToken: 'electric',
    domainStems: ['electric', 'sparky'],
    category: 'trades',
    demandPerCapitaPer1k: 4.8,
    valuePerSearchMicros: usd(6),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(3800),
  },
  {
    slug: 'hvac-repair',
    label: 'HVAC Repair',
    keywordNoun: 'hvac repair',
    emdToken: 'hvac',
    domainStems: ['hvac', 'heating', 'airconditioning', 'heatingandair', 'furnace'],
    category: 'trades',
    demandPerCapitaPer1k: 5.4,
    valuePerSearchMicros: usd(8),
    rentFloorMicros: usd(250),
    rentCeilingMicros: usd(5000),
  },
  {
    slug: 'roofing',
    label: 'Roofing',
    keywordNoun: 'roofing',
    emdToken: 'roofing',
    domainStems: ['roof'],
    category: 'exterior',
    demandPerCapitaPer1k: 3.9,
    valuePerSearchMicros: usd(14),
    rentFloorMicros: usd(300),
    rentCeilingMicros: usd(6000),
  },
  {
    slug: 'garage-door-repair',
    label: 'Garage Door Repair',
    keywordNoun: 'garage door repair',
    emdToken: 'garagedoor',
    domainStems: ['garagedoor', 'overheaddoor'],
    category: 'trades',
    demandPerCapitaPer1k: 2.6,
    valuePerSearchMicros: usd(7),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(3000),
  },
  {
    slug: 'appliance-repair',
    label: 'Appliance Repair',
    keywordNoun: 'appliance repair',
    emdToken: 'appliancerepair',
    domainStems: ['appliance'],
    category: 'trades',
    demandPerCapitaPer1k: 3.1,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2200),
  },
  {
    slug: 'locksmith',
    label: 'Locksmith',
    keywordNoun: 'locksmith',
    emdToken: 'locksmith',
    domainStems: ['locksmith', 'lockout'],
    category: 'trades',
    demandPerCapitaPer1k: 2.4,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2000),
  },
  {
    slug: 'septic-service',
    label: 'Septic Service',
    keywordNoun: 'septic service',
    emdToken: 'septic',
    domainStems: ['septic'],
    category: 'trades',
    demandPerCapitaPer1k: 1.2,
    valuePerSearchMicros: usd(9),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2500),
  },
  {
    slug: 'well-drilling',
    label: 'Well Drilling',
    keywordNoun: 'well drilling',
    emdToken: 'welldrilling',
    domainStems: ['welldrill', 'waterwell'],
    category: 'trades',
    demandPerCapitaPer1k: 0.4,
    valuePerSearchMicros: usd(15),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2500),
  },
  {
    slug: 'chimney-sweep',
    label: 'Chimney Sweep',
    keywordNoun: 'chimney sweep',
    emdToken: 'chimney',
    domainStems: ['chimney', 'flue'],
    category: 'trades',
    demandPerCapitaPer1k: 0.9,
    valuePerSearchMicros: usd(5),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(1800),
  },

  // --- Outdoor -----------------------------------------------------------
  {
    slug: 'tree-service',
    label: 'Tree Service',
    keywordNoun: 'tree service',
    emdToken: 'treeservice',
    domainStems: ['tree', 'arborist', 'stump'],
    category: 'outdoor',
    demandPerCapitaPer1k: 4.2,
    valuePerSearchMicros: usd(6),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(3500),
  },
  {
    slug: 'landscaping',
    label: 'Landscaping',
    keywordNoun: 'landscaping',
    emdToken: 'landscaping',
    domainStems: ['landscap', 'hardscap'],
    category: 'outdoor',
    demandPerCapitaPer1k: 4.6,
    valuePerSearchMicros: usd(5),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(3000),
  },
  {
    slug: 'lawn-care',
    label: 'Lawn Care',
    keywordNoun: 'lawn care',
    emdToken: 'lawncare',
    domainStems: ['lawn', 'mowing', 'turf'],
    category: 'outdoor',
    demandPerCapitaPer1k: 5.1,
    valuePerSearchMicros: usd(3),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(2200),
  },
  {
    slug: 'snow-removal',
    label: 'Snow Removal',
    keywordNoun: 'snow removal',
    emdToken: 'snowremoval',
    domainStems: ['snow', 'plowing'],
    category: 'outdoor',
    demandPerCapitaPer1k: 1.8,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(2000),
  },
  {
    slug: 'fencing',
    label: 'Fencing',
    keywordNoun: 'fence company',
    emdToken: 'fencing',
    domainStems: ['fence', 'fencing'],
    category: 'outdoor',
    demandPerCapitaPer1k: 2.2,
    valuePerSearchMicros: usd(9),
    rentFloorMicros: usd(180),
    rentCeilingMicros: usd(3000),
  },
  {
    slug: 'concrete-contractor',
    label: 'Concrete Contractor',
    keywordNoun: 'concrete contractor',
    emdToken: 'concrete',
    domainStems: ['concrete', 'cement'],
    category: 'outdoor',
    demandPerCapitaPer1k: 2.0,
    valuePerSearchMicros: usd(11),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(3500),
  },
  {
    slug: 'asphalt-paving',
    label: 'Asphalt Paving',
    keywordNoun: 'asphalt paving',
    emdToken: 'paving',
    domainStems: ['asphalt', 'paving', 'sealcoat'],
    category: 'outdoor',
    demandPerCapitaPer1k: 1.3,
    valuePerSearchMicros: usd(12),
    rentFloorMicros: usd(180),
    rentCeilingMicros: usd(3000),
  },
  {
    slug: 'pressure-washing',
    label: 'Pressure Washing',
    keywordNoun: 'pressure washing',
    emdToken: 'pressurewashing',
    domainStems: ['pressurewash', 'powerwash', 'softwash'],
    category: 'outdoor',
    demandPerCapitaPer1k: 1.9,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1800),
  },
  {
    slug: 'gutter-cleaning',
    label: 'Gutter Cleaning',
    keywordNoun: 'gutter cleaning',
    emdToken: 'gutters',
    domainStems: ['gutter'],
    category: 'outdoor',
    demandPerCapitaPer1k: 1.5,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1600),
  },
  {
    slug: 'pool-service',
    label: 'Pool Service',
    keywordNoun: 'pool service',
    emdToken: 'poolservice',
    domainStems: ['pool', 'spaservice'],
    category: 'outdoor',
    demandPerCapitaPer1k: 1.7,
    valuePerSearchMicros: usd(5),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(2400),
  },

  // --- Exterior improvement ---------------------------------------------
  {
    slug: 'siding-contractor',
    label: 'Siding Contractor',
    keywordNoun: 'siding contractor',
    emdToken: 'siding',
    domainStems: ['siding'],
    category: 'exterior',
    demandPerCapitaPer1k: 1.4,
    valuePerSearchMicros: usd(13),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(3200),
  },
  {
    slug: 'window-replacement',
    label: 'Window Replacement',
    keywordNoun: 'window replacement',
    emdToken: 'windows',
    domainStems: ['window', 'glazing'],
    category: 'exterior',
    demandPerCapitaPer1k: 1.8,
    valuePerSearchMicros: usd(12),
    rentFloorMicros: usd(200),
    rentCeilingMicros: usd(3400),
  },
  {
    slug: 'solar-installation',
    label: 'Solar Installation',
    keywordNoun: 'solar installers',
    emdToken: 'solar',
    domainStems: ['solar', 'photovoltaic'],
    category: 'exterior',
    demandPerCapitaPer1k: 1.6,
    valuePerSearchMicros: usd(18),
    rentFloorMicros: usd(250),
    rentCeilingMicros: usd(5000),
  },

  // --- Interior ----------------------------------------------------------
  {
    slug: 'painting-contractor',
    label: 'Painting Contractor',
    keywordNoun: 'painters',
    emdToken: 'painting',
    domainStems: ['paint'],
    category: 'interior',
    demandPerCapitaPer1k: 3.0,
    valuePerSearchMicros: usd(6),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2800),
  },
  {
    slug: 'drywall-repair',
    label: 'Drywall Repair',
    keywordNoun: 'drywall repair',
    emdToken: 'drywall',
    domainStems: ['drywall', 'plaster'],
    category: 'interior',
    demandPerCapitaPer1k: 1.6,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1800),
  },
  {
    slug: 'flooring-installation',
    label: 'Flooring Installation',
    keywordNoun: 'flooring installation',
    emdToken: 'flooring',
    domainStems: ['floor', 'hardwood', 'tile'],
    category: 'interior',
    demandPerCapitaPer1k: 2.3,
    valuePerSearchMicros: usd(9),
    rentFloorMicros: usd(180),
    rentCeilingMicros: usd(3000),
  },
  {
    slug: 'kitchen-remodeling',
    label: 'Kitchen Remodeling',
    keywordNoun: 'kitchen remodeling',
    emdToken: 'kitchenremodel',
    domainStems: ['kitchen', 'remodel', 'cabinet'],
    category: 'interior',
    demandPerCapitaPer1k: 2.1,
    valuePerSearchMicros: usd(16),
    rentFloorMicros: usd(250),
    rentCeilingMicros: usd(5000),
  },
  {
    slug: 'bathroom-remodeling',
    label: 'Bathroom Remodeling',
    keywordNoun: 'bathroom remodeling',
    emdToken: 'bathroomremodel',
    domainStems: ['bathroom', 'bathremodel', 'remodel'],
    category: 'interior',
    demandPerCapitaPer1k: 2.0,
    valuePerSearchMicros: usd(14),
    rentFloorMicros: usd(220),
    rentCeilingMicros: usd(4500),
  },

  // --- Cleaning ----------------------------------------------------------
  {
    slug: 'house-cleaning',
    label: 'House Cleaning',
    keywordNoun: 'house cleaning',
    emdToken: 'housecleaning',
    domainStems: ['cleaning', 'maid', 'housekeep'],
    category: 'cleaning',
    demandPerCapitaPer1k: 4.4,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2400),
  },
  {
    slug: 'carpet-cleaning',
    label: 'Carpet Cleaning',
    keywordNoun: 'carpet cleaning',
    emdToken: 'carpetcleaning',
    domainStems: ['carpet', 'upholstery'],
    category: 'cleaning',
    demandPerCapitaPer1k: 2.7,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2200),
  },
  {
    slug: 'window-cleaning',
    label: 'Window Cleaning',
    keywordNoun: 'window cleaning',
    emdToken: 'windowcleaning',
    domainStems: ['windowclean', 'windowwash'],
    category: 'cleaning',
    demandPerCapitaPer1k: 1.3,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1600),
  },
  {
    slug: 'pest-control',
    label: 'Pest Control',
    keywordNoun: 'pest control',
    emdToken: 'pestcontrol',
    domainStems: ['pest', 'exterminat', 'termite'],
    category: 'cleaning',
    demandPerCapitaPer1k: 4.0,
    valuePerSearchMicros: usd(6),
    rentFloorMicros: usd(180),
    rentCeilingMicros: usd(3000),
  },

  // --- Hauling and moving -----------------------------------------------
  {
    slug: 'junk-removal',
    label: 'Junk Removal',
    keywordNoun: 'junk removal',
    emdToken: 'junkremoval',
    domainStems: ['junk', 'hauling', 'debris'],
    category: 'hauling',
    demandPerCapitaPer1k: 2.5,
    valuePerSearchMicros: usd(5),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2400),
  },
  {
    slug: 'dumpster-rental',
    label: 'Dumpster Rental',
    keywordNoun: 'dumpster rental',
    emdToken: 'dumpsterrental',
    domainStems: ['dumpster', 'rolloff'],
    category: 'hauling',
    demandPerCapitaPer1k: 1.7,
    valuePerSearchMicros: usd(7),
    rentFloorMicros: usd(150),
    rentCeilingMicros: usd(2600),
  },
  {
    slug: 'moving-company',
    label: 'Moving Company',
    keywordNoun: 'movers',
    emdToken: 'movers',
    domainStems: ['moving', 'movers'],
    category: 'hauling',
    demandPerCapitaPer1k: 3.3,
    valuePerSearchMicros: usd(8),
    rentFloorMicros: usd(180),
    rentCeilingMicros: usd(3200),
  },
  {
    slug: 'towing',
    label: 'Towing',
    keywordNoun: 'towing service',
    emdToken: 'towing',
    domainStems: ['towing', 'tow', 'wrecker'],
    category: 'automotive',
    demandPerCapitaPer1k: 2.8,
    valuePerSearchMicros: usd(3),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1800),
  },
  {
    slug: 'auto-glass-repair',
    label: 'Auto Glass Repair',
    keywordNoun: 'auto glass repair',
    emdToken: 'autoglass',
    domainStems: ['autoglass', 'windshield'],
    category: 'automotive',
    demandPerCapitaPer1k: 1.9,
    valuePerSearchMicros: usd(4),
    rentFloorMicros: usd(120),
    rentCeilingMicros: usd(1800),
  },
]

export const NICHE_SEEDS: NicheSeed[] = NICHE_SEED_CORE.map((s) => {
  const eco = LEAD_ECO[s.slug] ?? categoryEconomics(s.category)
  return {
    ...s,
    avgTicketUsd: eco.ticket,
    leadCommissionRate: eco.commission,
  }
})

/** Derived lead sell price in micros (ticket × commission). */
export function nicheLeadValueMicros(seed: Pick<NicheSeed, 'avgTicketUsd' | 'leadCommissionRate'>): bigint {
  return usd(seed.avgTicketUsd * seed.leadCommissionRate)
}

export function nicheAvgTicketMicros(seed: Pick<NicheSeed, 'avgTicketUsd'>): bigint {
  return usd(seed.avgTicketUsd)
}

export function nicheCommissionBps(seed: Pick<NicheSeed, 'leadCommissionRate'>): number {
  return Math.round(seed.leadCommissionRate * 10_000)
}

if (NICHE_SEEDS.length !== 41) {
  // A guard rather than a comment: the count is quoted in the README and the
  // cost model ("~$0.24 per cold locality" assumes ~40 x 2 live calls).
  // eslint-disable-next-line no-console
  console.warn(`NICHE_SEEDS has ${NICHE_SEEDS.length} entries; update the cost estimate if this changed materially.`)
}
