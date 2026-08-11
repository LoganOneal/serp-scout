import { join, resolve, sep } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWorkspaceRootCache, workspaceRoot } from '../paths.js'
import { recordingsDir, resolveRecordingPath } from './recordings.js'

/**
 * The bug this file exists for.
 *
 * `RECORDINGS_DIR=./.recordings` was resolved against `process.cwd()`. The worker runs
 * from the repo root and `next dev` runs from `apps/web`, so the writer and the reader
 * disagreed about what `.` meant: every recording saved to <root>/.recordings and every
 * play button 404'd against <root>/apps/web/.recordings. In a browser that renders as a
 * 0-second clip, so it looked like the recordings had been deleted when nothing had.
 *
 * The defect was CWD-DEPENDENCE, so that is what these assertions pin -- not the
 * symptom. A test that only checked "the path contains .recordings" would have passed
 * throughout the entire outage.
 */

const ROOT = workspaceRoot()

/**
 * A ProcessEnv with RECORDINGS_DIR set, or removed when `dir` is undefined.
 *
 * Spread over the real env rather than cast from a bare literal: these functions take
 * a full ProcessEnv, and faking one hides that they read exactly one key. Deleting
 * matters too -- the ambient .env sets RECORDINGS_DIR, so an "unset" case has to
 * actually remove it rather than rely on it being absent.
 */
function envWith(dir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (dir === undefined) delete env['RECORDINGS_DIR']
  else env['RECORDINGS_DIR'] = dir
  return env
}

beforeEach(() => {
  clearWorkspaceRootCache()
})

describe('recordingsDir', () => {
  it('resolves to the SAME directory from any working directory', () => {
    const env = envWith('./.recordings')

    // The two cwds that actually occur in this repo.
    const fromRoot = recordingsDir(env, ROOT)
    const fromWebApp = recordingsDir(env, join(ROOT, 'apps', 'web'))
    const fromDeepNesting = recordingsDir(env, join(ROOT, 'packages', 'data', 'src', 'voice'))

    expect(fromWebApp).toBe(fromRoot)
    expect(fromDeepNesting).toBe(fromRoot)
    expect(fromRoot).toBe(resolve(ROOT, '.recordings'))
  })

  /**
   * THE DECISIVE TEST.
   *
   * The assertions above pass an explicit `from`, so they would ALSO pass against a
   * regressed implementation that ignored the parameter and used `process.cwd()` --
   * because vitest runs from the repo root, where cwd and root are the same directory.
   *
   * This one actually changes the working directory to `apps/web`, exactly as
   * `next dev` does, and calls the function with NO `from` argument. It is the only
   * case here that fails if the cwd-relative resolution ever comes back.
   */
  it('is unaffected by an actual chdir into apps/web', () => {
    const original = process.cwd()
    try {
      process.chdir(join(ROOT, 'apps', 'web'))
      clearWorkspaceRootCache()
      expect(process.cwd()).not.toBe(ROOT) // the test would be vacuous otherwise

      const dir = recordingsDir(envWith('./.recordings'))
      expect(dir).toBe(resolve(ROOT, '.recordings'))
      expect(dir).not.toBe(resolve(process.cwd(), '.recordings'))

      const rel = '1/2026-08/call_d477f530a2412a266ee41ff5a24.wav'
      expect(resolveRecordingPath(rel, envWith('./.recordings'))).toBe(
        resolve(ROOT, '.recordings', '1', '2026-08', 'call_d477f530a2412a266ee41ff5a24.wav'),
      )
    } finally {
      process.chdir(original)
      clearWorkspaceRootCache()
    }
  })

  it('defaults to <root>/.recordings when unset', () => {
    expect(recordingsDir(envWith(), join(ROOT, 'apps', 'web'))).toBe(
      resolve(ROOT, '.recordings'),
    )
  })

  it('treats an empty or whitespace value as unset rather than as the root', () => {
    // `resolve(root, '')` is the root itself, which would put recordings loose in the
    // repo -- and on a deployment, loose in `/`.
    for (const value of ['', '   ']) {
      expect(recordingsDir(envWith(value), ROOT)).toBe(
        resolve(ROOT, '.recordings'),
      )
    }
  })

  it('honours an absolute value verbatim, which is what a deployment sets', () => {
    const abs = process.platform === 'win32' ? 'D:\\srv\\recordings' : '/srv/recordings'
    expect(recordingsDir(envWith(abs), ROOT)).toBe(abs)
    // ...and still from a different cwd.
    expect(recordingsDir(envWith(abs), join(ROOT, 'apps'))).toBe(abs)
  })

  it('accepts a relative path other than the default', () => {
    expect(recordingsDir(envWith('var/audio'), join(ROOT, 'apps'))).toBe(
      resolve(ROOT, 'var', 'audio'),
    )
  })
})

describe('resolveRecordingPath', () => {
  const env = envWith('./.recordings')

  it('produces a cwd-independent absolute path for a stored row', () => {
    // The exact shape of a real row: 1/2026-08/call_....wav
    const rel = '1/2026-08/call_d477f530a2412a266ee41ff5a24.wav'
    const a = resolveRecordingPath(rel, env, ROOT)
    const b = resolveRecordingPath(rel, env, join(ROOT, 'apps', 'web'))
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(a!.startsWith(resolve(ROOT, '.recordings') + sep)).toBe(true)
  })

  it('still refuses to escape the recordings directory', () => {
    // recording_path comes from the database and is used to open a file that is then
    // streamed to an HTTP client. Moving the anchor must not have loosened this.
    for (const bad of [
      '../../../etc/passwd',
      '1/../../../../.env',
      '1/2026-08/../../../../../secrets',
    ]) {
      expect(resolveRecordingPath(bad, env, ROOT), bad).toBeNull()
    }
    const abs = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    expect(resolveRecordingPath(abs, env, ROOT)).toBeNull()
  })

  it('allows the directory itself but nothing beside it', () => {
    // `1/../1` normalises back inside and is fine; a sibling directory is not.
    expect(resolveRecordingPath('1/../1/x.wav', env, ROOT)).not.toBeNull()
    expect(resolveRecordingPath('../.recordings-other/x.wav', env, ROOT)).toBeNull()
  })
})

describe('workspaceRoot', () => {
  it('finds the same root from anywhere inside the workspace', () => {
    expect(workspaceRoot(join(ROOT, 'apps', 'web'))).toBe(ROOT)
    clearWorkspaceRootCache()
    expect(workspaceRoot(join(ROOT, 'packages', 'core', 'src'))).toBe(ROOT)
  })

  it('falls back to the given directory outside a workspace instead of throwing', () => {
    // A deployed bundle may not ship pnpm-workspace.yaml. Refusing to start would be a
    // worse failure than resolving against the process directory, which is correct
    // there anyway -- one process has no second cwd to disagree with.
    const outside = process.platform === 'win32' ? 'C:\\' : '/'
    expect(workspaceRoot(outside)).toBe(resolve(outside))
  })
})
