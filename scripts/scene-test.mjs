/**
 * 舞台 / 选项投票测试：
 *   - 剧情包 assets 通过 /pack-assets 提供（只认图片/音频，拒绝穿越与 svg）
 *   - GM 设置背景 / 立绘 / BGM / 字幕，玩家读到的 scene 一致
 *   - AI 的 <scene> 指令被剥掉并更新舞台
 *   - 选项投票：全员投完 → 平票取第一个 → AI 续写提示带选择结果
 *
 *   node scripts/scene-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.scenetest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.SCENE_TEST_PORT || 7382)
const systems = []
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    systems.push(system)
    return [
      '（旁白）雨更大了，窗玻璃上全是水痕。',
      '<scene>{"background":"assets/bg.png","sprites":[{"characterId":"a","pos":"left","emotion":"smile"}],"caption":"雨夜"}</scene>',
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

const card = (id, name, playedBy) =>
  JSON.stringify({ id, name, emoji: '🎭', playedBy, description: `${name}的设定`, first_mes: '' })

try {
  await server.start()

  const zip = makeZip([
    {
      name: 'pack.json',
      data: JSON.stringify({
        format: 'dsh-galgame-pack',
        formatVersion: 1,
        name: '雨夜舞台',
        version: '1.0.0',
        mode: 'roleplay',
        scenario: 'scenario.md',
        characters: ['characters/a.json', 'characters/b.json'],
      }),
    },
    { name: 'scenario.md', data: '雨夜。' },
    { name: 'characters/a.json', data: card('a', 'A', 'human') },
    { name: 'characters/b.json', data: card('b', 'B', 'ai') },
    { name: 'assets/bg.png', data: PNG },
    { name: 'assets/bgm.mp3', data: Buffer.from('fake-mp3') },
    { name: 'assets/evil.svg', data: Buffer.from('<svg></svg>') },
  ])
  const imported = await api('/api/packs', { method: 'POST', raw: true, body: zip })
  const packId = imported.pack.id

  const asset = await fetch(`http://127.0.0.1:${port}/pack-assets/${packId}/bg.png`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'image/png')
  assert.equal((await asset.arrayBuffer()).byteLength, PNG.length)
  const svg = await fetch(`http://127.0.0.1:${port}/pack-assets/${packId}/evil.svg`)
  assert.equal(svg.status, 404)
  const traversal = await fetch(`http://127.0.0.1:${port}/pack-assets/${packId}/..%2Fpack.json`)
  assert.equal(traversal.status, 404)
  console.log('素材路由：图片可取 / svg 与穿越被拒 OK')

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId, characterId: 'a', gmName: '澪' },
  })
  const roomId = created.room.id
  const joined = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '小满', role: 'player', inviteToken: created.inviteToken },
  })
  const base = `http://127.0.0.1:${port}`
  assert.ok(created.room.pack.assets.some((item) => item.path === 'assets/bg.png'))
  console.log('建房带出 pack.assets OK')

  const scene = await api(`/api/rooms/${roomId}/scene`, {
    method: 'POST',
    token: created.gm.token,
    body: {
      background: 'assets/bg.png',
      bgm: 'assets/bgm.mp3',
      caption: '雨夜',
      sprites: [
        { characterId: 'a', pos: 'left', emotion: 'smile' },
        { characterId: 'b', pos: 'right' },
        { characterId: 'unknown', name: '路人', pos: 'center' },
      ],
    },
  })
  assert.equal(scene.scene.background, 'assets/bg.png')
  assert.equal(scene.scene.bgm, 'assets/bgm.mp3')
  assert.equal(scene.scene.sprites.length, 3)
  assert.equal(scene.scene.sprites[0].name, 'A')
  assert.equal(scene.scene.sprites[1].name, 'B')
  const playerView = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(joined.token)}`)
  assert.equal(playerView.room.scene.background, 'assets/bg.png')
  assert.equal(playerView.room.scene.sprites[0].pos, 'left')
  console.log('GM 设置舞台 → 玩家读到同一份 scene OK')

  const badScene = await api(`/api/rooms/${roomId}/scene`, {
    method: 'POST',
    token: created.gm.token,
    body: { background: 'assets/does-not-exist.png', caption: '空背景' },
  })
  assert.equal(badScene.scene.background, '')
  assert.equal(badScene.scene.caption, '空背景')
  console.log('不存在的背景被忽略 OK')

  // AI <scene> 指令
  systems.length = 0
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: created.gm.token })
  const afterAi = await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(created.inviteToken)}`)
      return data.room.scene && data.room.scene.caption === '雨夜' ? data.room : null
    },
    4000,
    'AI 舞台指令',
  )
  assert.equal(afterAi.scene.background, 'assets/bg.png')
  assert.equal(afterAi.scene.sprites[0].characterId, 'a')
  const history = await api(`/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(created.inviteToken)}`)
  assert.equal(history.messages.some((message) => message.text.includes('<scene>')), false)
  console.log('AI <scene> 指令剥掉并将舞台同步 OK')

  // 选项投票
  const started = await api(`/api/rooms/${roomId}/choice`, {
    method: 'POST',
    token: created.gm.token,
    body: { action: 'start', options: ['去开门', '先躲起来'] },
  })
  assert.equal(started.choice.options.length, 2)
  await api(`/api/rooms/${roomId}/choice`, {
    method: 'POST',
    token: joined.token,
    body: { action: 'cast', optionId: 'o1' },
  })
  const partial = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(joined.token)}`)
  assert.equal(partial.room.choice.voted, 1)
  assert.equal(partial.room.choice.total, 2)
  const finished = await api(`/api/rooms/${roomId}/choice`, {
    method: 'POST',
    token: created.gm.token,
    body: { action: 'cast', optionId: 'o2' },
  })
  assert.equal(finished.passed, true)
  assert.equal(finished.winner, '去开门')
  assert.ok(
    await waitFor(
      async () => {
        const data = await api(`/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(created.inviteToken)}`)
        return data.messages.some((message) => message.kind === 'system' && message.text === '投票结果：去开门')
      },
      3000,
      '投票结果消息',
    ),
  )
  const choicePrompt = await waitFor(
    async () => {
      const hit = systems.find((system) => system.includes('投票选择了「去开门」'))
      return hit || null
    },
    4000,
    '选择结果进入提示词',
  )
  assert.match(choicePrompt, /不要重复投票过程/)
  console.log('选项投票：全员投完、平票取第一个、结果进提示词 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
