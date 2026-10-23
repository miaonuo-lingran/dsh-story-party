/**
 * 个人本测试：
 *   - 剧情包 solo 段（模式 / 前提 / 主角 / 章节 / 关键选项 / 结局）导入
 *   - 单人房初始化 story 状态
 *   - AI 的 <choices> 被剥掉，变成 room.story.choices
 *   - 系统提示词带章节目标与关键选项，上下文用「主角」标注
 *
 *   node scripts/solo-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.solotest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.SOLO_TEST_PORT || 7376)
const calls = []

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system, messages }) => {
    calls.push({ system, messages })
    return [
      '（旁白）雨声停了一拍，小柚把杯子放回桌上。',
      '<choices>',
      '- 追问她为什么搬来',
      '- 先转移话题，问她饿不饿',
      '</choices>',
    ].join('\n')
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, options = {}) {
  const headers = {}
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined && !Buffer.isBuffer(options.body)) headers['content-type'] = 'application/json'
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

// ---------- stored zip ----------

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

const card = JSON.stringify({
  id: 'yuzu',
  name: '小柚',
  emoji: '🍊',
  gender: 'female',
  playedBy: 'ai',
  description: '住在隔壁的学妹。',
  first_mes: '',
})

const playerCard = JSON.stringify({
  id: 'player',
  name: '澪',
  emoji: '🌙',
  gender: 'female',
  playedBy: 'human',
  playerBrief: '你是这个房间的住户。',
  description: '刚搬进旧公寓的人。',
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
        name: '旧公寓的夏天',
        version: '1.0.0',
        mode: 'roleplay',
        scenario: 'scenario.md',
        characters: ['characters/yuzu.json', 'characters/player.json'],
        solo: {
          mode: 'guided',
          protagonist: 'player',
          premise: '你和学妹在旧公寓同居的第三个月。',
          chapters: [
            {
              id: 'ch1',
              title: '雨夜',
              goal: '让小柚放下戒心',
              choices: ['追问她为什么搬来', '先转移话题'],
            },
          ],
          endings: [{ id: 'good', title: '雨停了', condition: '好感度达到 5，且聊过她的过去' }],
        },
      }),
    },
    { name: 'scenario.md', data: '旧公寓，雨夜。' },
    { name: 'characters/yuzu.json', data: card },
    { name: 'characters/player.json', data: playerCard },
  ])

  const imported = await api('/api/packs', { method: 'POST', raw: true, body: zip })
  assert.equal(imported.pack.solo.mode, 'guided')
  assert.equal(imported.pack.solo.chapters, 1)
  assert.equal(imported.pack.solo.endings, 1)
  const detail = await api(`/api/packs/${imported.pack.id}`)
  assert.equal(detail.pack.solo.chapters[0].choices.length, 2)
  console.log('剧情包 solo 段导入 / 列表摘要 OK')

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId: imported.pack.id, characterId: 'yuzu', gmName: '澪', solo: true },
  })
  const roomId = created.room.id
  assert.equal(created.room.solo, true)
  assert.equal(created.room.persona, null)
  assert.equal(created.room.story.mode, 'guided')
  assert.equal(created.room.story.protagonist.id, 'player')
  assert.equal(created.room.story.protagonist.name, '澪')
  assert.equal(created.room.agents.length, 1)
  assert.equal(created.room.story.chapter.title, '雨夜')
  assert.equal(created.room.story.chapter.goal, '让小柚放下戒心')
  assert.equal(created.room.story.choices.length, 0)
  console.log('单人房 story 初始化 OK')

  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: created.gm.token,
    body: { text: '我回来了。' },
  })
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: created.gm.token })
  const after = await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(created.inviteToken)}`)
      return data.room.story.choices.length > 0 ? data.room : null
    },
    4000,
    'AI 选项',
  )
  assert.deepEqual(after.story.choices, ['追问她为什么搬来', '先转移话题，问她饿不饿'])
  assert.equal(after.story.turn, 1)
  console.log('AI <choices> 剥掉正文、写入 story.choices OK')

  const history = await api(`/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(created.inviteToken)}`)
  const ai = history.messages.find((message) => message.kind === 'ai')
  assert.equal(ai.text.includes('<choices>'), false)
  assert.match(ai.text, /雨声停了一拍/)

  const prompt = calls.at(-1).system
  assert.match(prompt, /【个人本】/)
  assert.match(prompt, /主角：澪（由玩家扮演）/)
  assert.match(prompt, /小柚（AI 扮演）/)
  assert.match(prompt, /当前章节：雨夜/)
  assert.match(prompt, /章节目标：让小柚放下戒心/)
  assert.match(prompt, /追问她为什么搬来/)
  assert.match(prompt, /<choices>/)
  assert.match(prompt, /不要替玩家做决定/)
  const userContext = calls.at(-1).messages.find((message) => message.role === 'user')
  assert.match(userContext.content, /澪（主角）：我回来了。/)
  console.log('系统提示词带章节 / 关键选项 / 主角标注 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
