import { describe, expect, it } from 'vitest'
import { normalizePostgresUrl } from './db.js'

describe('normalizePostgresUrl', () => {
  it('encodes raw reserved characters in a database password', () => {
    expect(normalizePostgresUrl('postgresql://user:p#ass@db.example.com:5432/app'))
      .toBe('postgresql://user:p%23ass@db.example.com:5432/app')
  })

  it('preserves an already encoded password', () => {
    expect(normalizePostgresUrl('postgresql://user:p%23ass@db.example.com/app'))
      .toBe('postgresql://user:p%23ass@db.example.com/app')
  })
})
