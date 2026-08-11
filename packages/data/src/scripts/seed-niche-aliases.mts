/**
 * Seed keyword aliases on the existing niches.
 *
 * Measured against a 1,273-keyword Keyword Planner export: the matcher's
 * whole-noun rule covered 42.9% of volume, and alias matching covers 84.3% of
 * the SAME keywords. Nothing about the catalog changed -- only whether the
 * matcher could see it.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/seed-niche-aliases.mts
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../db.js'
import { niches } from '../schema.js'

/**
 * Phrases that should route a search to a niche.
 *
 * Deliberately includes the plural/agent forms the old matcher missed
 * ("roofers", "movers", "painters"), the equipment nouns an operator would
 * never think to search for as a niche ("water heater" -> plumber), and the
 * damage-cause terms that name the same job ("hail damage" -> roofing).
 */
const ALIASES: Record<string, string[]> = {
  'appliance-repair': ['appliance', 'refrigerator', 'fridge', 'dishwasher', 'washer', 'dryer repair', 'oven', 'stove', 'range hood', 'microwave', 'freezer', 'ice maker', 'garbage disposal'],
  'asphalt-paving': ['asphalt', 'paving', 'sealcoat', 'blacktop'],
  'auto-glass-repair': ['auto glass', 'windshield', 'car window'],
  'bathroom-remodeling': ['bathroom', 'shower remodel', 'bathtub', 'tub to shower', 'walk in tub', 'vanity'],
  'carpet-cleaning': ['carpet clean', 'rug clean', 'upholstery clean', 'steam clean'],
  'chimney-sweep': ['chimney', 'fireplace', 'flue', 'creosote'],
  'concrete-contractor': ['concrete', 'driveway', 'patio', 'sidewalk', 'stamped concrete', 'slab'],
  'drywall-repair': ['drywall', 'sheetrock', 'plaster', 'popcorn ceiling'],
  'dumpster-rental': ['dumpster', 'roll off', 'skip hire'],
  electrician: ['electric', 'electrician', 'wiring', 'panel upgrade', 'ev charger', 'ceiling fan install', 'generator install', 'outlet', 'breaker'],
  fencing: ['fence', 'fencing', 'gate install', 'privacy fence'],
  'fire-damage-restoration': ['fire damage', 'smoke damage', 'soot'],
  'flooring-installation': ['flooring', 'hardwood floor', 'laminate', 'vinyl plank', 'tile install', 'epoxy floor', 'floor refinish'],
  'foundation-repair': ['foundation', 'crawl space', 'basement waterproof', 'pier and beam', 'settling'],
  'garage-door-repair': ['garage door', 'overhead door'],
  'gutter-cleaning': ['gutter', 'downspout', 'gutter guard'],
  'house-cleaning': ['house clean', 'maid', 'housekeep', 'deep clean', 'move out clean', 'cleaning service'],
  'hvac-repair': ['hvac', 'ac repair', 'ac install', 'ac maintenance', 'air condition', 'furnace', 'heating', 'heat pump', 'mini split', 'air duct', 'duct clean', 'thermostat', 'boiler', 'swamp cooler'],
  'junk-removal': ['junk', 'hauling', 'debris removal', 'estate cleanout', 'trash removal'],
  'kitchen-remodeling': ['kitchen', 'cabinet', 'countertop', 'backsplash'],
  landscaping: ['landscap', 'sod', 'irrigation', 'sprinkler', 'hardscap', 'retaining wall', 'mulch', 'paver'],
  'lawn-care': ['lawn', 'mowing', 'aeration', 'fertiliz', 'weed control', 'turf', 'grass'],
  locksmith: ['locksmith', 'rekey', 'lockout', 'key duplicat', 'lock change'],
  'mold-remediation': ['mold', 'mildew'],
  'moving-company': ['mover', 'moving', 'packing service', 'relocation'],
  'painting-contractor': ['paint', 'painter', 'stain', 'wallpaper'],
  'pest-control': ['pest', 'exterminat', 'termite', 'bed bug', 'cockroach', 'roach', 'rodent', 'mice', 'rat control', 'ant control', 'mosquito', 'wildlife removal', 'bee removal', 'flea'],
  plumber: ['plumb', 'water heater', 'tankless', 'sewer', 'drain', 'toilet', 'faucet', 'sump pump', 'water softener', 'repipe', 'leak detect', 'backflow'],
  'pool-service': ['pool', 'spa service', 'hot tub'],
  'pressure-washing': ['pressure wash', 'power wash', 'soft wash'],
  roofing: ['roof', 'roofer', 'shingle', 'hail damage', 'storm damage', 'skylight'],
  'septic-service': ['septic', 'leach field', 'grease trap'],
  'siding-contractor': ['siding', 'stucco', 'soffit', 'fascia'],
  'snow-removal': ['snow', 'ice dam', 'plowing', 'salting'],
  'solar-installation': ['solar'],
  towing: ['towing', 'tow truck', 'roadside'],
  'tree-service': ['tree', 'stump', 'arborist', 'shrub', 'limb removal'],
  'water-damage-restoration': ['water damage', 'flood', 'water restoration', 'burst pipe'],
  'well-drilling': ['well drilling', 'well pump', 'water well'],
  'window-cleaning': ['window clean', 'window wash'],
  'window-replacement': ['window replacement', 'window install', 'glass replacement', 'blinds', 'shutter', 'front door replacement', 'door install'],
}

const database = db()
const existing = await database.select({ id: niches.id, slug: niches.slug }).from(niches)

let updated = 0
for (const n of existing) {
  const aliases = ALIASES[n.slug]
  if (!aliases) {
    console.log(`  no alias list for ${n.slug} — left empty`)
    continue
  }
  await database.update(niches).set({ keywordAliases: aliases }).where(eq(niches.id, n.id))
  updated += 1
}
console.log(`\nseeded aliases on ${updated}/${existing.length} niche(s)`)
process.exit(0)
