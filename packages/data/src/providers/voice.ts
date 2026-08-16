import type { ParsedRetellCall } from './retell/contracts.js'
import { RetellClient, type ImportNumberArgs } from './retell/client.js'
import { TwilioClient, type NumberConfig } from './twilio/client.js'
import { CAPTURED_AGENT, CAPTURED_FLOW } from '@rnr/core'
import type { EnvLike } from './index.js'
import { liveCallsEnabled } from './index.js'

/**
 * The voice provider seam. Same polarity as the DataForSEO seam in ./index.ts:
 * fixtures unless LIVE_CALLS_ENABLED is the exact string 'true'.
 *
 * ==================== WHAT THIS FLAG DOES AND DOES NOT GATE ====================
 * It gates OUTBOUND requests: recording downloads, get-call backfills, SMS sends,
 * number provisioning.
 *
 * It does NOT gate inbound webhook acceptance. Webhooks are free, and a flag that
 * caused them to be ignored would silently drop real customer calls whenever it
 * was off -- so the ingest routes never consult it.
 *
 * Signature verification is likewise never gated. See retell/signature.ts.
 * =============================================================================
 */

export interface VoiceProviders {
  /** True only when real outbound requests will be made. */
  readonly live: boolean
  getCall(callId: string): Promise<ParsedRetellCall | null>
  downloadRecording(url: string): Promise<Buffer>
  sendSms(args: { from: string; to: string; body: string }): Promise<{ sid: string }>
  getNumberConfig(e164: string): Promise<NumberConfig | null>
  attachNumberToTrunk(trunkSid: string, numberSid: string): Promise<void>
  getTrunk(trunkSid: string): Promise<{
    sid: string
    disasterRecoveryUrl: string | null
    disasterRecoveryMethod: string | null
  } | null>
  listTrunkOriginationUris(trunkSid: string): Promise<Array<{ sipUrl: string; enabled: boolean }>>
  importPhoneNumber(args: ImportNumberArgs): Promise<{ phoneNumber: string }>
  /** Retarget an already-imported DID. Import is a 400 the second time. */
  updatePhoneNumberWebhook(args: {
    phoneNumber: string
    inboundWebhookUrl: string
    inboundAgentId?: string
  }): Promise<unknown>
  /** Raw agent JSON. Parsed by @rnr/core, not here. */
  getAgent(agentId: string): Promise<unknown>
  getConversationFlow(flowId: string): Promise<unknown>
  /** The prompt and tools behind a single-prompt agent. */
  getRetellLlm(llmId: string): Promise<unknown>
  listAgents(): Promise<unknown[]>
  /** Every imported DID and the agent it answers with. */
  listPhoneNumbers(): Promise<unknown[]>
  /** Create a single-prompt response engine from this repo's script. */
  createRetellLlm(payload: Record<string, unknown>): Promise<{ llmId: string; raw: unknown }>
  createAgent(payload: Record<string, unknown>): Promise<{ agentId: string; raw: unknown }>
  /** Integration fields only -- the client enforces the allowlist. */
  updateAgent(agentId: string, patch: Record<string, unknown>): Promise<unknown>
}

// ---------------------------------------------------------------------------

/** A tiny silent WAV, so the recording path is exercised without network IO. */
function fixtureWav(): Buffer {
  const samples = 8000 // one second at 8kHz, matching the PSTN reality
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples * 2, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples * 2, 40)
  return Buffer.concat([header, Buffer.alloc(samples * 2)])
}

class FixtureVoiceProviders implements VoiceProviders {
  readonly live = false

  async getCall(): Promise<ParsedRetellCall | null> {
    // The simulator drives ingest through the webhook routes, so a backfill read
    // has nothing to add offline. Null rather than a fabricated call: inventing one
    // here would let a backfill "succeed" against a call that never existed.
    return null
  }

  async downloadRecording(): Promise<Buffer> {
    return fixtureWav()
  }

  async sendSms(): Promise<{ sid: string }> {
    return { sid: `SM_fixture_${Math.random().toString(36).slice(2, 10)}` }
  }

