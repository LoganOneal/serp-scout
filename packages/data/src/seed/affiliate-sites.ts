import { LOCATION_US, type KeywordSpace } from '@rnr/core'

/**
 * The two live affiliate sites, as keyword spaces.
 *
 * ==================== BOTH BASE GRIDS ARE country:US ====================
 * `hotelhottubs` keeps its canonical generated grid US-scoped because its CPC
 * and seasonality terms need a single ad market — worldwide blends hemispheres
 * and ad economies. Its Reddit research workspace supplements that grid with
 * explicit Canadian destinations measured separately at country:CA.
 *
 * `borenhealth` because shipping and regulation are national.
 *
 * Two sites agreeing is NOT evidence that agreement is automatic, which is why
 * `audienceScope` has no default and each of these states it explicitly. The
 * ==================================================================================
 */

export interface AffiliateSiteSeed {
  domain: string
  displayName: string
  keywordSpace: KeywordSpace
  platformVerticals: string[]
  /** Entity sets this space needs, seeded alongside it. */
  entitySets?: string[]
  notes: string
}

export const HOTEL_HOT_TUBS: AffiliateSiteSeed = {
  domain: 'hotelhottubs.com',
  displayName: 'Hotel Hot Tubs',
  platformVerticals: ['travel'],
  keywordSpace: {
    /**
     * The destination is a TOKEN, and its location code is never sent.
     *
     * "hotels with hot tubs in room las vegas" bought at the Las Vegas location
     * code measures Las Vegas residents — the one group not booking a Las Vegas
     * hotel. See @rnr/core serpLocationFor.
     */
    geoMode: 'in_keyword',
    audienceScope: 'country:US',
    serpLocationCode: LOCATION_US,
    dimensions: {
      // Top markets by selected_rank. The corpus already carries ~300.
      locality: { source: 'research_geos', limit: 300 },
    },
    patterns: [
      { template: 'hotels with hot tubs in room {locality}', label: 'in-room' },
      { template: '{locality} hotels with jacuzzi in room', label: 'jacuzzi-in-room' },
      { template: '{locality} jacuzzi suites', label: 'suites' },
      { template: 'romantic hotels with hot tub {locality}', label: 'romantic' },
      { template: 'hot tub suites {locality}', label: 'hot-tub-suites' },
    ],
    volumeFloor: 50,
  },
  notes:
    'Affiliate: hotel bookings. Destination is in the keyword; the base grid audience is the whole US. ' +
    'The Reddit research pipeline adds Canadian destinations with a separate CA-national scope. ' +
    'Seasonality (monthly_series) is load-bearing here — Aspen and Vegas peak six months apart.',
}

export const BOREN_HEALTH: AffiliateSiteSeed = {
  domain: 'borenhealth.com',
  displayName: 'Boren Health',
  platformVerticals: ['health_supplement'],
  entitySets: ['peptides', 'peptide-vendors'],
  keywordSpace: {
    geoMode: 'none',
    audienceScope: 'country:US',
    serpLocationCode: LOCATION_US,
    dimensions: {
      product: { source: 'entity_set', setSlug: 'peptides' },
      vendor: { source: 'entity_set', setSlug: 'peptide-vendors' },
    },
    patterns: [
      { template: '{product}', label: 'head' },
      { template: '{product} review', label: 'product-review' },
      { template: '{product} dosage', label: 'dosage' },
      { template: '{product} side effects', label: 'side-effects' },
      { template: '{product} before and after', label: 'before-after' },
      { template: 'where to buy {product}', label: 'where-to-buy' },
      { template: '{vendor} review', label: 'vendor-review' },
      { template: 'is {vendor} legit', label: 'vendor-legit' },
      { template: '{vendor} reviews reddit', label: 'vendor-reddit' },
      { template: '{vendor} coupon code', label: 'vendor-coupon' },
      /**
       * Opt-in and capped. 20 products is 190 unordered pairs; 120 would be
       * 7,140 from this one line. Volume is free so the cost is fine and the row
       * count is not.
       */
      { template: '{product} vs {product:2}', label: 'product-vs', pairwise: true },
    ],
    volumeFloor: 50,
    pairwiseCap: 300,
  },
  notes:
    'Affiliate: peptide vendor reviews. YMYL — Google evaluates dosage and side-effect queries ' +
    'harshly, and scoreDifficulty does not model that. A low difficulty on "{product} side effects" ' +
    'is not the invitation it looks like.',
}

