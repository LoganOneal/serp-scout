import 'dotenv/config'
import { drainLines, handleRequest, type JsonRpcRequest, RPC } from './rpc.js'
import { TOOLS } from './tools.js'

/**
 * The MCP server, over stdio.
 *
 *   claude mcp add rank-and-rent -- pnpm tsx --conditions=react-server \
 *     packages/mcp/src/server.ts
 *
 * ==================== STDOUT IS THE PROTOCOL ====================
 * Every diagnostic goes to stderr. A single stray `console.log` — a debug line,
 * a driver warning, a dotenv notice — lands in the middle of the JSON-RPC stream
 * and the client sees a parse error rather than the message that actually
 * mattered. This is the failure mode of stdio transports and it is why the
 * `log` helper below exists instead of console.log.
 * ================================================================
 */

const log = (...args: unknown[]): void => {
  process.stderr.write(args.map(String).join(' ') + '\n')
}

const send = (payload: unknown): void => {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

const SERVER_INFO = {
  name: 'rank-and-rent',
  version: '0.1.0',
  instructions:
    'Read-only access to the rank-and-rent portfolio: supply (what each site has to sell), ' +
    'keyword verdicts, per-keyword economics, and link prospects.\n\n' +
    'Two conventions matter when reading anything here:\n' +
    '  · UNKNOWN never means zero. "We measured and there is nothing" and "nobody ever looked" ' +
    'are stored and reported separately, and treating the second as the first is the mistake ' +
    'this system is built to prevent. Say which one you are looking at.\n' +
    '  · Nothing here can spend money, send email, or change a row. Launching ads and sending ' +
    'outreach are CLI commands with their own gates, deliberately not reachable from a chat.',
}

async function main(): Promise<void> {
  let buffer = ''
  /**
   * ==================== IN-FLIGHT WORK OUTLIVES STDIN ====================
   * This used to be `stdin.on('end', () => process.exit(0))`, which killed the
   * process while tool calls were still awaiting the database — three requests
   * in, two responses out, and the missing one indistinguishable from a tool
   * that returned nothing.
   *
   * A long-lived client never closes stdin, so it would not have surfaced in
   * normal use; it surfaced immediately when the server was driven from a file,
   * which is also how anyone would script it. Pending work is tracked and
   * drained before exit.
   * =======================================================================
   */
  const inFlight = new Set<Promise<void>>()
  let stdinClosed = false

  const exitWhenDrained = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight])
    process.exit(0)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    const { lines, rest } = drainLines(buffer)
    buffer = rest

    for (const line of lines) {
      const task = (async () => {
        let req: JsonRpcRequest
        try {
          req = JSON.parse(line) as JsonRpcRequest
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'Invalid JSON' } })
          return
        }
        try {
          const res = await handleRequest(req, { tools: TOOLS, serverInfo: SERVER_INFO })
          if (res) send(res)
        } catch (e) {
          log(`[rank-and-rent-mcp] ${req.method} threw:`, (e as Error).stack ?? e)
          if (req.id !== undefined && req.id !== null) {
            send({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: RPC.INTERNAL_ERROR, message: (e as Error).message },
            })
          }
        }
      })()

      inFlight.add(task)
      void task.finally(() => {
        inFlight.delete(task)
        if (stdinClosed && inFlight.size === 0) void exitWhenDrained()
      })
    }
  })

  process.stdin.on('end', () => {
    stdinClosed = true
    void exitWhenDrained()
  })
  log(`[rank-and-rent-mcp] ready — ${TOOLS.length} read-only tools`)
}

void main()
