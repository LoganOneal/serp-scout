import { registrableDomain, type HttpTriage } from '@rnr/core'

/**
 * Stage 3c — open the door and see whether anyone is home.
 *
 * This is the last free stage and the one that decides most rows: LIVE stops
 * here and costs nothing further, everything else advances to RDAP.
 */

export const HTTP_TIMEOUT_MS = 10_000
export const MAX_REDIRECT_HOPS = 3

/**
 * Text that means a page is inventory rather than a business.
 *
 * Matched case-insensitively against the first slice of the body. These are
 * deliberately phrases rather than single words: "domain" alone appears on
 * plenty of live hosting companies, while "this domain is for sale" does not.
 */
export const PARKING_PHRASES_FOR_AUDIT: readonly string[] = [
  // Explicit for-sale language. Deliberately long and specific -- short generic
  // phrases were the problem, not the solution.
  'this domain is for sale',
  'this domain name is for sale',
  'the domain is for sale',
  'this domain may be for sale',
  'buy this domain',
  'the domain name you are looking for',
  'this domain name is available',
  'domain name is available for purchase',
  'inquire about this domain',
  'interested in this domain',
  'contact the domain owner',
  'the owner of this domain',
  'transfer the domain to you',
  // Parking operators, by name.
  'this web page is parked',
  'this domain is parked',
  'parked free, courtesy of',
  'domain parking',
  'hugedomains.com',
  'sedoparking',
  'parkingcrew',
  'bodis.com',
  'afternic.com',
  'squadhelp.com',
  'brandbucket.com',
  // Registrar / host placeholders that no real business page carries.
  'this domain has expired',
  'domain has expired and is pending renewal',
  'this account has been suspended',
  'no website configured at this address',
  'apache2 ubuntu default page',
  'apache2 debian default page',
  'welcome to nginx',
  'future home of something quite cool',
]

/**
 * ============ PHRASES THAT WERE REMOVED, AND WHY ============
 * "under construction" flagged constellationhome.com -- a real HVAC company
 * with 5,633 characters of content -- because a contractor's site mentions
 * construction. "make an offer", "payment plan available", "lease to own",
 * "secure transaction" and "buy now for" were added to catch marketplace
 * splash pages and instead caught every home-services site that offers
 * financing. "it works!", "coming soon!", "related searches" and
 * "godaddy.com, llc" all appear in the footers and copy of ordinary sites.
 *
 * A phrase earns its place here only if a genuine business page would never
 * contain it.
 * ============================================================
 */

/**
 * Above this much visible text, a single phrase match is not enough.
 *
 * Parking pages are short. A page with thousands of words is a real site that
 * happens to contain a suspicious string somewhere in its copy.
 */
const PARKING_PHRASE_MAX_TEXT = 2_000

/**
 * Live business pages carry more than a headline. Parking pages are usually
 * under a kilobyte of visible text, so a floor here separates "a real site"
 * from "a placeholder that happens to avoid our phrase list".
 */
const MIN_LIVE_TEXT_CHARS = 600

/**
 * ============ THE TEXT FLOOR ASSUMES SERVER-RENDERED HTML ============
 * It does not hold. A React/Next/Vue site ships an empty shell and fills it in
 * the browser, and this probe does not run JavaScript -- so a real business
 * site reads as 0-200 characters and got called a parking page.
 *
 * Measured on a sample of 14 domains labelled PARKED_DEAD: 12 carried an app
 * shell. 1sthvacrepairhoustontx.com had 67 characters of text and a root div;
 * greaterhoustonhvac.com served 159KB across 36 scripts.
 *
 * A parking page does not ship a JS bundle. So when the shell is present, thin
 * text means "we cannot read this without a browser", never "nothing is here".
 * =====================================================================
 */
