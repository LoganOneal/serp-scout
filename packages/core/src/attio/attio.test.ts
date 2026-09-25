import { describe, expect, it } from 'vitest'
import {
  backlinkSourceKey,
  buildBacklinkTargets,
  buildEditorsChoiceTargets,
  buildGuestPostTargets,
  contactDatesFromOutbound,
  canonicalCompanyDomain,
  extractExplicitEmail,
  classifyFirstTouch,
  extractHhtListingSlugs,
  extractHotelFromBody,
  extractHotelFromSubject,
  followupDueDate,
  greetingName,
  nextFollowupAfterSend,
  planDailyEmailQueue,
  renderEmailTemplate,
  sequenceFromFirstTouch,
  followupMarker,
  followupTaskContent,
  isDueOnOrBefore,
  isNonOfficialHotelHost,
  matchGmailToLeads,
  mergeEntryValues,
  nextFollowupNumber,
  nextStatus,
  normalizeEmail,
  officialCompanyDomain,
  outreachCrmValues,
  parseCsv,
  parseFollowupMarker,
  sourceRef,
  statusFromOutreach,
} from './index.js'

describe('company domain canonicalization', () => {
  it('lowercases, strips protocol, www, path and trailing slash, keeps meaningful subdomains', () => {
    expect(canonicalCompanyDomain('HTTPS://WWW.Flagstaff.LittleAmerica.com/media/')?.domain).toBe(
      'flagstaff.littleamerica.com',
    )
    expect(canonicalCompanyDomain('gatlinburgtownsquare.com')?.domain).toBe('gatlinburgtownsquare.com')
    expect(canonicalCompanyDomain('https://amateurtraveler.com/guest-post-guidelines')?.domain).toBe(
      'amateurtraveler.com',
    )
  })

  it('does not fabricate domains from junk', () => {
    expect(canonicalCompanyDomain('')).toBeNull()
    expect(canonicalCompanyDomain('not a domain')).toBeNull()
    expect(canonicalCompanyDomain('http://localhost/x')).toBeNull()
  })

  it('rejects OTA and scrape-source hosts as official hotel sites', () => {
    expect(isNonOfficialHotelHost('https://www.kayak.com/hotels/x')).toBe(true)
    expect(isNonOfficialHotelHost('https://www.tubstays.com/missouri/branson')).toBe(true)
    expect(officialCompanyDomain('https://gatlinburgtownsquare.com/press')?.domain).toBe('gatlinburgtownsquare.com')
    expect(officialCompanyDomain('https://www.kayak.com/hotels/x')).toBeNull()
  })
})

describe('source keys', () => {
  it('are stable for the same hotel, article, and guest-post opportunity', () => {
    expect(backlinkSourceKey('HTTPS://WWW.Example.com/Best-Hotels/?utm_source=x')).toBe(
      'backlink:https://example.com/Best-Hotels',
    )
    const first = buildBacklinkTargets([
      {
        id: 1,
        url: 'https://www.example.com/austin-hotels/',
        rootDomain: 'example.com',
        isProspectable: true,
        suggestedHhtUrl: 'https://hotelhottubs.com/texas/austin',
      },
      {
        id: 2,
        url: 'https://example.com/austin-hotels',
        rootDomain: 'example.com',
        isProspectable: true,
      },
    ])
    expect(first.targets).toHaveLength(1)
    expect(first.targets[0]?.sourceKey).toBe('backlink:https://example.com/austin-hotels')
    expect(first.targets[0]?.sourceOwned.target_article_url).toBe('https://example.com/austin-hotels')
    expect(first.targets[0]?.sourceOwned.serp_keyword).toBeNull()
  })

  it('maps landing-page SERP, authority, and outbound counts onto list fields', () => {
    const { targets } = buildBacklinkTargets([
      {
        id: 9,
        url: 'https://www.travelandleisure.com/best-hot-tub-hotels',
        title: 'Best Hot Tub Hotels',
        rootDomain: 'travelandleisure.com',
        isProspectable: true,
        suggestedHhtUrl: 'https://hotelhottubs.com/guides/hot-tub-hotels',
        whyLink: 'Missing destination roundup citation',
        serpKeyword: 'hot tub hotels',
        serpPosition: 4,
        keywordVolume: 5400,
        authorityScore: 91,
        referringDomains: 18200,
        outboundLinks: 37,
      },
    ])
    expect(targets[0]?.sourceOwned).toMatchObject({
      target_article_url: 'https://travelandleisure.com/best-hot-tub-hotels',
      article_title: 'Best Hot Tub Hotels',
      serp_keyword: 'hot tub hotels',
      serp_position: 4,
      keyword_volume: 5400,
      authority_score: 91,
      referring_domains: 18200,
      outbound_links: 37,
    })
  })

  it('never includes absolute filesystem paths in source refs', () => {
    expect(sourceRef('serp-scout', '/Users/kaisulkin/serp-scout/packages/data/src/attio/x.ts')).toBe(
      'serp-scout:packages/data/src/attio/x.ts',
    )
  })
})

