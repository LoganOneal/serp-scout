import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type postgres from 'postgres'
import { workspaceRoot } from '../paths.js'

/**
 * Build a test schema from the REAL generated migration.
 *
 * ==================== WHY NOT HAND-WRITTEN DDL ====================
 * Both e2e suites used to carry their own `CREATE TABLE` block. That block is a
 * second copy of the schema, and it drifts silently: adding
 * `spend_ledger.site_id` to schema.ts broke the pipeline suite in a way that
 * surfaced as `expected 0 to be 41` -- a scan that scored nothing -- rather than as
 * "your test DDL is missing a column". Drizzle lists every declared column in the
 * INSERT, so any column the test table lacks fails the write, and the failure
 * appears several layers away from its cause.
 *
 * Reading the migration instead means the test schema cannot drift, and applying it
 * also proves the migration itself works.
 * =================================================================
 */

/** Apply every generated migration into `schema`, which must already exist. */
export async function applyMigrations(client: postgres.Sql, schema: string): Promise<void> {
  // search_path on THIS connection, so the unqualified CREATE TABLEs land in the
  // target schema. `client` must be a single-connection pool (max: 1) or the SET
  // applies to whichever pooled connection happened to run it.
  await client.unsafe(`SET search_path TO ${schema}`)
  for (const statement of await migrationStatements(schema)) {
    await client.unsafe(statement)
  }
}

export async function migrationStatements(schema: string): Promise<string[]> {
  // Root-anchored so the suite works from any cwd, like the recordings dir.
  const dir = join(workspaceRoot(), 'packages', 'data', 'drizzle')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    throw new Error(
      `No migration SQL in ${dir}. Run: pnpm exec drizzle-kit generate --config=packages/data/drizzle.config.ts`,
    )
  }

  const out: string[] = []
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    // drizzle-kit hard-codes `REFERENCES "public"."x"` on every foreign key. Left
    // alone, a throwaway schema's FKs would point at the REAL tables -- so a test
    // insert could fail against, or worse succeed against, production rows.
    const scoped = text.replaceAll('"public"."', `"${schema}"."`)
    for (const chunk of scoped.split('--> statement-breakpoint')) {
      const trimmed = chunk.trim()
      if (trimmed !== '') out.push(trimmed)
    }
  }
  return out
}

/** Drop and recreate `schema`, then apply the migration. */
export async function resetSchema(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await client.unsafe(`CREATE SCHEMA ${schema}`)
  await applyMigrations(client, schema)
}
