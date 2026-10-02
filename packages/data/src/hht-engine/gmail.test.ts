import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  GMAIL_NOTIFICATION_ADDRESS,
  GMAIL_SEND_SCOPE,
  GmailAuthError,
  gmailRawMessage,
  sendGmailNotification,
} from './gmail.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const credentials = {
  clientEmail: 'mailer@example-project.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  clientId: 'service-account-client-id',
}

describe('Gmail service-account notifications', () => {
  it('impersonates Kai with gmail.send and sends from and to Kai', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
        const payload = JSON.parse(
          Buffer.from(body.get('assertion')!.split('.')[1]!, 'base64url').toString(),
        ) as { iss: string; sub: string; scope: string }
        expect(payload.iss).toBe(credentials.clientEmail)
        expect(payload.sub).toBe(GMAIL_NOTIFICATION_ADDRESS)
        expect(payload.scope).toBe(GMAIL_SEND_SCOPE)
        return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 })
      }
      const request = JSON.parse(String(init?.body)) as { raw: string }
      const raw = Buffer.from(request.raw, 'base64url').toString()
      expect(raw).toContain(`From: ${GMAIL_NOTIFICATION_ADDRESS}`)
      expect(raw).toContain(`To: ${GMAIL_NOTIFICATION_ADDRESS}`)
      return new Response(JSON.stringify({ id: 'message-id' }), { status: 200 })
    })

    await expect(sendGmailNotification({
      credentials,
      subject: 'Test',
      text: 'It works.',
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBe('message-id')
  })

  it('explains a missing domain-wide delegation grant', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'unauthorized_client', error_description: 'Client is unauthorized' }),
      { status: 401 },
    ))
    const error = await sendGmailNotification({
      credentials,
      subject: 'Test',
      text: 'It works.',
      fetchImpl: fetchImpl as typeof fetch,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GmailAuthError)
    expect((error as Error).message).toContain(GMAIL_SEND_SCOPE)
    expect((error as Error).message).toContain(credentials.clientId)
  })

  it('sanitizes subject headers', () => {
    const raw = Buffer.from(gmailRawMessage({
      from: GMAIL_NOTIFICATION_ADDRESS,
      to: GMAIL_NOTIFICATION_ADDRESS,
      subject: 'hello\r\nBcc: other@example.com',
      text: 'body',
    }), 'base64url').toString()
    expect(raw).toContain('Subject: hello Bcc: other@example.com')
    expect(raw).not.toContain('\r\nBcc:')
  })
})