describe('status and merge', () => {
  it('never regresses Contacted to New', () => {
    expect(nextStatus('Contacted', 'New')).toBe('Contacted')
    expect(nextStatus('Replied', 'Researching')).toBe('Replied')
    expect(nextStatus(null, 'New')).toBe('New')
  })

  it('does not let a blank source field erase a populated Attio field', () => {
    const merged = mergeEntryValues({
      existing: {
        status: 'Contacted',
        target_article_url: 'https://example.com/old',
        outcome_notes: 'Spoke with editor',
        hht_page_to_link: 'https://hotelhottubs.com/vermont',
      },
      sourceOwned: {
        target_article_url: 'https://example.com/new',
        hht_page_to_link: null,
      },
      crmOwned: {
        outcome_notes: '',
      },
      isCreate: false,
    })
    expect(merged.values.status).toBe('Contacted')
    expect(merged.values.target_article_url).toBe('https://example.com/new')
    expect(merged.values.hht_page_to_link).toBe('https://hotelhottubs.com/vermont')
    expect(merged.values.outcome_notes).toBe('Spoke with editor')
  })

  it('sets Status=New only when creating an entry', () => {
    const created = mergeEntryValues({
      existing: null,
      sourceOwned: { target_article_url: 'https://example.com/a' },
      isCreate: true,
    })
    expect(created.values.status).toBe('New')
  })
})

describe('multiple backlink opportunities per company', () => {
  it('keeps separate list identities for two articles on the same domain', () => {
    const { targets } = buildBacklinkTargets([
      {
        id: 10,
        url: 'https://travelblog.com/austin-romantic-hotels',
        rootDomain: 'travelblog.com',
        isProspectable: true,
      },
      {
        id: 11,
        url: 'https://travelblog.com/best-spa-hotels',
        rootDomain: 'travelblog.com',
        isProspectable: true,
      },
    ])
    expect(targets).toHaveLength(2)
    expect(new Set(targets.map((t) => t.domain))).toEqual(new Set(['travelblog.com']))
    expect(new Set(targets.map((t) => t.sourceKey)).size).toBe(2)
  })

  it('drops non-prospectable SERP leftovers', () => {
    const { targets, skipped } = buildBacklinkTargets([
      { id: 1, url: 'https://booking.com/austin', rootDomain: 'booking.com', isProspectable: false },
      { id: 2, url: 'https://blog.example.com/hot-tubs', rootDomain: 'example.com', isProspectable: true },
    ])
    expect(targets).toHaveLength(1)
    expect(skipped.some((row) => row.reason === 'not_prospectable')).toBe(true)
  })
})

