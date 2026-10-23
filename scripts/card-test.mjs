/**
 * 人设卡集成测试（不需要 DSH）：给房间服务注入一张假卡，
 * 验证 /api/cards、建房带 cardId、开场白、system prompt 里的人设段落。
 *
 *   node scripts/card-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.cardtest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.CARD_TEST_PORT || 7310)
const card = {
  id: 'c1',
  name: '小柚',
  emoji: '🍊',
  description: '十七岁，住楼下的学妹。',
  personality: '嘴硬心软，被夸会结巴。',
  scenario: '老式公寓的楼道，灯坏了一半。',
  first_mes: '（敲门）喏，趁热。',
  rules: '叫用户「学长」。',
  behavior: '紧张时会拽衣角。',
}

const calls = []
const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  loadCards: () => [card],
  generate: async ({ system, messages }) => {
    calls.push({ system, messages })
    return '（旁白）门开了，她别过头去。'
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

try {
  await server.start()

  // 1. 角色库：内置鲸鱼娘 + 注入的小柚
  const list = await api('/api/cards')
  assert.equal(list.cards.length, 2)
  const injected = list.cards.find((item) => item.id === 'c1')
  assert.equal(injected.name, '小柚')
  assert.equal(injected.emoji, '🍊')
  const builtin = list.cards.find((item) => item.id === 'builtin-deepseek')
  assert.equal(builtin.name, '鲸鱼娘')
  assert.equal(builtin.avatar, '/plugin-assets/characters/deepseek/portraits/neutral.webp')
  const portrait = await fetch(
    `http://127.0.0.1:${port}/plugin-assets/characters/deepseek/portraits/neutral.webp`,
  )
  assert.equal(portrait.status, 200)
  assert.equal(portrait.headers.get('content-type'), 'image/webp')
  assert.ok((await portrait.arrayBuffer()).byteLength > 1000)
  console.log('[/api/cards] 内置鲸鱼娘 + cosplay 卡 OK，内置立绘路由 OK')

  // 1b. 内置角色也能直接建房
  const builtinRoom = await api('/api/rooms', {
    method: 'POST',
    body: { cardId: 'builtin-deepseek', gmName: '澪' },
  })
  assert.equal(builtinRoom.room.persona.name, '鲸鱼娘')
  assert.equal(
    builtinRoom.room.persona.avatar,
    '/plugin-assets/characters/deepseek/portraits/neutral.webp',
  )
  console.log('内置鲸鱼娘建房 OK')

  // 2. 建房带 cardId → 人设 / 标题 / 场景 / 开场白
  const created = await api('/api/rooms', { method: 'POST', body: { cardId: 'c1', gmName: '澪' } })
  assert.equal(created.room.persona.name, '小柚')
  assert.equal(created.room.aiName, '小柚')
  assert.equal(created.room.scenario, card.scenario)
  const opening = await api(`/api/rooms/${created.room.id}/messages?since=0&t=${created.inviteToken}`)
  assert.equal(opening.messages[0].kind, 'ai')
  assert.equal(opening.messages[0].text, card.first_mes)
  assert.equal(opening.messages[0].name, '小柚')
  console.log('建房带卡 OK：人设=小柚，开场白已入消息流')

  // 3. 不存在的卡 → 400
  await assert.rejects(
    api('/api/rooms', { method: 'POST', body: { cardId: 'nope' } }),
    (error) => error.status === 400,
  )
  console.log('未知卡 400 OK')

  // 4. 发言 → system prompt 带上人设段落
  const joined = await api(`/api/rooms/${created.room.id}/join`, {
    method: 'POST',
    body: { name: '小满', inviteToken: created.inviteToken },
  })
  await api(`/api/rooms/${created.room.id}/messages`, {
    method: 'POST',
    token: joined.token,
    body: { text: '门后面是谁？' },
  })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.ok(calls.length >= 1, '应该调用过模型')
  const system = calls[0].system
  assert.ok(system.includes('【角色设定】'), 'system 应有角色设定')
  assert.ok(system.includes('小柚'))
  assert.ok(system.includes('嘴硬心软'))
  assert.ok(system.includes(card.scenario), 'system 里应有卡的场景')
  console.log('system prompt 人设段落 OK（' + system.length + ' 字）')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
