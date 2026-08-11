import type { Niche, RentModel } from '../types.js'

/**
 * Modelled monthly rent for a site ranking in this market.
 *
 * DELIBERATELY EXCLUDES median household income. That was a scoping decision,
 * not an oversight: the ACS API now requires a key on every request (and returns
 * an HTML "Missing Key" page inside an HTTP 200 when it is absent), and the
 * whole geography corpus is otherwise obtainable from keyless bulk files. Rather
 * than block ingest on a credential for one enrichment field, income was cut.
 *
 * The cost is real and worth stating: this model cannot distinguish a wealthy
 * suburb from a poor city of the same population. If that matters later, add
 * B19013_001E per place behind CENSUS_API_KEY and multiply here -- do not
 * "restore" it by inferring income from anything else.
 *
 * Like demand, the return type carries `modelled: true` as a literal so it
 * cannot be constructed as a measurement.
 */
export function modelRent(args: {
  monthlySearches: number | null
  niche: Pick<Niche, 'valuePerSearchMicros' | 'rentFloorMicros' | 'rentCeilingMicros' | 'label'>
}): RentModel | null {
  const { monthlySearches, niche } = args
  // No demand estimate => no rent figure. Not zero. A $0 rent is a claim that
  // the market is worthless, which is a different statement from "unknown".
  if (monthlySearches === null || monthlySearches <= 0) return null

  const raw = BigInt(monthlySearches) * niche.valuePerSearchMicros
  const clamped =
    raw < niche.rentFloorMicros
      ? niche.rentFloorMicros
      : raw > niche.rentCeilingMicros
        ? niche.rentCeilingMicros
        : raw

  const clampNote =
    clamped === raw
      ? ''
      : raw < niche.rentFloorMicros
        ? ' Clamped up to the niche floor.'
        : ' Clamped down to the niche ceiling.'

  return {
    rentMicros: clamped,
    modelled: true,
    basis: `${monthlySearches} estimated monthly searches x ${niche.label} value-per-search prior.${clampNote} Modelled, and downstream of a volume figure that is itself estimated. Excludes local income.`,
  }
}