describe("editor's choice adapter", () => {
  it('uses press-contact websites, not Kayak or TubStays scrape URLs', () => {
    const { targets, skipped } = buildEditorsChoiceTargets({
      membership: { slugs: ['hillbrook-inn', 'missing-hotel'] },
      properties: [
        {
          slug: 'hillbrook-inn',
          name: 'Hillbrook Inn',
          href: '/west-virginia/hillbrook-inn',
          sourceUrl: 'https://www.tubhotels.com/virginia-hotels-with-jacuzzi-in-room/',
          bookingUrl: 'https://www.kayak.com/hotels/x',
        },
      ],
      pressContacts: [
        {
          hotel_name: 'Hillbrook Inn',
          hotel_website: 'https://hillbrookinn.com/',
          press_contact_page: 'https://hillbrookinn.com/press.html',
        },
      ],
    })
    expect(skipped).toEqual([{ id: 'missing-hotel', reason: 'slug_not_in_inventory' }])
    expect(targets).toHaveLength(1)
    expect(targets[0]?.domain).toBe('hillbrookinn.com')
    expect(targets[0]?.sourceOwned.hotel_website).toBe('https://hillbrookinn.com')
    expect(targets[0]?.sourceOwned.hht_listing_url).toBe('https://hotelhottubs.com/west-virginia/hillbrook-inn')
    expect(targets[0]?.sourceOwned.press_media_page).toBe('https://hillbrookinn.com/press.html')
    expect(targets[0]?.contact).toBeNull()
  })

  it('attaches scraped press-page emails as Primary Contact', () => {
    const { targets } = buildEditorsChoiceTargets({
      membership: { slugs: ['made-hotel'] },
      properties: [{ slug: 'made-hotel', name: 'MADE Hotel', href: '/new-york/made-hotel' }],
      pressContacts: [
        { hotel_name: 'MADE Hotel', hotel_website: 'https://madehotels.com/', press_contact_page: 'https://madehotels.com/press' },
      ],
      pressProspects: [
        { hotel: 'MADE Hotel', domain: 'madehotels.com', pr_name: 'MADE PR', pr_email: 'pr@madehotels.com' },
      ],
    })
    expect(targets[0]?.contact).toEqual({ email: 'pr@madehotels.com', name: 'MADE PR', jobTitle: null })
  })
})

describe('guest posts', () => {
  it('prefers opportunity ids and extracts only explicit emails', () => {
    const { targets } = buildGuestPostTargets({
      opportunities: [
        {
          id: 44,
          rootDomain: 'amateurtraveler.com',
          displayName: 'Amateur Traveler',
          opportunityType: 'editorial_guest',
          eligibility: 'REVIEW',
          opportunityUrl: 'https://amateurtraveler.com/guest-post-guidelines',
          pitchAngle: 'Destination hot-tub hotels',
          contactEmail: 'chris2x@gmail.com',
          contactName: 'Chris',
          contactRole: 'Editor',
          authorityScore: 44,
          outboundLinks: 12,
          serpKeyword: 'guest post travel',
          serpPosition: 8,
          keywordVolume: 320,
        },
        {
          id: 45,
          rootDomain: 'spam.example',
          opportunityType: 'forum_ugc',
          eligibility: 'PASS',
          opportunityUrl: 'https://spam.example/forum',
        },
      ],
      csvRows: [
        {
          website_url: 'https://destinationlesstravel.com',
          submission_page: 'https://destinationlesstravel.com/write-for-us',
          conditions: 'We are NOT currently accepting guest posts.',
        },
      ],
    })
    expect(targets.map((t) => t.sourceKey)).toEqual(['guest-post:opp-44'])
    expect(targets[0]?.contact?.email).toBe('chris2x@gmail.com')
    expect(targets[0]?.sourceOwned).toMatchObject({
      target_page_url: 'https://amateurtraveler.com/guest-post-guidelines',
      authority_score: 44,
      outbound_links: 12,
      serp_keyword: 'guest post travel',
      serp_position: 8,
      keyword_volume: 320,
    })
  })

  it('parses obfuscated emails from guideline text', () => {
    expect(extractExplicitEmail('email chris2x [at] gmail.com for pitches')).toBe('chris2x@gmail.com')
    expect(normalizeEmail('Name [at] Site.com')).toBe('name@site.com')
  })
})

describe('follow-up markers', () => {
  it('are deterministic and skip a second duplicate', () => {
    expect(followupMarker('backlink:https://example.com/a', 1)).toBe('[hht-followup:backlink:https://example.com/a:1]')
    expect(nextFollowupNumber([1])).toBe(2)
    expect(nextFollowupNumber([1, 2])).toBe(0)
    expect(isDueOnOrBefore('2026-09-10', '2026-09-11')).toBe(true)
    expect(isDueOnOrBefore('2026-09-12', '2026-09-11')).toBe(false)
    expect(followupTaskContent({
      sourceKey: 'editor-choice:hillbrook-inn',
      n: 1,
      workstream: 'editors-choice',
      companyName: 'Hillbrook Inn',
      outreachDate: '2026-09-01',
    })).toContain('[hht-followup:editor-choice:hillbrook-inn:1]')
    expect(parseFollowupMarker('[hht-followup:backlink:https://example.com/a:1]')).toEqual({
      sourceKey: 'backlink:https://example.com/a',
      n: 1,
    })
    expect(followupDueDate({
      outreachDate: '2026-09-01',
      nextFollowup: null,
      existingNumbers: [],
      cadence: { firstDays: 6, secondDays: 7 },
    })).toBe('2026-09-07')
  })
})

