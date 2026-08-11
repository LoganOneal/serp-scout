/**
 * Honest coverage of a Keyword Planner export against the niche catalog.
 *
 * The first pass used the app's own matcher and reported 42.9%. That figure was
 * wrong, and the reason matters: `matchNicheByKeyword` requires the whole
 * keyword_noun as a substring, so "roofers" never matches the `roofing` niche
 * and "fence installation" never matches `fencing` (noun "fence company").
 *
 * This pass matches on stems and aliases instead, which is what a human means
 * by "is this category covered". The gap between the two numbers is itself a
 * finding about the app's matcher.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-niche-coverage2.mts "<csv>"
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('Pass the CSV path')

/** Stems that should route a keyword to an existing niche. */
const NICHE_STEMS: Record<string, string[]> = {
  'appliance-repair': ['appliance', 'refrigerator', 'dishwasher', 'washer', 'dryer repair', 'oven', 'stove', 'microwave', 'freezer', 'ice maker', 'garbage disposal'],
  'asphalt-paving': ['asphalt', 'paving', 'sealcoat', 'driveway paving'],
  'auto-glass-repair': ['auto glass', 'windshield'],
  'bathroom-remodeling': ['bathroom', 'shower remodel', 'bathtub', 'tub to shower'],
  'carpet-cleaning': ['carpet clean', 'rug clean', 'upholstery clean'],
  'chimney-sweep': ['chimney', 'fireplace', 'flue'],
  'concrete-contractor': ['concrete', 'driveway', 'patio', 'sidewalk', 'stamped'],
  'drywall-repair': ['drywall', 'sheetrock', 'plaster'],
  'dumpster-rental': ['dumpster', 'roll off'],
  electrician: ['electric', 'wiring', 'panel upgrade', 'generator', 'ev charger', 'lighting install'],
  fencing: ['fence', 'fencing', 'gate install'],
  'fire-damage-restoration': ['fire damage', 'smoke damage', 'soot'],
  'flooring-installation': ['floor', 'hardwood', 'laminate', 'vinyl plank', 'tile install', 'carpet install'],
  'foundation-repair': ['foundation', 'crawl space', 'basement waterproof', 'slab', 'pier and beam'],
  'garage-door-repair': ['garage door'],
  'gutter-cleaning': ['gutter'],
  'house-cleaning': ['house clean', 'maid', 'housekeep', 'deep clean', 'move out clean'],
  'hvac-repair': ['hvac', 'ac repair', 'air condition', 'furnace', 'heating', 'heat pump', 'mini split', 'air duct', 'duct clean', 'thermostat', 'boiler'],
  'junk-removal': ['junk', 'hauling', 'debris removal', 'estate cleanout'],
  'kitchen-remodeling': ['kitchen', 'cabinet', 'countertop', 'backsplash'],
  landscaping: ['landscap', 'sod', 'irrigation', 'sprinkler', 'hardscap', 'retaining wall', 'mulch', 'garden'],
  'lawn-care': ['lawn', 'mowing', 'aeration', 'fertiliz', 'weed control', 'turf'],
  locksmith: ['locksmith', 'lock rekey', 'key duplicat', 'lockout'],
  'mold-remediation': ['mold', 'mildew'],
  'moving-company': ['mover', 'moving', 'packing service'],
  'painting-contractor': ['paint', 'stain', 'wallpaper'],
  'pest-control': ['pest', 'exterminat', 'termite', 'bed bug', 'cockroach', 'roach', 'rodent', 'mice', 'rat control', 'ant control', 'mosquito', 'wildlife removal', 'bee removal', 'flea'],
  plumber: ['plumb', 'water heater', 'sewer', 'drain', 'toilet', 'faucet', 'sump pump', 'water softener', 'repipe', 'leak detect', 'septic tank pump'],
  'pool-service': ['pool', 'spa service', 'hot tub'],
  'pressure-washing': ['pressure wash', 'power wash', 'soft wash'],
  roofing: ['roof', 'shingle', 'storm damage', 'hail damage'],
  'septic-service': ['septic', 'leach field', 'grease trap'],
  'siding-contractor': ['siding', 'stucco', 'soffit', 'fascia'],
  'snow-removal': ['snow', 'ice dam', 'plowing'],
  'solar-installation': ['solar'],
  towing: ['towing', 'tow truck', 'roadside'],
  'tree-service': ['tree', 'stump', 'arborist', 'shrub'],
  'water-damage-restoration': ['water damage', 'flood', 'restoration'],
  'well-drilling': ['well drilling', 'well pump', 'water well'],
  'window-cleaning': ['window clean', 'window wash'],
  'window-replacement': ['window', 'glass replacement', 'door install', 'closet organizer', 'blinds', 'shutter'],
}

