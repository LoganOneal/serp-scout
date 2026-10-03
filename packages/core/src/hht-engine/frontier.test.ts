import { describe, expect, it } from 'vitest'
import { frontierCandidates, keywordOnTopic, neighborhoodLabel, serpJaccard } from './frontier.js'
import { DEFAULT_BLOCK_LISTS } from './relevance.js'

const lists = DEFAULT_BLOCK_LISTS
const cities = [
  { city: 'Asheville', state: 'NC' },
  { city: 'New York', state: 'NY' },
  { city: 'York', state: 'PA' },
]

describe('keyword frontier', () => {
  it('keeps romantic hotel queries and drops hot tub sales and repairs', () => {
    expect(keywordOnTopic('romantic hotels with hot tubs in Asheville', lists).ok).toBe(true)
    expect(keywordOnTopic('hot tub repair near me', lists).reason).toBe('sales_repair')
    expect(keywordOnTopic('hot tub chemicals and heater price', lists).reason).toBe('product_drift')
    expect(keywordOnTopic('best coffee in Asheville', lists).reason).toBe('off_topic')
  })

  it('builds city templates, article titles, and related lodging terms from one SERP', () => {
    const candidates = frontierCandidates({
      keyword: 'hotels with hot tubs',
      templates: ['hotels with hot tubs in {city}', 'romantic hotels with hot tubs in {city} {state}'],
      cities,
      titles: ['10 Best Romantic Hotels in Asheville | Travel Blog', 'Where to stay in New York'],
      urls: ['https://imfixintoblog.com/romantic-inns-western-nc/'],
      lists,
    })
    const keywords = candidates.map((candidate) => candidate.keyword.toLowerCase())
    expect(keywords).toContain('hotels with hot tubs in asheville')
    expect(keywords).toContain('romantic hotels with hot tubs in asheville nc')
    expect(keywords).toContain('best romantic hotels in asheville')
    expect(keywords.some((keyword) => keyword.includes('romantic inns western'))).toBe(true)
    expect(keywords).toContain('romantic hotels with hot tubs')
    expect(keywords.some((keyword) => keyword.includes('york') && !keyword.includes('new york') && !keyword.includes('asheville'))).toBe(false)
    expect(candidates.find((candidate) => candidate.city === 'Asheville')?.sourceType).toBe('geo_template')
  })

  it('treats a heavy URL overlap as a used-up neighborhood and a fresh pitchable SERP as productive', () => {
    const left = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4']
    const close = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://e.example/5']
    expect(serpJaccard(left, close)).toBeGreaterThan(0.5)
    expect(neighborhoodLabel(serpJaccard(left, close), 2)).toBe('saturated')
    expect(neighborhoodLabel(0.1, 3)).toBe('productive')
    expect(neighborhoodLabel(0, 0)).toBe('neutral')
  })
})
