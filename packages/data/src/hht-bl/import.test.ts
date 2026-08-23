import { describe, expect, it } from 'vitest'
import { shouldImportHhtBlBacklinkRow } from './import.js'

describe('HHT detailed backlink normalization', () => {
  it('accepts only rows Semrush explicitly identifies as follow links', () => {
    expect(shouldImportHhtBlBacklinkRow({ nofollow: 'false' })).toBe(true)
    expect(shouldImportHhtBlBacklinkRow({ nofollow: '0' })).toBe(true)
    expect(shouldImportHhtBlBacklinkRow({ nofollow: 'true' })).toBe(false)
    expect(shouldImportHhtBlBacklinkRow({ nofollow: '1' })).toBe(false)
    expect(shouldImportHhtBlBacklinkRow({})).toBe(false)
  })
})
