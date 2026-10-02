import { eq, and, sql } from 'drizzle-orm'
import type { EngineDatabase } from './db.js'
import { hhtEngineEmbeddings } from './schema.js'

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

type Extractor = (
  text: string,
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ data: Float32Array | number[] }>

let extractorPromise: Promise<Extractor> | null = null

export async function localEmbedding(text: string): Promise<number[]> {
  const extractor = await getExtractor()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  const vector = Array.from(output.data)
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding model returned ${vector.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`)
  }
  return vector
}

export async function cachedEmbedding(
  db: EngineDatabase,
  entityType: string,
  entityKey: string,
  text: string,
): Promise<number[]> {
  const [cached] = await db.select().from(hhtEngineEmbeddings).where(and(
    eq(hhtEngineEmbeddings.entityType, entityType),
    eq(hhtEngineEmbeddings.entityKey, entityKey),
    eq(hhtEngineEmbeddings.model, EMBEDDING_MODEL),
  ))
  if (cached) return cached.embedding
  const embedding = await localEmbedding(text)
  await db.insert(hhtEngineEmbeddings).values({
    entityType,
    entityKey,
    model: EMBEDDING_MODEL,
    embedding,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [hhtEngineEmbeddings.entityType, hhtEngineEmbeddings.entityKey, hhtEngineEmbeddings.model],
    set: { embedding, updatedAt: new Date() },
  })
  return embedding
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

export async function maxCachedSimilarity(
  db: EngineDatabase,
  entityType: string,
  excludeEntityKey: string,
  embedding: number[],
): Promise<number> {
  const serialized = `[${embedding.join(',')}]`
  const rows = await db.execute<{ similarity: number | null }>(sql`
    SELECT max(1 - (embedding <=> ${serialized}::vector))::double precision AS similarity
      FROM hht_engine.embeddings
     WHERE entity_type = ${entityType}
       AND entity_key <> ${excludeEntityKey}
       AND model = ${EMBEDDING_MODEL}
  `)
  return Number((rows as unknown as Array<{ similarity: number | null }>)[0]?.similarity ?? 0)
}

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then(async ({ pipeline }) => {
      return await pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      }) as unknown as Extractor
    })
  }
  return extractorPromise
}
