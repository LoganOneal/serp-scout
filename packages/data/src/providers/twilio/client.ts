/**
 * Twilio REST. Three things only: read a number's current config, attach it to
 * the trunk, and send an SMS.
 *
 * No SDK dependency -- the surface used here is three form-encoded POSTs and one
 * GET, and the SDK is 40MB of surface we would then have to keep pinned.
 */

const BASE = 'https://api.twilio.com/2010-04-01'
const TRUNKING = 'https://trunking.twilio.com/v1'

export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'TwilioError'
  }
}

/** What a number is configured to do RIGHT NOW, before we take it over. */
export interface NumberConfig {
  sid: string
  phoneNumber: string
  friendlyName: string | null
  /** Set = the number currently answers via Programmable Voice. */
  voiceUrl: string | null
  voiceApplicationSid: string | null
  /** Set = already on a trunk. */
  trunkSid: string | null
  smsUrl: string | null
}

export class TwilioClient {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private auth(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`
  }

  private async request(
    url: string,
    init: { method?: string; form?: Record<string, string> } = {},
  ): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: this.auth(),
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new TwilioError(
        `Twilio ${init.method ?? 'GET'} ${url} -> ${res.status}`,
        res.status,
        text,
      )
    }
    return text === '' ? null : JSON.parse(text)
  }

  /**
   * Find a number by E.164 and report what it does today.
   *
   * The provisioning script prints this and refuses to proceed without --confirm.
   * These are working business numbers: attaching one to a trunk silently removes
   * it from Programmable Voice, and whatever it currently does -- forward to the
   * owner's cell, run a Studio flow -- stops.
   */
  async getNumberConfig(e164: string): Promise<NumberConfig | null> {
    const body = (await this.request(
      `${BASE}/Accounts/${this.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
    )) as { incoming_phone_numbers?: Array<Record<string, unknown>> } | null

    const row = body?.incoming_phone_numbers?.[0]
    if (!row) return null

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v : null