export const AFFILIATE_SITE_SEEDS: AffiliateSiteSeed[] = [HOTEL_HOT_TUBS, BOREN_HEALTH]

/**
 * Starter entity sets.
 *
 * ==================== THESE ARE A STARTING POINT, NOT A CORPUS ====================
 * Hand-written lists have been wrong in this repo before — `probe-wayback-directory`
 * reported fifteen "business websites" that were all adtech. The intended path is
 * to INDUCE the real list from what already ranks (Search Console, then the
 * competitor gap) and extend these sets from measured data.
 *
 * Aliases matter more than the labels: without them the "what do we already rank
 * for" join under-reports our own coverage, and under-reported coverage reads as
 * an opportunity — so we would build a page that already exists.
 * ================================================================================
 */
export const PEPTIDE_SEED = {
  slug: 'peptides',
  kind: 'product',
  label: 'Peptides',
  notes: 'Starter list. Extend from Search Console and competitor-gap results, not from memory.',
  entities: [
    { slug: 'bpc-157', label: 'BPC-157', aliases: ['BPC 157', 'BPC157'] },
    { slug: 'tb-500', label: 'TB-500', aliases: ['TB 500', 'TB500', 'thymosin beta 4'] },
    { slug: 'ipamorelin', label: 'Ipamorelin', aliases: [] },
    { slug: 'cjc-1295', label: 'CJC-1295', aliases: ['CJC 1295', 'CJC1295'] },
    { slug: 'semaglutide', label: 'semaglutide', aliases: ['ozempic', 'wegovy'] },
    { slug: 'tirzepatide', label: 'tirzepatide', aliases: ['mounjaro', 'zepbound'] },
    { slug: 'tesamorelin', label: 'tesamorelin', aliases: [] },
    { slug: 'sermorelin', label: 'sermorelin', aliases: [] },
    { slug: 'ghk-cu', label: 'GHK-Cu', aliases: ['GHK Cu', 'copper peptide'] },
    { slug: 'melanotan-2', label: 'Melanotan II', aliases: ['Melanotan 2', 'MT-2'] },
    { slug: 'pt-141', label: 'PT-141', aliases: ['PT 141', 'bremelanotide'] },
    { slug: 'aod-9604', label: 'AOD-9604', aliases: ['AOD 9604'] },
    { slug: 'll-37', label: 'LL-37', aliases: ['LL 37'] },
    { slug: 'kpv', label: 'KPV', aliases: [] },
    { slug: 'epitalon', label: 'epitalon', aliases: ['epithalon'] },
    { slug: 'nad-plus', label: 'NAD+', aliases: ['NAD plus', 'NAD'] },
    { slug: 'mots-c', label: 'MOTS-c', aliases: ['MOTS c'] },
    { slug: 'selank', label: 'selank', aliases: [] },
    { slug: 'semax', label: 'semax', aliases: [] },
    { slug: 'hexarelin', label: 'hexarelin', aliases: [] },
  ],
}

export const PEPTIDE_VENDOR_SEED = {
  slug: 'peptide-vendors',
  kind: 'brand',
  label: 'Peptide vendors',
  notes:
    'Starter list. The real set should come from what already ranks and from the competitor gap.',
  entities: [
    { slug: 'peptide-sciences', label: 'Peptide Sciences', aliases: ['peptidesciences'] },
    { slug: 'core-peptides', label: 'Core Peptides', aliases: ['corepeptides'] },
    { slug: 'limitless-life', label: 'Limitless Life', aliases: ['limitless life nootropics'] },
    { slug: 'swiss-chems', label: 'Swiss Chems', aliases: ['swisschems'] },
    { slug: 'amino-asylum', label: 'Amino Asylum', aliases: ['aminoasylum'] },
    { slug: 'biotech-peptides', label: 'Biotech Peptides', aliases: ['biotechpeptides'] },
    { slug: 'polypeptide-labs', label: 'Polypeptide Labs', aliases: [] },
    { slug: 'sports-technology-labs', label: 'Sports Technology Labs', aliases: ['STL'] },
    { slug: 'paradigm-peptides', label: 'Paradigm Peptides', aliases: [] },
    { slug: 'peptide-pros', label: 'Peptide Pros', aliases: ['thepeptidepros'] },
  ],
}

export const ENTITY_SET_SEEDS = [PEPTIDE_SEED, PEPTIDE_VENDOR_SEED]
