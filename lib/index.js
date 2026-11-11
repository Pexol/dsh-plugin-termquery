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
import { randomUUID } from 'node:crypto'
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

// Never let a handler rejection escape into the host process: an unhandled
// async throw here can terminate DSH (this is exactly what took it down once).
function safe(fn) {
  return (req, res) => {
    let p
    try {
      p = fn(req, res)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      return
    }
    if (p && typeof p.then === 'function') {
      p.catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message || e) }))
    }
  }
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
      ctx.webServer.register({ kind: 'exact', path: base + path, handler: safe(handler) })

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
          sessionController: !!svc('sessionController'),
          tokenMeter: !!svc('tokenMeter'),
          llm: !!svc('llm'),
        },
        time: nowIso(),
      })
    })

    reg('/sessions', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const out = []
        const sc = svc('sessionController')
        if (sc?.list) {
          const r = await sc.list({}, new AbortController().signal)
          for (const it of r?.items || []) {
            out.push({
              id: it.sessionId,
              running: !!it.running,
              blank: !!it.blank,
              updatedAt: it.updatedAt,
              cwd: it.cwd,
            })
          }
        }
        if (!out.length) {
          const agents = svc('agents')
          if (agents?.list) {
            for (const a of agents.list()) {
              const id = a?.sessionId || a?.session?.id || a?.id || null
              out.push({ id, status: a?.status ?? null, live: true })
            }
          }
        }
        sendJson(res, 200, { ok: true, sessions: out })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/models', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      const sc = svc('sessionController')
      if (!sc?.modelCatalog) return sendJson(res, 503, { ok: false, error: 'modelCatalog unavailable' })
      const catalog = await sc.modelCatalog()
      sendJson(res, 200, { ok: true, catalog })
    })

    reg('/model-info', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      const q = queryOf(req)
      const provider = q.get('provider')
      const model = q.get('model')
      if (!provider || !model) return sendJson(res, 400, { ok: false, error: 'provider and model required' })
      const llm = svc('llm')
      if (!llm?.resolveModelInfo) return sendJson(res, 503, { ok: false, error: 'llm service unavailable' })
      // resolveModelInfo(provider, model) MUST receive both ids; calling it bare
      // throws NO_ADAPTER. safe() also guards this rejection.
      const info = await llm.resolveModelInfo(provider, model)
      sendJson(res, 200, {
        ok: true,
        provider,
        model,
        context: info?.context ?? null,
        defaultMaxTokens: info?.defaultMaxTokens ?? null,
        reasoning: info?.reasoning ?? null,
      })
    })

    reg('/select-model', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      const body = await readBody(req)
      if (!body.sessionId || !body.provider || !body.model) {
        return sendJson(res, 400, { ok: false, error: 'sessionId, provider, model required' })
      }
      const sc = svc('sessionController')
      if (!sc?.selectModel) return sendJson(res, 503, { ok: false, error: 'selectModel unavailable' })
      try {
        const r = await sc.selectModel({
          sessionId: body.sessionId,
          provider: body.provider,
          model: body.model,
          reasoningEffort: body.reasoningEffort || undefined,
        })
        sendJson(res, 200, { ok: true, selected: r?.selected ?? null })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message || e) })
      }
    })

    reg('/ask', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const body = await readBody(req)
        const text = String(body.text ?? body.term ?? '').trim()
        if (!text) return sendJson(res, 400, { ok: false, error: 'text required' })
        const id = body.sessionId || body.session || null
        if (!id) return sendJson(res, 400, { ok: false, error: 'sessionId required' })

        // Preferred path: SessionController resumes the Session (cold or live)
        // and admits the prompt into its Agent inbox.
        const sc = svc('sessionController')
        if (sc?.prompt) {
          const r = await sc.prompt(
            {
              requestId: randomUUID(),
              sessionId: id,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            new AbortController().signal,
          )
          return sendJson(res, 200, { ok: true, sessionId: id, via: 'sessionController', accepted: !!r?.accepted })
        }

        // Fallback: drive a live Agent directly.
        const agents = svc('agents')
        if (!agents) return sendJson(res, 503, { ok: false, error: 'sessionController/agents unavailable' })
        const agent = agents.get ? agents.get(id) : null
        if (!agent) return sendJson(res, 404, { ok: false, error: 'agent not found', sessionId: id })
        const fn = agent.followup || agent.steer
        if (typeof fn !== 'function') return sendJson(res, 500, { ok: false, error: 'agent has no followup()' })
        await fn.call(agent, { content: [{ type: 'text', text }], source: { kind: 'user' } })
        sendJson(res, 200, { ok: true, sessionId: id, via: 'agent' })
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
        // NOTE: ctx.llm.resolveModelInfo() requires an explicit provider/model.
        // Calling it without one throws NO_ADAPTER and can take down the host,
        // so we deliberately never call it here. Callers may configure a window.
        const contextWindow = null
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
