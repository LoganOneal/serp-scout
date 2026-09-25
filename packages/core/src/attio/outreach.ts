import type { AttioSourceTarget, AttioWorkstream } from './types.js'

/**
 * Future outbound architecture. Nothing here sends mail.
 * ATTIO_SEND_ENABLED must be the exact string "true" before a send provider
 * may deliver. GitHub Actions never set that flag.
 */

export interface EnrichmentContext {
  workstream: AttioWorkstream
  target: AttioSourceTarget
  facts: Record<string, string>
}

export interface TargetEnricher {
  enrich(target: AttioSourceTarget): Promise<EnrichmentContext>
}

export interface ContactDiscovery {
  discover(target: AttioSourceTarget): Promise<AttioSourceTarget['contact']>
}

export interface PitchGenerator {
  generate(context: EnrichmentContext): Promise<{ title: string; body: string }>
}

export interface MessageDraft {
  to: string
  subject: string
  body: string
  workstream: AttioWorkstream
  sourceKey: string
}

export interface MessageDrafter {
  draft(context: EnrichmentContext, contactEmail: string): Promise<MessageDraft>
}

export interface ReplySignal {
  sourceKey: string
  inbound: boolean
  sentAt: string
  participant?: string | null
}

export interface ReplyDetector {
  findInboundReply(args: {
    companyRecordId?: string | null
    personRecordId?: string | null
    afterDate: string
  }): Promise<ReplySignal | null>
}

export interface SendProvider {
  readonly enabled: boolean
  send(draft: MessageDraft): Promise<{ id: string }>
}

export interface FollowupScheduler {
  schedule(args: { sourceKey: string; outreachDate: string; n: number }): Promise<{ dueOn: string }>
}

export class DisabledSendProvider implements SendProvider {
  readonly enabled = false
  async send(): Promise<{ id: string }> {
    throw new Error('Outbound sending is disabled. Set ATTIO_SEND_ENABLED=true only after CRM state is verified.')
  }
}

export class UnsupportedReplyDetector implements ReplyDetector {
  readonly reason: string
  constructor(reason: string) {
    this.reason = reason
  }
  async findInboundReply(): Promise<ReplySignal | null> {
    return null
  }
}

export function sendEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ATTIO_SEND_ENABLED === 'true'
}
