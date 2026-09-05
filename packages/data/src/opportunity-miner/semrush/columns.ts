/**
 * Semrush Analytics API column codes ↔ internal field names.
 *
 * MCP execute_report uses friendly names (keyword, volume, cpc).
 * The HTTP API uses two-letter codes (Ph, Nq, Cp). The normalizer accepts both.
 *
 * Official codes: https://developer.semrush.com/api/
 */

export const FRIENDLY_TO_CODE: Record<string, string> = {
  keyword: 'Ph',
  volume: 'Nq',
  cpc: 'Cp',
  competitive_density: 'Co',
  results: 'Nr',
  trend: 'Td',
  intent: 'In',
  keyword_difficulty: 'Kd',
  relevance: 'Rr',
  triggered_serp_features: 'Fk',
  domain: 'Dn',
  url: 'Ur',
  position: 'Po',
  previous_position: 'Pp',
  position_difference: 'Pd',
  position_type: 'Pt',
  traffic: 'Tr',
  traffic_share: 'Tg',
  traffic_cost: 'Tc',
  traffic_cost_share: 'Tc',
  visible_url: 'Vu',
  ad_title: 'Tt',
  ad_text: 'Ds',
  date: 'Dt',
  paid_traffic: 'At',
  paid_traffic_cost: 'Ac',
  paid_keywords: 'Ad',
  organic_keywords: 'Or',
  organic_traffic: 'Ot',
  organic_traffic_cost: 'Oc',
  rank: 'Rk',
  competition_level: 'Cr',
  common_keywords: 'Np',
  authority_score: 'ascore',
  total: 'total',
  domains_num: 'domains_num',
}

export const CODE_TO_FRIENDLY: Record<string, string> = Object.fromEntries(
  Object.entries(FRIENDLY_TO_CODE).map(([k, v]) => [v, k]),
)

/** MCP report name → classic Analytics API `type=` value. */
export const MCP_TO_API_TYPE: Record<string, string> = {
  phrase_this: 'phrase_this',
  phrase_related: 'phrase_related',
  phrase_fullsearch: 'phrase_fullsearch',
  phrase_questions: 'phrase_questions',
  phrase_kdi: 'phrase_kdi',
  phrase_these: 'phrase_these',
  phrase_organic: 'phrase_organic',
  phrase_adwords: 'phrase_adwords',
  phrase_adwords_historical: 'phrase_adwords_historical',
  resource_organic: 'domain_organic',
  resource_adwords: 'domain_adwords',
  resource_adwords_unique: 'domain_adwords_unique',
  domain_rank: 'domain_rank',
  resource_rank_history: 'domain_rank_history',
  domain_organic_organic: 'domain_organic_organic',
  domain_adwords_adwords: 'domain_adwords_adwords',
  domain_adwords_historical: 'domain_adwords_historical',
  backlinks_overview: 'backlinks_overview',
}

export const MCP_SORT_TO_API: Record<string, string> = {
  volume_desc: 'nq_desc',
  volume_asc: 'nq_asc',
  cpc_desc: 'cp_desc',
  cpc_asc: 'cp_asc',
  competitive_density_desc: 'co_desc',
  competitive_density_asc: 'co_asc',
  keyword_difficulty_desc: 'kd_desc',
  keyword_difficulty_asc: 'kd_asc',
  relevance_desc: 'rr_desc',
  relevance_asc: 'rr_asc',
  position_desc: 'po_desc',
  position_asc: 'po_asc',
  traffic_desc: 'tr_desc',
  traffic_asc: 'tr_asc',
  common_keywords_desc: 'np_desc',
  common_keywords_asc: 'np_asc',
}

export const FILTER_OP_TO_API: Record<string, string> = {
  equals: 'Eq',
  greater_than: 'Gt',
  less_than: 'Lt',
  begins_with: 'Bw',
  ends_with: 'Ew',
  contains: 'Co',
  word_match: 'Wm',
}

export const KEYWORD_METRIC_COLUMNS = [
  'keyword',
  'volume',
  'cpc',
  'competitive_density',
  'results',
  'trend',
  'intent',
  'keyword_difficulty',
] as const

export const RELATED_COLUMNS = [...KEYWORD_METRIC_COLUMNS, 'relevance'] as const
