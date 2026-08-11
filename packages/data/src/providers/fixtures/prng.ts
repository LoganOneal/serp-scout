/**
 * Deterministic pseudo-randomness, seeded from a string.
 *
 * The fixture providers must be reproducible: the same keyword must produce the
 * same SERP on every run, in every process, forever. Otherwise the $0 e2e suite
 * becomes flaky and its assertions about difficulty spread have to be loosened
 * until they stop meaning anything.
 */

/** FNV-1a 32-bit. Small, fast, good enough for fixture selection. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32. Deterministic, uniform enough, 2^32 period. */
export function seededPrng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Rng {
  private readonly next: () => number

  constructor(seedSource: string) {
    this.next = seededPrng(hashString(seedSource))
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next()
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** Log-uniform integer, for link counts -- which are heavily right-skewed. */
  logInt(min: number, max: number): number {
    const lo = Math.log(Math.max(1, min))
    const hi = Math.log(Math.max(1, max))
    return Math.round(Math.exp(lo + this.next() * (hi - lo)))
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on an empty list')
    return items[Math.floor(this.next() * items.length)]!
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }

  /** Fisher-Yates, on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const a = out[i]!
      out[i] = out[j]!
      out[j] = a
    }
    return out
  }
}
