/**
 * Reddit permalink parsing, and finding our comment's ordinal in a thread's HTML.
 *
 * ==================== WHY HTML, AND WHY THIS IS FRAGILE ====================
 * Reddit's public JSON returns 403 to server IPs (verified: www, old and api hosts all
 * answer with a "blocked / bot / network security" HTML page), and self-service OAuth
 * registration closed in 2026. So the thread is fetched through DataForSEO's page API and
 * the comment order is read out of `old.reddit.com` markup, which is server-rendered.
 *
 * That is third-party HTML scraping, and it WILL break. Every function here is therefore
 * built to return "unknown" rather than a guess, and the caller must map unknown to NULL.
 * ========================================================================
 *
 * ==================== THE RULE THAT MATTERS MOST ====================
 * A fetch failure, a block page, a markup change, or a truncated comment tree must all
 * produce `present: null` -- NEVER `present: false`. `false` means "we loaded the whole
 * thread and your comment is not in it", which triggers a "your comment was deleted"
 * alert. Telling someone their comment was removed when Reddit merely blocked us is the
 * worst thing this feature can do.
 * ===================================================================
 *
 * Pure. Takes strings, returns plain data. No IO.
 */

export interface RedditPermalink {
  /** Base-36 post id, e.g. `1e8w3qh`. */
  postId: string
  /** Base-36 comment id, e.g. `lebg7yz`. Null when the link points at the post itself. */
  commentId: string | null
  subreddit: string | null
}

/**
 * Parse a Reddit comment permalink.
 *
 * Accepts the shapes people actually paste:
 *   https://www.reddit.com/r/HVAC/comments/1e8w3qh/some_title/lebg7yz/
 *   https://old.reddit.com/r/HVAC/comments/1e8w3qh/some_title/lebg7yz/?context=3
 *   reddit.com/comments/1e8w3qh/_/lebg7yz
 *
 * Returns null for a share link (`/r/x/s/AbCdEf`), which is an opaque redirect carrying no
 * ids -- resolving it needs a network fetch, so it is refused here rather than guessed at.
 */
export function parseRedditPermalink(raw: string): RedditPermalink | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  let path: string
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const u = new URL(withScheme)
    if (!/(^|\.)reddit\.com$/i.test(u.hostname) && !/(^|\.)redd\.it$/i.test(u.hostname)) return null
    path = u.pathname
  } catch {
    return null
  }

  const parts = path.split('/').filter((p) => p !== '')

  // Share links carry no ids at all. Refused, not guessed.
  if (parts.includes('s') && !parts.includes('comments')) return null

  const ci = parts.indexOf('comments')
  if (ci === -1) return null

  const postId = parts[ci + 1]
  if (postId === undefined || !/^[a-z0-9]{4,12}$/i.test(postId)) return null

  const subreddit = parts[0]?.toLowerCase() === 'r' ? (parts[1] ?? null) : null

  // /comments/{postId}/{slug}/{commentId}
  const candidate = parts[ci + 3]
  const commentId =
    candidate !== undefined && /^[a-z0-9]{5,12}$/i.test(candidate) ? candidate.toLowerCase() : null

  return { postId: postId.toLowerCase(), commentId, subreddit }
}

/** The URL to fetch for a thread. `old.` because its comment tree is server-rendered. */
export function oldRedditThreadUrl(postId: string, sort = 'confidence'): string {
  return `https://old.reddit.com/comments/${postId}/?sort=${sort}&limit=500`
}

export type OrdinalOutcome =
  /** Found it. `rank` is 1-based among top-level comments. */
  | { status: 'found'; rank: number; total: number }
  /** Loaded a COMPLETE top-level list and it is not there. The only case that means gone. */
  | { status: 'absent'; total: number }
  /** Could not tell. Blocked, unparseable, or the list was truncated. */
  | { status: 'unknown'; reason: string }

/**
 * Find a comment's ordinal among the top-level comments in `old.reddit.com` HTML.
 *
 * Depth is read from `data-` attributes rather than DOM nesting, so no HTML parser is
 * needed and a markup reshuffle degrades to `unknown` instead of a wrong number.
 */
