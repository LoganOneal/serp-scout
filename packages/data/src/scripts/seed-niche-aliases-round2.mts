/**
 * Second alias pass: close the long tail the first pass left.
 *
 * Every phrase here is a SUB-SERVICE of a niche we already have, not a new
 * category -- which is the case aliases-as-data exists for. Adding a row beats
 * adding a niche whenever the work and the buyer are the same.
 */
import 'dotenv/config'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db.js'
import { niches } from '../schema.js'

const MORE: Record<string, string[]> = {
  'window-replacement': ['window repair', 'window screen', 'screen repair', 'window tint', 'storm window', 'egress window'],
  'flooring-installation': ['carpet install', 'carpet replacement', 'floor cleaning', 'subfloor'],
  'carpet-cleaning': ['tile and grout', 'grout cleaning'],
  electrician: ['generator repair', 'generator maintenance', 'surge protect', 'landscape lighting'],
  plumber: ['hydro jetting', 'hydrojetting', 'pipe lining', 'trenchless', 'water line'],
  'pest-control': ['spider control', 'scorpion control', 'wasp removal', 'tick control'],
  'house-cleaning': ['post construction clean', 'window washing residential', 'pressure clean'],
  'home-inspection': ['radon mitigation', 'radon', 'mold testing', 'thermal imaging'],
  'land-surveying': ['soil testing', 'percolation test', 'topographic'],
  'general-contractor': ['new home construction', 'room addition', 'adu', 'home addition'],
  'furniture-repair': ['furniture refinishing', 'furniture assembly'],
  'concrete-contractor': ['tuckpointing', 'masonry', 'brick repair', 'chimney repair', 'retaining wall repair'],
  'hvac-repair': ['radiator repair', 'radiator', 'evaporative cooler', 'humidifier'],
  'tree-service': ['tree trimming', 'tree removal', 'palm tree'],
  roofing: ['flat roof', 'metal roof', 'tile roof', 'roof coating'],
  'pool-service': ['pool resurfacing', 'pool deck', 'pool heater'],
  landscaping: ['artificial turf', 'xeriscap', 'tree planting', 'drainage'],
  'junk-removal': ['appliance removal', 'mattress removal', 'hot tub removal'],
}

const database = db()
let updated = 0
for (const [slug, extra] of Object.entries(MORE)) {
  const [row] = await database
    .select({ id: niches.id, aliases: niches.keywordAliases })
    .from(niches)
    .where(eq(niches.slug, slug))
    .limit(1)
  if (!row) { console.log(`  MISSING niche ${slug}`); continue }
  const merged = [...new Set([...(row.aliases ?? []), ...extra])]
  await database.update(niches).set({ keywordAliases: merged }).where(eq(niches.id, row.id))
  updated += 1
}
console.log(`extended aliases on ${updated} niche(s)`)
process.exit(0)
