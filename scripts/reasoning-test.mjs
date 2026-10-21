/**
 * 思维链调试开关测试：
 *   - saveReasoning: true 时房间 JSON 的 debug 里留 reasoning
 *   - reasoning 不进 messages / 房间公开信息（玩家拿不到）
 *   - 关掉后不再新增
 *
 *   node scripts/reasoning-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.reasoningtest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.REASONING_TEST_PORT || 7318)
const SECRET = '导演笔记：先不要揭穿她，下一幕再抛线索'

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  saveReasoning: true,
  loadCards: () => [],
  generate: async () => ({ text: '（旁白）门开了。', reasoning: SECRET }),
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

async function waitForAi(invite, roomId) {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const data = await api(`/api/rooms/${roomId}/messages?since=0&t=${invite}`)
    if (data.messages.some((m) => m.kind === 'ai')) return data
    await sleep(100)
  }
  throw new Error('等不到 AI 回复')
}

try {
  await server.start()

  const settings = await api('/api/settings')
  assert.equal(settings.saveReasoning, true)
  console.log('[/api/settings] 初始 true OK')

  const created = await api('/api/rooms', { method: 'POST', body: { gmName: '澪' } })
  const joined = await api(`/api/rooms/${created.room.id}/join`, {
    method: 'POST',
    body: { name: '小满', inviteToken: created.inviteToken },
  })
  await api(`/api/rooms/${created.room.id}/messages`, {
    method: 'POST',
    token: joined.token,
    body: { text: '门后面是谁？' },
  })
  const history = await waitForAi(created.inviteToken, created.room.id)

  // 1. 落盘里有 reasoning
  const raw = readFileSync(join(workDir, 'rooms', `${created.room.id}.json`), 'utf8')
  assert.ok(raw.includes(SECRET), '房间 JSON 里应有思维链')
  const stored = JSON.parse(raw)
  assert.equal(stored.debug.at(-1).reasoning, SECRET)
  console.log('debug 里存到思维链 OK')

  // 2. 玩家接口看不到（messages / 房间公开信息）
  const historyRaw = JSON.stringify(history)
  assert.ok(!historyRaw.includes(SECRET), 'messages 接口不能带思维链')
  const room = await api(`/api/rooms/${created.room.id}`, { token: joined.token })
  assert.ok(!JSON.stringify(room).includes(SECRET), '房间公开信息不能带思维链')
  console.log('玩家接口不含思维链 OK')

  // 3. 关掉开关后不再新增
  await api('/api/settings', { method: 'POST', body: { saveReasoning: false } })
  const before = JSON.parse(readFileSync(join(workDir, 'rooms', `${created.room.id}.json`), 'utf8')).debug.length
  await api(`/api/rooms/${created.room.id}/messages`, {
    method: 'POST',
    token: joined.token,
    body: { text: '然后呢？' },
  })
  await sleep(1200)
  const after = JSON.parse(readFileSync(join(workDir, 'rooms', `${created.room.id}.json`), 'utf8')).debug.length
  assert.equal(after, before)
  console.log('关闭后不再记录 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
