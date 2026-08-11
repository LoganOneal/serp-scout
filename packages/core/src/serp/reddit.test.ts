import { describe, expect, it } from 'vitest'
import {
  findCommentOrdinal,
  looksBlocked,
  oldRedditThreadUrl,
  parseRedditPermalink,
  probeCommentability,
} from './reddit.js'

/**
 * The assertion that matters most in this file is negative: a block page, a markup change,
 * or a truncated tree must produce `unknown`, never `absent`. `absent` is what fires a
 * "your comment was deleted" alert, and firing that because Reddit rate-limited us is the
 * worst outcome this feature can produce.
 */

/** Minimal old.reddit-shaped markup: ordered top-level comments. */
function thread(ids: string[], opts: { truncated?: boolean } = {}): string {
  const nodes = ids
    .map(
      (id) =>
        `<div class="thing comment" data-type="comment" data-fullname="t1_${id}">
           <div class="md"><p>comment ${id}</p></div>
         </div>`,
    )
    .join('\n')
  const more = opts.truncated
    ? '<div class="morecomments"><a href="#">load more comments (42 replies)</a></div>'
    : ''
  return `<!doctype html><html><body><div class="commentarea">${nodes}${more}</div></body></html>`
}

describe('parseRedditPermalink', () => {
  it('parses the shapes people actually paste', () => {
    const cases = [
      'https://www.reddit.com/r/HVAC/comments/1e8w3qh/best_ac_in_tucson/lebg7yz/',
      'https://old.reddit.com/r/HVAC/comments/1e8w3qh/best_ac_in_tucson/lebg7yz/?context=3',
      'reddit.com/r/HVAC/comments/1e8w3qh/_/lebg7yz',
      'https://www.reddit.com/comments/1e8w3qh/best_ac_in_tucson/lebg7yz',
    ]
    for (const url of cases) {
      const p = parseRedditPermalink(url)
      expect(p, url).not.toBeNull()
      expect(p!.postId).toBe('1e8w3qh')
      expect(p!.commentId).toBe('lebg7yz')
    }
  })

  it('reads the subreddit when present', () => {
    expect(parseRedditPermalink('https://reddit.com/r/HVAC/comments/1e8w3qh/t/lebg7yz')!.subreddit).toBe(
      'HVAC',
    )
  })

  it('returns commentId null for a link to the post itself', () => {
    const p = parseRedditPermalink('https://www.reddit.com/r/HVAC/comments/1e8w3qh/best_ac/')
    expect(p!.postId).toBe('1e8w3qh')
    expect(p!.commentId).toBeNull()
  })

  it('refuses a share link rather than guessing', () => {
    // /s/ links are opaque redirects carrying no ids. Resolving one needs a network fetch,
    // so it is rejected here with the caller free to say "paste the full permalink".
    expect(parseRedditPermalink('https://www.reddit.com/r/HVAC/s/AbCdEfGh')).toBeNull()
  })

  it('rejects non-Reddit and malformed input without throwing', () => {
    for (const bad of [
      '',
      '   ',
      'not a url',
      'https://example.com/r/HVAC/comments/1e8w3qh/t/lebg7yz',
      'https://www.reddit.com/r/HVAC/',
      'https://www.reddit.com/comments/',
    ]) {
      expect(parseRedditPermalink(bad), bad).toBeNull()
    }
  })
})

describe('oldRedditThreadUrl', () => {
  it('targets old.reddit, which server-renders the comment tree', () => {
    const u = oldRedditThreadUrl('1e8w3qh')
    expect(u).toContain('old.reddit.com/comments/1e8w3qh')
    expect(u).toContain('sort=confidence')
  })
})

