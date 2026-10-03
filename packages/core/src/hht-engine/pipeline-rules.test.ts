import { describe, expect, it } from 'vitest'
import { chooseContact } from './contacts.js'
import {
  groundStructuredGuestPostGuidelines,
  guestPostGuidelineReviewReasons,
  judgeGuestPostPages,
  structuredGuidelinesFromAnswer,
} from './guest-post.js'
import { classifyGadsFailure } from './gads.js'
import { relevanceGate } from './relevance.js'
import { renderTemplate, geographicKeywords } from './render.js'
import { pickFrontierKeyword } from './schedule.js'
import { classifyByRules, DEFAULT_SITE_RULES } from './sites.js'
import { scorePageSignals, serpLeadDecision, triageSerpUrl } from './serp-targets.js'
import { parseOrganicSerp, parseRankedKeywords } from './serp-table.js'
import { classifyHhtUrl, parseSitemapUrls, verifiedStayCountFromHtml } from './sitemap.js'
import { DEFAULT_BLOCK_LISTS } from './relevance.js'

describe('relevance gate', () => {
  it('rejects block-list terms and sends only the middle band to the LLM', () => {
    expect(relevanceGate({
      keyword: 'hot tub repair near me',
      lists: DEFAULT_BLOCK_LISTS,
      references: ['hotels with hot tubs'],
      volumeHigh: 100,
      enforceMinVolume: true,
      low: 0.2,
      high: 0.9,
    }).decision).toBe('reject')
    const borderline = relevanceGate({
      keyword: 'weekend getaway with a private spa',
      lists: DEFAULT_BLOCK_LISTS,
      references: ['hotels with hot tubs'],
      volumeHigh: 80,
      enforceMinVolume: true,
      low: 0.05,
      high: 0.99,
    })
    expect(borderline.decision).toBe('llm')
  })
})

describe('routing helpers', () => {
  it('classifies known OTAs and leaves unknown domains for the LLM', () => {
    expect(classifyByRules('www.tripadvisor.com', DEFAULT_SITE_RULES)).toBe('ota_booking')
    expect(classifyByRules('independenttravel.example', DEFAULT_SITE_RULES)).toBeNull()
  })

  it('reads city pages from a sitemap and verified-stay counts from HTML', () => {
    const xml = '<urlset><url><loc>https://www.hotelhottubs.com/california/san-francisco</loc></url></urlset>'
    expect(parseSitemapUrls(xml)[0]?.pageType).toBe('city')
    expect(classifyHhtUrl('https://www.hotelhottubs.com/romantic')?.collection).toBe('romantic')
    expect(verifiedStayCountFromHtml('We list 42 verified stays in town')).toBe(42)
  })

  it('accepts guest posts from guidelines text and prefers the guidelines email', () => {
    const judged = judgeGuestPostPages([{ url: 'https://blog.example/write-for-us', text: 'Write for us. Guest post guidelines.', ok: true }])
    expect(judged.status).toBe('ACCEPTS')
    expect(judged.inconclusive).toBe(false)
    const contact = chooseContact('guest_post', [
      { name: null, role: null, email: 'hello@blog.example', formUrl: null, source: 'general' },
      { name: 'Ada', role: 'editor', email: 'ada@blog.example', formUrl: null, source: 'guidelines' },
    ])
    expect(contact?.email).toBe('ada@blog.example')
  })

  it('grounds structured guidelines and routes risky requirements to review', () => {
    const guidelines = groundStructuredGuestPostGuidelines(structuredGuidelinesFromAnswer({
      submission_method: 'google_form',
      submission_url: 'https://forms.google.com/example',
      pitch_topic_count: 3,
      pitch_content_stage: 'outline',
      required_subject_line_format: 'Guest pitch: [topic]',
      accepted_topics: ['travel'],
      excluded_topics: [],
      word_count: '1,200–1,500 words',
      link_policy: 'One relevant link',
      samples_required: true,
      bio_required: true,
      ai_content_policy: 'No AI-assisted copy',
      ai_content_prohibited: true,
      paid_or_sponsored: false,
      evidence: {
        submission_method: 'https://blog.example/write-for-us',
        pitch_format: 'https://blog.example/write-for-us',
        accepted_topics: 'https://blog.example/write-for-us',
        word_count: 'https://blog.example/write-for-us',
        link_policy: 'https://blog.example/write-for-us',
        samples_required: 'https://blog.example/write-for-us',
        bio_required: 'https://blog.example/write-for-us',
        ai_content_policy: 'https://blog.example/write-for-us',
      },
    }), ['https://blog.example/write-for-us'])
    expect(guidelines.submissionMethod).toBe('google_form')
    expect(guidelines.pitchTopicCount).toBe(3)
    expect(guestPostGuidelineReviewReasons(guidelines)).toEqual([
      'guest_post_samples_required',
      'guest_post_ai_content_prohibited',
    ])
  })

  it('renders the template slot and explores on the configured cadence', () => {
    const draft = renderTemplate('Subject: {{publisherName}}\n{{targetHhtUrl}}', {
      publisherName: 'Trail Notes',
      contactName: '',
      articleTitle: '',
      articleUrl: '',
      rankingKeyword: '',
      serpPosition: '',
      city: '',
      state: '',
      targetHhtUrl: 'https://www.hotelhottubs.com/california/san-francisco',
      secondaryHhtUrl: '',
      insertionSuggestion: '',
      guestPostRequirements: '',
      pitchTopics: '',
      fitLine: '',
      subjectLine: '',
      submissionMethod: '',
      submissionUrl: '',
      pitchTopicCount: '',
      pitchContentStage: '',
      requiredSubjectLineFormat: '',
      acceptedTopics: '',
      excludedTopics: '',
      wordCount: '',
      linkPolicy: '',
      samplesRequired: '',
      bioRequired: '',
      aiContentPolicy: '',
      paidOrSponsored: '',
      guidelineEvidence: '',
    })
    expect(draft.subject).toBe('Trail Notes')
    expect(draft.body).toContain('san-francisco')
    expect(geographicKeywords('Austin', 'Texas', ['hotels with hot tubs in {city}'])).toEqual(['hotels with hot tubs in Austin'])
    const picked = pickFrontierKeyword([
      { id: 1, priorityScore: 10, cluster: 'a', city: 'Austin', sourceType: 'seed', scanned: true },
      { id: 2, priorityScore: 1, cluster: 'b', city: 'Bend', sourceType: 'publisher_keyword', scanned: false },
    ], 0.2, 0)
    expect(picked?.id).toBe(2)
    expect(classifyGadsFailure('401 unauthorized')).toBe('auth')
  })

  it('refuses placeholder copy and overlong contact-form bodies', () => {
    const variables = {
      publisherName: '',
      contactName: '',
      articleTitle: '',
      articleUrl: '',
      rankingKeyword: '',
      serpPosition: '',
      city: '',
      state: '',
      targetHhtUrl: '',
      secondaryHhtUrl: '',
      insertionSuggestion: '',
      guestPostRequirements: '',
      pitchTopics: '',
      fitLine: '',
      subjectLine: '',
      submissionMethod: '',
      submissionUrl: '',
      pitchTopicCount: '',
      pitchContentStage: '',
      requiredSubjectLineFormat: '',
      acceptedTopics: '',
      excludedTopics: '',
      wordCount: '',
      linkPolicy: '',
      samplesRequired: '',
      bioRequired: '',
      aiContentPolicy: '',
      paidOrSponsored: '',
      guidelineEvidence: '',
    }
    expect(() => renderTemplate('[[PLACEHOLDER COPY]]', variables)).toThrow(/placeholder/i)
    expect(() => renderTemplate('x'.repeat(1_001), variables, { maxBodyLength: 1_000 })).toThrow(/1000/)
  })

  it('parses offset SERP rows and domain keyword exports separately', () => {
    const serp = parseOrganicSerp('Domain;Url;Position\nexample.com;https://example.com/tubs;21', 20)
    expect(serp).toEqual([{ position: 21, domain: 'example.com', url: 'https://example.com/tubs' }])
    expect(parseRankedKeywords('Keyword;Position;Url\nhotels with hot tubs in austin;4;https://blog.example/austin')).toEqual(['hotels with hot tubs in austin'])
  })
})

