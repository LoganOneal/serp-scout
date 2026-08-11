import type { DomainAuthority, Niche, SerpItem } from '../../types.js'

/**
 * The three hand-built SERP archetypes from the brief. These are the acceptance
 * tests for every constant in priors.ts: the ordering between them is a hard
 * assertion, and the magnitudes are ranges.
 *
 * They are written by hand rather than generated, because their whole purpose is
 * to encode an experienced operator's read of three real pages. A generated
 * fixture would agree with whatever the model already believes.
 *
 * ================== WHERE THE MODEL DIFFERS FROM THE BRIEF ==================
 * As built, this model scores:  soft 16 (brief ~10) | mixed 32 (~33) | brutal 81 (~72)
 *
 * The ordering and all three verdict bands match exactly. The two magnitude
 * gaps are left in place deliberately rather than tuned away, because the only
 * knob that closes them makes the model worse:
 *
 * Reaching ~72 on `brutal` requires authorityWall ~0.52 for defenders holding
 * 150-420 referring main domains. That needs AUTHORITY_SATURATION_REF_DOMAINS
 * around 23,000 -- a national-scale ceiling. But a local-scale ceiling is the
 * specific reason this model reads local SERPs better than Ahrefs KD does, so
 * raising it to hit a target number would trade the model's actual advantage
 * for cosmetic agreement with an estimate. With the local ceiling kept, the
 * brutal page's slotDefence (0.81) and intentLock (0.95) alone put it in the
 * high 70s, and that is the honest reading of five exact-match operators.
 *
 * Both differences are conservative -- the model reads SERPs as slightly HARDER
 * than the brief's estimates, which costs missed opportunities rather than
 * wasted domain purchases. Treat these as the first entries in the calibration
 * log: if real outcome data says `soft`-class pages rank faster than a 16
 * implies, the constants move then, against measurements instead of estimates.
 * ===========================================================================
 */

export const KENOSHA = { name: 'Kenosha', stateCode: 'WI', population: 99_500 }

export const TREE_SERVICE: Niche = {
  slug: 'tree-service',
  label: 'Tree Service',
  keywordNoun: 'tree service',
  emdToken: 'treeservice',
  // Curated, not stemmed: an arborist site and a stump-removal site are both
  // "about" this niche, and no morphological rule gets there from "tree service".
  domainStems: ['tree', 'arborist', 'stump'],
  category: 'outdoor',
  demandPerCapitaPer1k: 4.2,
  valuePerSearchMicros: 6_000_000n,
  rentFloorMicros: 150_000_000n,
  rentCeilingMicros: 3_500_000_000n,
  active: true,
}

// --- helpers ---------------------------------------------------------------

function item(
  position: number,
  domain: string,
  url: string,
  title: string,
  opts?: { isHomepage?: boolean },
): SerpItem {
  return {
    position,
    domain,
    url,
    title,
    description: null,
    isHomepage: opts?.isHomepage ?? /^https?:\/\/[^/]+\/?$/.test(url),
    breadcrumb: null,
  }
}

/** A fully measured link profile: all three bulk endpoints answered. */
function auth(
  target: string,
  refMain: number,
  opts?: { nofollowShare?: number; spam?: number; rank?: number },
): DomainAuthority {
  const nofollowShare = opts?.nofollowShare ?? 0.2
  const referringDomains = Math.round(refMain * 1.2)
  return {
    target,
    rank: opts?.rank ?? Math.min(1000, refMain * 2),
    referringDomains,
    referringDomainsNofollow: Math.round(referringDomains * nofollowShare),
    referringMainDomains: refMain,
    spamScore: opts?.spam ?? 5,
    sources: ['ranks', 'refdomains', 'spam'],
  }
}

export interface Archetype {
  name: string
  description: string
  items: SerpItem[]
  authorities: Record<string, DomainAuthority>
  hasLocalPack: boolean
  /** The brief's expected reading. */
  expected: { difficultyAbout: number; verdict: string }
}

