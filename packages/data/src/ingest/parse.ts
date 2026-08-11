import { lines, splitCsv } from './download.js'
import { FIPS_TO_STATE } from './census-sources.js'

/** Parsers for the Census flat files. Pure over strings, so they are testable. */

export interface GazPlace {
  geoid: string // state FIPS + place FIPS, 7 chars
  stateCode: string
  rawName: string
  lat: number | null
  lon: number | null
  landAreaSqMi: number | null
}

/** Gazetteer place file: TAB-delimited, header row, trailing spaces on every field. */
export function parseGazetteerPlaces(text: string): GazPlace[] {
  const rows = lines(text)
  const header = rows[0]?.split('\t').map((h) => h.trim().toUpperCase()) ?? []
  const idx = (name: string) => header.indexOf(name)
  const iState = idx('USPS')
  const iGeoid = idx('GEOID')
  const iName = idx('NAME')
  const iAland = idx('ALAND_SQMI')
  const iLat = idx('INTPTLAT')
  const iLon = idx('INTPTLONG')

  const out: GazPlace[] = []
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i]!.split('\t').map((v) => v.trim())
    const geoid = f[iGeoid] ?? ''
    const stateCode = f[iState] ?? ''
    const rawName = f[iName] ?? ''
    if (!geoid || !stateCode || !rawName) continue
    out.push({
      geoid,
      stateCode,
      rawName,
      lat: num(f[iLat]),
      lon: num(f[iLon]),
      landAreaSqMi: num(f[iAland]),
    })
  }
  return out
}

export interface GazCounty {
  geoid: string // 5 chars
  stateCode: string
  rawName: string
  lat: number | null
  lon: number | null
}

export function parseGazetteerCounties(text: string): GazCounty[] {
  const rows = lines(text)
  const header = rows[0]?.split('\t').map((h) => h.trim().toUpperCase()) ?? []
  const idx = (name: string) => header.indexOf(name)
  const iState = idx('USPS')
  const iGeoid = idx('GEOID')
  const iName = idx('NAME')
  const iLat = idx('INTPTLAT')
  const iLon = idx('INTPTLONG')

  const out: GazCounty[] = []
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i]!.split('\t').map((v) => v.trim())
    if (!f[iGeoid] || !f[iName]) continue
    out.push({
      geoid: f[iGeoid]!,
      stateCode: f[iState] ?? '',
      rawName: f[iName]!,
      lat: num(f[iLat]),
      lon: num(f[iLon]),
    })
  }
  return out
}

export interface GazCbsa {
  cbsaCode: string
  rawName: string
  /** 1 = Metropolitan Statistical Area, 2 = Micropolitan. */
  cbsaType: string
  lat: number | null
  lon: number | null
}

/**
 * CBSA gazetteer.
 *
 * NOTE the column names, which do NOT follow the other gazetteer files: the CBSA
 * code lives in `GEOID`, not `CBSA`. Looking for `CBSA` yields index -1 and
 * therefore ZERO rows -- with no error, because an empty result set from a
 * successfully-downloaded file looks exactly like "there are no metros". That is
 * how this shipped with 0 metros the first time.
 *
 * `NAME` also carries a suffix: "Abilene, TX Metro Area". It has to come off
 * before the name is any use for a provider lookup.
 */
export function parseGazetteerCbsa(text: string): GazCbsa[] {
  const rows = lines(text)
  const header = rows[0]?.split('\t').map((h) => h.trim().toUpperCase()) ?? []
  const idx = (name: string) => header.indexOf(name)
  const iGeoid = idx('GEOID')
  const iName = idx('NAME')
  const iType = idx('CBSA_TYPE')
  const iLat = idx('INTPTLAT')
  const iLon = idx('INTPTLONG')

  if (iGeoid < 0 || iName < 0) {
    throw new Error(
      `CBSA gazetteer is missing GEOID or NAME. Header was: ${header.join(', ')}. ` +
        'Refusing to return an empty list, which would silently produce zero metros.',
    )
  }

  const out: GazCbsa[] = []
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i]!.split('\t').map((v) => v.trim())
    const geoid = f[iGeoid]
    const name = f[iName]
    if (!geoid || !name) continue
    out.push({
      cbsaCode: geoid,
      rawName: name.replace(/\s+(Metro|Micro)\s+Area$/i, '').trim(),
      cbsaType: f[iType] ?? '',
      lat: num(f[iLat]),
      lon: num(f[iLon]),
    })
  }
  return out
}

// ---------------------------------------------------------------------------

export interface SubEstRow {
  sumlev: string
  stateCode: string
  /** state FIPS + place FIPS for SUMLEV 162, state+county FIPS for 050. */
  geoid: string
  rawName: string
  population: number | null
}

/**
 * sub-est2024.csv.
 *
 * SUMLEV 162 = incorporated place (this is the corpus)
 * SUMLEV 050 = county
 * SUMLEV 040 = state
 *
 * There is NO CDP level here, so unincorporated communities never get a
 * population and are excluded by construction -- consistent with the ~19,475
 * incorporated-place figure.
 */
