/**
 * LLM hypotheses only. Validated JSON. Never writes volume/CPC/KD/traffic.
 */
import Anthropic from '@anthropic-ai/sdk'
import { anthropicConfigured } from '../links/contacts.js'

export interface MarketNarrative {
  name: string
  thesis: string
  customer: string
  businessIdea: string
  risks: string
  expansion: string
  discoveryPath: string
}

const SCHEMA_HINT = `Return ONLY JSON with keys:
name, thesis, customer, businessIdea, risks, expansion, discoveryPath.
No markdown. Thesis is 2-4 sentences. Distinguish evidence you were given
from guesses. Do not invent search volume, CPC, KD, traffic, or prices.`

export async function narrateMarket(args: {
  keywords: string[]
  nameHint: string
  volume: number | null
  cpc: number | null
  kd: number | null
  advertisers: number
  price: number | null
  buyer: string
  discoveryPath?: string | null
}): Promise<MarketNarrative | null> {
  if (!anthropicConfigured()) return null
  const client = new Anthropic()
  const prompt = `${SCHEMA_HINT}

Evidence (do not contradict):
name hint: ${args.nameHint}
keywords: ${args.keywords.slice(0, 20).join(', ')}
adjusted volume: ${args.volume ?? 'unknown'}
weighted CPC: ${args.cpc ?? 'unknown'}
median KD: ${args.kd ?? 'unknown'}
unique advertisers: ${args.advertisers}
observed median price: ${args.price ?? 'none observed'}
buyer type: ${args.buyer}
known discovery path: ${args.discoveryPath ?? 'unknown'}
`
  const res = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = res.content[0] && res.content[0].type === 'text' ? res.content[0].text : ''
  return parseNarrative(text)
}

function parseNarrative(text: string): MarketNarrative | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<MarketNarrative>
    if (!raw.thesis || !raw.businessIdea) return null
    return {
      name: String(raw.name ?? ''),
      thesis: String(raw.thesis),
      customer: String(raw.customer ?? ''),
      businessIdea: String(raw.businessIdea),
      risks: String(raw.risks ?? ''),
      expansion: String(raw.expansion ?? ''),
      discoveryPath: String(raw.discoveryPath ?? ''),
    }
  } catch {
    return null
  }
}
