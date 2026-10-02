import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./packages/data/src/schema.ts', './packages/data/src/hht-engine/schema.ts'],
  out: './packages/data/drizzle',
  dbCredentials: {
    // The HHT engine's dedicated Supabase project exposes the IPv4 session
    // pooler on 5432. Migrations and runtime intentionally use this same URL.
    url: process.env['DATABASE_URL'] || '',
  },
  verbose: true,
  strict: true,
})