function readKeywordRows(file: string): Array<{ keyword: string; volume: number }> {
  const raw = readFileSync(file)
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')
  const lines = text.split(/\r?\n/)
  const h = lines.findIndex((l) => l.startsWith('Keyword\t'))
  const cols = lines[h]!.split('\t')
  const volIndex = cols.findIndex((c) => c.trim().toLowerCase().startsWith('avg. monthly'))
  const out: Array<{ keyword: string; volume: number }> = []
  for (const line of lines.slice(h + 1)) {
    const parts = line.split('\t')
    const keyword = (parts[0] ?? '').trim()
    if (!keyword) continue
    const v = Number((parts[volIndex] ?? '').trim())
    out.push({ keyword, volume: Number.isFinite(v) ? v : 0 })
  }
  return out
}

const rows = readKeywordRows(path)
const total = rows.reduce((a, b) => a + b.volume, 0)

const hit = new Map<string, { volume: number; count: number }>()
const missed: Array<{ keyword: string; volume: number }> = []

for (const r of rows) {
  const k = r.keyword.toLowerCase()
  let slug: string | null = null
  let bestLen = 0
  for (const [s, stems] of Object.entries(NICHE_STEMS)) {
    for (const stem of stems) {
      if (k.includes(stem) && stem.length > bestLen) {
        slug = s
        bestLen = stem.length
      }
    }
  }
  if (slug) {
    const cur = hit.get(slug) ?? { volume: 0, count: 0 }
    cur.volume += r.volume
    cur.count += 1
    hit.set(slug, cur)
  } else {
    missed.push(r)
  }
}

const missedVol = missed.reduce((a, b) => a + b.volume, 0)
console.log(`${rows.length} keywords · ${Math.round(total).toLocaleString()} searches/mo\n`)
console.log('==================== COVERAGE (stem matching) ====================')
console.log(`matched   : ${rows.length - missed.length}/${rows.length} keywords`)
console.log(`by volume : ${(((total - missedVol) / total) * 100).toFixed(1)}% covered`)
console.log(`uncovered : ${Math.round(missedVol).toLocaleString()} searches/mo across ${missed.length} keywords\n`)

const unused = Object.keys(NICHE_STEMS).filter((s) => !hit.has(s))
console.log(unused.length ? `Niches with NO keywords in this export: ${unused.join(', ')}\n` : 'Every niche matched something.\n')

const STOP = new Set(['near','me','in','the','a','for','of','and','best','top','cost','cheap','local','service','services','company','companies','contractor','contractors','repair','installation','install','replacement','my','how','much','to','is','what','emergency','24','7','hour','same','day','average','price','prices','quotes','estimate'])
const heads = new Map<string, { volume: number; examples: string[] }>()
for (const m of missed) {
  const tokens = m.keyword.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t))
  const head = tokens.slice(0, 2).join(' ') || m.keyword.toLowerCase()
  const cur = heads.get(head) ?? { volume: 0, examples: [] }
  cur.volume += m.volume
  if (cur.examples.length < 2) cur.examples.push(m.keyword)
  heads.set(head, cur)
}

console.log('==================== GENUINELY UNCOVERED CATEGORIES ====================')
for (const [head, v] of [...heads.entries()].sort((a, b) => b[1].volume - a[1].volume).slice(0, 30)) {
  console.log(`${String(Math.round(v.volume)).padStart(9)}  ${head.padEnd(28)} e.g. ${v.examples.join(' / ')}`)
}
console.log(`\n${heads.size} distinct uncovered head terms`)
process.exit(0)
