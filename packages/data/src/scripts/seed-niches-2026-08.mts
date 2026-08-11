/**
 * Add the service categories a 1,273-keyword Keyword Planner export showed the
 * catalog was missing.
 *
 * Measured uncovered volume before this: ~6.7M searches/mo across 231 head
 * terms. These 17 recover roughly 3.5M of it, ranked by that volume.
 *
 * ==================== ON THE ECONOMICS ====================
 * Every prior here is copied from the closest existing niche and marked
 * `economics_source = 'prior:analogue'`, so it is auditable and obviously not
 * measured. Inventing a plausible-looking ticket for "land surveyor" would put
 * a fabricated number in a column the scorer treats as evidence -- these are
 * placeholders that say so.
 *
 * `pnpm enrich:niche-gads` will replace the gads_* fields with real measured
 * demand; the ticket/commission priors need a human.
 * ==========================================================
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/seed-niches-2026-08.mts
 */
import 'dotenv/config'
import { db } from '../db.js'
import { niches } from '../schema.js'

const M = 1_000_000n

interface NewNiche {
  slug: string
  label: string
  keywordNoun: string
  emdToken: string
  category: string
  domainStems: string[]
  keywordAliases: string[]
  /** Monthly searches per 1,000 residents. Prior. */
  dpc: number
  /** Rent per monthly search, micros. Prior. */
  vps: bigint
  ticketUsd: number
  bps: number
  /** Which existing niche the economics were copied from. */
  analogue: string
}

