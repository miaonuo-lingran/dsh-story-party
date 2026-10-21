/**
 * 剧情包导入测试（零依赖 zip）：在 Node 里造一个 stored zip，
 * 走 /api/packs 上传 → 列表 → 建房 → 删除，并验证 zip-slip 被拒。
 *
 *   node scripts/pack-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.packtest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

/** 1×1 PNG，用来验证人物头像随包导入 */
const AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const port = Number(process.env.PACK_TEST_PORT || 7313)

// ---------- 测试用 zip 生成（stored） ----------

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
    local.writeUInt16LE(0, 28)
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
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
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

// ---------- 测试服务器 ----------

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  loadCards: () => [],
  generate: async () => '（旁白）门开了。',
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

async function upload(zip) {
  const response = await fetch(`http://127.0.0.1:${port}/api/packs`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zip,
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

  const packZip = makeZip([
    {
      name: 'pack.json',
      data: JSON.stringify({
        format: 'dsh-galgame-pack',
        formatVersion: 1,
        name: '老式公寓的夏天',
        version: '1.0.0',
        mode: 'soup',
        intro: '固定开场说明：欢迎使用',
        recommendedPlayers: { min: 2, max: 5 },
        map: {
          locations: [
            { id: 'cinema', name: '电影院', direction: 'east', pos: { x: 0.8, y: 0.3 } },
            { id: 'dorm', name: '宿舍', direction: 'west' },
            { id: 'room301', name: '宿舍 301', direction: 'north', parent: 'dorm' },
          ],
          routes: [{ from: 'cinema', to: 'dorm', label: '步行 10 分钟' }],
        },
        author: '测试作者',
        description: '楼下学妹和你的同居日常',
        scenario: 'scenario.md',
        characters: ['characters/1.json'],
        assets: ['assets/bg.png'],
      }),
    },
    { name: 'scenario.md', data: '老式公寓，楼道灯坏了一半，她在楼下敲门。' },
    {
      name: 'characters/1.json',
      data: JSON.stringify({
        id: 'xiaoyou',
        name: '小柚',
        emoji: '🍊',
        gender: 'female',
        playedBy: 'human',
        playerBrief: '你今晚要隐瞒一件事。',
        likes: '奶茶、电影',
        favoritePlaces: ['cinema'],
        description: '住楼下的学妹。',
        personality: '嘴硬心软。',
        first_mes: '「…不是特意等你的。」',
        rules: '叫学长。',
        behavior: '拽衣角。',
        avatar: AVATAR,
        relations: [{ target: 'you', name: '学长', relation: '青梅竹马，嘴硬心软' }],
      }),
    },
    { name: 'assets/bg.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ])

  // 1. 上传
  const imported = await upload(packZip)
  assert.equal(imported.pack.name, '老式公寓的夏天')
  assert.equal(imported.pack.mode, 'soup')
  assert.equal(imported.pack.recommendedPlayers.min, 2)
  assert.equal(imported.pack.recommendedPlayers.max, 5)
  assert.equal(imported.pack.mapCounts.locations, 3)
  assert.equal(imported.pack.mapCounts.routes, 1)
  assert.equal(imported.pack.characters[0].playedBy, 'human')
  assert.equal(imported.pack.characters[0].hasPlayerBrief, true)
  assert.equal(imported.pack.characters.length, 1)
  assert.equal(imported.pack.characters[0].name, '小柚')
  console.log('[/api/packs] 导入 OK：' + imported.pack.id)

  // 2. 列表 + 详情
  const list = await api('/api/packs')
  assert.ok(list.packs.some((pack) => pack.id === imported.pack.id))
  const detail = await api(`/api/packs/${imported.pack.id}`)
  assert.equal(detail.pack.characters[0].firstMes, '「…不是特意等你的。」')
  console.log('[/api/packs] 列表与详情 OK')

  // 3. 用房里的角色建房
  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId: imported.pack.id, characterId: 'xiaoyou', gmName: '澪' },
  })
  assert.equal(created.room.persona.name, '小柚')
  assert.equal(created.room.persona.gender, 'female')
  assert.equal(created.room.persona.avatar, AVATAR)
  assert.equal(created.room.persona.relations[0].relation, '青梅竹马，嘴硬心软')
  assert.equal(created.room.persona.relations[0].name, '学长')
  assert.equal(created.room.pack.name, '老式公寓的夏天')
  assert.equal(created.room.pack.mode, 'soup')
  assert.equal(created.room.pack.map.locations.length, 3)
  assert.equal(created.room.pack.map.locations.find((item) => item.id === 'room301').parent, 'dorm')
  assert.equal(created.room.pack.map.locations.find((item) => item.id === 'cinema').pos.x, 0.8)
  assert.match(created.room.scenario, /楼道灯坏了一半/)
  const history = await api(`/api/rooms/${created.room.id}/messages?since=0&t=${created.inviteToken}`)
  assert.equal(history.messages[0].text, '固定开场说明：欢迎使用')
  assert.equal(history.messages[1].text, '「…不是特意等你的。」')
  console.log('用房 OK：人设=小柚，场景来自剧情包，开场白已入流')

  // 4. zip-slip 被拒
  const evil = makeZip([
    { name: 'pack.json', data: JSON.stringify({ format: 'dsh-galgame-pack', name: 'x', characters: [] }) },
    { name: '../evil.txt', data: 'x' },
  ])
  await assert.rejects(upload(evil), (error) => error.status === 400)
  console.log('zip-slip 拒绝 OK')

  // 5. 删除
  await api(`/api/packs/${imported.pack.id}`, { method: 'DELETE' })
  await assert.rejects(api(`/api/packs/${imported.pack.id}`), (error) => error.status === 404)
  console.log('删除 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
