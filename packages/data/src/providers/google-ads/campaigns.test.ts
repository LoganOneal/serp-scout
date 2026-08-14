import { describe, expect, it } from 'vitest'
import {
  buildCampaignOperations,
  toBillableMicros,
  validateCampaignPlan,
  type CampaignPlan,
} from './campaigns.js'
import { assertMutationsAllowed, googleAdsMutationsEnabled } from './client.js'

const AD = {
  headlines: ['Hotels With Hot Tubs', 'In-Room Jacuzzi Suites', 'Compare Hot Tub Hotels'],
  descriptions: [
    'Find hotels with a private hot tub in the room.',
    'Handpicked jacuzzi suites with photos and prices.',
  ],
  finalUrl: 'https://hotelhottubs.com/',
}

const PLAN: CampaignPlan = {
  name: 'hotelhottubs search',
  dailyBudgetMicros: 50_000_000n,
  locationCode: 2840,
  languageCode: 'en',
  adGroups: [
    {
      name: 'in-room',
      defaultMaxCpcMicros: 1_000_000n,
      keywords: [{ text: 'hotels with hot tubs in room las vegas', matchType: 'EXACT' }],
      ads: [AD],
    },
  ],
}

/**
 * ==================== THESE TESTS GUARD SPENDING, NOT BEHAVIOUR ====================
 * Every other test in this repo protects a number. These protect the property
 * that running the code does not create a Google Ads campaign. A regression here
 * is not a wrong figure on a screen, it is an unattended daily budget.
 */
describe('the launch gates', () => {
  const open = { LIVE_CALLS_ENABLED: 'true', GOOGLE_ADS_MUTATIONS_ENABLED: 'true' }

  it('is a SEPARATE gate from LIVE_CALLS_ENABLED', () => {
    expect(googleAdsMutationsEnabled({ LIVE_CALLS_ENABLED: 'true' })).toBe(false)
  })

  it('refuses when only the repo-wide spend gate is open', () => {
    expect(() =>
      assertMutationsAllowed({ confirm: true, env: { LIVE_CALLS_ENABLED: 'true' }, what: 'x' }),
    ).toThrow(/GOOGLE_ADS_MUTATIONS_ENABLED/)
  })

  it('refuses when only the ads gate is open', () => {
    expect(() =>
      assertMutationsAllowed({
        confirm: true,
        env: { GOOGLE_ADS_MUTATIONS_ENABLED: 'true' },
        what: 'x',
      }),
    ).toThrow(/LIVE_CALLS_ENABLED/)
  })

  it('refuses when both gates are open but confirm was not passed', () => {
    expect(() => assertMutationsAllowed({ confirm: false, env: open, what: 'x' })).toThrow(
      /--confirm was not passed/,
    )
  })

  it('requires the EXACT string "true" — a misconfigured var fails toward $0', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'true ']) {
      expect(googleAdsMutationsEnabled({ GOOGLE_ADS_MUTATIONS_ENABLED: v })).toBe(false)
    }
  })

  it('allows only when all three conditions are deliberate', () => {
    expect(() => assertMutationsAllowed({ confirm: true, env: open, what: 'x' })).not.toThrow()
  })
})

describe('campaigns are created paused and capped', () => {
  const ops = buildCampaignOperations(PLAN, '1234567890') as Array<Record<string, any>>

  it('creates the campaign PAUSED, with no way to ask for ENABLED', () => {
    const campaign = ops.find((o) => o['campaignOperation'])!['campaignOperation'].create
    expect(campaign.status).toBe('PAUSED')
  })

  it('creates ad groups and ads PAUSED too', () => {
    expect(ops.find((o) => o['adGroupOperation'])!['adGroupOperation'].create.status).toBe('PAUSED')
    expect(ops.find((o) => o['adGroupAdOperation'])!['adGroupAdOperation'].create.status).toBe(
      'PAUSED',
    )
  })

  it('always attaches a budget', () => {
    const budget = ops.find((o) => o['campaignBudgetOperation'])!['campaignBudgetOperation'].create
    expect(budget.amountMicros).toBe('50000000')
  })

  it('targets Google search only — not display, not partners', () => {
    const campaign = ops.find((o) => o['campaignOperation'])!['campaignOperation'].create
    expect(campaign.networkSettings).toEqual({
      targetGoogleSearch: true,
      targetSearchNetwork: false,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    })
  })
})