const APP_SHELL =
  /<div[^>]+id=["'](root|__next|app|__nuxt|svelte)["']|__NEXT_DATA__|window\.__NUXT__|data-reactroot|ng-version|<script[^>]+src=[^>]*\/(_next|static\/js|assets|bundle|chunk)|wp-content\/themes/i

/**
 * Pages that are blocking us rather than telling us the site is empty.
 *
 * chron.com -- the Houston Chronicle -- was recorded PARKED_DEAD off a thin
 * response, while answering with 8,471 characters on every later attempt. Bot
 * checks, consent walls and paywalls all serve a short page that looks exactly
 * like a placeholder, and calling those "parked" turns a newspaper into an
 * acquisition candidate.
 */
const INTERSTITIAL =
  /captcha|are you a human|checking your browser|cf-browser-verification|just a moment|access denied|enable javascript|please enable cookies|cookie consent|consent to continue|subscribe to continue|article limit|verify you are|ddos protection|attention required/i

/** Enough markup and scripting to be an application rather than a placeholder. */
function looksLikeRealSite(html: string): boolean {
  if (APP_SHELL.test(html)) return true
  const scripts = (html.match(/<script/gi) ?? []).length
  return scripts >= 8 || html.length > 60_000
}

export interface HttpTriageResult extends HttpTriage {
  finalUrl: string | null
  httpStatus: number | null
  hops: number
  /** Which parking phrase fired, so the call can be audited. */
  matchedPhrase: string | null
  visibleTextChars: number
  error: string | null
}

/** Strip markup so phrase matching and length both see what a reader sees. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchParkingPhrase(text: string): string | null {
  const lower = text.toLowerCase()
  return PARKING_PHRASES_FOR_AUDIT.find((p) => lower.includes(p)) ?? null
}

/**
 * Probe one domain over HTTP, following up to `MAX_REDIRECT_HOPS` hops by hand.
 *
 * Redirects are followed manually rather than by `redirect: 'follow'` because
 * the destination is itself the signal: a domain that lands on a different
 * registrable domain has almost certainly been bought and pointed at its
 * buyer's brand, which is ACQUIRED_301 rather than anything we can purchase.
 */
export async function httpTriage(
  domain: string,
  opts: { timeoutMs?: number; maxHops?: number } = {},
): Promise<HttpTriageResult> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS

  const base: HttpTriageResult = {
    outcome: 'unknown',
    redirectedTo: null,
    finalUrl: null,
    httpStatus: null,
    hops: 0,
    matchedPhrase: null,
    visibleTextChars: 0,
    error: null,
  }

  /**
   * ============ ONE ORIGIN IS NOT THE SITE ============
   * The probe used to try `https://<domain>/` and, on a connection failure,
   * `http://<domain>/`. Both assumptions broke on twdaz.com:
   *
   *   https://twdaz.com/       connection fails from here
   *   https://www.twdaz.com/   301 -> https://twdaz.com/
   *   http://twdaz.com/        404
   *   http://www.twdaz.com/    301 -> https://twdaz.com/
   *
   * The old chain reached the plain-HTTP apex, read its 404, and reported a
   * live business as "registered but nothing is served". Plenty of sites serve
   * only the www host, or only over HTTPS.
   * ====================================================
   */
  const origins = [
    `https://${domain}/`,
    `https://www.${domain}/`,
    `http://${domain}/`,
    `http://www.${domain}/`,
  ]
  let originIndex = 0
  let url = origins[0]!
  let hops = 0

  /**
   * A 404 or 5xx seen on ONE origin while another refused to connect proves
   * nothing about the site -- we never reached the endpoint the domain
   * actually serves. These remember the best evidence across all attempts.
   */
  let sawConnectionFailure = false
  let bestErrorStatus: number | null = null
  let lastError: string | null = null

  /**
   * Errors that mean nothing is listening. Anything else — above all a
   * timeout — means we did not get an answer, which is a different claim.
   */
  const DEAD_CAUSES = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i

  try {
    for (;;) {
      let res: Response
      // ==================== ONE TIMEOUT PER ATTEMPT ====================
      // A single controller for the whole function would abort the plain-HTTP
      // fallback the instant the HTTPS attempt timed out, so the retry never
      // really happened. Each attempt gets its own budget.
      // ================================================================
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            /**
             * A browser user-agent, because plenty of sites serve a stripped
             * page to unrecognised agents -- greaterhoustonhvac.com returned
             * 11,559 characters to Chrome and little enough to a bot string to
             * fall under the text floor. Reading what a visitor reads is the
             * only way the floor means anything.
             */
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const aborted = controller.signal.aborted
        lastError = message
        if (!aborted) sawConnectionFailure = true

        // Move to the next origin. A refused connection on one host says
        // nothing about the others.
        if (!aborted && originIndex + 1 < origins.length) {
          originIndex += 1
          url = origins[originIndex]!
          hops = 0
          continue
        }

        /**
         * A TIMEOUT IS NOT A DEAD DOMAIN.
         *
         * This mattered immediately: kohler.com — a live manufacturer with 2 A
         * records and 8 nameservers — timed out on a 10s budget and was
         * classified PARKED_DEAD, ranking second in a real run. Slow hosts and
         * bot protection both look exactly like this, so an abort yields
         * `unknown` and the row is marked as unproven rather than offered up
         * as an acquisition target.
         */
        /**
         * Only ENOTFOUND/ECONNREFUSED-class causes on EVERY origin mean the
         * domain serves nothing. A timeout, a TLS failure or bot protection
         * all reject without proving absence.
         */
        const allRefused = DEAD_CAUSES.test(message) && bestErrorStatus == null
        return {
          ...base,
          outcome: aborted || !allRefused ? 'unknown' : 'dead',
          hops,
          finalUrl: url,
          ...(bestErrorStatus === null ? {} : { httpStatus: bestErrorStatus }),
          error: aborted ? `Timed out after ${timeoutMs}ms` : (lastError ?? message),
        }
      } finally {
        clearTimeout(timer)
      }

      const status = res.status

      if (status >= 300 && status < 400) {
        const location = res.headers.get('location')
        if (!location) {
          return { ...base, outcome: 'dead', httpStatus: status, hops, finalUrl: url }
        }
        if (hops >= maxHops) {
          return { ...base, outcome: 'unknown', httpStatus: status, hops, finalUrl: url }
        }
        const next = new URL(location, url).toString()
        hops += 1

        const from = registrableDomain(domain)?.domain ?? domain
        const to = registrableDomain(next)?.domain ?? null
        if (to && to !== from) {
          return {
            ...base,
            outcome: 'redirect',
            redirectedTo: to,
            httpStatus: status,
            hops,
            finalUrl: next,
          }
        }
        url = next
        continue
      }

      /**
       * ================ A 5xx IS NOT AN ABSENT SITE ================
       * 404 means the host is up and the page is gone. 5xx means a server is
       * running, executing code, and failing -- which proves hosting is active
       * and being paid for. Treating them alike put 247manhattanplumbingnyc.com
       * (HTTP 500, expiry 748 days out, DNS pointed at live hosting) in the
       * same bucket as domains with no server at all.
       *
       * A broken WordPress install is somebody's problem, not an expired
       * domain.
       * =============================================================
       */
      /**
       * A 404 or 5xx does not end the enquiry while other origins are untried:
       * the apex often 404s on a site that serves only www.
       */
      if (status >= 500 || status === 404) {
        bestErrorStatus = status
        if (originIndex + 1 < origins.length) {
          originIndex += 1
          url = origins[originIndex]!
          hops = 0
          continue
        }
        // Every origin exhausted. If any of them refused to connect, we never
        // reached the endpoint this domain serves, so this status is not
        // evidence of absence.
        if (sawConnectionFailure) {
          return {
            ...base,
            outcome: 'unknown',
            httpStatus: status,
            hops,
            finalUrl: url,
            error: `HTTP ${status} on ${url}, but another origin refused to connect`,
          }
        }
        return {
          ...base,
          outcome: status >= 500 ? 'broken' : 'dead',
          httpStatus: status,
          hops,
          finalUrl: url,
        }
      }

      // 401/403 are ambiguous — something is running, we just cannot see it.
      if (status === 401 || status === 403) {
        return { ...base, outcome: 'unknown', httpStatus: status, hops, finalUrl: url }
      }

      const html = await res.text()
      const text = visibleText(html)
      // A phrase only decides the matter on a SHORT page; on a long one it is
      // a string inside real copy.
      const phrase = text.length <= PARKING_PHRASE_MAX_TEXT ? matchParkingPhrase(text) : null

      if (phrase) {
        return {
          ...base,
          outcome: 'parked',
          httpStatus: status,
          hops,
          finalUrl: url,
          matchedPhrase: phrase,
          visibleTextChars: text.length,
        }
      }

      /**
       * A thin page that is challenging us, or one with substantial markup
       * behind it, is unreadable rather than empty. Genuine parking pages are
       * both short AND small -- macfelderplumbing.com is 114 bytes total.
       */
      if (text.length < MIN_LIVE_TEXT_CHARS && (INTERSTITIAL.test(html) || html.length > 20_000)) {
        return {
          ...base,
          outcome: 'unknown',
          httpStatus: status,
          hops,
          finalUrl: url,
          visibleTextChars: text.length,
          error: INTERSTITIAL.test(html)
            ? 'Bot check, consent wall or paywall — the page is blocking, not empty'
            : 'Thin text behind substantial markup — needs a browser to read',
        }
      }

      if (text.length < MIN_LIVE_TEXT_CHARS && !looksLikeRealSite(html)) {
        return {
          ...base,
          outcome: 'parked',
          httpStatus: status,
          hops,
          finalUrl: url,
          matchedPhrase: null,
          visibleTextChars: text.length,
        }
      }

      return {
        ...base,
        outcome: 'live',
        httpStatus: status,
        hops,
        finalUrl: url,
        visibleTextChars: text.length,
      }
    }
  } catch (err) {
    // Reading the body can still fail after a successful response.
    return {
      ...base,
      outcome: 'unknown',
      hops,
      finalUrl: url,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
