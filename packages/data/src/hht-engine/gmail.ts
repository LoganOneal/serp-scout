import { createSign } from 'node:crypto'

export const GMAIL_NOTIFICATION_ADDRESS = 'kai@useterrace.ai'
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

export interface GoogleServiceAccountCredentials {
  clientEmail: string
  privateKey: string
  clientId: string
  tokenUri?: string
}

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

export async function sendGmailNotification(input: {
  credentials: GoogleServiceAccountCredentials
  subject: string
  text: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const accessToken = await gmailAccessToken(input.credentials, fetchImpl)
  const raw = gmailRawMessage({
    from: GMAIL_NOTIFICATION_ADDRESS,
    to: GMAIL_NOTIFICATION_ADDRESS,
    subject: input.subject,
    text: input.text,
  })
  const response = await fetchImpl(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(GMAIL_NOTIFICATION_ADDRESS)}/messages/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    },
  )
  const body = await response.text()
  if (!response.ok) {
    throw gmailError(response.status, body)
  }
  const result = JSON.parse(body) as { id?: string }
  return result.id ?? 'sent'
}

async function gmailAccessToken(
  credentials: GoogleServiceAccountCredentials,
  fetchImpl: typeof fetch,
): Promise<string> {
  const tokenUri = credentials.tokenUri || 'https://oauth2.googleapis.com/token'
  const now = Math.floor(Date.now() / 1_000)
  const assertion = serviceAccountAssertion(credentials, tokenUri, now)
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const body = await response.text()
  if (!response.ok) {
    if (isDelegationScopeFailure(body)) {
      throw new GmailAuthError(
        `Gmail domain-wide delegation is missing ${GMAIL_SEND_SCOPE} for service account client ID ${credentials.clientId}`,
      )
    }
    throw gmailError(response.status, body)
  }
  const result = JSON.parse(body) as { access_token?: string }
  if (!result.access_token) throw new Error('Gmail service-account token exchange returned no access token')
  return result.access_token
}

function serviceAccountAssertion(
  credentials: GoogleServiceAccountCredentials,
  audience: string,
  issuedAt: number,
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: credentials.clientEmail,
      sub: GMAIL_NOTIFICATION_ADDRESS,
      scope: GMAIL_SEND_SCOPE,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }),
  ].join('.')
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(credentials.privateKey, 'base64url')}`
}

function isDelegationScopeFailure(body: string): boolean {
  const normalized = body.toLowerCase()
  return normalized.includes('unauthorized_client')
    || normalized.includes('unauthorized client')
    || normalized.includes('invalid_scope')
    || normalized.includes('scope')
}

export function gmailRawMessage(input: {
  from: string
  to: string
  subject: string
  text: string
}): string {
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim()
  const body = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.text,
  ].join('\r\n')
  return Buffer.from(body).toString('base64url')
}

function gmailError(status: number, body: string): GmailAuthError {
  const compact = body.replace(/\s+/g, ' ').slice(0, 300)
  return new GmailAuthError(`Gmail API HTTP ${status}: ${compact}`)
}
