/**
 * 个人本存档 / 回滚 / 长期记忆测试：
 *   - AI 的 <memory> 合并进 room.story.memory，并从正文剥掉
 *   - 每回合自动存档；手动存档最多 5 个
 *   - 读档整份恢复消息 / story / 摘要
 *   - 回退一步回到 AI 开口之前
 *   - 手动 PATCH 记忆
 *
 *   node scripts/save-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.savetest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.SAVE_TEST_PORT || 7386)
const systems = []

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    systems.push(system)
    return [
      '（旁白）雨声停了一拍，小柚把杯子放回桌上。',
      '<memory>{"facts":["小柚住在隔壁"],"relations":{"小柚":"开始信任你"},"affection":{"小柚":1},"items":["旧钥匙"]}</memory>',
    ].join('\n')
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(80)
  }
  throw new Error(`超时：${label}${last ? '（' + last.message + '）' : ''}`)
}

try {
  await server.start()

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { cardId: 'builtin-deepseek', gmName: '澪', solo: true },
  })
  const roomId = created.room.id
  const token = created.gm.token
  const query = `t=${encodeURIComponent(created.inviteToken)}`

  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token,
    body: { text: '我回来了。' },
  })
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token })
  const afterTurn = await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}?${query}`)
      return data.room.story.memory?.facts?.length > 0 ? data.room : null
    },
    4000,
    'AI 记忆',
  )
  assert.deepEqual(afterTurn.story.memory.facts, ['小柚住在隔壁'])
  assert.equal(afterTurn.story.memory.relations['小柚'], '开始信任你')
  assert.equal(afterTurn.story.memory.affection['小柚'], 1)
  assert.deepEqual(afterTurn.story.memory.items, ['旧钥匙'])
  const history = await api(`/api/rooms/${roomId}/messages?since=0&${query}`)
  assert.equal(history.messages.some((message) => message.text.includes('<memory>')), false)
  console.log('AI <memory> 合并 + 正文剥离 OK')

  const saves1 = await api(`/api/rooms/${roomId}/saves`, { token })
  assert.equal(saves1.auto.kind, 'auto')
  assert.equal(saves1.saves.length, 0)
  assert.equal(saves1.auto.turn, 0)

  const manual = await api(`/api/rooms/${roomId}/saves`, {
    method: 'POST',
    token,
    body: { name: '雨夜存档' },
  })
  assert.equal(manual.save.name, '雨夜存档')
  assert.equal(manual.saves.length, 1)
  console.log('自动存档 + 手动存档 OK')

  // 再走一轮，然后读回手动存档
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token,
    body: { text: '我把钥匙放在桌上。' },
  })
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token })
  await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}?${query}`)
      return data.room.story.turn >= 2 ? data.room : null
    },
    4000,
    '第二回合',
  )
  const loaded = await api(`/api/rooms/${roomId}/saves/${manual.save.id}/load`, {
    method: 'POST',
    token,
  })
  assert.equal(loaded.room.story.turn, 1)
  const restored = await api(`/api/rooms/${roomId}?${query}`)
  assert.equal(restored.room.story.turn, 1)
  const restoredHistory = await api(`/api/rooms/${roomId}/messages?since=0&${query}`)
  assert.equal(restoredHistory.messages.length, manual.save.messageCount)
  console.log('读档整份恢复消息 / story OK')

  // 读档后自动存档已清空；再走一轮，测试回退一步
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token,
    body: { text: '我把钥匙放在桌上。' },
  })
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token })
  await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}?${query}`)
      return data.room.story.turn >= 2 ? data.room : null
    },
    4000,
    '读档后再走一轮',
  )
  const beforeRewind = await api(`/api/rooms/${roomId}/messages?since=0&${query}`)
  const rewound = await api(`/api/rooms/${roomId}/rewind`, { method: 'POST', token })
  assert.equal(rewound.rewound, true)
  const afterRewind = await api(`/api/rooms/${roomId}/messages?since=0&${query}`)
  assert.ok(afterRewind.messages.length < beforeRewind.messages.length)
  assert.notEqual(afterRewind.messages.at(-1).kind, 'ai')
  console.log('回退一步到 AI 开口前 OK')

  // 手动改记忆
  const patched = await api(`/api/rooms/${roomId}/memory`, {
    method: 'PATCH',
    token,
    body: {
      facts: ['小柚住在隔壁', '你们一起吃了晚饭'],
      relations: { 小柚: '信任你' },
      affection: { 小柚: 3 },
      items: ['旧钥匙', '雨伞'],
    },
  })
  assert.deepEqual(patched.memory.facts, ['小柚住在隔壁', '你们一起吃了晚饭'])
  assert.equal(patched.memory.affection['小柚'], 3)
  const memory = await api(`/api/rooms/${roomId}/memory`, { token })
  assert.deepEqual(memory.memory.items, ['旧钥匙', '雨伞'])
  console.log('手动 PATCH 长期记忆 OK')

  // 删除手动存档
  const afterDelete = await api(`/api/rooms/${roomId}/saves/${manual.save.id}`, {
    method: 'DELETE',
    token,
  })
  assert.equal(afterDelete.saves.length, 0)
  console.log('删除存档 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