  async getNumberConfig(e164: string): Promise<NumberConfig | null> {
    // Deliberately reports a number that currently forwards somewhere. The
    // provisioning script must show a real "you are about to break this" warning
    // in fixture mode too, or the confirmation step is untested theatre.
    return {
      sid: 'PNfixture0000000000000000000000000',
      phoneNumber: e164,
      friendlyName: 'Fixture business line',
      voiceUrl: 'https://handler.twilio.com/twiml/EHfixture',
      voiceApplicationSid: null,
      trunkSid: null,
      smsUrl: null,
    }
  }

  async attachNumberToTrunk(): Promise<void> {}

  async getTrunk(trunkSid: string) {
    return {
      sid: trunkSid,
      disasterRecoveryUrl: 'https://fixture.invalid/api/twilio/failover',
      disasterRecoveryMethod: 'POST',
    }
  }

  async listTrunkOriginationUris() {
    return [{ sipUrl: 'sip:sip.retellai.com', enabled: true }]
  }

  async importPhoneNumber(args: ImportNumberArgs): Promise<{ phoneNumber: string }> {
    return { phoneNumber: args.phoneNumber }
  }

  async updatePhoneNumberWebhook(): Promise<unknown> {
    // No-op: in fixture mode there is no imported number to retarget, and nothing to spend.
    return null
  }

  /**
   * The REAL captured agent, redacted to structure.
   *
   * Reusing the committed fixture means the /agent page and its audit are
   * developable offline against a payload that genuinely occurred -- including its
   * three absences (no webhook_url, no tools, no analysis fields), which an
   * invented fixture would have helpfully filled in and hidden.
   */
  async getAgent(agentId: string): Promise<unknown> {
    return { ...CAPTURED_AGENT, agent_id: agentId }
  }

  async getConversationFlow(): Promise<unknown> {
    return CAPTURED_FLOW
  }

  async getRetellLlm(): Promise<unknown> {
    // The captured agent is a conversation-flow, so there is no LLM behind it. Null
    // rather than an invented prompt: a fabricated one would let the audit pass
    // offline against tools that do not exist anywhere.
    return null
  }

  async listAgents(): Promise<unknown[]> {
    return [CAPTURED_AGENT]
  }

  async listPhoneNumbers(): Promise<unknown[]> {
    // Empty, not a fabricated DID. An invented number would appear in the fleet view
    // as a live line and make the site/number cross-check pass against nothing.
    return []
  }

  /**
   * ==================== CREATION HAS NO HONEST FIXTURE ====================
   * Every other fixture returns something true offline: a captured agent, a silent
   * WAV, a number config. There is no offline equivalent of an agent id, and a
   * synthetic one would be WRITTEN TO `sites.retell_agent_id` and outlive the
   * session -- leaving a row that claims a Retell agent which has never existed,
   * and a provisioning run that would point a real phone number at it.
   *
   * So this throws, in the same spirit as requireTwilio below.
   * ======================================================================
   */
  async createRetellLlm(): Promise<{ llmId: string; raw: unknown }> {
    throw new Error(
      'Creating a Retell agent needs LIVE_CALLS_ENABLED=true. Refusing to invent an ' +
        'llm_id, which would be stored on the site as though an agent existed.',
    )
  }

  async createAgent(): Promise<{ agentId: string; raw: unknown }> {
    throw new Error(
      'Creating a Retell agent needs LIVE_CALLS_ENABLED=true. Refusing to invent an ' +
        'agent_id, which would be stored on the site as though an agent existed.',
    )
  }

  async updateAgent(): Promise<unknown> {
    // Returns without pretending to have changed anything. The caller re-pulls, and
    // in fixture mode that re-pull yields the unchanged capture -- so the UI shows
    // the checks still failing, which is the truth offline.
    return {}
  }
}

class LiveVoiceProviders implements VoiceProviders {
  readonly live = true