export function parseSubEst(text: string): SubEstRow[] {
  const rows = lines(text)
  const header = splitCsv(rows[0]!).map((h) => h.trim().toUpperCase())
  const idx = (name: string) => header.indexOf(name)
  const iSumlev = idx('SUMLEV')
  const iState = idx('STATE')
  const iCounty = idx('COUNTY')
  const iPlace = idx('PLACE')
  const iName = idx('NAME')
  const iPop = idx('POPESTIMATE2024')

  const out: SubEstRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const f = splitCsv(rows[i]!)
    const sumlev = (f[iSumlev] ?? '').trim()
    const stateFips = (f[iState] ?? '').trim()
    const stateCode = FIPS_TO_STATE[stateFips] ?? ''
    if (!stateCode) continue

    if (sumlev === '162') {
      const place = (f[iPlace] ?? '').trim()
      if (!place || place === '00000') continue
      out.push({
        sumlev,
        stateCode,
        geoid: `${stateFips}${place}`,
        rawName: (f[iName] ?? '').trim(),
        population: num(f[iPop]),
      })
    } else if (sumlev === '050') {
      const county = (f[iCounty] ?? '').trim()
      if (!county || county === '000') continue
      out.push({
        sumlev,
        stateCode,
        geoid: `${stateFips}${county}`,
        rawName: (f[iName] ?? '').trim(),
        population: num(f[iPop]),
      })
    }
  }
  return out
}

export interface CbsaEstRow {
  cbsaCode: string
  name: string
  population: number | null
}

/**
 * cbsa-est2024-alldata.csv.
 *
 * Contains BOTH the metro totals and one row per component county. Only rows
 * whose LSAD is a "... Statistical Area" and which have no STCOU are the metro
 * totals. Taking every row would double-count component counties as metros.
 */
export function parseCbsaEst(text: string): CbsaEstRow[] {
  const rows = lines(text)
  const header = splitCsv(rows[0]!).map((h) => h.trim().toUpperCase())
  const idx = (name: string) => header.indexOf(name)
  const iCbsa = idx('CBSA')
  const iStcou = idx('STCOU')
  const iName = idx('NAME')
  const iLsad = idx('LSAD')
  const iPop = idx('POPESTIMATE2024')

  const out: CbsaEstRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const f = splitCsv(rows[i]!)
    const stcou = (f[iStcou] ?? '').trim()
    const lsad = (f[iLsad] ?? '').trim()
    // Metro/micro totals only: component-county rows carry an STCOU.
    if (stcou) continue
    if (!/Statistical Area/i.test(lsad)) continue
    const cbsaCode = (f[iCbsa] ?? '').trim()
    if (!cbsaCode) continue
    out.push({
      cbsaCode,
      name: (f[iName] ?? '').trim(),
      population: num(f[iPop]),
    })
  }
  return out
}

// ---------------------------------------------------------------------------

export interface PlaceCounty {
  stateCode: string
  /** state FIPS + place FIPS */
  placeGeoid: string
  /** state FIPS + county FIPS */
  countyGeoid: string
  countyName: string
  placeName: string
  incorporated: boolean
}

/**
 * national_place_by_county2020.txt -- pipe-delimited with a header.
 * STATE|STATEFP|COUNTYFP|COUNTYNAME|PLACEFP|PLACENS|PLACENAME|TYPE|CLASSFP|FUNCSTAT
 *
 * APPROXIMATION, stated plainly: a place spanning several counties appears on
 * several rows, and we keep the FIRST by county FIPS as its primary county. The
 * correct answer needs a point-in-polygon test against county shapefiles, which
 * is a lot of machinery for a field used only to build one extra provider
 * lookup candidate. If the county is wrong, candidate form 1 (name + state)
 * still resolves the place; only forms 2 and 3 are affected.
 */
export function parsePlaceCounty(text: string): Map<string, PlaceCounty> {
  const rows = lines(text)
  const byPlace = new Map<string, PlaceCounty>()

  for (let i = 1; i < rows.length; i++) {
    const f = rows[i]!.split('|').map((v) => v.trim())
    const [stateCode, stateFp, countyFp, countyName, placeFp, , placeName, type] = f
    if (!stateFp || !countyFp || !placeFp || !placeName) continue
    const placeGeoid = `${stateFp}${placeFp}`
    const existing = byPlace.get(placeGeoid)
    // Deterministic: lowest county FIPS wins, so a re-ingest is stable.
    if (existing && existing.countyGeoid <= `${stateFp}${countyFp}`) continue
    byPlace.set(placeGeoid, {
      stateCode: stateCode ?? '',
      placeGeoid,
      countyGeoid: `${stateFp}${countyFp}`,
      countyName: countyName ?? '',
      placeName,
      incorporated: (type ?? '').toUpperCase().includes('INCORPORATED'),
    })
  }
  return byPlace
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const t = v.trim()
  if (t === '' || t === 'NA' || t === 'null') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
