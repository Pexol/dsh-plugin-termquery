/**
 * dsh-plugin-termquery — host half.
 *
 * Exposes a small loopback HTTP API so an external TermQuery UI can:
 *   - send a term into a live DSH agent  (ctx.agents.get(id).followup(...))
 *   - read the derived messages back      (session.deriveMessages())
 *   - read real token pressure            (ctx.tokenMeter.measure(session))
 *   - archive a conversation to JSON      (written under D:/TermQueryData/backups)
 *
 * It never injects keystrokes, never moves the mouse and never steals focus.
 * Every route is registered through the plugin fiber, so unloading the plugin
 * removes them.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'termquery'

// webServer is the only hard dependency; agents/sessions/tokenMeter/llm are
// read defensively so the plugin still loads in a partial composition.
export const inject = ['webServer']

const DEFAULT_DATA_DIR = 'D:/TermQueryData'

function ensureDir(p) {
  try {
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  } catch {}
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  }
}

function sendJson(res, code, obj) {
  let body = Buffer.from('{"ok":false,"error":"serialize"}', 'utf8')
  try {
    body = Buffer.from(JSON.stringify(obj), 'utf8')
  } catch {}
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      ...corsHeaders(),
    })
    res.end(body)
  } catch {}
}

function sendEmpty(res, code) {
  try {
    res.writeHead(code, { 'cache-control': 'no-store', ...corsHeaders() })
    res.end()
  } catch {}
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function nowIso() {
  return new Date().toISOString()
}

export function apply(ctx, config = {}) {
  try {
    const cfg = { basePath: '/termquery', dataDir: DEFAULT_DATA_DIR, ...(config || {}) }
    const base = String(cfg.basePath || '/termquery').replace(/\/+$/, '')
    const svc = (n) => {
      try {
        const v = ctx[n]
        if (v !== undefined) return v
      } catch {}
      try {
        return typeof ctx.get === 'function' ? ctx.get(n) : undefined
      } catch {
        return undefined
      }
    }

    const port = ctx.webServer?.port
    try {
      ensureDir(cfg.dataDir)
      writeFileSync(
        join(cfg.dataDir, 'runtime.json'),
        JSON.stringify(
          { plugin: 'dsh-plugin-termquery', version: '0.1.0', port, base, startedAt: nowIso() },
          null,
          2,
        ),
        'utf8',
      )
    } catch {}

    try {
      ctx.logger?.info?.(`[termquery] active at http://127.0.0.1:${port}${base}`)
    } catch {}

    const reg = (path, handler) =>
      ctx.webServer.register({ kind: 'exact', path: base + path, handler })

    reg('/health', (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-plugin-termquery',
        version: '0.1.0',
        port,
        base,
        services: {
          agents: !!svc('agents'),
          sessions: !!svc('sessions'),
          tokenMeter: !!svc('tokenMeter'),
          llm: !!svc('llm'),
        },
        time: nowIso(),
      })
    })

    reg('/sessions', (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const out = []
        const agents = svc('agents')
        if (agents?.list) {
          for (const a of agents.list()) {
            const id = a?.sessionId || a?.session?.id || a?.id || null
            out.push({ id, status: a?.status ?? null, live: true })
          }
        }
        if (!out.length && svc('sessions')?.list) {
          for (const s of svc('sessions').list()) out.push({ id: s?.id ?? null, status: 'cold', live: false })
        }
        sendJson(res, 200, { ok: true, sessions: out })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/ask', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const body = await readBody(req)
        const text = String(body.text ?? body.term ?? '').trim()
        if (!text) return sendJson(res, 400, { ok: false, error: 'text required' })
        const agents = svc('agents')
        if (!agents) return sendJson(res, 503, { ok: false, error: 'agents service unavailable' })

        let id = body.sessionId || body.session || null
        let agent = id && agents.get ? agents.get(id) : null
        let created = false

        if (!agent && body.create && typeof agents.create === 'function') {
          const handle = await agents.create({
            sessionId: id || undefined,
            agentOptions: body.agentOptions || undefined,
          })
          agent = handle?.agent || handle
          created = true
          id = agent?.sessionId || id || null
        }

        if (!agent) return sendJson(res, 404, { ok: false, error: 'agent not found', sessionId: id })

        const fn = agent.followup || agent.steer
        if (typeof fn !== 'function') return sendJson(res, 500, { ok: false, error: 'agent has no followup()' })

        await fn.call(agent, {
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })

        sendJson(res, 200, { ok: true, sessionId: id || agent.sessionId || null, created })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/messages', (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const q = queryOf(req)
        const id = q.get('sessionId')
        const limit = Math.max(1, Math.min(200, parseInt(q.get('limit') || '20', 10) || 20))
        const session = id && svc('sessions')?.get ? svc('sessions').get(id) : null
        if (!session) return sendJson(res, 404, { ok: false, error: 'session not found', sessionId: id })
        const all = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
        const tail = all.slice(-limit).map((m) => ({ role: m?.role ?? null, content: m?.content ?? null }))
        sendJson(res, 200, { ok: true, sessionId: id, total: all.length, messages: tail })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/pressure', (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const q = queryOf(req)
        const id = q.get('sessionId')
        const session = id && svc('sessions')?.get ? svc('sessions').get(id) : null
        if (!session) return sendJson(res, 404, { ok: false, error: 'session not found', sessionId: id })
        const meter = svc('tokenMeter')
        const m = meter?.measure ? meter.measure(session) : null
        let contextWindow = null
        try {
          contextWindow = svc('llm')?.resolveModelInfo?.()?.context ?? null
        } catch {}
        sendJson(res, 200, {
          ok: true,
          sessionId: id,
          totalTokens: m?.totalTokens ?? null,
          surfaceTokens: m?.surfaceTokens ?? null,
          contextWindow,
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/archive', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const body = await readBody(req)
        const id = body.sessionId
        const session = id && svc('sessions')?.get ? svc('sessions').get(id) : null
        if (!session) return sendJson(res, 404, { ok: false, error: 'session not found', sessionId: id })
        const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
        ensureDir(join(cfg.dataDir, 'backups'))
        const stamp = nowIso().replace(/[:.]/g, '-')
        const file = join(cfg.dataDir, 'backups', `conv_${String(id).slice(0, 8)}_${stamp}.json`)
        const backup = {
          version: '1.0',
          conversation_id: id,
          created_at: nowIso(),
          message_count: messages.length,
          messages,
        }
        writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8')
        sendJson(res, 200, { ok: true, sessionId: id, backupFile: file, messageCount: messages.length })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    // Unknown /termquery/* → JSON 404 (so a typo is obvious to the caller)
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (req, res) => {
        if (req.method === 'OPTIONS') return sendEmpty(res, 204)
        sendJson(res, 404, { ok: false, error: 'unknown termquery route', path: req.url })
      },
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[termquery] failed to activate: ${e?.message || e}`)
    } catch {}
  }
}
