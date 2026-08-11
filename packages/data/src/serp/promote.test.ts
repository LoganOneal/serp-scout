import { describe, expect, it } from 'vitest'
import { PromoteError } from './promote.js'

/**
 * PromoteError is the public failure type the web action maps to form errors.
 * Behavioural promote coverage lives in discovery e2e once a full cell exists.
 */
describe('PromoteError', () => {
  it('is an Error with a stable name for instanceof checks', () => {
    const e = new PromoteError('Map this discovery niche to a seeded niche before promoting.')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('PromoteError')
    expect(e.message).toMatch(/seeded niche/)
  })
})
