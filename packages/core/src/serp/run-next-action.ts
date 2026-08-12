/**
 * The one thing to do next with a run, derived from its state.
 *
 * ==================== A STATUS IS NOT AN INSTRUCTION ====================
 * A run card said `done · 438 of 438 · 0 failed` and stopped there. Every
 * word is true and none of it tells you whether to open the grid, widen the
 * selection, or start over -- so the answer was reconstructed from the job
 * counts every time, and the two states that actually need a human ("every
 * job failed" and "finished but nothing to act on") read identically to the
 * one that does not.
 *
 * The states differ in what they ask of you, which is the whole point:
 *
 *   wait  nothing to do -- the worker is mid-flight and the page self-updates
 *   act   there is something to read or shortlist
 *   stop  it will not finish on its own; a decision is required
 *
 * `stop` is deliberately narrow. A run that failed a third of its jobs is
 * still worth opening -- the results that landed are real -- so that is `act`
 * with a caveat, not `stop`. Only a run with nothing usable earns a stop.
 * =======================================================================
 */

export type NextActionTone = 'wait' | 'act' | 'stop'

/**
 * What the button should do, named by intent rather than by href.
 *
 * The URL for a run lives in the routing layer and has already moved once
 * (`/research/runs` → `/scout/runs`); baking it in here would mean a rename
 * silently pointing every card at a 404.
 */
export type NextActionCta = 'open-results' | 'delete-and-retry' | 'new-sweep' | null

export interface RunNextAction {
  tone: NextActionTone
  /** Imperative, six words or fewer -- it sits on the card as the heading. */
  headline: string
  /** Why, and what happens if you do nothing. */
  detail: string
  cta: NextActionCta
}

export interface RunStateInput {
  status: string
  jobCount: number
  jobsDone: number
  jobsFailed: number
  jobsSkipped?: number | null
  /** Reddit threads found across the run. */
  hitCount: number
  error?: string | null
}

const IN_FLIGHT = new Set(['pending', 'claimed', 'running'])

/** True while the worker still owes this run work. */
export function isRunInFlight(status: string): boolean {
  return IN_FLIGHT.has(status)
}

export function runNextAction(run: RunStateInput): RunNextAction {
  const skipped = run.jobsSkipped ?? 0
  const finished = run.jobsDone + run.jobsFailed + skipped
  const remaining = Math.max(0, run.jobCount - finished)

  if (run.status === 'pending') {
    return {
      tone: 'wait',
      headline: 'Waiting for a worker',
      detail:
        `${run.jobCount} SERP job${run.jobCount === 1 ? '' : 's'} are queued and nothing has claimed them yet. ` +
        'Locally that means `pnpm worker`; in production cron drains them about once a minute.',
      cta: null,
    }
  }

  if (run.status === 'claimed') {
    return {
      tone: 'wait',
      headline: 'Starting',
      detail: 'A worker has claimed the run and is about to buy the first SERPs.',
      cta: null,
    }
  }

  if (run.status === 'running') {
    return {
      tone: 'wait',
      headline: 'Collecting SERPs',
      detail:
        `${remaining} of ${run.jobCount} left. This page updates itself — results appear in the grid as each one lands.`,
      cta: remaining < run.jobCount ? 'open-results' : null,
    }
  }

  /**
   * Queued SERPs are bought and paid for at DataForSEO but not yet fetched
   * back. Nothing is running, so the card would otherwise look idle while the
   * money is already spent -- the state that once let runs be marked done
   * before their results were collected.
   */
  if (run.status === 'awaiting') {
    return {
      tone: 'wait',
      headline: 'Results are waiting at the provider',
      detail:
        'Queued SERPs are bought and ready; the collector fetches them on the next drain. They are already paid for, so let it finish rather than re-running.',
      cta: null,
    }
  }

  /**
   * Stopped early on purpose -- the budget cap fired, or someone cancelled.
   *
   * These are the states most easily mistaken for failures, and they are the
   * opposite: everything bought before the stop is measured and stored. Run
   * #43 hit its cap with 3,852 SERPs and 3,000 Reddit threads on disk and
   * showed "this run is in a state the UI does not have advice for yet".
   */
  if (run.status === 'budget_exceeded' || run.status === 'cancelled') {
    const stoppedBy = run.status === 'cancelled' ? 'Cancelled' : 'Stopped at the budget cap'
    if (run.jobsDone === 0) {
      return {
        tone: 'stop',
        headline: run.status === 'cancelled' ? 'Cancelled before any results' : 'Stopped before any results',
        detail: `${stoppedBy} with nothing measured. Nothing was kept — start again, ${
          run.status === 'cancelled' ? 'or leave it running this time.' : 'with a higher cap or a smaller selection.'
        }`,
        cta: 'delete-and-retry',
      }
    }
    return {
      tone: 'act',
      headline: `${stoppedBy} — partial results`,
      detail:
        `${run.jobsDone} of ${run.jobCount} SERPs were bought before it stopped. ` +
        'Everything measured up to that point is real and worth reading; the rest of the selection was never queried. ' +
        'To finish it, sweep the missing pairs as a new run.',
      cta: 'open-results',
    }
  }

  if (run.status === 'failed') {
    return {
      tone: 'stop',
      headline: 'Run failed — nothing measured',
      detail:
        (run.error ? `${run.error} ` : '') +
        'No results were stored. Fix the cause, then delete this run and sweep the same selection again.',
      cta: 'delete-and-retry',
    }
  }

  if (run.status === 'done') {
    if (run.jobsDone === 0) {
      return {
        tone: 'stop',
        headline: 'Every job failed',
        detail:
          `All ${run.jobCount} SERP job${run.jobCount === 1 ? '' : 's'} errored, so the grid is empty. ` +
          'Usually a provider or credential problem rather than a bad selection — check the error, then delete and re-run.',
        cta: 'delete-and-retry',
      }
    }

    if (run.hitCount === 0) {
      return {
        tone: 'act',
        headline: 'Finished — no Reddit threads',
        detail:
          `${run.jobsDone} SERPs measured and not one had a Reddit thread on page 1. ` +
          'That rules out the comment play here, not the market — open the grid for build and domain signals, or sweep wider keywords.',
        cta: 'open-results',
      }
    }

    if (run.jobsFailed > 0) {
      return {
        tone: 'act',
        headline: 'Finished with gaps — review results',
        detail:
          `${run.jobsDone} of ${run.jobCount} SERPs landed and ${run.jobsFailed} failed. ` +
          `What is in the grid is real; ${run.jobsFailed} keyword/market pair${run.jobsFailed === 1 ? ' is' : 's are'} simply missing from it.`,
        cta: 'open-results',
      }
    }

    return {
      tone: 'act',
      headline: 'Ready — shortlist the winners',
      detail:
        `${run.hitCount} Reddit thread${run.hitCount === 1 ? '' : 's'} across ${run.jobsDone} SERPs. ` +
        'Open the grid, sort by signal, and pick the rows worth acting on.',
      cta: 'open-results',
    }
  }

  return {
    tone: 'wait',
    headline: `Status: ${run.status}`,
    detail: 'This run is in a state the UI does not have advice for yet.',
    cta: null,
  }
}
