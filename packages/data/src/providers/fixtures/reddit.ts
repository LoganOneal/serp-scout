import { Rng } from './prng.js'

/**
 * A deterministic `old.reddit.com` thread, for developing the comment-ordinal parser with
 * no network and no Reddit access.
 *
 * ==================== WHY THIS FIXTURE HAS TO BE UNKIND ====================
 * Reddit 403s server IPs and DataForSEO's ability to fetch it is UNVERIFIED (their API
 * IP-whitelists, and this machine is not whitelisted). So the offline path is, for now, the
 * only path that runs — which makes it dangerous to be generous.
 *
 * A fixture that always returns a clean, complete thread containing our comment would make
 * the parser look correct and hide every case that matters. So the seed decides between four
 * shapes, three of which must produce `commentPresent: null`:
 *
 *   complete   — full tree, our comment present            -> found
 *   truncated  — "load more comments" present              -> UNKNOWN, never absent
 *   blocked    — the real 403 challenge page               -> UNKNOWN
 *   removed    — complete tree, our comment genuinely gone -> absent (the only false)
 * ========================================================================
 */

export type RedditFixtureShape = 'complete' | 'truncated' | 'blocked' | 'removed'

const SHAPES: readonly RedditFixtureShape[] = ['complete', 'truncated', 'blocked', 'removed']

/** The comment id the 'complete' and 'truncated' shapes plant, so tests can assert on it. */
export const FIXTURE_COMMENT_ID = 'lebg7yz'

/**
 * The real block page Reddit served, reduced to its recognisable text.
 *
 * Kept verbatim-ish rather than invented: `looksBlocked` matches on these phrases, and a
 * paraphrase would let the detector pass against words Reddit does not actually send.
 */
export const REDDIT_BLOCK_PAGE =
  '<!doctype html><html><head><title>Blocked</title></head><body>' +
  '<h1>Whoa there, pardner!</h1>' +
  '<p>Your request has been blocked due to a network security policy.</p>' +
  '</body></html>'

export function fixtureRedditThread(url: string, forced?: RedditFixtureShape): string {
  const rng = new Rng(`reddit:${url}`)
  const shape = forced ?? rng.pick(SHAPES)

  if (shape === 'blocked') return REDDIT_BLOCK_PAGE

  // A plausible spread of ids, with ours planted mid-list when it is present at all.
  const others = Array.from({ length: rng.int(4, 9) }, (_, i) => `c${rng.int(100000, 999999)}${i}`)
  const ids = shape === 'removed' ? others : [...others.slice(0, 2), FIXTURE_COMMENT_ID, ...others.slice(2)]

  const nodes = ids
    .map(
      (id) => `
      <div class="thing id-t1_${id} comment" data-type="comment" data-fullname="t1_${id}">
        <p class="tagline"><a class="author">u/someone</a><span class="score">${rng.int(1, 400)} points</span></p>
        <div class="md"><p>Comment body ${id}.</p></div>
      </div>`,
    )
    .join('\n')

  const more =
    shape === 'truncated'
      ? '<div class="thing morechildren"><a href="#" onclick="return morechildren()">load more comments (37 replies)</a></div>'
      : ''

  return `<!doctype html><html><body>
    <div id="siteTable"><div class="thing link"><a class="title">Best HVAC company in Tucson?</a></div></div>
    <div class="commentarea">${nodes}${more}</div>
  </body></html>`
}
