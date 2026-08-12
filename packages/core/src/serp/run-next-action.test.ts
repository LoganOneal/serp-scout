import { describe, expect, it } from 'vitest'
import { isRunInFlight, runNextAction, type RunStateInput } from './run-next-action.js'

function run(over: Partial<RunStateInput> = {}): RunStateInput {
  return {
    status: 'done',
    jobCount: 100,
    jobsDone: 100,
    jobsFailed: 0,
    jobsSkipped: 0,
    hitCount: 12,
    error: null,
    ...over,
  }
}

describe('runNextAction', () => {
  it('tells a pending run there is nothing to do but wait', () => {
    const a = runNextAction(run({ status: 'pending', jobsDone: 0, hitCount: 0 }))
    expect(a.tone).toBe('wait')
    expect(a.cta).toBeNull()
  })

  it('counts down the jobs still owed while running', () => {
    const a = runNextAction(run({ status: 'running', jobsDone: 40, hitCount: 3 }))
    expect(a.tone).toBe('wait')
    expect(a.detail).toContain('60 of 100')
  })

  it('offers results mid-run only once some have landed', () => {
    expect(runNextAction(run({ status: 'running', jobsDone: 0, hitCount: 0 })).cta).toBeNull()
    expect(runNextAction(run({ status: 'running', jobsDone: 1, hitCount: 0 })).cta).toBe(
      'open-results',
    )
  })

  it('says paid-for queued results are still coming rather than looking idle', () => {
    const a = runNextAction(run({ status: 'awaiting', jobsDone: 0, hitCount: 0 }))
    expect(a.tone).toBe('wait')
    expect(a.detail).toMatch(/already paid for/i)
  })

  it('stops on a failed run and carries its error into the advice', () => {
    const a = runNextAction(run({ status: 'failed', jobsDone: 0, hitCount: 0, error: 'DFS 40201' }))
    expect(a.tone).toBe('stop')
    expect(a.detail).toContain('DFS 40201')
    expect(a.cta).toBe('delete-and-retry')
  })

  it('stops when every job failed, even though the run says done', () => {
    const a = runNextAction(run({ jobsDone: 0, jobsFailed: 100, hitCount: 0 }))
    expect(a.tone).toBe('stop')
    expect(a.cta).toBe('delete-and-retry')
  })

  /**
   * The distinction the old card could not make: a third of the jobs failing
   * is a gap in real results, not a reason to throw the run away.
   */
  it('treats partial failure as worth reading, not as a stop', () => {
    const a = runNextAction(run({ jobsDone: 68, jobsFailed: 32, hitCount: 9 }))
    expect(a.tone).toBe('act')
    expect(a.cta).toBe('open-results')
    expect(a.detail).toContain('32 failed')
  })

  it('separates "no Reddit" from "nothing here"', () => {
    const a = runNextAction(run({ hitCount: 0 }))
    expect(a.tone).toBe('act')
    expect(a.headline).toMatch(/no Reddit/i)
    expect(a.detail).toMatch(/build and domain/i)
    expect(a.cta).toBe('open-results')
  })

  it('sends a clean finished run to the grid', () => {
    const a = runNextAction(run())
    expect(a.tone).toBe('act')
    expect(a.headline).toMatch(/shortlist/i)
    expect(a.detail).toContain('12 Reddit threads')
  })

  it('singularises rather than printing "1 threads"', () => {
    expect(runNextAction(run({ hitCount: 1 })).detail).toContain('1 Reddit thread across')
    expect(runNextAction(run({ jobsDone: 99, jobsFailed: 1, hitCount: 4 })).detail).toContain(
      'pair is',
    )
  })

  /**
   * The state that exposed the fallback: run #43 held 3,852 measured SERPs and
   * 3,000 Reddit threads, and the card offered no advice at all.
   */
  it('treats a budget stop with results as readable, not broken', () => {
    const a = runNextAction(
      run({ status: 'budget_exceeded', jobCount: 4984, jobsDone: 3852, hitCount: 3000 }),
    )
    expect(a.tone).toBe('act')
    expect(a.cta).toBe('open-results')
    expect(a.detail).toContain('3852 of 4984')
    expect(a.detail[0]).toBe(a.detail[0]!.toUpperCase())
  })

  it('stops on a budget or cancel that bought nothing', () => {
    for (const status of ['budget_exceeded', 'cancelled']) {
      const a = runNextAction(run({ status, jobsDone: 0, hitCount: 0 }))
      expect(a.tone).toBe('stop')
      expect(a.cta).toBe('delete-and-retry')
    }
  })

  it('distinguishes a cancel from a cap in what it tells you to change', () => {
    const cancelled = runNextAction(run({ status: 'cancelled', jobsDone: 0, hitCount: 0 }))
    const capped = runNextAction(run({ status: 'budget_exceeded', jobsDone: 0, hitCount: 0 }))
    expect(cancelled.detail).toMatch(/leave it running/i)
    expect(capped.detail).toMatch(/higher cap/i)
  })

  it('does not invent advice for an unknown status', () => {
    const a = runNextAction(run({ status: 'quantum' }))
    expect(a.tone).toBe('wait')
    expect(a.cta).toBeNull()
  })

  it('counts skipped jobs as finished so the remaining count cannot go negative', () => {
    const a = runNextAction(
      run({ status: 'running', jobCount: 10, jobsDone: 4, jobsFailed: 2, jobsSkipped: 4 }),
    )
    expect(a.detail).toContain('0 of 10')
  })
})

describe('isRunInFlight', () => {
  it('covers every state the worker still owes work for', () => {
    expect(['pending', 'claimed', 'running'].every(isRunInFlight)).toBe(true)
    expect(['done', 'failed', 'awaiting'].some(isRunInFlight)).toBe(false)
  })
})
