/**
 * 子代理测试：
 *   - 剧情包里的其他 AI 角色会进房间名册
 *   - GM 点名 → 子代理出意图 → 主代理定稿成一条消息
 *   - 子代理状态（inScene / lastSeenSeq）落进存档
 *
 *   node scripts/agents-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.agentstest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.AGENTS_TEST_PORT || 7376)
const systems = []
let autoSpeak = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    systems.push(system)
    if (system.includes('角色代理')) return JSON.stringify({ line: '她想问：你为什么会在这里？', location: '电影院', plan: '看完电影去吃夜宵' })
    if (system.includes('接下来由子代理')) return '（B）……你终于来了。'
    if (autoSpeak) return '（旁白）门轴响了一声。\n<speak B>'
    return '（B）……你终于来了。'
  },
})

// ---------- 测试用 zip（stored） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    chunks.push(local, data)
    central.push({ nameBytes, crc, size: data.length, offset })
    offset += local.length + data.length
  }
  const centralStart = offset
  let centralSize = 0
  for (const entry of central) {
    const header = Buffer.alloc(46 + entry.nameBytes.length)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.size, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entry.nameBytes.length, 28)
    header.writeUInt32LE(entry.offset, 42)
    entry.nameBytes.copy(header, 46)
    chunks.push(header)
    centralSize += header.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  chunks.push(eocd)
  return Buffer.concat(chunks)
}

async function api(path, options = {}) {
  const headers = {}
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined && !Buffer.isBuffer(options.body)) {
    headers['content-type'] = 'application/json'
  }
  if (options.raw) headers['content-type'] = 'application/zip'
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? options.body
          : JSON.stringify(options.body),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

const card = (id, name) =>
  JSON.stringify({
    id,
    name,
    emoji: '🙂',
    description: `${name}的设定`,
    personality: '冷静',
    first_mes: '',
  })

try {
  await server.start()

  const zip = makeZip([
    {
      name: 'pack.json',
      data: JSON.stringify({
        format: 'dsh-galgame-pack',
        formatVersion: 1,
        name: '双人小屋',
        version: '1.0.0',
        mode: 'roleplay',
        scenario: 'scenario.md',
        characters: ['characters/a.json', 'characters/b.json'],
      }),
    },
    { name: 'scenario.md', data: '雨夜的小屋，门外有人。' },
    { name: 'characters/a.json', data: card('a', 'A') },
    { name: 'characters/b.json', data: card('b', 'B') },
  ])
  const imported = await api('/api/packs', { method: 'POST', raw: true, body: zip })

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId: imported.pack.id, characterId: 'a', gmName: '澪' },
  })
  const roomId = created.room.id
  assert.equal(created.room.persona.name, 'A')
  assert.equal(created.room.agents.length, 1)
  assert.equal(created.room.agents[0].name, 'B')
  console.log('剧情包其他角色进名册 OK')

  const spoken = await api(`/api/rooms/${roomId}/speak`, {
    method: 'POST',
    token: created.gm.token,
    body: { agentId: 'b' },
  })
  assert.match(spoken.message, /终于来了/)
  assert.equal(systems[0].includes('角色代理'), true)
  assert.match(systems[1], /【你的子代理】/)
  assert.match(systems[1], /接下来由子代理「B」接话/)
  assert.match(systems[1], /电影院/)
  assert.match(systems[1], /吃夜宵/)
  console.log('子代理出意图 → 主代理定稿 OK')

  const history = await api(`/api/rooms/${roomId}/messages?since=0&t=${created.inviteToken}`)
  const last = history.messages.at(-1)
  assert.equal(last.name, 'B')
  assert.equal(last.kind, 'ai')
  console.log('消息署名是子代理 OK')

  const stored = JSON.parse(readFileSync(join(workDir, 'rooms', `${roomId}.json`), 'utf8'))
  const agent = stored.agents.find((item) => item.id === 'b')
  assert.equal(agent.inScene, true)
  assert.ok(agent.lastSeenSeq > 0)
  assert.equal(agent.location, '电影院')
  assert.match(agent.plan, /吃夜宵/)
  console.log('代理状态落存档 OK')

  // 主代理自动点名：回复里带 <speak B> → 剥掉标记 → 自动让 B 接一句
  const systemStart = systems.length
  autoSpeak = true
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: created.gm.token })
  const auto = await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}/messages?since=0&t=${created.inviteToken}`)
      const main = data.messages.find((message) => message.text.includes('门轴响了一声'))
      if (!main) return null
      const index = data.messages.indexOf(main)
      const after = data.messages
        .slice(index + 1)
        .find((message) => message.name === 'B' && message.kind === 'ai')
      return after ? { main, after } : null
    },
    5000,
    '主代理自动点名',
  )
  assert.equal(auto.main.text.includes('<speak'), false, '指令标记不应显示在消息里')
  assert.equal(auto.after.name, 'B')
  const autoSystems = systems.slice(systemStart)
  assert.ok(autoSystems.some((system) => system.includes('【你的子代理】')))
  assert.ok(autoSystems.some((system) => system.includes('接下来由子代理「B」接话')))
  console.log('主代理 <speak B> 自动点名 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
