/**
 * Minimal TermQuery client example.
 *
 * Usage:
 *   node examples/termquery-client.mjs "<sessionId>" "页表与段表是什么意思？"
 *
 * It discovers the plugin port from D:/TermQueryData/runtime.json, sends the
 * question, waits, then prints the latest messages.
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const RUNTIME = 'D:/TermQueryData/runtime.json'

function loadBase() {
  const rt = JSON.parse(readFileSync(RUNTIME, 'utf8'))
  return `http://127.0.0.1:${rt.port}${rt.base || '/termquery'}`
}

async function getJson(url, init) {
  const res = await fetch(url, init)
  return res.json()
}

const base = loadBase()
const sessionId = process.argv[2]
const text = process.argv[3] || '这个概念是什么意思？'

console.log('health:', await getJson(`${base}/health`))
console.log('sessions:', await getJson(`${base}/sessions`))

if (!sessionId) {
  console.log('\nTip: pass a sessionId to send a question.')
  process.exit(0)
}

console.log('\nask:', await getJson(`${base}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, text }),
}))

await sleep(4000)
console.log('\nmessages:', JSON.stringify(await getJson(`${base}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=6`), null, 2))
console.log('\npressure:', await getJson(`${base}/pressure?sessionId=${encodeURIComponent(sessionId)}`))
