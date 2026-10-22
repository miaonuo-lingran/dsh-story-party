/**
 * 海龟汤私有汤底测试：
 *   - pack.json 的 truth / truth.md 导入后只留在房主主机
 *   - 列表 / 详情 / 房间公开信息只暴露 hasTruth
 *   - 玩家不能读，GM 能读
 *   - 系统提示词带汤底（让 AI 能准确回答是/不是），揭晓时带原文
 *
 *   node scripts/soup-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.souptest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.SOUP_TEST_PORT || 7374)
const TRUTH = '汤底：女孩其实已经死了，敲门的是她自己的回声。'
const systems = []

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    systems.push(system)
    return '不是。门外的声音停了一拍。'
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  id: 'girl',
  name: '门外的女孩',
  emoji: '🚪',
  playedBy: 'ai',
  description: '雨夜里站在门外的女孩。',
  first_mes: '你听见敲门声的时候，已经过了午夜。',
})

try {
  await server.start()

  const zip = makeZip([
    {
      name: 'pack.json',
      data: JSON.stringify({
        format: 'dsh-galgame-pack',
        formatVersion: 1,
        name: '午夜的敲门声',
        version: '1.0.0',
        mode: 'soup',
        truth: TRUTH,
        scenario: 'scenario.md',
        characters: ['characters/girl.json'],
      }),
    },
    { name: 'scenario.md', data: '午夜，门外有人敲门。' },
    { name: 'characters/girl.json', data: card },
  ])
  const imported = await api('/api/packs', { method: 'POST', raw: true, body: zip })
  assert.equal(imported.pack.mode, 'soup')
  assert.equal(imported.pack.hasTruth, true)

  const list = await api('/api/packs')
  const listed = list.packs.find((item) => item.id === imported.pack.id)
  assert.equal(listed.hasTruth, true)
  assert.equal(JSON.stringify(list).includes('回声'), false, '列表不能带汤底')

  const detail = await api(`/api/packs/${imported.pack.id}`)
  assert.equal(detail.pack.hasTruth, true)
  assert.equal('truth' in detail.pack, false)
  assert.equal(JSON.stringify(detail).includes('回声'), false, '详情不能带汤底')
  console.log('导入：列表 / 详情只暴露 hasTruth OK')

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId: imported.pack.id, gmName: '澪' },
  })
  const roomId = created.room.id
  assert.equal(created.room.pack.mode, 'soup')
  assert.equal(created.room.hasTruth, true)
  assert.equal(JSON.stringify(created.room).includes('回声'), false, '房间公开信息不能带汤底')
  const storedRoom = JSON.parse(await readFile(join(workDir, 'rooms', `${roomId}.json`), 'utf8'))
  assert.match(storedRoom.truth, /回声/, '房主本机存档应保留汤底')
  console.log('建房：公开信息不含汤底，本机存档保留 OK')

  const player = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '小满', role: 'player', inviteToken: created.inviteToken },
  })

  const gmTruth = await api(`/api/rooms/${roomId}/truth`, { token: created.gm.token })
  assert.equal(gmTruth.truth, TRUTH)
  await assert.rejects(
    () => api(`/api/rooms/${roomId}/truth`, { token: player.token }),
    (error) => error.status === 403,
  )
  console.log('汤底只有 GM 能读 OK')

  systems.length = 0
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: created.gm.token })
  await waitFor(() => systems.length > 0, 4000, '汤底进系统提示词')
  assert.match(systems[0], /【汤底（最高机密，只有你知道）】/)
  assert.match(systems[0], /回声/)
  assert.match(systems[0], /是」「不是」「无关」/)
  console.log('系统提示词带汤底与回答限制 OK')

  // 全员投票 → 揭晓：提示词带上原文
  await api(`/api/rooms/${roomId}/vote`, {
    method: 'POST',
    token: created.gm.token,
    body: { action: 'start', kind: 'reveal' },
  })
  await api(`/api/rooms/${roomId}/vote`, {
    method: 'POST',
    token: player.token,
    body: { action: 'cast', agree: true },
  })
  await waitFor(() => systems.length > 1, 4000, '揭晓投票触发 AI')
  const revealSystem = systems.at(-1)
  assert.match(revealSystem, /揭晓汤底/)
  assert.match(revealSystem, /汤底原文/)
  assert.match(revealSystem, /回声/)
  console.log('全票揭晓时提示词带汤底原文 OK')

  const publicAfter = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(created.inviteToken)}`)
  assert.equal(JSON.stringify(publicAfter).includes('回声'), false)
  console.log('揭晓后公开接口仍不泄露汤底 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
