import type { ReplyDetector, ReplySignal } from '@rnr/core'
import { AttioClient, AttioError } from './client.js'

interface AttioEmail {
  direction?: 'inbound' | 'outbound'
  sent_at?: string
  subject?: string | null
  participants?: Array<{ email_address?: string; role?: string }>
}

/**
 * Attio GET /v2/emails returns metadata including `direction` and `sent_at`.
 * Content is never returned. The endpoint is alpha and must be enabled per
 * workspace; if Attio rejects the call we degrade to "unsupported" rather than
 * guessing at replies.
 */
export class AttioEmailReplyDetector implements ReplyDetector {
  readonly supportedNote =
    'Attio email metadata includes inbound/outbound direction. The endpoint is alpha and may be disabled for this token.'

  constructor(private readonly client: AttioClient) {}

  async findInboundReply(args: {
    companyRecordId?: string | null
    personRecordId?: string | null
    afterDate: string
  }): Promise<ReplySignal | null> {
    const ids = [args.personRecordId, args.companyRecordId].filter((id): id is string => Boolean(id))
    if (!ids.length) return null
    const after = Date.parse(`${args.afterDate}T00:00:00.000Z`)
    try {
      if (args.personRecordId) {
        const hit = await this.scan('people', [args.personRecordId], after)
        if (hit) return hit
      }
      if (args.companyRecordId) {
        return await this.scan('companies', [args.companyRecordId], after)
      }
      return null
    } catch (err) {
      if (err instanceof AttioError && (err.status === 403 || err.status === 404 || err.status === 400)) {
        return null
      }
      throw err
    }
  }

  private async scan(object: 'people' | 'companies', recordIds: string[], after: number): Promise<ReplySignal | null> {
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const res = await this.client.get<{ data: AttioEmail[]; next_cursor?: string }>('/emails', {
        linked_object: object,
        linked_record_ids: recordIds.join(','),
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      for (const email of res.data ?? []) {
        if (email.direction !== 'inbound') continue
        const sent = email.sent_at ? Date.parse(email.sent_at) : NaN
        if (!Number.isFinite(sent) || sent < after) continue
        return {
          sourceKey: '',
          inbound: true,
          sentAt: email.sent_at!,
          participant: email.participants?.find((p) => p.role === 'from')?.email_address ?? null,
        }
      }
      cursor = res.next_cursor
      if (!cursor) break
    }
    return null
  }
}
