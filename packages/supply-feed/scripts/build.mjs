/**
 * Dual ESM + CJS build, with declarations, using nothing but the TypeScript
 * already in this repo's devDependencies.
 *
 * ==================== WHY THE MARKER package.json FILES ====================
 * The package manifest says `"type": "module"`, so Node treats every `.js` under
 * this directory as ESM — including the CommonJS output. `require()` of it then
 * fails with ERR_REQUIRE_ESM inside the consumer's codebase, which is exactly the
 * environment we cannot debug.
 *
 * Writing `{"type":"commonjs"}` into dist/cjs and `{"type":"module"}` into
 * dist/esm makes each directory declare its own format. This is the standard fix
 * and it is invisible until it is missing, which is why it is written down here.
 * ==========================================================================
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(root))
const dist = join(root, 'dist')

/**
 * The local compiler, not `npx`.
 *
 * `npx tsc` will reach the network when the binary is not already linked, which
 * turns a build into something that can fail offline for a reason that has
 * nothing to do with the code.
 */
const tscJs = [
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
].find((p) => existsSync(p))

if (!tscJs) {
  console.error('typescript is not installed. Run `pnpm install` at the repo root first.')
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })

const tsc = (args) =>
  execFileSync(process.execPath, [tscJs, '-p', join(root, 'tsconfig.build.json'), ...args], {
    stdio: 'inherit',
    cwd: root,
  })

// ESM plus the declarations. NodeNext because this output is loaded BY NODE, so
// the emitted specifiers have to be the ones Node itself resolves — extensions
// included. One pass emits both .js and .d.ts.
tsc([
  '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext',
  '--outDir', join(dist, 'esm'),
  '--declarationDir', join(dist, 'types'),
])

// CJS. Declarations already exist, so this pass only rewrites the module format.
tsc([
  '--module', 'CommonJS',
  '--moduleResolution', 'Node10',
  '--outDir', join(dist, 'cjs'),
  '--declaration', 'false',
  '--declarationMap', 'false',
])

for (const [dir, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  mkdirSync(join(dist, dir), { recursive: true })
  writeFileSync(join(dist, dir, 'package.json'), JSON.stringify({ type }, null, 2) + '\n')
}

console.log('@rnr/supply-feed built -> dist/{esm,cjs,types}')
