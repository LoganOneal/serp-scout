import { readFile, writeFile } from 'node:fs/promises'
import { and, eq, sql } from 'drizzle-orm'
import type { EngineDatabase } from './db.js'
import { hhtEngineJobs, hhtEngineLlmTasks, hhtEngineOpportunities } from './schema.js'

export type EngineLlmTaskType =
  | 'guest_post_policy'
  | 'guest_post_personalization'
  | 'site_type'
  | 'keyword_relevance'
  | 'contextual_fit'
  | 'insertion_suggestion'
  | 'target_page_match'

export class LlmTaskPendingError extends Error {
  constructor(readonly taskId: number) {
    super(`LLM task ${taskId} is pending`)
    this.name = 'LlmTaskPendingError'
  }
}

export const LLM_SCHEMAS: Record<EngineLlmTaskType, Record<string, unknown>> = {
  guest_post_policy: objectSchema({
    status: { type: 'string', enum: ['ACCEPTS', 'LIKELY_ACCEPTS', 'UNKNOWN', 'LIKELY_REJECTS', 'DOES_NOT_ACCEPT'] },
    evidence_url: { type: ['string', 'null'] },
    requirements: { type: ['string', 'null'] },
    submission_method: { type: ['string', 'null'], enum: ['email', 'form', 'google_form', 'other', null] },
    submission_url: { type: ['string', 'null'] },
    pitch_topic_count: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
    pitch_content_stage: { type: ['string', 'null'], enum: ['outline', 'draft', 'either', null] },
    required_subject_line_format: { type: ['string', 'null'] },
    accepted_topics: { type: 'array', items: { type: 'string' } },
    excluded_topics: { type: 'array', items: { type: 'string' } },
    word_count: { type: ['string', 'null'] },
    link_policy: { type: ['string', 'null'] },
    samples_required: { type: 'boolean' },
    bio_required: { type: 'boolean' },
    ai_content_policy: { type: ['string', 'null'] },
    ai_content_prohibited: { type: 'boolean' },
    paid_or_sponsored: { type: 'boolean' },
    evidence: objectSchema({
      submission_method: { type: ['string', 'null'] },
      pitch_format: { type: ['string', 'null'] },
      accepted_topics: { type: ['string', 'null'] },
      excluded_topics: { type: ['string', 'null'] },
      word_count: { type: ['string', 'null'] },
      link_policy: { type: ['string', 'null'] },
      samples_required: { type: ['string', 'null'] },
      bio_required: { type: ['string', 'null'] },
      ai_content_policy: { type: ['string', 'null'] },
      paid_or_sponsored: { type: ['string', 'null'] },
    }),
  }),
  guest_post_personalization: objectSchema({
    pitch_topics: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: objectSchema({
        title: { type: 'string', minLength: 1 },
        target_hht_url: { type: 'string', minLength: 1 },
        citations: { type: 'array', minItems: 1, items: { type: 'string' } },
      }),
    },
    fit_line: objectSchema({
      text: { type: 'string', minLength: 1 },
      citations: { type: 'array', minItems: 1, items: { type: 'string' } },
    }),
    subject_line: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['text', 'citations'],
      properties: {
        text: { type: 'string', minLength: 1 },
        citations: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    },
  }),
  site_type: objectSchema({
    site_type: {
      type: 'string',
      enum: ['editorial_blog', 'news_media', 'travel_guide', 'hotel_property', 'hotel_chain', 'ota_booking', 'competitor_directory', 'forum_social_ugc', 'marketplace', 'search_engine', 'hht', 'unknown'],
    },
  }),
  keyword_relevance: objectSchema({
    decision: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
  }),
  contextual_fit: objectSchema({
    fits: { type: 'boolean' },
    reason: { type: 'string' },
  }),
  insertion_suggestion: objectSchema({
    suggestion: { type: 'string', minLength: 1, maxLength: 300 },
  }),
  target_page_match: objectSchema({
    target_hht_url: { type: 'string' },
    secondary_hht_url: { type: ['string', 'null'] },
    reason: { type: 'string' },
  }),
}

