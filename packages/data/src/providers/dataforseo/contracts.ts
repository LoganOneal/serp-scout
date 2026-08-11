import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader for the captured provider payloads in __contracts__/. */

export const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__contracts__')

export interface ContractMeta {
  /**
   * False means the payload was TRANSCRIBED FROM DOCUMENTATION, not captured
   * from the live API -- so any test asserting against it is only confirming what
   * we already believe. That is exactly the belief that produced Trap 1.
   */
  verified: boolean
  capturedAt: string | null
  source: string
  note?: string
  /**
   * Set ONLY on a fixture that is deliberately hand-built because the arrangement
   * it tests cannot be obtained on demand from the live API.
   *
   * This is a narrow exemption from the capture gate, not a way to opt out of it.
   * The string must say WHY capture is impossible and, where one exists, point at
   * the captured fixture that covers the same endpoint's real shape -- the gate
   * asserts it is substantive rather than a token.
   */
  constructed?: string
}

export interface ContractFile<T = unknown> {
  __meta: ContractMeta
  payload: T
}

export function loadContract<T = unknown>(name: string): ContractFile<T> {
  const path = join(CONTRACTS_DIR, `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as ContractFile<T>
}

export function listContracts(): string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

/** Used by the probe script to overwrite a fixture with a real response. */
/**
 * @param verified False when the call came back but the TASK failed.
 *
 * ==================== A CAPTURE IS NOT AUTOMATICALLY TRUTH ====================
 * This used to hardcode `verified: true`. A live probe of the maps endpoint
 * came back with task status 40102 and `result: null`; the fixture was
 * overwritten with that empty envelope and stamped verified anyway, so the
 * provenance gate went green on a file containing nothing while the probe
 * printed "those fixtures were not replaced with a good capture" -- which was
 * also untrue, it had just replaced them.
 *
 * A hollow fixture claiming to be captured truth is worse than an honestly
 * transcribed one, because the gate exists precisely to stop that claim.
 * =============================================================================
 */
export function writeContract(
  name: string,
  payload: unknown,
  source: string,
  verified = true,
): void {
  const file: ContractFile = {
    __meta: {
      verified,
      capturedAt: new Date().toISOString(),
      source,
    },
    payload,
  }
  writeFileSync(join(CONTRACTS_DIR, `${name}.json`), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/** Pull the first task's `result` out of a captured envelope. */
export function resultOf<T>(payload: unknown): T | null {
  const tasks = (payload as { tasks?: Array<{ result?: T | null }> })?.tasks
  return tasks?.[0]?.result ?? null
}

/** Pull the items[] out of a bulk backlinks result block. */
export function bulkItemsOf<T>(payload: unknown): T[] {
  const result = resultOf<Array<{ items?: T[] | null }>>(payload)
  if (!Array.isArray(result)) return []
  return result.flatMap((b) => b?.items ?? [])
}