describe('findCommentOrdinal', () => {
  it('finds a 1-based ordinal among top-level comments', () => {
    const html = thread(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(findCommentOrdinal(html, 'ccc')).toEqual({ status: 'found', rank: 3, total: 4 })
    expect(findCommentOrdinal(html, 'aaa')).toEqual({ status: 'found', rank: 1, total: 4 })
  })

  it('accepts a t1_-prefixed id and is case-insensitive', () => {
    const html = thread(['aaa', 'bbb'])
    expect(findCommentOrdinal(html, 't1_BBB')).toMatchObject({ status: 'found', rank: 2 })
  })

  it('reports absent ONLY when the tree is complete', () => {
    const html = thread(['aaa', 'bbb'])
    expect(findCommentOrdinal(html, 'zzz')).toEqual({ status: 'absent', total: 2 })
  })

  it('reports UNKNOWN, not absent, when the tree is truncated', () => {
    // The comment may simply be behind "load more comments". Calling this absent would
    // tell the operator their comment was deleted.
    const html = thread(['aaa', 'bbb'], { truncated: true })
    const r = findCommentOrdinal(html, 'zzz')
    expect(r.status).toBe('unknown')
    if (r.status === 'unknown') expect(r.reason).toContain('inconclusive')
  })

  it('still finds a present comment in a truncated tree', () => {
    const html = thread(['aaa', 'bbb'], { truncated: true })
    expect(findCommentOrdinal(html, 'bbb')).toMatchObject({ status: 'found', rank: 2 })
  })

  it('reports UNKNOWN for a block page, never absent', () => {
    // THE most important case. This is the real 403 body Reddit served during planning.
    const blocked =
      '<!doctype html><html><body><h1>Whoa there, pardner!</h1>' +
      '<p>Your request has been blocked due to a network security policy.</p></body></html>'
    const r = findCommentOrdinal(blocked, 'aaa')
    expect(r.status).toBe('unknown')
    if (r.status === 'unknown') expect(r.reason).toContain('block')
    expect(looksBlocked(blocked)).toBe(true)
  })

  it('reports UNKNOWN when the markup has no comment nodes at all', () => {
    // A layout change must degrade, not conclude. "No comments found" and "your comment is
    // gone" are different facts.
    const r = findCommentOrdinal('<html><body><div id="app"></div></body></html>', 'aaa')
    expect(r.status).toBe('unknown')
    if (r.status === 'unknown') expect(r.reason).toContain('layout')
  })

  it('reports UNKNOWN for an empty body', () => {
    expect(findCommentOrdinal('', 'aaa').status).toBe('unknown')
    expect(findCommentOrdinal('   ', 'aaa').status).toBe('unknown')
  })

  it('tolerates the attribute order being swapped', () => {
    // Reddit could emit data-fullname before data-type; that must not read as "no comments".
    const html =
      '<div class="commentarea">' +
      '<div data-fullname="t1_aaa" data-type="comment"></div>' +
      '<div data-fullname="t1_bbb" data-type="comment"></div>' +
      '</div>'
    expect(findCommentOrdinal(html, 'bbb')).toMatchObject({ status: 'found', rank: 2 })
  })

  it('counts each comment once even if its id appears twice in the markup', () => {
    // old.reddit repeats ids in permalink hrefs and edit forms; double-counting would
    // inflate `total` and shift every ordinal.
    const html =
      '<div class="commentarea">' +
      '<div class="thing" data-type="comment" data-fullname="t1_aaa"><a href="/comments/x/_/aaa"></a></div>' +
      '<div class="thing" data-type="comment" data-fullname="t1_bbb"></div>' +
      '<div class="thing" data-type="comment" data-fullname="t1_aaa"></div>' +
      '</div>'
    expect(findCommentOrdinal(html, 'bbb')).toEqual({ status: 'found', rank: 2, total: 2 })
  })
})

describe('probeCommentability', () => {
  const openThread = `
    <div id="siteTable">
      <div class="thing link" data-type="link" data-author="someuser" data-fullname="t3_1abc">
        <a href="/r/HVAC/comments/1abc/title/">title</a>
      </div>
    </div>
    <div class="commentarea"></div>
  `

  it('returns open for a normal thread', () => {
    expect(probeCommentability(openThread)).toEqual({ status: 'open' })
  })

  it('returns unknown on empty or block pages — never closed', () => {
    expect(probeCommentability('').status).toBe('unknown')
    expect(probeCommentability('Whoa there! network security blocked').status).toBe('unknown')
    expect(probeCommentability('<html><body>random</body></html>').status).toBe('unknown')
  })

  it('detects archived threads', () => {
    const html = openThread.replace(
      'data-type="link"',
      'data-type="link" data-archived="true" class="archived"',
    )
    const r = probeCommentability(
      html + '<div>This thread is archived. You won\'t be able to vote or comment.</div>',
    )
    expect(r.status).toBe('closed')
    if (r.status === 'closed') expect(r.reasons).toContain('archived')
  })

  it('detects locked threads', () => {
    const r = probeCommentability(
      openThread + '<div class="locked-banner">This thread is locked</div>',
    )
    expect(r.status).toBe('closed')
    if (r.status === 'closed') expect(r.reasons).toContain('locked')
  })

  it('detects deleted OP on the link thing only', () => {
    const html = openThread.replace('data-author="someuser"', 'data-author="[deleted]"')
    const r = probeCommentability(html)
    expect(r.status).toBe('closed')
    if (r.status === 'closed') expect(r.reasons).toContain('op_deleted')
  })
})
