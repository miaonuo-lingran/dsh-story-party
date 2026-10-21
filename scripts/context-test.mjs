/**
 * AI 读取历史测试：
 *   - 房间 contextMessages=3 → 只把最近 3 条发给模型
 *   - contextMessages=0 → 全部历史
 *
 *   node scripts/context-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.contexttest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.CONTEXT_TEST_PORT || 7368)
let lastMessages = []

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  // 防抖拉长，避免发消息时就自动调用；测试里用 /advance 强制触发
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ messages }) => {
    lastMessages = messages
    return '（旁白）收到。'
  },
})

async function api(path, options = {}) {
  const headers = {}
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postMessages(room, inviteToken, count, gmToken) {
  // 用 GM 发言，省去 join
  for (let index = 0; index < count; index += 1) {
    await api(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      token: gmToken,
      body: { text: `第 ${index + 1} 句` },
    })
  }
  await api(`/api/rooms/${room.id}/advance`, { method: 'POST', token: gmToken })
  await sleep(400)
}

try {
  await server.start()

  // 1. 只读最近 3 条
  const limited = await api('/api/rooms', {
    method: 'POST',
    body: { gmName: '澪', contextMessages: 3 },
  })
  assert.equal(limited.room.contextMessages, 3)
  await postMessages(limited.room, limited.inviteToken, 5, limited.gm.token)
  assert.equal(lastMessages.length, 3)
  console.log('contextMessages=3 → 只发最近 3 条 OK')

  // 2. 全部历史
  const all = await api('/api/rooms', {
    method: 'POST',
    body: { gmName: '澪', contextMessages: 0 },
  })
  assert.equal(all.room.contextMessages, 0)
  await postMessages(all.room, all.inviteToken, 4, all.gm.token)
  assert.equal(lastMessages.length, 4)
  console.log('contextMessages=0 → 全部历史 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