const NEW: NewNiche[] = [
  { slug: 'handyman', label: 'Handyman', keywordNoun: 'handyman', emdToken: 'handyman', category: 'trades',
    domainStems: ['handyman', 'handyservice'], dpc: 9.5, vps: 5_000_000n, ticketUsd: 300, bps: 1200, analogue: 'plumber',
    keywordAliases: ['handyman', 'handy man', 'home repair', 'odd jobs', 'tv mounting', 'furniture assembly', 'picture hanging'] },
  { slug: 'general-contractor', label: 'General Contractor', keywordNoun: 'general contractor', emdToken: 'generalcontractor', category: 'construction',
    domainStems: ['generalcontract', 'gccontract'], dpc: 4.2, vps: 12_000_000n, ticketUsd: 15000, bps: 800, analogue: 'roofing',
    keywordAliases: ['general contractor', 'home remodeling', 'home renovation', 'custom home builder', 'home builder', 'construction company'] },
  { slug: 'dryer-vent-cleaning', label: 'Dryer Vent Cleaning', keywordNoun: 'dryer vent cleaning', emdToken: 'dryerventcleaning', category: 'trades',
    domainStems: ['dryervent'], dpc: 3.1, vps: 5_000_000n, ticketUsd: 180, bps: 1400, analogue: 'gutter-cleaning',
    keywordAliases: ['dryer vent', 'lint removal'] },
  { slug: 'insulation', label: 'Insulation', keywordNoun: 'insulation contractor', emdToken: 'insulation', category: 'exterior',
    domainStems: ['insulation', 'sprayfoam'], dpc: 2.4, vps: 8_000_000n, ticketUsd: 2200, bps: 1000, analogue: 'siding-contractor',
    keywordAliases: ['insulation', 'spray foam', 'blown in insulation', 'attic insulation', 'radiant barrier'] },
  { slug: 'home-inspection', label: 'Home Inspection', keywordNoun: 'home inspector', emdToken: 'homeinspection', category: 'professional',
    domainStems: ['homeinspect'], dpc: 2.0, vps: 7_000_000n, ticketUsd: 450, bps: 1200, analogue: 'well-drilling',
    keywordAliases: ['home inspection', 'home inspector', '4 point inspection', 'wind mitigation', 'radon testing', 'sewer scope'] },
  { slug: 'asbestos-abatement', label: 'Asbestos Abatement', keywordNoun: 'asbestos removal', emdToken: 'asbestosremoval', category: 'restoration',
    domainStems: ['asbestos'], dpc: 1.1, vps: 11_000_000n, ticketUsd: 3000, bps: 1000, analogue: 'mold-remediation',
    keywordAliases: ['asbestos', 'lead paint removal'] },
  { slug: 'excavation', label: 'Excavation', keywordNoun: 'excavation contractor', emdToken: 'excavation', category: 'construction',
    domainStems: ['excavat', 'earthwork'], dpc: 1.6, vps: 9_000_000n, ticketUsd: 4500, bps: 900, analogue: 'concrete-contractor',
    keywordAliases: ['excavation', 'grading', 'land clearing', 'trenching', 'digging'] },
  { slug: 'demolition', label: 'Demolition', keywordNoun: 'demolition contractor', emdToken: 'demolition', category: 'construction',
    domainStems: ['demolition', 'demo'], dpc: 1.2, vps: 9_000_000n, ticketUsd: 5000, bps: 900, analogue: 'concrete-contractor',
    keywordAliases: ['demolition', 'interior demo', 'tear down'] },
  { slug: 'basement-remodeling', label: 'Basement Remodeling', keywordNoun: 'basement remodeling', emdToken: 'basementremodeling', category: 'remodeling',
    domainStems: ['basementremodel', 'basementfinish'], dpc: 1.4, vps: 12_000_000n, ticketUsd: 22000, bps: 800, analogue: 'kitchen-remodeling',
    keywordAliases: ['basement remodel', 'basement finishing', 'egress window'] },
  { slug: 'tv-mounting', label: 'TV Mounting & Repair', keywordNoun: 'tv mounting', emdToken: 'tvmounting', category: 'trades',
    domainStems: ['tvmount', 'tvrepair'], dpc: 2.6, vps: 4_000_000n, ticketUsd: 200, bps: 1400, analogue: 'appliance-repair',
    keywordAliases: ['tv mounting', 'tv repair', 'tv installation', 'home theater install'] },
  { slug: 'furniture-repair', label: 'Furniture Repair', keywordNoun: 'furniture repair', emdToken: 'furniturerepair', category: 'trades',
    domainStems: ['furniturerepair', 'upholstery'], dpc: 1.5, vps: 4_000_000n, ticketUsd: 350, bps: 1300, analogue: 'appliance-repair',
    keywordAliases: ['furniture repair', 'furniture restoration', 'upholstery repair', 'antique restoration'] },
  { slug: 'christmas-light-installation', label: 'Christmas Light Installation', keywordNoun: 'christmas light installation', emdToken: 'christmaslights', category: 'seasonal',
    domainStems: ['christmaslight', 'holidaylight'], dpc: 1.8, vps: 6_000_000n, ticketUsd: 700, bps: 1200, analogue: 'pressure-washing',
    keywordAliases: ['christmas light', 'holiday light', 'permanent lighting'] },
  { slug: 'interior-design', label: 'Interior Design', keywordNoun: 'interior designer', emdToken: 'interiordesign', category: 'professional',
    domainStems: ['interiordesign', 'homestaging'], dpc: 2.1, vps: 7_000_000n, ticketUsd: 3500, bps: 1000, analogue: 'kitchen-remodeling',
    keywordAliases: ['interior design', 'home staging', 'custom closets', 'closet organizer'] },
  { slug: 'land-surveying', label: 'Land Surveying', keywordNoun: 'land surveyor', emdToken: 'landsurveying', category: 'professional',
    domainStems: ['landsurvey', 'surveying'], dpc: 1.3, vps: 8_000_000n, ticketUsd: 900, bps: 1000, analogue: 'well-drilling',
    keywordAliases: ['land surveyor', 'property survey', 'boundary survey', 'elevation certificate'] },
  { slug: 'structural-engineering', label: 'Structural Engineering', keywordNoun: 'structural engineer', emdToken: 'structuralengineer', category: 'professional',
    domainStems: ['structuraleng'], dpc: 1.2, vps: 9_000_000n, ticketUsd: 1200, bps: 1000, analogue: 'foundation-repair',
    keywordAliases: ['structural engineer', 'structural inspection', 'engineering report'] },
  { slug: 'garage-floor-coating', label: 'Garage Floor Coating', keywordNoun: 'garage floor coating', emdToken: 'garagefloorcoating', category: 'remodeling',
    domainStems: ['garagefloor', 'epoxyfloor'], dpc: 1.1, vps: 8_000_000n, ticketUsd: 2800, bps: 1000, analogue: 'flooring-installation',
    keywordAliases: ['garage floor coating', 'epoxy garage', 'polyaspartic'] },
  { slug: 'deck-builder', label: 'Deck Builder', keywordNoun: 'deck builder', emdToken: 'deckbuilder', category: 'exterior',
    domainStems: ['deckbuild', 'deckcontract'], dpc: 2.0, vps: 10_000_000n, ticketUsd: 9000, bps: 900, analogue: 'fencing',
    keywordAliases: ['deck builder', 'deck installation', 'deck repair', 'pergola', 'patio cover', 'screened porch'] },
]

const database = db()
const existing = new Set(
  (await database.select({ slug: niches.slug }).from(niches)).map((n) => n.slug),
)

const toInsert = NEW.filter((n) => !existing.has(n.slug))
console.log(`${NEW.length} candidate(s), ${toInsert.length} not already present\n`)

for (const n of toInsert) {
  const ticket = BigInt(n.ticketUsd) * M
  await database.insert(niches).values({
    slug: n.slug,
    label: n.label,
    keywordNoun: n.keywordNoun,
    emdToken: n.emdToken,
    domainStems: n.domainStems,
    keywordAliases: n.keywordAliases,
    category: n.category,
    demandPerCapitaPer1k: n.dpc,
    valuePerSearchMicros: n.vps,
    rentFloorMicros: 200n * M,
    rentCeilingMicros: 4_000n * M,
    avgTicketMicros: ticket,
    leadCommissionRateBps: n.bps,
    leadValueMicros: (ticket * BigInt(n.bps)) / 10_000n,
    // Says out loud that these are copied, not measured.
    economicsSource: `prior:analogue:${n.analogue}`,
    active: true,
  })
  console.log(`  + ${n.slug.padEnd(30)} (economics from ${n.analogue})`)
}

const total = await database.select({ slug: niches.slug }).from(niches)
console.log(`\ncatalog is now ${total.length} niches`)
process.exit(0)
