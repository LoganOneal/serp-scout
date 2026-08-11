import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/data/src/schema.ts',
  out: './packages/data/drizzle',
  dbCredentials: {
    // DIRECT, not pooled. `push` takes advisory locks and issues DDL, neither of which
    // survives a transaction-mode pooler handing each statement a different backend.
    url: process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL'] || '',
  },
  verbose: true,
  strict: true,
})
