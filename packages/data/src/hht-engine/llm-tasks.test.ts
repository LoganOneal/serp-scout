import { describe, expect, it } from 'vitest'
import { LLM_SCHEMAS, validateJsonSchema } from './llm-tasks.js'

describe('LLM task schemas', () => {
  it('accepts an exact answer and rejects missing or extra fields', () => {
    const schema = LLM_SCHEMAS.keyword_relevance
    expect(validateJsonSchema({ decision: 'accept', reason: 'Strong hotel intent' }, schema)).toEqual({ ok: true })
    expect(validateJsonSchema({ decision: 'accept' }, schema)).toEqual({
      ok: false,
      error: 'missing required property answer.reason',
    })
    expect(validateJsonSchema({ decision: 'accept', reason: 'Strong hotel intent', score: 1 }, schema)).toEqual({
      ok: false,
      error: 'unexpected property answer.score',
    })
  })

  it('enforces enum and insertion-suggestion length constraints', () => {
    expect(validateJsonSchema(
      { decision: 'maybe', reason: 'unclear' },
      LLM_SCHEMAS.keyword_relevance,
    )).toEqual({ ok: false, error: 'answer.decision is not an allowed value' })
    expect(validateJsonSchema(
      { suggestion: '' },
      LLM_SCHEMAS.insertion_suggestion,
    )).toEqual({ ok: false, error: 'answer.suggestion is too short' })
  })

  it('validates nested grounded guest-post personalization objects', () => {
    const valid = {
      pitch_topics: [{
        title: 'A useful topic',
        target_hht_url: 'https://www.hotelhottubs.com/chicago',
        citations: ['https://publisher.example/travel'],
      }],
      fit_line: {
        text: 'This complements your Chicago travel coverage.',
        citations: ['https://publisher.example/chicago'],
      },
      subject_line: null,
    }
    expect(validateJsonSchema(valid, LLM_SCHEMAS.guest_post_personalization)).toEqual({ ok: true })
    expect(validateJsonSchema({
      ...valid,
      pitch_topics: [{ ...valid.pitch_topics[0], citations: [] }],
    }, LLM_SCHEMAS.guest_post_personalization)).toEqual({
      ok: false,
      error: 'answer.pitch_topics[0].citations has too few items',
    })
  })
})
