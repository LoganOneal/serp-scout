import { parseRetellCall, type ParsedRetellCall } from './contracts.js'

/**
 * Retell REST client. Only the endpoints this system actually calls.
 *
 * Inbound webhooks are free and are handled elsewhere; everything here is an
 * OUTBOUND request, which is why it sits behind the LIVE_CALLS_ENABLED seam like
 * the DataForSEO client does.
 */

const BASE = 'https://api.retellai.com'

export class RetellError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'RetellError'
  }
}

export interface ImportNumberArgs {
  phoneNumber: string
  terminationUri: string
  sipTrunkAuthUsername?: string | undefined
  sipTrunkAuthPassword?: string | undefined
  inboundAgentId: string
  inboundWebhookUrl: string
  nickname: string
  /** Cheap toll-fraud protection on a number pointed at a paid agent. */
  allowedInboundCountries?: string[]
}

export class RetellClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new RetellError(`Retell ${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status, text)
    }
    return text === '' ? null : JSON.parse(text)
  }

  /** Reconciliation read. Used by the backfill job when a webhook was missed. */
  async getCall(callId: string): Promise<ParsedRetellCall | null> {
    const body = await this.request(`/v2/get-call/${encodeURIComponent(callId)}`)
    return parseRetellCall(body)
  }

  /** Raw agent JSON. Parsed by @rnr/core's parseAgent, not here. */
  async getAgent(agentId: string): Promise<unknown> {
    return this.request(`/get-agent/${encodeURIComponent(agentId)}`)
  }

  async listAgents(): Promise<unknown[]> {
    const body = await this.request('/list-agents')
    return Array.isArray(body) ? body : []
  }

  /** The conversation graph for a `conversation-flow` agent. */
  async getConversationFlow(flowId: string): Promise<unknown> {
    return this.request(`/get-conversation-flow/${encodeURIComponent(flowId)}`)
  }

  /**
   * Retarget the custom-function URLs on a flow. The URL, and nothing else.
   *
   * ==================== WHY THIS IS ALLOWED WHEN FLOW WRITES ARE NOT ====================
   * `updateAgent` refuses anything outside the integration allowlist because a PATCH that
   * touched a Conversation Flow could replace hand-built branching dialogue with a guess.
   * That reasoning is about the DIALOGUE -- nodes, edges, instructions, the global prompt.
   *
   * A tool's `url` is not dialogue. It is the same class of thing as `webhook_url`: the
   * address of an endpoint this repo owns. And it has to be writable, because moving hosts
   * otherwise leaves `save_lead` pointing at a dead tunnel -- the agent then captures a lead
   * perfectly, posts it nowhere, tells the caller someone will ring back, and no row is
   * created. Silent, and the most expensive failure in the system.
   *
   * The body sent contains ONLY `tools`. `nodes`, `global_prompt`, `start_node_id` and the
   * rest are never transmitted, so there is nothing for a partial update to clobber.
   * ===================================================================================
   */
  async updateConversationFlowTools(flowId: string, tools: unknown[]): Promise<unknown> {
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new RetellError(
        'Refusing to PATCH an empty tools array -- that would delete every custom function.',
        400,
        '',
      )
    }
    return this.request(`/update-conversation-flow/${encodeURIComponent(flowId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tools }),
    })
  }

  /**
   * Patch agent-level fields.
   *
   * ==================== INTEGRATION FIELDS ONLY ====================
   * Callers must pass only `webhook_url` and `post_call_analysis_data`. The
   * conversation itself -- nodes, instructions, edges, voice, model -- belongs to
   * whoever built it in the Retell UI, and a PATCH that touched a Conversation Flow
   * would replace hand-built branching dialogue with whatever this repo guessed.
   *
   * The allowlist is enforced here rather than trusted at the call sites, because
   * there is no undo on the other end of this request.
   * ================================================================
   */
  async updateAgent(agentId: string, patch: Record<string, unknown>): Promise<unknown> {
    const allowed = new Set(['webhook_url', 'post_call_analysis_data', 'post_call_analysis_model'])
    const rejected = Object.keys(patch).filter((k) => !allowed.has(k))
    if (rejected.length > 0) {
      throw new RetellError(
        `Refusing to PATCH agent fields outside the integration allowlist: ${rejected.join(', ')}. ` +
          'Conversation design belongs to Retell; this repo owns webhooks and analysis fields only.',
        400,
        '',
      )
    }
    return this.request(`/update-agent/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /**
   * Import a Twilio DID.
   *
   * `inbound_webhook_url` is set HERE, at provisioning time, which is what makes
   * the "forgot to paste the URL into the dashboard" failure structurally
   * impossible rather than merely detectable.
   */
  async importPhoneNumber(args: ImportNumberArgs): Promise<{ phoneNumber: string }> {
    const payload: Record<string, unknown> = {
      phone_number: args.phoneNumber,
      termination_uri: args.terminationUri,
      nickname: args.nickname,
      inbound_agents: [{ agent_id: args.inboundAgentId, weight: 1.0 }],
      inbound_webhook_url: args.inboundWebhookUrl,
      allowed_inbound_country_list: args.allowedInboundCountries ?? ['US'],
      transport: 'TCP',
    }
    if (args.sipTrunkAuthUsername) payload['sip_trunk_auth_username'] = args.sipTrunkAuthUsername
    if (args.sipTrunkAuthPassword) payload['sip_trunk_auth_password'] = args.sipTrunkAuthPassword

    const body = (await this.request('/import-phone-number', {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as Record<string, unknown> | null

    return { phoneNumber: String(body?.['phone_number'] ?? args.phoneNumber) }
  }

  /**
   * Retarget an ALREADY-IMPORTED number's inbound webhook.
   *
   * ==================== IMPORT IS NOT IDEMPOTENT ====================
   * `importPhoneNumber` sets `inbound_webhook_url` at provisioning time, which is the right
   * place for it -- but a second import of the same DID is a 400, so on a host move there
   * was no way to update the URL. It stayed pointing at the old tunnel, and that URL is how
   * Retell learns WHICH agent answers: with it dead, an inbound call reaches the fallback
   * agent, which greets the caller with no business name and cannot save a lead.
   *
   * A narrow patch, for the same reason the agent patch is narrow: `termination_uri` and the
   * SIP credentials are trunk topology, and getting them wrong takes the line down.
   * ================================================================
   */
  async updatePhoneNumberWebhook(args: {
    phoneNumber: string
    inboundWebhookUrl: string
    inboundAgentId?: string
  }): Promise<unknown> {
    const payload: Record<string, unknown> = { inbound_webhook_url: args.inboundWebhookUrl }
    if (args.inboundAgentId) {
      payload['inbound_agents'] = [{ agent_id: args.inboundAgentId, weight: 1.0 }]
    }
    return this.request(`/update-phone-number/${encodeURIComponent(args.phoneNumber)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  }

  /**
   * Download a recording.
   *
   * Not JSON, and deliberately not routed through `request`. Retell's link is an
   * S3 URL whose lifetime is unspecified -- and 10 MINUTES when the PII opt-out is
   * enabled -- so this runs from a queued job that can retry, and the bytes land
   * in storage we control.
   */
  async downloadRecording(url: string): Promise<Buffer> {
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      throw new RetellError(`Recording download -> ${res.status}`, res.status, res.statusText)
    }
    return Buffer.from(await res.arrayBuffer())
  }
}
