import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Where the workspace root is, independent of how the process was launched.
 *
 * ==================== WHY NOT process.cwd() ====================
 * Different entry points run from different directories:
 *
 *   pnpm worker  ->  tsx packages/data/src/worker/main.ts   cwd = repo root
 *   pnpm dev     ->  pnpm --filter @rnr/web dev -> next dev  cwd = apps/web
 *
 * So a relative path in .env means two different absolute paths in two processes.
 * That is not hypothetical: `RECORDINGS_DIR=./.recordings` had the worker WRITING
 * call recordings to <root>/.recordings while the web app READ from
 * <root>/apps/web/.recordings. Every recording saved correctly and every play button
 * returned 404, which in a browser looks exactly like a 0-second clip -- so it read
 * as "the recording was lost" when nothing had been lost at all.
 *
 * Anchoring on pnpm-workspace.yaml makes every process agree on what `.` means.
 * ==============================================================
 */

const MARKER = 'pnpm-workspace.yaml'

let cached: string | null = null

/**
 * Walk up from `from` looking for the workspace marker.
 *
 * Falls back to `from` rather than throwing: a deployed bundle may not ship
 * pnpm-workspace.yaml, and refusing to start would be a worse failure than resolving
 * against the process directory -- which is correct there anyway, because a
 * single-process deployment has only one cwd to disagree with.
 */
export function workspaceRoot(from: string = process.cwd()): string {
  if (cached !== null && from === process.cwd()) return cached

  let dir = resolve(from)
  for (;;) {
    if (existsSync(resolve(dir, MARKER))) {
      if (from === process.cwd()) cached = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const fallback = resolve(from)
  if (from === process.cwd()) cached = fallback
  return fallback
}

/**
 * Resolve a possibly-relative configured path against the workspace root.
 *
 * An absolute value is returned untouched -- that is what a deployment will set, and
 * second-guessing it would break the case this function exists to serve.
 */
export function resolveFromRoot(configured: string, from?: string): string {
  return resolve(workspaceRoot(from), configured)
}

/** Test seam. The cache would otherwise leak between cases. */
export function clearWorkspaceRootCache(): void {
  cached = null
}
