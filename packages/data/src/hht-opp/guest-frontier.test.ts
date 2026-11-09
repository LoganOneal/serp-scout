import { describe, expect, it } from 'vitest'
import { GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED, runGuestPostFrontier } from './guest-frontier.js'

describe('guest-frontier Semrush access', () => {
  it('refuses the old direct-Semrush loop and points to --plan / --serp-from', async () => {
    await expect(runGuestPostFrontier()).rejects.toThrow(GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED)
    expect(GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED).toMatch(/--plan/)
    expect(GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED).toMatch(/--serp-from/)
  })
})