describe('serp page quality', () => {
  const rules = {
    ...DEFAULT_SITE_RULES,
    otas: [...DEFAULT_SITE_RULES.otas, 'travelocity.com'],
    competitors: ['tubstays.com'],
  }

  it('keeps obvious articles and sends a root-level post slug to the page fetch', () => {
    const story = triageSerpUrl({
      url: 'https://www.cntraveler.com/story/best-hotels-with-hot-tubs',
      rootDomain: 'cntraveler.com',
      rules,
    })
    expect(story.quality).toBe('article')
    expect(serpLeadDecision({ position: 5, quality: story.quality, affiliate: false, siteType: story.siteType, stage: 'url' }).lane).toBe('both')
    expect(serpLeadDecision({ position: 40, quality: 'article', affiliate: false, siteType: 'editorial_blog', stage: 'url' }).lane).toBe('guest_post')
    expect(triageSerpUrl({
      url: 'https://imfixintoblog.com/romantic-inns-western-nc/',
      rootDomain: 'imfixintoblog.com',
      rules,
    }).quality).toBe('unsure')
  })

  it('drops commercial urls, tags tourism, and lets an affiliate listicle be an insertion below position 10', () => {
    expect(triageSerpUrl({
      url: 'https://www.travelocity.com/hotels-with-hot-tubs',
      rootDomain: 'travelocity.com',
      rules,
    }).quality).toBe('commercial')
    expect(triageSerpUrl({
      url: 'https://www.theburgundyhotel.com/',
      rootDomain: 'theburgundyhotel.com',
      rules,
    }).quality).toBe('commercial')
    expect(triageSerpUrl({
      url: 'https://www.visitnc.com/romantic',
      rootDomain: 'visitnc.com',
      rules,
    }).quality).toBe('tourism')
    expect(serpLeadDecision({
      position: 40,
      quality: 'article',
      affiliate: true,
      siteType: 'editorial_blog',
      stage: 'page',
    }).lane).toBe('both')
    expect(serpLeadDecision({
      position: 4,
      quality: 'tourism',
      affiliate: false,
      siteType: null,
      stage: 'url',
    }).lane).toBe('tourism')
  })

  it('lets JSON-LD settle the page and treats affiliate links as an article boost', () => {
    const empty = {
      schemaTypes: [],
      ogType: null,
      publishedTime: null,
      hasAuthor: false,
      wordCount: 0,
      outboundLinks: 0,
      outboundHotelOrOta: 0,
      hasBookingWidget: false,
      hasAffiliate: false,
      hasWriteForUs: false,
    }
    expect(scorePageSignals({ ...empty, schemaTypes: ['BlogPosting'] }).quality).toBe('article')
    expect(scorePageSignals({ ...empty, schemaTypes: ['Hotel'] }).quality).toBe('commercial')
    expect(scorePageSignals(empty).quality).toBe('unsure')
    const listicle = scorePageSignals({ ...empty, schemaTypes: ['BlogPosting'], hasAffiliate: true, outboundHotelOrOta: 4, outboundLinks: 12 })
    expect(listicle.quality).toBe('article')
    expect(listicle.affiliate).toBe(true)
  })
})