    return {
      sid: String(row['sid']),
      phoneNumber: String(row['phone_number']),
      friendlyName: str(row['friendly_name']),
      voiceUrl: str(row['voice_url']),
      voiceApplicationSid: str(row['voice_application_sid']),
      trunkSid: str(row['trunk_sid']),
      smsUrl: str(row['sms_url']),
    }
  }

  /** Every number on the account, so provisioning can show you what you have. */
  async listNumbers(): Promise<NumberConfig[]> {
    const body = (await this.request(
      `${BASE}/Accounts/${this.accountSid}/IncomingPhoneNumbers.json?PageSize=100`,
    )) as { incoming_phone_numbers?: Array<Record<string, unknown>> } | null

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v : null

    return (body?.incoming_phone_numbers ?? []).map((row) => ({
      sid: String(row['sid']),
      phoneNumber: String(row['phone_number']),
      friendlyName: str(row['friendly_name']),
      voiceUrl: str(row['voice_url']),
      voiceApplicationSid: str(row['voice_application_sid']),
      trunkSid: str(row['trunk_sid']),
      smsUrl: str(row['sms_url']),
    }))
  }

  /** Attach a number to the trunk. THIS is the step that changes voice routing. */
  async attachNumberToTrunk(trunkSid: string, numberSid: string): Promise<void> {
    await this.request(`${TRUNKING}/Trunks/${trunkSid}/PhoneNumbers`, {
      method: 'POST',
      form: { PhoneNumberSid: numberSid },
    })
  }

  // --- Trunk construction ---------------------------------------------------

  async listTrunks(): Promise<Array<{ sid: string; friendlyName: string; domainName: string }>> {
    const body = (await this.request(`${TRUNKING}/Trunks`)) as {
      trunks?: Array<Record<string, unknown>>
    } | null
    return (body?.trunks ?? []).map((t) => ({
      sid: String(t['sid']),
      friendlyName: String(t['friendly_name'] ?? ''),
      domainName: String(t['domain_name'] ?? ''),
    }))
  }

  /**
   * Create a trunk.
   *
   * `domainName` must end in `.pstn.twilio.com` and is globally unique across all of
   * Twilio -- so the caller derives it from the account SID rather than a friendly
   * word, which would collide with somebody else's trunk on the first try.
   */
  async createTrunk(args: {
    friendlyName: string
    domainName: string
    disasterRecoveryUrl?: string | undefined
  }): Promise<{ sid: string; domainName: string }> {
    const form: Record<string, string> = {
      FriendlyName: args.friendlyName,
      DomainName: args.domainName,
    }
    if (args.disasterRecoveryUrl) {
      form['DisasterRecoveryUrl'] = args.disasterRecoveryUrl
      form['DisasterRecoveryMethod'] = 'POST'
    }
    const body = (await this.request(`${TRUNKING}/Trunks`, { method: 'POST', form })) as Record<
      string,
      unknown
    > | null
    return {
      sid: String(body?.['sid'] ?? ''),
      domainName: String(body?.['domain_name'] ?? args.domainName),
    }
  }

  /** Set the Disaster Recovery URL. Without one, a Retell outage is a dead line. */
  async setDisasterRecoveryUrl(trunkSid: string, url: string): Promise<void> {
    await this.request(`${TRUNKING}/Trunks/${trunkSid}`, {
      method: 'POST',
      form: { DisasterRecoveryUrl: url, DisasterRecoveryMethod: 'POST' },
    })
  }

  /** Origination = inbound. This is the line that makes calls reach Retell at all. */
  async addOriginationUri(
    trunkSid: string,
    args: { friendlyName: string; sipUrl: string },
  ): Promise<{ sid: string }> {
    const body = (await this.request(`${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`, {
      method: 'POST',
      form: {
        FriendlyName: args.friendlyName,
        SipUrl: args.sipUrl,
        Weight: '10',
        Priority: '10',
        Enabled: 'true',
      },
    })) as Record<string, unknown> | null
    return { sid: String(body?.['sid'] ?? '') }
  }

  // --- Termination auth (credential list) -----------------------------------

  async listCredentialLists(): Promise<Array<{ sid: string; friendlyName: string }>> {
    const body = (await this.request(
      `${BASE}/Accounts/${this.accountSid}/SIP/CredentialLists.json?PageSize=100`,
    )) as { credential_lists?: Array<Record<string, unknown>> } | null
    return (body?.credential_lists ?? []).map((c) => ({
      sid: String(c['sid']),
      friendlyName: String(c['friendly_name'] ?? ''),
    }))
  }

  async createCredentialList(friendlyName: string): Promise<{ sid: string }> {
    const body = (await this.request(
      `${BASE}/Accounts/${this.accountSid}/SIP/CredentialLists.json`,
      { method: 'POST', form: { FriendlyName: friendlyName } },
    )) as Record<string, unknown> | null
    return { sid: String(body?.['sid'] ?? '') }
  }

  /**
   * Add a SIP credential.
   *
   * Twilio requires the password to be 12+ characters with at least one uppercase,
   * one lowercase and one digit, and rejects the whole request otherwise -- so the
   * generator in setup-trunk.ts guarantees all three rather than hoping.
   */
  async addCredential(
    credentialListSid: string,
    args: { username: string; password: string },
  ): Promise<{ sid: string }> {
    const body = (await this.request(
      `${BASE}/Accounts/${this.accountSid}/SIP/CredentialLists/${credentialListSid}/Credentials.json`,
      { method: 'POST', form: { Username: args.username, Password: args.password } },
    )) as Record<string, unknown> | null
    return { sid: String(body?.['sid'] ?? '') }
  }

  async attachCredentialListToTrunk(trunkSid: string, credentialListSid: string): Promise<void> {
    await this.request(`${TRUNKING}/Trunks/${trunkSid}/CredentialLists`, {
      method: 'POST',
      form: { CredentialListSid: credentialListSid },
    })
  }

  async listTrunkCredentialLists(trunkSid: string): Promise<Array<{ sid: string }>> {
    const body = (await this.request(`${TRUNKING}/Trunks/${trunkSid}/CredentialLists`)) as {
      credential_lists?: Array<Record<string, unknown>>
    } | null
    return (body?.credential_lists ?? []).map((c) => ({ sid: String(c['sid']) }))
  }

  /** Read the trunk, so provisioning can refuse when disaster recovery is unset. */
  async getTrunk(trunkSid: string): Promise<{
    sid: string
    disasterRecoveryUrl: string | null
    disasterRecoveryMethod: string | null
  } | null> {
    const body = (await this.request(`${TRUNKING}/Trunks/${trunkSid}`)) as Record<
      string,
      unknown
    > | null
    if (!body) return null
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v : null
    return {
      sid: String(body['sid']),
      disasterRecoveryUrl: str(body['disaster_recovery_url']),
      disasterRecoveryMethod: str(body['disaster_recovery_method']),
    }
  }

  async listTrunkOriginationUris(
    trunkSid: string,
  ): Promise<Array<{ sipUrl: string; enabled: boolean }>> {
    const body = (await this.request(`${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`)) as {
      origination_urls?: Array<Record<string, unknown>>
    } | null
    return (body?.origination_urls ?? []).map((u) => ({
      sipUrl: String(u['sip_url'] ?? ''),
      enabled: u['enabled'] === true,
    }))
  }

  /**
   * Send the lead alert.
   *
   * `from` is the site's own tracking number, which is the point: the contractor's
   * phone shows a text from the number the customer dialled rather than a random
   * long code that reads as spam. Elastic SIP Trunking is voice-only, so messaging
   * on a trunk number keeps working.
   */
  async sendSms(args: { from: string; to: string; body: string }): Promise<{ sid: string }> {
    const body = (await this.request(`${BASE}/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      form: { From: args.from, To: args.to, Body: args.body },
    })) as Record<string, unknown> | null
    return { sid: String(body?.['sid'] ?? '') }
  }
}