  constructor(
    private readonly retell: RetellClient,
    /**
     * NULL when Twilio credentials are absent.
     *
     * ==================== CREDENTIALS ARE PER CAPABILITY ====================
     * Requiring all three keys up front meant you could not read your own Retell
     * agent until Twilio was also configured -- which blocks the legitimate first
     * step (connect the agent, see what is missing) behind an unrelated setup.
     *
     * So Retell-only operations work with a Retell key alone, and each Twilio
     * operation throws a NAMED error at call time. The property that mattered is
     * kept: nothing silently degrades to a fixture, so a lead alert can never be
     * recorded as sent while sending nothing.
     * =====================================================================
     */
    private readonly twilio: TwilioClient | null,
  ) {}

  private requireTwilio(operation: string): TwilioClient {
    if (this.twilio === null) {
      throw new Error(
        `${operation} needs Twilio, but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set. ` +
          'Refusing to fall back to fixtures, which would report success while doing nothing.',
      )
    }
    return this.twilio
  }

  getCall(callId: string) {
    return this.retell.getCall(callId)
  }
  downloadRecording(url: string) {
    return this.retell.downloadRecording(url)
  }
  sendSms(args: { from: string; to: string; body: string }) {
    return this.requireTwilio('Sending a lead alert SMS').sendSms(args)
  }
  getNumberConfig(e164: string) {
    return this.requireTwilio('Reading a number configuration').getNumberConfig(e164)
  }
  attachNumberToTrunk(trunkSid: string, numberSid: string) {
    return this.requireTwilio('Attaching a number to the trunk').attachNumberToTrunk(trunkSid, numberSid)
  }
  getTrunk(trunkSid: string) {
    return this.requireTwilio('Reading the SIP trunk').getTrunk(trunkSid)
  }
  listTrunkOriginationUris(trunkSid: string) {
    return this.requireTwilio('Reading trunk origination URIs').listTrunkOriginationUris(trunkSid)
  }
  importPhoneNumber(args: ImportNumberArgs) {
    return this.retell.importPhoneNumber(args)
  }
  updatePhoneNumberWebhook(args: {
    phoneNumber: string
    inboundWebhookUrl: string
    inboundAgentId?: string
  }) {
    return this.retell.updatePhoneNumberWebhook(args)
  }
  getAgent(agentId: string) {
    return this.retell.getAgent(agentId)
  }
  getConversationFlow(flowId: string) {
    return this.retell.getConversationFlow(flowId)
  }
  getRetellLlm(llmId: string) {
    return this.retell.getRetellLlm(llmId)
  }
  listAgents() {
    return this.retell.listAgents()
  }
  listPhoneNumbers() {
    return this.retell.listPhoneNumbers()
  }
  createRetellLlm(payload: Record<string, unknown>) {
    return this.retell.createRetellLlm(payload)
  }
  createAgent(payload: Record<string, unknown>) {
    return this.retell.createAgent(payload)
  }
  updateAgent(agentId: string, patch: Record<string, unknown>) {
    return this.retell.updateAgent(agentId, patch)
  }
}

// ---------------------------------------------------------------------------

export function retellApiKey(env: EnvLike = process.env): string | undefined {
  return env['RETELL_API_KEY']
}

export function createVoiceProviders(env: EnvLike = process.env): VoiceProviders {
  if (!liveCallsEnabled(env)) return new FixtureVoiceProviders()

  const retellKey = env['RETELL_API_KEY']
  const accountSid = env['TWILIO_ACCOUNT_SID']
  const authToken = env['TWILIO_AUTH_TOKEN']

  // Retell is the floor: without it there is no voice feature at all, and falling
  // back to fixtures here would present a captured agent as the live one.
  if (!retellKey) {
    throw new Error(
      'LIVE_CALLS_ENABLED=true but RETELL_API_KEY is missing. Refusing to fall back to ' +
        'fixtures, which would present a captured agent as your live one.',
    )
  }

  // Twilio is optional at construction and required per operation -- see the
  // constructor comment. This is what lets you connect the agent before the trunk.
  const twilio = accountSid && authToken ? new TwilioClient(accountSid, authToken) : null

  return new LiveVoiceProviders(new RetellClient(retellKey), twilio)
}
