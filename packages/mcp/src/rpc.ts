/**
 * Just enough MCP to expose read-only tools over stdio.
 *
 * ==================== WHY NOT @modelcontextprotocol/sdk ====================
 * MCP over stdio is newline-delimited JSON-RPC 2.0 and the surface a tool server
 * needs is four methods. The SDK is a dependency in a repo whose two library
 * packages have one runtime dependency between them, pulled in to save about a
 * hundred lines of message routing that will not change.
 *
 * The honest cost of this choice: when the protocol adds a capability we want
 * (sampling, resources, elicitation), it is implemented here rather than
 * arriving in a version bump. That is a real trade and it is written down
 * because the next person to want one of those should know where to look.
 * ==========================================================================
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  /** Absent on a notification, which must NOT be answered. */
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** JSON-RPC 2.0 reserved codes. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/**
 * Protocol versions this server can speak.
 *
 * The spec says to echo the client's version when we support it and answer with
 * our own when we do not, letting the client decide whether to proceed. Silently
 * asserting a version we were not asked for is how a client ends up parsing
 * fields that are not there.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export interface ServerInfo {
  name: string
  version: string
  instructions?: string
}

export interface HandleOptions {
  tools: ToolDefinition[]
  serverInfo: ServerInfo
}

/**
 * Route one request. Returns null for a notification, which must go unanswered —
 * replying to one is a protocol violation and some clients treat the stray
 * response as a reply to a later request.
 */
export async function handleRequest(
  req: JsonRpcRequest,
  opts: HandleOptions,
): Promise<JsonRpcResponse | null> {
  const id = req.id
  const isNotification = id === undefined || id === null

  const ok = (result: unknown): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id: id!, result }
  const err = (code: number, message: string): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id: id!, error: { code, message } }

  switch (req.method) {
    case 'initialize': {
      const asked = (req.params?.['protocolVersion'] as string) ?? ''
      const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION
      return ok({
        protocolVersion: version,
        // Tools only. No resources, no prompts, and above all no sampling —
        // this server answers questions and never asks the model for anything.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.serverInfo.name, version: opts.serverInfo.version },
        ...(opts.serverInfo.instructions ? { instructions: opts.serverInfo.instructions } : {}),
      })
    }

    case 'notifications/initialized':
    case 'initialized':
      return null

    case 'ping':
      return ok({})

    case 'tools/list':
      return ok({
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = req.params?.['name'] as string | undefined
      const tool = opts.tools.find((t) => t.name === name)
      if (!tool) {
        return err(RPC.INVALID_PARAMS, `Unknown tool "${name}". Call tools/list for the set.`)
      }
      const args = (req.params?.['arguments'] as Record<string, unknown>) ?? {}
      try {
        const result = await tool.handler(args)
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result, jsonSafe, 2) }],
          isError: false,
        })
      } catch (e) {
        /**
         * A tool failure is reported as a RESULT with isError, not as a JSON-RPC
         * error. That is what the spec asks for and it is also what makes the
         * failure useful: the model sees the message and can correct the call,
         * where a transport-level error is invisible to it.
         */
        return ok({
          content: [{ type: 'text', text: `${name} failed: ${(e as Error).message}` }],
          isError: true,
        })
      }
    }

    default:
      return err(RPC.METHOD_NOT_FOUND, `Method "${req.method}" is not implemented.`)
  }
}

/**
 * BigInt is money here, and JSON.stringify throws on it outright.
 *
 * Serialised as a decimal STRING rather than a Number: micros routinely exceed
 * 2^53 in aggregate, and a silently rounded price is the class of bug the
 * integer-micros convention exists to prevent.
 */
export function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Split a stdio buffer into complete newline-delimited messages.
 *
 * Returns the parsed messages and whatever partial line is left over. A chunk
 * boundary can land mid-message on any stream, and treating the fragment as a
 * whole message is a parse error that looks like a malformed client.
 */
export function drainLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest }
}