// ---------------------------------------------------------------------------
// A -- 8 directory slots + 2 thin locals. The market this tool exists to find.
// ---------------------------------------------------------------------------

export const ARCHETYPE_SOFT: Archetype = {
  name: 'soft',
  description: '8 directory slots + 2 thin locals',
  hasLocalPack: true,
  expected: { difficultyAbout: 10, verdict: 'likely_30d' },
  items: [
    item(1, 'yelp.com', 'https://www.yelp.com/search?find_desc=Tree+Service&find_loc=Kenosha%2C+WI', 'THE BEST 10 Tree Services in KENOSHA, WI - Updated 2026 - Yelp'),
    item(2, 'angi.com', 'https://www.angi.com/companylist/us/wi/kenosha/tree-service.htm', '10 Best Tree Services - Kenosha WI | Angi'),
    item(3, 'thumbtack.com', 'https://www.thumbtack.com/wi/kenosha/tree-removal/', 'The 10 Best Tree Removal Services in Kenosha, WI 2026'),
    item(4, 'bbb.org', 'https://www.bbb.org/us/wi/kenosha/category/tree-service', 'Tree Service in Kenosha, WI | Better Business Bureau'),
    item(5, 'yellowpages.com', 'https://www.yellowpages.com/kenosha-wi/tree-service', 'Best 30 Tree Service in Kenosha, WI with Reviews'),
    item(6, 'facebook.com', 'https://www.facebook.com/marketplace/kenosha/tree-service/', 'Tree Service in Kenosha, Wisconsin | Facebook'),
    item(7, 'homeadvisor.com', 'https://www.homeadvisor.com/c.Tree-Service.Kenosha.WI.-12053.html', 'Best 15 Tree Services in Kenosha, WI | HomeAdvisor'),
    item(8, 'expertise.com', 'https://www.expertise.com/wi/kenosha/tree-services', 'Best 12 Tree Services in Kenosha, WI'),
    // Two thin local operators, neither built for this query.
    item(9, 'bobsyardcare.com', 'https://bobsyardcare.com/', "Bob's Yard Care - Lawn & Property Maintenance"),
    item(10, 'kenoshalawnandsnow.com', 'https://kenoshalawnandsnow.com/', 'Kenosha Lawn & Snow LLC'),
  ],
  authorities: {
    'bobsyardcare.com': auth('bobsyardcare.com', 3, { nofollowShare: 0.5, spam: 12 }),
    'kenoshalawnandsnow.com': auth('kenoshalawnandsnow.com', 7, { nofollowShare: 0.45, spam: 9 }),
  },
}

// ---------------------------------------------------------------------------
// B -- mixed: 2 committed operators sitting below directories.
// ---------------------------------------------------------------------------

export const ARCHETYPE_MIXED: Archetype = {
  name: 'mixed',
  description: '2 committed operators + directories',
  hasLocalPack: true,
  expected: { difficultyAbout: 33, verdict: 'likely_6m' },
  items: [
    item(1, 'yelp.com', 'https://www.yelp.com/search?find_desc=Tree+Service&find_loc=Kenosha%2C+WI', 'THE BEST 10 Tree Services in KENOSHA, WI - Yelp'),
    item(2, 'angi.com', 'https://www.angi.com/companylist/us/wi/kenosha/tree-service.htm', 'Top 10 Tree Services in Kenosha, WI | Angi'),
    item(3, 'kenoshatreeservice.com', 'https://kenoshatreeservice.com/', 'Kenosha Tree Service | Tree Removal & Trimming'),
    item(4, 'thumbtack.com', 'https://www.thumbtack.com/wi/kenosha/tree-removal/', 'The 10 Best Tree Removal Services in Kenosha, WI'),
    item(5, 'bobstreeremoval.com', 'https://bobstreeremoval.com/', "Bob's Tree Removal - Serving Southeast Wisconsin"),
    item(6, 'bbb.org', 'https://www.bbb.org/us/wi/kenosha/category/tree-service', 'Tree Service in Kenosha, WI | BBB'),
    item(7, 'facebook.com', 'https://www.facebook.com/KenoshaTreeGuys/', 'Kenosha Tree Guys | Facebook'),
    item(8, 'kenoshalandscaping.com', 'https://kenoshalandscaping.com/services/tree-trimming/', 'Tree Trimming Services | Kenosha Landscaping'),
    item(9, 'yellowpages.com', 'https://www.yellowpages.com/kenosha-wi/tree-service', 'Best 30 Tree Service in Kenosha, WI'),
    item(10, 'homeadvisor.com', 'https://www.homeadvisor.com/c.Tree-Service.Kenosha.WI.-12053.html', 'Best 15 Tree Services in Kenosha, WI'),
  ],
  authorities: {
    'kenoshatreeservice.com': auth('kenoshatreeservice.com', 90, { nofollowShare: 0.27, spam: 8 }),
    'bobstreeremoval.com': auth('bobstreeremoval.com', 25, { nofollowShare: 0.4, spam: 12 }),
    'kenoshalandscaping.com': auth('kenoshalandscaping.com', 12, { nofollowShare: 0.5, spam: 15 }),
  },
}