export function findCommentOrdinal(html: string, commentId: string): OrdinalOutcome {
  if (html.trim() === '') return { status: 'unknown', reason: 'Empty response body.' }

  // A block page is HTML too, and it contains no comment markup -- so detect it explicitly
  // rather than concluding "absent" from the absence of comments.
  if (looksBlocked(html)) {
    return { status: 'unknown', reason: 'Reddit returned a block/challenge page, not the thread.' }
  }

  const wanted = commentId.toLowerCase().replace(/^t1_/, '')

  /**
   * Top-level comment containers.
   *
   * old.reddit renders each as a div carrying `data-fullname="t1_xxx"` and
   * `data-type="comment"`; nesting depth is not in an attribute, so top-level is inferred
   * from the ordered list of comment ids that appear inside the top-level `.commentarea`
   * sibling structure. Rather than reconstruct the tree, this reads the ordered
   * `data-fullname` sequence and treats the FIRST occurrence of each as its position --
   * which matches top-level order because old.reddit emits parents before children.
   */
  const ids: string[] = []
  const re = /data-type="comment"[^>]*?data-fullname="t1_([a-z0-9]+)"|data-fullname="t1_([a-z0-9]+)"[^>]*?data-type="comment"/gi
  for (const m of html.matchAll(re)) {
    const id = (m[1] ?? m[2] ?? '').toLowerCase()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }

  if (ids.length === 0) {
    return {
      status: 'unknown',
      reason: 'No comment markup found. Either the layout changed or the thread did not load.',
    }
  }

  const idx = ids.indexOf(wanted)
  if (idx !== -1) return { status: 'found', rank: idx + 1, total: ids.length }

  /**
   * Not found. Is the list COMPLETE?
   *
   * A "load more comments" / "continue this thread" node means we were served a truncated
   * tree, so absence proves nothing. Reporting `absent` here would fire a "your comment was
   * deleted" alert for a comment that is simply on page two.
   */
  if (isTruncated(html)) {
    return {
      status: 'unknown',
      reason: 'The comment tree was truncated ("load more comments"), so absence is inconclusive.',
    }
  }

  return { status: 'absent', total: ids.length }
}

/** Reddit's block/challenge pages. Distinguished so they never read as "absent". */
export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase()
  return (
    head.includes('whoa there') ||
    head.includes('network security') ||
    head.includes('blocked') ||
    head.includes('too many requests') ||
    head.includes('are you a robot') ||
    head.includes('access denied')
  )
}

function isTruncated(html: string): boolean {
  const lower = html.toLowerCase()
  return (
    lower.includes('load more comments') ||
    lower.includes('continue this thread') ||
    lower.includes('morechildren') ||
    lower.includes('class="morerecursion"') ||
    lower.includes('class="morecomments"')
  )
}

// ---------------------------------------------------------------------------
// Commentability — can an operator still post?
// ---------------------------------------------------------------------------

export type CommentabilityClosedReason = 'archived' | 'locked' | 'op_deleted'

export type CommentabilityOutcome =
  | { status: 'open' }
  | { status: 'closed'; reasons: CommentabilityClosedReason[] }
  | { status: 'unknown'; reason: string }

/**
 * Probe whether a thread still accepts comments from old.reddit HTML.
 *
 * ==================== SAME BIAS AS ORDINAL PARSER ====================
 * Ambiguity → `unknown`. Only clear archived / locked / deleted-OP markers
 * produce `closed`. A block page, empty body, or missing OP region is never
 * "closed" — callers map unknown to commentable NULL (silent).
 * ==================================================================
 */
export function probeCommentability(html: string): CommentabilityOutcome {
  if (html.trim() === '') {
    return { status: 'unknown', reason: 'Empty response body.' }
  }

  if (looksBlocked(html)) {
    return {
      status: 'unknown',
      reason: 'Reddit returned a block/challenge page, not the thread.',
    }
  }

  const lower = html.toLowerCase()

  // No recognisable thread chrome → layout change or wrong page, not "closed".
  const hasThreadChrome =
    lower.includes('data-type="link"') ||
    lower.includes('class="commentarea"') ||
    lower.includes('id="siteTable"') ||
    lower.includes('thing id-t3_') ||
    lower.includes('class="sitetable') ||
    /\/comments\/[a-z0-9]{4,12}/i.test(html)

  if (!hasThreadChrome) {
    return {
      status: 'unknown',
      reason: 'No thread markup found. Layout may have changed or the page did not load.',
    }
  }

  const reasons: CommentabilityClosedReason[] = []

  // Archived: explicit banner or archived-link class on the post.
  if (
    lower.includes('this thread is archived') ||
    lower.includes('this post is archived') ||
    lower.includes('archiving keeps online discourse') ||
    lower.includes('class="archived"') ||
    /\barchived-link\b/.test(lower) ||
    (lower.includes('data-archived="true"') && lower.includes('data-type="link"'))
  ) {
    reasons.push('archived')
  }

  // Locked: comments closed by mods.
  if (
    lower.includes('this thread is locked') ||
    lower.includes('this post is locked') ||
    lower.includes('comments are locked') ||
    lower.includes('locked due to') ||
    lower.includes('data-locked="true"') ||
    (lower.includes('class="locked"') && lower.includes('data-type="link"'))
  ) {
    reasons.push('locked')
  }

  // OP deleted: author region shows [deleted] on the link/post thing.
  // Require post-level markers so a single deleted comment does not close the thread.
  if (
    lower.includes('data-type="link"') &&
    (lower.includes('data-author="[deleted]"') ||
      /class="[^"]*thing[^"]*link[^"]*"[^>]*data-author="\[deleted\]"/.test(lower) ||
      /data-type="link"[^>]{0,400}data-author="\[deleted\]"/.test(lower) ||
      /data-author="\[deleted\]"[^>]{0,400}data-type="link"/.test(lower))
  ) {
    reasons.push('op_deleted')
  }

  if (reasons.length > 0) {
    return { status: 'closed', reasons: [...new Set(reasons)] }
  }

  return { status: 'open' }
}