describe('csv parser', () => {
  it('keeps quoted commas', () => {
    const rows = parseCsv('website_url,conditions\n"https://a.com","one, two"\n')
    expect(rows[0]).toEqual({ website_url: 'https://a.com', conditions: 'one, two' })
  })
})

describe('gmail contact touches', () => {
  it('maps unique outbound dates onto 1st-4th contact columns', () => {
    expect(contactDatesFromOutbound(['2026-09-10', '2026-09-09', '2026-09-09'])).toEqual({
      contact_1_date: '2026-09-09',
      contact_2_date: '2026-09-10',
      contact_3_date: null,
      contact_4_date: null,
    })
  })

  it('advances New to Contacted or Replied and never overwrites Won', () => {
    expect(statusFromOutreach('New', { contacted: true, replied: false })).toBe('Contacted')
    expect(statusFromOutreach('Contacted', { contacted: true, replied: true })).toBe('Replied')
    expect(statusFromOutreach('Won / Published', { contacted: true, replied: true })).toBe('Won / Published')
    expect(statusFromOutreach('Rejected', { contacted: true, replied: false })).toBe('Rejected')
    expect(statusFromOutreach('New', { contacted: false, replied: false, contactFound: true })).toBe('Contact Found')
    expect(statusFromOutreach('Contacted', { contacted: false, replied: false, contactFound: true })).toBe('Contacted')
  })

  it('matches by person email first, then unique company domain, and skips gmail.com domains', () => {
    const rows = [
      { email: 'pr@madehotels.com', outbound: ['2026-09-08'], inbound: null },
      { email: 'floridarambler@gmail.com', outbound: ['2026-09-11'], inbound: null },
      { email: 'a@vestahospitality.com', outbound: ['2026-09-09'], inbound: null },
    ]
    const { matches, unmatched } = matchGmailToLeads({
      rows,
      leads: [
        {
          entryId: 'e1',
          sourceKey: 'editor-choice:made',
          workstream: 'editors-choice',
          personEmails: ['pr@madehotels.com'],
          companyDomains: ['madehotels.com'],
        },
        {
          entryId: 'e2',
          sourceKey: 'editor-choice:florida',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['floridarambler.com'],
        },
        {
          entryId: 'e3',
          sourceKey: 'editor-choice:vesta-a',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['vestahospitality.com'],
        },
        {
          entryId: 'e4',
          sourceKey: 'editor-choice:vesta-b',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['vestahospitality.com'],
        },
      ],
    })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.lead.sourceKey).toBe('editor-choice:made')
    expect(matches[0]?.via).toBe('email')
    expect(unmatched.map((row) => row.email).sort()).toEqual(['a@vestahospitality.com', 'floridarambler@gmail.com'])
  })

  it('domain-matches when exactly one lead owns that company domain', () => {
    const { matches } = matchGmailToLeads({
      rows: [{ email: 'pr@madehotels.com', outbound: ['2026-09-08'], inbound: null }],
      leads: [
        {
          entryId: 'e1',
          sourceKey: 'editor-choice:made',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['madehotels.com'],
        },
      ],
    })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.via).toBe('domain')
    expect(matches[0]?.row.outbound).toEqual(['2026-09-08'])
  })

  it('matches PR-agency local parts and subject hotel names, including Gold Strike replies from a different CNENT inbox', () => {
    expect(extractHotelFromSubject("RE: Can you help us update Gold Strike Casino Resort's feature?")).toBe(
      'Gold Strike Casino Resort',
    )
    const { matches } = matchGmailToLeads({
      rows: [
        {
          email: 'travis.noland@cnent.com',
          outbound: ['2026-09-10'],
          inbound: null,
          hotelHints: ['Gold Strike Casino Resort'],
        },
        {
          email: 'darcy.stephens@cnent.com',
          outbound: [],
          inbound: '2026-09-11',
          hotelHints: ['Gold Strike Casino Resort'],
        },
        {
          email: 'hotelglorieta@m18pr.com',
          outbound: ['2026-09-10'],
          inbound: '2026-09-14',
          hotelHints: ['Hotel Glorieta'],
        },
      ],
      leads: [
        {
          entryId: 'gold',
          sourceKey: 'editor-choice:gold-strike-casino-resort',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['goldstrike.com'],
          names: ['gold-strike-casino-resort'],
        },
        {
          entryId: 'other-cnent',
          sourceKey: 'editor-choice:hard-rock-hotel-and-casino-tulsa',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['hardrockcasinotulsa.com'],
        },
        {
          entryId: 'glorieta',
          sourceKey: 'editor-choice:hotel-glorieta',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['hotelglorietasantafe.com'],
        },
      ],
    })
    const gold = matches.find((row) => row.lead.entryId === 'gold')
    const glorieta = matches.find((row) => row.lead.entryId === 'glorieta')
    expect(gold?.via).toBe('slug')
    expect(gold?.row.inbound).toBe('2026-09-11')
    expect(glorieta?.via).toBe('slug')
    expect(glorieta?.row.inbound).toBe('2026-09-14')
  })

  it('fills blank CRM touch dates from Gmail without overwriting an existing 1st Contact', () => {
    const first = outreachCrmValues({
      existing: { status: 'New' },
      row: { email: 'pr@madehotels.com', outbound: ['2026-09-08', '2026-09-15'], inbound: null },
      firstFollowupDays: 6,
    })
    expect(first.values).toMatchObject({
      contact_1_date: '2026-09-08',
      contact_2_date: '2026-09-15',
      outreach_date: '2026-09-08',
      next_follow_up: '2026-09-14',
      status: 'Contacted',
    })
    const second = outreachCrmValues({
      existing: { status: 'Contacted', contact_1_date: '2026-09-08', outreach_date: '2026-09-08' },
      row: { email: 'pr@madehotels.com', outbound: ['2026-09-01'], inbound: '2026-09-10' },
      firstFollowupDays: 6,
    })
    expect(second.values.contact_1_date).toBeUndefined()
    expect(second.values.replied_at).toBe('2026-09-10')
    expect(second.values.status).toBe('Replied')
  })

  it('classifies first-touch copy and matches hotels even when Gmail To: is not the scraped contact', () => {
    expect(classifyFirstTouch(
      "Hotel Hot Tubs Editor's Choice 2026\nWould you be open to including the recognition on Inn at Cape Kiwanda’s Press & Awards page? We’d be happy to send over our Editor’s Choice badge, logo files, and a short piece of suggested copy",
    )).toBe('asked_backlink')
    expect(classifyFirstTouch(
      "Can you help us update Hotel Glorieta's feature?\nWe selected Hotel Glorieta for our 2026 Editor's Choice. Could you confirm the casitas?",
    )).toBe('no_backlink')
    expect(classifyFirstTouch(
      "von Trapp Family Lodge & Resort - Hotel Hot Tubs Editor's Choice 2026\nI was wondering if you would be able to share some additional photos of the hot tubs",
    )).toBe('no_backlink')
    expect(sequenceFromFirstTouch('asked_backlink')).toBe('Asked backlink')
    expect(sequenceFromFirstTouch('no_backlink')).toBe('Fact-check')

    expect(extractHotelFromSubject("Can you help us update Coast Cabins’ feature?")).toBe('Coast Cabins')
    expect(extractHotelFromSubject('Hotel Hot Tubs / Inn at Cape Kiwanda')).toBe('Inn at Cape Kiwanda')
    expect(extractHotelFromSubject('von Trapp Family Lodge & Resort - Hotel Hot Tubs Editor\'s Choice 2026')).toBe(
      'von Trapp Family Lodge & Resort',
    )
    expect(extractHotelFromBody('We selected 1000 Islands Harbor Hotel for our Editor’s Choice 2026 collection')).toBe(
      '1000 Islands Harbor Hotel',
    )
    expect(extractHhtListingSlugs('https://hotelhottubs.com/new-york/harbor-hotel-1000-islands')).toEqual([
      'harbor-hotel-1000-islands',
    ])

    const { matches, unmatched } = matchGmailToLeads({
      rows: [
        {
          email: 'amangus@harthotels.com',
          outbound: ['2026-09-08'],
          inbound: null,
          hotelHints: ['1000 Islands Harbor Hotel'],
          hhtSlugs: ['harbor-hotel-1000-islands'],
          firstTouch: 'asked_backlink',
        },
        {
          email: 'rittenhouse@20twostudio.com',
          outbound: ['2026-09-08'],
          inbound: null,
          hotelHints: ['The Rittenhouse'],
          firstTouch: 'asked_backlink',
        },
        {
          email: 'info@rittenhousehotel.com',
          outbound: ['2026-09-08'],
          inbound: null,
          hotelHints: ['The Rittenhouse'],
          firstTouch: 'asked_backlink',
        },
      ],
      leads: [
        {
          entryId: 'harbor',
          sourceKey: 'editor-choice:harbor-hotel-1000-islands',
          workstream: 'editors-choice',
          personEmails: ['press@1000islandsharborhotel.com'],
          companyDomains: ['1000islandsharborhotel.com'],
          names: ['harbor-hotel-1000-islands'],
        },
        {
          entryId: 'rittenhouse',
          sourceKey: 'editor-choice:the-rittenhouse',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['rittenhousehotel.com'],
          names: ['the-rittenhouse'],
        },
      ],
    })
    expect(unmatched).toEqual([])
    const harbor = matches.find((row) => row.lead.entryId === 'harbor')
    const rittenhouse = matches.find((row) => row.lead.entryId === 'rittenhouse')
    expect(harbor?.via).toBe('slug')
    expect(harbor?.row.firstTouch).toBe('asked_backlink')
    expect(rittenhouse?.emails.sort()).toEqual(['info@rittenhousehotel.com', 'rittenhouse@20twostudio.com'])
    expect(rittenhouse?.row.firstTouch).toBe('asked_backlink')
  })

  it('prefers an exact hotel-name match so Wentworth Mansion does not collide with The Wentworth Inn', () => {
    const { matches, unmatched } = matchGmailToLeads({
      rows: [
        {
          email: 'sbodnar@charminginns.com',
          outbound: ['2026-09-10'],
          inbound: null,
          hotelHints: ['Wentworth Mansion'],
          firstTouch: 'no_backlink',
        },
      ],
      leads: [
        {
          entryId: 'mansion',
          sourceKey: 'editor-choice:wentworth-mansion',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['wentworthmansion.com'],
          names: ['wentworth-mansion'],
        },
        {
          entryId: 'inn',
          sourceKey: 'editor-choice:the-wentworth-inn',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['thewentworth.com'],
          names: ['the-wentworth-inn'],
        },
      ],
    })
    expect(unmatched).toEqual([])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.lead.entryId).toBe('mansion')
  })

  it('stamps a second hotel from the same sent thread when the body names both properties', () => {
    const { matches } = matchGmailToLeads({
      rows: [
        {
          email: 'sbodnar@charminginns.com',
          outbound: ['2026-09-10'],
          inbound: null,
          hotelHints: ['Wentworth Mansion', 'Fulton Lane Inn'],
          hhtSlugs: ['wentworth-mansion', 'fulton-lane-inn'],
          firstTouch: 'no_backlink',
        },
      ],
      leads: [
        {
          entryId: 'mansion',
          sourceKey: 'editor-choice:wentworth-mansion',
          workstream: 'editors-choice',
          personEmails: ['sbodnar@charminginns.com'],
          companyDomains: ['wentworthmansion.com'],
          names: ['wentworth-mansion'],
        },
        {
          entryId: 'fulton',
          sourceKey: 'editor-choice:fulton-lane-inn',
          workstream: 'editors-choice',
          personEmails: [],
          companyDomains: ['fultonlaneinn.com'],
          names: ['fulton-lane-inn'],
        },
      ],
    })
    expect(matches.map((row) => row.lead.entryId).sort()).toEqual(['fulton', 'mansion'])
  })

  it('stamps sequence from the first-touch classifier without overwriting an existing value', () => {
    const first = outreachCrmValues({
      existing: { status: 'New' },
      row: {
        email: 'amangus@harthotels.com',
        outbound: ['2026-09-08'],
        inbound: null,
        firstTouch: 'asked_backlink',
      },
      firstFollowupDays: 2,
    })
    expect(first.values.sequence).toBe('Asked backlink')
    expect(first.values.next_follow_up).toBe('2026-09-10')
    const kept = outreachCrmValues({
      existing: { status: 'Contacted', sequence: 'Asked backlink' },
      row: {
        email: 'amangus@harthotels.com',
        outbound: ['2026-09-08'],
        inbound: null,
        firstTouch: 'no_backlink',
      },
      firstFollowupDays: 2,
    })
    expect(kept.values.sequence).toBeUndefined()
  })
})

