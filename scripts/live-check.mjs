/**
 * 真机联调：对着**跑在 DSH 里的插件**（127.0.0.1:7302）走一遍真实模型链路。
 *
 *   node scripts/live-check.mjs
 *   $env:GALGAME_ROOM_BASE='http://127.0.0.1:7302'; node scripts/live-check.mjs
 *
 * 与 host-sim 的区别：这里没有桩，AI 回复来自 DSH 的真实模型；
 * 所以给的时间更宽，并且「AI 沉默」时会用 GM 推进强制它开口。
 */
import assert from 'node:assert/strict'

const base = process.env.GALGAME_ROOM_BASE || 'http://127.0.0.1:7302'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data.error ?? ''}`)
  return data
}

async function waitAi(invite, roomId, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const data = await api(`/api/rooms/${roomId}/messages?since=0&t=${invite}`)
    const ai = [...data.messages].reverse().find((m) => m.kind === 'ai')
    if (ai) return ai
    await sleep(500)
  }
  return null
}

const network = await api('/api/network')
assert.ok(Number.isInteger(network.port), '插件应已监听并返回 /api/network')
console.log(`[live] 端口 ${network.port}，地址 ${(network.addresses || []).join(', ') || '（无局域网地址）'}`)

const created = await api('/api/rooms', {
  method: 'POST',
  body: { title: '真机联调', gmName: '澪' },
})
const roomId = created.room.id
const gmToken = created.gm.token
console.log(`[live] 建房 ${roomId}`)

const joined = await api(`/api/rooms/${roomId}/join`, {
  method: 'POST',
  body: { name: '小满', role: 'player', inviteToken: created.inviteToken },
})
console.log('[live] 玩家加入')

await api(`/api/rooms/${roomId}/messages`, {
  method: 'POST',
  token: joined.token,
  body: { text: '门后面是谁在呼吸？我们要不要进去看看。' },
})
console.log('[live] 已发言，等真实模型判断（最多 30 秒）…')

let ai = await waitAi(created.inviteToken, roomId, 30000)
let forced = false
if (!ai) {
  console.log('[live] 模型选择了沉默，用 GM 推进强制开口…')
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: gmToken })
  forced = true
  ai = await waitAi(created.inviteToken, roomId, 30000)
}

if (!ai) {
  console.error('[live] 失败：30 秒内没有 AI 消息。看看 DSH 日志里 [galgame-room] 或 llm 相关的错误。')
  process.exit(1)
}

console.log('\n[live] 真实模型回复：')
console.log('  ' + ai.text)
console.log(`  （seq=${ai.seq}${forced ? '，由 GM 推进强制触发' : '，由模型自己判断接话'}）`)

await api(`/api/rooms/${roomId}`, { method: 'DELETE', token: gmToken })
console.log('\n[live] 通过，测试房间已关闭。')