/**
 * Both of these were found by the first VALIDATE-ONLY run against Google, for
 * $0 and before anything existed. Pinned so the fixes cannot be undone by a
 * refactor that never talks to Google again.
 */
describe('what validate-only caught', () => {
  it('rounds every money field DOWN to a whole cent', () => {
    // 80% of a $25.11 top-of-page high is $20.088 — a multiple of 1,000 micros
    // and NOT of 10,000. Google rejected the whole mutation for it.
    expect(toBillableMicros(20_088_000n)).toBe(20_080_000n)
    expect(toBillableMicros(50_000_000n)).toBe(50_000_000n)
    expect(toBillableMicros(9_999n)).toBe(0n)
    expect(toBillableMicros(-5n)).toBe(0n)
  })

  it('rounds DOWN, never up — a rounded-up bid outspends its own break-even', () => {
    expect(toBillableMicros(19_999n)).toBeLessThan(19_999n)
  })

  it('emits every bid already rounded', () => {
    const ops = buildCampaignOperations(
      {
        ...PLAN,
        adGroups: [
          {
            ...PLAN.adGroups[0]!,
            defaultMaxCpcMicros: 20_088_000n,
            keywords: [{ text: 'k', matchType: 'EXACT', maxCpcMicros: 20_088_000n }],
          },
        ],
      },
      '1',
    ) as Array<Record<string, any>>

    const group = ops.find((o) => o['adGroupOperation'])!['adGroupOperation'].create
    const kw = ops.find((o) => o['adGroupCriterionOperation'])!['adGroupCriterionOperation'].create
    expect(group.cpcBidMicros).toBe('20080000')
    expect(kw.cpcBidMicros).toBe('20080000')
  })

  it('declares EU political advertising — required on create, and undocumented in the examples', () => {
    const ops = buildCampaignOperations(PLAN, '1') as Array<Record<string, any>>
    const campaign = ops.find((o) => o['campaignOperation'])!['campaignOperation'].create
    expect(campaign.containsEuPoliticalAdvertising).toBe(
      'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    )
  })
})

describe('validateCampaignPlan', () => {
  it('accepts a well-formed plan', () => {
    expect(validateCampaignPlan(PLAN)).toEqual([])
  })

  it('refuses a campaign with no budget cap', () => {
    const errors = validateCampaignPlan({ ...PLAN, dailyBudgetMicros: 0n })
    expect(errors.join(' ')).toMatch(/without a cap is not plannable/)
  })

  /**
   * The break-even figure for a keyword is computed against ITS organic rank,
   * which sets its incrementality band. Broad match spends that budget on
   * queries whose rank was never measured, so the coefficient the whole model
   * is keyed on no longer describes what is being bought.
   */
  it('refuses BROAD match, because it voids the incrementality coefficient', () => {
    const errors = validateCampaignPlan({
      ...PLAN,
      adGroups: [
        {
          ...PLAN.adGroups[0]!,
          keywords: [{ text: 'hot tub hotels', matchType: 'BROAD' }],
        },
      ],
    })
    expect(errors.join(' ')).toMatch(/voids the incrementality coefficient/)
  })

  it('catches Google’s RSA limits locally, so a 400 is not the first news', () => {
    const errors = validateCampaignPlan({
      ...PLAN,
      adGroups: [
        {
          ...PLAN.adGroups[0]!,
          ads: [{ ...AD, headlines: ['only one'] }],
        },
      ],
    })
    expect(errors.join(' ')).toMatch(/need 3-15/)
  })

  it('catches an over-long headline', () => {
    const errors = validateCampaignPlan({
      ...PLAN,
      adGroups: [
        {
          ...PLAN.adGroups[0]!,
          ads: [{ ...AD, headlines: [...AD.headlines, 'x'.repeat(31)] }],
        },
      ],
    })
    expect(errors.join(' ')).toMatch(/over 30 chars/)
  })

  it('refuses an ad group with no ads', () => {
    const errors = validateCampaignPlan({
      ...PLAN,
      adGroups: [{ ...PLAN.adGroups[0]!, ads: [] }],
    })
    expect(errors.join(' ')).toMatch(/has no ads/)
  })
})
