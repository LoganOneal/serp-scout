import { describe, expect, it } from 'vitest'
import { bufferToCursorValue, cursorValueToBuffer, decryptCursorSecret, encryptCursorSecret } from './cursor-crypto.js'

describe('Cursor safeStorage', () => {
  it('round-trips a connector token blob', () => {
    const password = 'test-safe-storage'
    const plaintext = JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 })
    const stored = bufferToCursorValue(encryptCursorSecret(password, plaintext))
    const back = decryptCursorSecret(password, cursorValueToBuffer(stored))
    expect(back).toBe(plaintext)
  })
})
