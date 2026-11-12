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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

export const name = 'termquery'

// webServer is the only hard dependency; agents/sessions/tokenMeter/llm are
// read defensively so the plugin still loads in a partial composition.
export const inject = ['webServer']

const VERSION = '0.2.0'
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

/** Flatten a message `content` union (string | parts[]) into plain text. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  return ''
}

/** First non-empty line, trimmed to `max` code points. */
function firstLine(text, max = 48) {
  // PDF/粘贴文本常把一整个词拆成「一行一个字」，先把被换行/空格切开的
  // 中文字符拼回去，再去取第一行。
  const joined = String(text || '')
    .replace(/\r/g, '\n')
    .replace(/([\u4e00-\u9fff])[\s]+(?=[\u4e00-\u9fff])/g, '$1')
  const line = joined
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!line) return ''
  const clean = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ')
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

/** DSH injects request-context blocks as user messages; keep them out of cards. */
function isMetaUser(text) {
  const t = String(text || '')
  return (
    /^Time sampled while preparing/i.test(t) ||
    /^(current|the)\s+(runtime|workspace|session)\s+context\b/i.test(t) ||
    /^<[a-z][\w-]*[\s>]/i.test(t) ||
    /^\[?(system|tool|assistant)\b/i.test(t)
  )
}

/**
 * Turn a raw first prompt into a sidebar-style title: our own injected prompts
 * ("操作系统 是什么意思？…") should collapse to just the term.
 */
function titleFromPrompt(text) {
  let s = firstLine(text, 60)
  s = s.replace(/^请\s*/, '')
  const cut = s.search(/是什么意思|具体是怎么实现|具体实现流程|解决了什么|相关的?名词|应用领域/)
  if (cut > 0) s = s.slice(0, cut)
  return s.replace(/[\s，,。.、：:；;？?！!]+$/, '').slice(0, 48) || firstLine(text, 48)
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
          { plugin: 'dsh-plugin-termquery', version: VERSION, port, base, startedAt: nowIso() },
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
        version: VERSION,
        port,
        base,
        services: {
          agents: !!svc('agents'),
          sessions: !!svc('sessions'),
          sessionController: !!svc('sessionController'),
          tokenMeter: !!svc('tokenMeter'),
          llm: !!svc('llm'),
          sessionControllerApi: (() => {
            const sc = svc('sessionController')
            if (!sc) return []
            try {
              return Object.getOwnPropertyNames(Object.getPrototypeOf(sc)).filter((k) => k !== 'constructor')
            } catch {
              return []
            }
          })(),
        },
        time: nowIso(),
      })
    })

    // Session cards need a human title, a preview and the bound model, exactly
    // like the DSH sidebar. SessionSummary carries none of that, so we read the
    // durable log through sessionController.inspect() (cold-safe) and cache the
    // result per (id, updatedAt).
    const summaryCache = new Map()

    async function inspectEvents(id) {
      const sc = svc('sessionController')
      if (sc && typeof sc.inspect === 'function') {
        try {
          const insp = await sc.inspect(id, new AbortController().signal)
          if (insp && Array.isArray(insp.events) && insp.events.length) return insp.events
        } catch {}
      }
      return readLogEvents(id)
    }

    // ---- durable-log fallback -------------------------------------------
    // Some builds do not expose sessionController.inspect to plugins, so we can
    // read the same source of truth ourselves: <home>/.dsh/sessions/<ws>/<id>/
    // session.v4.jsonl.zstd, a concatenation of zstd frames holding JSONL.
    const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    // Node >=22.15 exposes zstd on zlib; older runtimes simply skip the fallback
    // instead of failing the whole module import.
    const zstdDecompressSync =
      typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null

    function inflateFrames(buf) {
      const at = []
      let i = 0
      while ((i = buf.indexOf(zstdMagic, i)) !== -1) {
        at.push(i)
        i += 4
      }
      if (!at.length) return buf.toString('utf8')
      if (typeof zstdDecompressSync !== 'function') return ''
      let out = ''
      for (let k = 0; k < at.length; k++) {
        const start = at[k]
        const end = k + 1 < at.length ? at[k + 1] : buf.length
        try {
          out += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        } catch {}
      }
      return out
    }

    function sessionLogPath(id) {
      const root = join(homedir(), '.dsh', 'sessions')
      try {
        for (const ws of readdirSync(root)) {
          for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
            const p = join(root, ws, id, name)
            if (existsSync(p)) return p
          }
        }
      } catch {}
      return null
    }

    const logCache = new Map()

    function readLogEvents(id) {
      const p = sessionLogPath(id)
      if (!p) return []
      try {
        const st = readFileSync(p)
        const key = `${p}@${st.length}`
        const hit = logCache.get(id)
        if (hit && hit.key === key) return hit.events
        const text = p.endsWith('.zstd') ? inflateFrames(st) : st.toString('utf8')
        const events = []
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const o = JSON.parse(line)
            if (o && o.type && o.type !== 'session') events.push(o)
          } catch {}
        }
        logCache.set(id, { key, events })
        if (logCache.size > 60) logCache.delete(logCache.keys().next().value)
        return events
      } catch {
        return []
      }
    }

    function messageTextOf(data) {
      const c = data?.content ?? data?.message?.content ?? data
      return contentText(c)
    }

    async function deriveSummary(id, updatedAt) {
      const key = `${id}@${updatedAt ?? 0}`
      const hit = summaryCache.get(id)
      if (hit && hit.key === key) return hit.value
      let value = { title: '', preview: '', messageCount: 0, lastPromptAt: null, source: 'none' }

      // Live session: deriveMessages() is the cheapest and matches the UI.
      try {
        const live = svc('sessions')?.get ? svc('sessions').get(id) : null
        if (live && typeof live.deriveMessages === 'function') {
          const msgs = live.deriveMessages()
          const users = msgs
            .filter((m) => m?.role === 'user')
            .map((m) => contentText(m.content).trim())
            .filter((t) => t && !isMetaUser(t))
          value.messageCount = msgs.length
          if (users.length) {
            value.preview = firstLine(users[users.length - 1], 72)
            value.title = titleFromPrompt(users[0])
            value.source = 'live'
          }
        }
      } catch {}

      // Cold session (or still empty): read the durable event log.
      if (!value.title) {
        try {
          const events = await inspectEvents(id)
          if (events.length) {
            let title = ''
            let firstUser = ''
            let lastUser = ''
            let lastTime = null
            for (const e of events) {
              const t = e?.type || ''
              if (t === 'session/title') {
                const d = e.data || {}
                title = String(d.title ?? d.value ?? d.text ?? '').trim() || title
              } else if (t === 'user/message') {
                const text = messageTextOf(e.data).trim()
                if (text && !isMetaUser(text)) {
                  if (!firstUser) firstUser = text
                  lastUser = text
                }
              }
              if (typeof e?.time === 'number') lastTime = e.time
            }
            value.messageCount = value.messageCount || events.length
            value.title = title || (firstUser ? titleFromPrompt(firstUser) : '')
            value.preview = value.preview || (lastUser ? firstLine(lastUser, 72) : '')
            value.lastPromptAt = lastTime
            value.source = 'log'
          }
        } catch {}
      }

      summaryCache.set(id, { key, value })
      if (summaryCache.size > 200) {
        const first = summaryCache.keys().next().value
        summaryCache.delete(first)
      }
      return value
    }

    reg('/sessions', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      try {
        const q = queryOf(req)
        const detail = q.get('detail') !== '0'
        const limit = Math.max(1, Math.min(200, parseInt(q.get('limit') || '60', 10) || 60))
        const out = []
        const sc = svc('sessionController')
        if (sc?.list) {
          const r = await sc.list({}, new AbortController().signal)
          for (const it of r?.items || []) {
            const row = {
              id: it.sessionId,
              running: !!it.running,
              blank: !!it.blank,
              updatedAt: it.updatedAt ?? null,
              cwd: it.cwd ?? null,
              model: it.projections?.values?.modelSelection?.next ?? null,
              title: '',
              preview: '',
              messageCount: 0,
            }
            if (detail && !it.blank) {
              const s = await deriveSummary(it.sessionId, it.updatedAt)
              row.title = s.title
              row.preview = s.preview
              row.messageCount = s.messageCount
            }
            out.push(row)
            if (out.length >= limit) break
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
        sendJson(res, 200, { ok: true, sessions: out, detail, count: out.length })
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

    reg('/events', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      const q = queryOf(req)
      const id = q.get('sessionId')
      if (!id) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
      const limit = Math.max(1, Math.min(200, parseInt(q.get('limit') || '30', 10) || 30))
      const events = await inspectEvents(id)
      const tail = events.slice(-limit).map((e) => ({
        type: e?.type ?? null,
        seq: e?.seq ?? null,
        time: e?.time ?? null,
        data: e?.data ?? null,
      }))
      sendJson(res, 200, {
        ok: true,
        sessionId: id,
        total: events.length,
        types: [...new Set(events.map((e) => e?.type))].slice(0, 40),
        events: tail,
      })
    })

    reg('/messages', async (req, res) => {
      if (req.method === 'OPTIONS') return sendEmpty(res, 204)
      const q = queryOf(req)
      const id = q.get('sessionId')
      if (!id) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
      const limit = Math.max(1, Math.min(200, parseInt(q.get('limit') || '20', 10) || 20))

      let msgs = []
      // 1) Live session: the derived history the UI itself renders.
      try {
        const live = svc('sessions')?.get ? svc('sessions').get(id) : null
        if (live && typeof live.deriveMessages === 'function') {
          msgs = live.deriveMessages().map((m) => ({ role: m?.role ?? null, content: m?.content ?? null }))
        }
      } catch {}
      // 2) Cold session: rebuild the message list from the durable log.
      if (!msgs.length) {
        const events = await inspectEvents(id)
        for (const e of events) {
          const t = e?.type
          if (t === 'user/message') {
            const raw = e.data?.content ?? e.data ?? ''
            if (isMetaUser(contentText(raw).trim())) continue
            msgs.push({ role: 'user', content: raw })
          } else if (t === 'assistant/message') {
            const d = e.data || {}
            msgs.push({ role: 'assistant', content: d.content ?? d.message?.content ?? d.text ?? '' })
          }
        }
      }
      if (!msgs.length) return sendJson(res, 404, { ok: false, error: 'session not found', sessionId: id })
      // Assistant turns that only carry reasoning/tool parts have no text;
      // they would render as blank bubbles in the client.
      msgs = msgs.filter((m) => contentText(m.content).trim().length > 0)
      if (!msgs.length) return sendJson(res, 404, { ok: false, error: 'session not found', sessionId: id })
      const tail = msgs.slice(-limit)
      sendJson(res, 200, { ok: true, sessionId: id, total: msgs.length, messages: tail })
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
