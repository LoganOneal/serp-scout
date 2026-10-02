import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'

const SALT = 'saltysalt'
const ITERATIONS = 1003

function keyFor(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, 16, 'sha1')
}

/** Cursor stores MCP OAuth blobs as Chromium safeStorage "v10" AES-128-CBC. */
export function decryptCursorSecret(password: string, stored: Buffer): string {
  if (stored.subarray(0, 3).toString() !== 'v10') {
    throw new Error('Cursor secret is not a v10 safeStorage blob')
  }
  const decipher = createDecipheriv('aes-128-cbc', keyFor(password), Buffer.alloc(16, ' '))
  return Buffer.concat([decipher.update(stored.subarray(3)), decipher.final()]).toString('utf8')
}

export function encryptCursorSecret(password: string, plaintext: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', keyFor(password), Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

export function bufferToCursorValue(blob: Buffer): string {
  return JSON.stringify({ type: 'Buffer', data: [...blob] })
}

export function cursorValueToBuffer(value: string): Buffer {
  const parsed = JSON.parse(value) as { data?: number[] }
  if (!parsed.data) throw new Error('Cursor secret value is not a buffer')
  return Buffer.from(parsed.data)
}
