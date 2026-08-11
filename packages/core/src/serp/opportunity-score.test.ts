import { describe, expect, it } from 'vitest'
import { rankScore, scoreRedditLeadOpportunity } from './opportunity-score.js'

describe('scoreRedditLeadOpportunity', () => {
  it('scores high for high volume + top Reddit commentable + clean SERP', () => {
    const s = scoreRedditLeadOpportunity({
      volume: 50_000,
      bestRedditAbsoluteRank: 2,
      redditOnPage1: true,
      commentable: true,
      adsAboveOrganic: 0,
      localAboveOrganic: 0,
      difficulty: 30,
      discussionsPackPresent: true,
      bestRedditSource: 'discussions_and_forums',
    })
    expect(s.score).not.toBeNull()
    expect(s.score!).toBeGreaterThan(40)
  })

  it('scores low when no Reddit', () => {
    const s = scoreRedditLeadOpportunity({
      volume: 50_000,
      bestRedditAbsoluteRank: null,
      redditOnPage1: false,
      commentable: null,
      adsAboveOrganic: 2,
      localAboveOrganic: 3,
      difficulty: 40,
      discussionsPackPresent: false,
      bestRedditSource: null,
    })
    expect(s.score).not.toBeNull()
    expect(s.score!).toBeLessThan(25)
  })

  it('rankScore decays with position', () => {
    expect(rankScore(1)).toBeGreaterThan(rankScore(5)!)
    expect(rankScore(5)).toBeGreaterThan(rankScore(10)!)
    expect(rankScore(null)).toBe(0)
  })
})