describe('editor choice email flow', () => {
  const step1 = {
    n: 1,
    subject: "{{hotel_name}} selected for Hotel Hot Tubs Editor's Choice 2026",
    body: 'Hi {{first_name}},\n\n{{property_blurb}}\n\n{{hht_listing_url}}',
    required: ['first_name', 'hotel_name', 'hht_listing_url', 'property_blurb'],
  }

  it('renders a personalized email 1 and refuses a missing or example blurb', () => {
    const ok = renderEmailTemplate({
      ...step1,
      vars: {
        first_name: 'Alexis',
        hotel_name: 'The Essex Resort & Spa',
        hht_listing_url: 'https://hotelhottubs.com/vermont/the-essex-resort-and-spa',
        property_blurb:
          'The Essex listing centers the spa-suite soaking tubs as part of the room, not a shared spa-floor add-on, which is the distinction we used when we selected it.',
      },
    })
    expect(ok.subject).toContain('The Essex Resort & Spa')
    expect(ok.body).toContain('Alexis')
    expect(ok.body).not.toMatch(/\{\{/)

    expect(() =>
      renderEmailTemplate({
        ...step1,
        vars: {
          first_name: 'Alexis',
          hotel_name: 'The Essex Resort & Spa',
          hht_listing_url: 'https://hotelhottubs.com/vermont/the-essex-resort-and-spa',
        },
      }),
    ).toThrow(/property_blurb/)

    expect(() =>
      renderEmailTemplate({
        ...step1,
        vars: {
          first_name: 'Alexis',
          hotel_name: 'The Essex Resort & Spa',
          hht_listing_url: 'https://hotelhottubs.com/vermont/the-essex-resort-and-spa',
          property_blurb:
            'We especially loved how the private soaking experience is integrated into the oceanfront rooms rather than treated as a separate amenity.',
        },
      }),
    ).toThrow(/spec example/)
  })

  it('uses the hotel team greeting when there is no first name', () => {
    expect(greetingName(null, 'Hotel Glorieta')).toBe('Hotel Glorieta team')
    expect(greetingName('Julia', 'Hotel Glorieta')).toBe('Julia')
  })

  it('does not double the article when the hotel name already starts with The', () => {
    const ok = renderEmailTemplate({
      n: 2,
      subject: 'Quick question about the {{hotel_name}} feature',
      body: 'Wanted to follow up on the {{hotel_name}} feature.\n{{hht_listing_url}}',
      required: ['first_name', 'hotel_name', 'hht_listing_url'],
      vars: {
        first_name: 'The Chanler at Cliff Walk team',
        hotel_name: 'The Chanler at Cliff Walk',
        hht_listing_url: 'https://hotelhottubs.com/rhode-island/the-chanler-at-cliff-walk',
      },
    })
    expect(ok.subject).toBe('Quick question about The Chanler at Cliff Walk feature')
    expect(ok.body).not.toMatch(/the The /)
  })

  it('renders a fact-check follow-up only when the listing detail is filled in', () => {
    const step = {
      n: 2,
      subject: "Re: {{hotel_name}} Editor's Choice 2026",
      body: 'Hi {{first_name}},\n\n{{fact_to_verify}}\n\n{{hht_listing_url}}',
      required: ['first_name', 'hotel_name', 'hht_listing_url', 'fact_to_verify'],
    }
    const ok = renderEmailTemplate({
      ...step,
      vars: {
        first_name: 'Hotel Glorieta team',
        hotel_name: 'Hotel Glorieta',
        hht_listing_url: 'https://hotelhottubs.com/new-mexico/hotel-glorieta',
        fact_to_verify: 'the casitas still include a private whirlpool on the patio',
      },
    })
    expect(ok.body).toContain('private whirlpool on the patio')
    expect(() =>
      renderEmailTemplate({
        ...step,
        vars: {
          first_name: 'Hotel Glorieta team',
          hotel_name: 'Hotel Glorieta',
          hht_listing_url: 'https://hotelhottubs.com/new-mexico/hotel-glorieta',
        },
      }),
    ).toThrow(/fact_to_verify/)
  })

  it('fills the daily cap with overdue follow-ups before any new first-touch, one step per thread', () => {
    expect(nextFollowupAfterSend('2026-09-22', 2)).toBe('2026-09-24')
    const plan = planDailyEmailQueue({
      today: '2026-09-22',
      maxEmailsPerDay: 3,
      waitDays: 2,
      leads: [
        { sourceKey: 'new-a', sequence: 'New contact' },
        { sourceKey: 'new-b', sequence: 'New contact' },
        { sourceKey: 'new-c', sequence: 'New contact' },
        {
          sourceKey: 'overdue-asked',
          sequence: 'Asked backlink',
          status: 'Contacted',
          contact_1_date: '2026-09-08',
        },
        {
          sourceKey: 'overdue-fact',
          sequence: 'Fact-check',
          status: 'Contacted',
          contact_1_date: '2026-09-10',
        },
        {
          sourceKey: 'not-due-yet',
          sequence: 'Asked backlink',
          status: 'Contacted',
          contact_1_date: '2026-09-21',
        },
        {
          sourceKey: 'replied',
          sequence: 'Fact-check',
          status: 'Replied',
          contact_1_date: '2026-09-09',
          repliedAt: '2026-09-10',
        },
        {
          sourceKey: 'mid-sequence',
          sequence: 'New contact',
          status: 'Contacted',
          contact_1_date: '2026-09-18',
          contact_2_date: '2026-09-20',
        },
      ],
    })
    expect(plan.followUps.map((row) => row.sourceKey)).toEqual([
      'overdue-asked',
      'overdue-fact',
      'mid-sequence',
    ])
    expect(plan.followUps[0]).toMatchObject({ n: 2, overdue: true, kind: 'follow_up' })
    expect(plan.followUps[2]).toMatchObject({ n: 3, overdue: false, kind: 'follow_up' })
    expect(plan.selected.map((row) => row.sourceKey)).toEqual([
      'overdue-asked',
      'overdue-fact',
      'mid-sequence',
    ])
    expect(plan.selected.every((row) => row.kind === 'follow_up')).toBe(true)
    expect(plan.deferredNew).toBe(3)
    expect(plan.newSequences).toHaveLength(3)

    const suppressed = planDailyEmailQueue({
      today: '2026-09-22',
      maxEmailsPerDay: 5,
      leads: [
        { sourceKey: 'excluded', sequence: 'New contact', suppressOutreach: true },
        { sourceKey: 'new-a', sequence: 'New contact' },
      ],
    })
    expect(suppressed.selected.map((row) => row.sourceKey)).toEqual(['new-a'])

    const withRoom = planDailyEmailQueue({
      today: '2026-09-22',
      maxEmailsPerDay: 5,
      waitDays: 2,
      leads: [
        { sourceKey: 'new-a', sequence: 'New contact' },
        {
          sourceKey: 'overdue-asked',
          sequence: 'Asked backlink',
          status: 'Contacted',
          contact_1_date: '2026-09-08',
        },
        {
          sourceKey: 'same-day-second-step',
          sequence: 'Asked backlink',
          status: 'Contacted',
          contact_1_date: '2026-09-08',
          contact_2_date: '2026-09-22',
        },
      ],
    })
    expect(withRoom.selected.map((row) => `${row.sourceKey}:${row.n}`)).toEqual([
      'overdue-asked:2',
      'new-a:1',
    ])
    expect(withRoom.selected.find((row) => row.sourceKey === 'same-day-second-step')).toBeUndefined()
  })
})