export async function requireLlmAnswer(input: {
  db: EngineDatabase
  job: { id: number; payload: Record<string, unknown> }
  taskType: EngineLlmTaskType
  entityType: string
  entityId: string
  taskInput: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const answers = asRecord(input.job.payload['llmAnswers'])
  const injected = asRecord(answers[input.taskType])
  if (Object.keys(injected).length > 0) return injected
  const [existing] = await input.db.select().from(hhtEngineLlmTasks).where(and(
    eq(hhtEngineLlmTasks.taskType, input.taskType),
    eq(hhtEngineLlmTasks.entityType, input.entityType),
    eq(hhtEngineLlmTasks.entityId, input.entityId),
  ))
  if (existing?.status === 'APPLIED' && existing.answer) return existing.answer
  const [task] = await input.db.insert(hhtEngineLlmTasks).values({
    taskType: input.taskType,
    entityType: input.entityType,
    entityId: input.entityId,
    input: input.taskInput,
    outputSchema: LLM_SCHEMAS[input.taskType],
    status: 'PENDING',
    parkedJobId: input.job.id,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [hhtEngineLlmTasks.taskType, hhtEngineLlmTasks.entityType, hhtEngineLlmTasks.entityId],
    set: {
      input: input.taskInput,
      outputSchema: LLM_SCHEMAS[input.taskType],
      parkedJobId: input.job.id,
      status: 'PENDING',
      updatedAt: new Date(),
    },
  }).returning()
  if (!task) throw new Error('Could not create LLM task')
  throw new LlmTaskPendingError(task.id)
}

export async function exportPendingLlmTasks(
  db: EngineDatabase,
  path = 'llm-tasks.json',
  limit = 100,
): Promise<number> {
  const rows = await db.select().from(hhtEngineLlmTasks)
    .where(eq(hhtEngineLlmTasks.status, 'PENDING'))
    .orderBy(hhtEngineLlmTasks.id)
    .limit(limit)
  await writeFile(path, JSON.stringify({
    generated_at: new Date().toISOString(),
    tasks: rows.map((row) => ({
      task_id: row.id,
      task_type: row.taskType,
      input: row.input,
      output_schema: row.outputSchema,
    })),
  }, null, 2))
  return rows.length
}

export async function ingestLlmAnswers(
  db: EngineDatabase,
  path = 'llm-answers.json',
): Promise<{ applied: number; pending: number; review: number }> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    answers?: Array<{ task_id?: number; answer?: unknown }>
  }
  if (!Array.isArray(parsed.answers)) throw new Error('llm-answers.json must contain answers[]')
  const result = { applied: 0, pending: 0, review: 0 }
  for (const item of parsed.answers) {
    const taskId = Number(item.task_id)
    const [task] = await db.select().from(hhtEngineLlmTasks).where(eq(hhtEngineLlmTasks.id, taskId))
    if (!task || task.status !== 'PENDING') continue
    const validation = validateJsonSchema(item.answer, task.outputSchema)
    if (!validation.ok) {
      const attempts = task.attemptCount + 1
      if (attempts >= 3) {
        await db.update(hhtEngineLlmTasks).set({
          status: 'FAILED',
          attemptCount: attempts,
          lastError: validation.error,
          updatedAt: new Date(),
        }).where(eq(hhtEngineLlmTasks.id, task.id))
        await sendEntityToReview(db, task.entityType, task.entityId)
        if (task.parkedJobId) {
          await db.update(hhtEngineJobs).set({
            status: 'done',
            lastError: 'LLM answer failed validation three times; entity sent to REVIEW',
            updatedAt: new Date(),
          }).where(eq(hhtEngineJobs.id, task.parkedJobId))
        }
        result.review += 1
      } else {
        await db.update(hhtEngineLlmTasks).set({
          attemptCount: attempts,
          lastError: validation.error,
          updatedAt: new Date(),
        }).where(eq(hhtEngineLlmTasks.id, task.id))
        result.pending += 1
      }
      continue
    }
    const answer = item.answer as Record<string, unknown>
    await db.update(hhtEngineLlmTasks).set({
      status: 'APPLIED',
      answer,
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(hhtEngineLlmTasks.id, task.id))
    if (task.parkedJobId) {
      const [job] = await db.select().from(hhtEngineJobs).where(eq(hhtEngineJobs.id, task.parkedJobId))
      if (job) {
        const llmAnswers = asRecord(job.payload['llmAnswers'])
        await db.update(hhtEngineJobs).set({
          status: 'pending',
          payload: { ...job.payload, llmAnswers: { ...llmAnswers, [task.taskType]: answer } },
          runAfter: new Date(),
          lockedBy: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        }).where(eq(hhtEngineJobs.id, job.id))
      }
    }
    result.applied += 1
  }
  return result
}

export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const error = validateValue(value, schema, 'answer')
  return error ? { ok: false, error } : { ok: true }
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  const allowedTypes = Array.isArray(schema['type'])
    ? schema['type'].map(String)
    : [String(schema['type'])]
  const actual = value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value
  const compatible = allowedTypes.includes(actual) || (actual === 'integer' && allowedTypes.includes('number'))
  if (!compatible) return `${path} must be ${allowedTypes.join(' or ')}`
  if (value === null) return null
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) return `${path} is not an allowed value`
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) return `${path} is too short`
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) return `${path} is too long`
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) return `${path} is below minimum`
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) return `${path} exceeds maximum`
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return `${path} has too few items`
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return `${path} has too many items`
    const itemSchema = asRecord(schema['items'])
    for (let index = 0; index < value.length; index += 1) {
      const itemError = validateValue(value[index], itemSchema, `${path}[${index}]`)
      if (itemError) return itemError
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const properties = asRecord(schema['properties'])
  const required = Array.isArray(schema['required']) ? schema['required'].map(String) : []
  for (const key of required) {
    if (!(key in record)) return `missing required property ${path}.${key}`
  }
  if (schema['additionalProperties'] === false) {
    const extra = Object.keys(record).find((key) => !(key in properties))
    if (extra) return `unexpected property ${path}.${extra}`
  }
  for (const [key, definitionValue] of Object.entries(properties)) {
    if (!(key in record)) continue
    const childError = validateValue(record[key], asRecord(definitionValue), `${path}.${key}`)
    if (childError) return childError
  }
  return null
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

async function sendEntityToReview(db: EngineDatabase, entityType: string, entityId: string): Promise<void> {
  if (entityType !== 'opportunity') return
  const id = Number(entityId)
  if (!Number.isFinite(id)) return
  await db.update(hhtEngineOpportunities).set({
    filterStatus: 'REVIEW',
    filterReasons: sql`coalesce(${hhtEngineOpportunities.filterReasons}, '[]'::jsonb) || '["llm_validation_failed"]'::jsonb`,
  }).where(eq(hhtEngineOpportunities.id, id))
}