// ---------------------------------------------------------------------------
// C -- 5 exact-match operators holding the top 5, 150-420 refdomains.
// ---------------------------------------------------------------------------

export const ARCHETYPE_BRUTAL: Archetype = {
  name: 'brutal',
  description: '5 exact-match operators, 150-420 refdomains',
  hasLocalPack: true,
  expected: { difficultyAbout: 72, verdict: 'not_winnable' },
  items: [
    item(1, 'kenoshatreeservice.com', 'https://kenoshatreeservice.com/', 'Kenosha Tree Service | #1 Tree Removal in Kenosha WI'),
    item(2, 'kenoshatreecare.com', 'https://kenoshatreecare.com/', 'Kenosha Tree Care | Certified Arborists'),
    item(3, 'treeservicekenosha.com', 'https://treeservicekenosha.com/', 'Tree Service Kenosha WI | Free Estimates'),
    item(4, 'kenoshaarborists.com', 'https://kenoshaarborists.com/', 'Kenosha Arborists | ISA Certified Tree Experts'),
    item(5, 'kenoshastumpremoval.com', 'https://kenoshastumpremoval.com/', 'Kenosha Stump Removal & Grinding'),
    item(6, 'yelp.com', 'https://www.yelp.com/search?find_desc=Tree+Service&find_loc=Kenosha%2C+WI', 'THE BEST 10 Tree Services in KENOSHA, WI - Yelp'),
    item(7, 'angi.com', 'https://www.angi.com/companylist/us/wi/kenosha/tree-service.htm', 'Top 10 Tree Services in Kenosha, WI | Angi'),
    item(8, 'bbb.org', 'https://www.bbb.org/us/wi/kenosha/category/tree-service', 'Tree Service in Kenosha, WI | BBB'),
    item(9, 'yellowpages.com', 'https://www.yellowpages.com/kenosha-wi/tree-service', 'Best 30 Tree Service in Kenosha, WI'),
    item(10, 'facebook.com', 'https://www.facebook.com/KenoshaTreeService/', 'Kenosha Tree Service | Facebook'),
  ],
  authorities: {
    'kenoshatreeservice.com': auth('kenoshatreeservice.com', 420, { nofollowShare: 0.2, spam: 4 }),
    'kenoshatreecare.com': auth('kenoshatreecare.com', 310, { nofollowShare: 0.2, spam: 5 }),
    'treeservicekenosha.com': auth('treeservicekenosha.com', 250, { nofollowShare: 0.2, spam: 5 }),
    'kenoshaarborists.com': auth('kenoshaarborists.com', 180, { nofollowShare: 0.2, spam: 6 }),
    'kenoshastumpremoval.com': auth('kenoshastumpremoval.com', 150, { nofollowShare: 0.2, spam: 5 }),
  },
}

export const ALL_ARCHETYPES = [ARCHETYPE_SOFT, ARCHETYPE_MIXED, ARCHETYPE_BRUTAL] as const
