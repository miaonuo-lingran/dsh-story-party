/**
 * 剧本杀测试：
 *   - 剧情包 mode=mystery → 房间带阶段机（阅读 → 自我介绍 → … → 复盘）
 *   - 角色本：玩家只能看到自己那份，GM 能看全部
 *   - 私聊：玩家只能私聊 GM，第三方在历史与 SSE 里都看不到
 *   - 真相只通过 GM 接口返回，不进公开房间
 *
 *   node scripts/mystery-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.mysterytest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.MYSTERY_TEST_PORT || 7372)
const systems = []

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    systems.push(system)
    return '（旁白）窗外的雨声停了一拍，客厅里没有人先开口。'
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

const card = (id, name, secret, playedBy = 'human') =>
  JSON.stringify({
    id,
    name,
    emoji: '🎭',
    gender: 'female',
    playedBy,
    playerBrief: `${name}的玩家须知`,
    secret,
    description: `${name}的设定`,
    first_mes: '',
  })

/** 收集一小段 SSE 文本（用于验证私聊不会广播给第三方） */
async function readSse(token, roomId, ms = 900) {
  const controller = new AbortController()
  const response = await fetch(
    `http://127.0.0.1:${port}/api/rooms/${roomId}/events?t=${encodeURIComponent(token)}&since=0`,
    { signal: controller.signal },
  )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    /* abort 是预期的结束方式 */
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return text
}

try {
  await server.start()

  const zip = makeZip([
    {
      name: 'pack.json',
      data: JSON.stringify({
        format: 'dsh-galgame-pack',
        formatVersion: 1,
        name: '雨夜别墅',
        version: '1.0.0',
        mode: 'mystery',
        truth: '凶手是 A：她用客厅的座钟砸了 B 的后脑。',
        scenario: 'scenario.md',
        characters: ['characters/a.json', 'characters/b.json', 'characters/c.json'],
      }),
    },
    { name: 'scenario.md', data: '暴雨封山的别墅，主人 B 死在客厅。' },
    { name: 'characters/a.json', data: card('a', 'A', '你是凶手。你用过座钟，之后把钟拨慢了十分钟。') },
    { name: 'characters/b.json', data: card('b', 'B', '你是侦探。你发现座钟的指针停在 21:10。') },
    { name: 'characters/c.json', data: card('c', 'C', '你目击有人从客厅出来。', 'ai') },
  ])
  const imported = await api('/api/packs', { method: 'POST', raw: true, body: zip })
  assert.equal(imported.pack.mode, 'mystery')
  assert.equal(imported.pack.hasTruth, true)
  assert.equal(imported.pack.hasSecrets, true)

  const detail = await api(`/api/packs/${imported.pack.id}`)
  assert.equal(detail.pack.hasTruth, true)
  assert.equal('truth' in detail.pack, false, '剧情包详情不能返回汤底正文')
  assert.equal(detail.pack.characters.some((item) => 'secret' in item), false, '列表详情不能返回角色本')
  assert.equal(detail.pack.characters.some((item) => 'playerBrief' in item), false, '详情不能返回玩家须知')
  console.log('剧情包：mode / hasTruth / hasSecrets OK，详情不泄露正文')

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { packId: imported.pack.id, characterId: 'a', gmName: '澪' },
  })
  const roomId = created.room.id
  assert.equal(created.room.mode, 'mystery')
  assert.equal(created.room.phase.id, 'reading')
  assert.equal(created.room.cast.length, 3)
  assert.equal('truth' in created.room, false)
  assert.equal(created.room.hasTruth, true)
  assert.equal(JSON.stringify(created.room).includes('凶手是 A'), false)
  assert.equal(created.room.cast.some((item) => 'secret' in item), false)
  console.log('建房：阶段机 reading / 名单可见 / 真相与角色本不泄露 OK')

  const player1 = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '小满', role: 'player', inviteToken: created.inviteToken },
  })
  const player2 = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '阿澈', role: 'player', inviteToken: created.inviteToken },
  })

  const claimedA = await api(`/api/rooms/${roomId}/roles`, {
    method: 'POST',
    token: player1.token,
    body: { action: 'claim', characterId: 'a' },
  })
  const ownA = claimedA.cast.find((item) => item.id === 'a')
  assert.equal(claimedA.myCharacterId, 'a')
  assert.match(ownA.secret, /凶手/)
  assert.equal(ownA.assignee.name, '小满')
  const otherB = claimedA.cast.find((item) => item.id === 'b')
  assert.equal(otherB.secret, '')
  assert.equal(otherB.hasSecret, true)
  console.log('玩家领角色本：只看得到自己那份 OK')

  await assert.rejects(
    () =>
      api(`/api/rooms/${roomId}/roles`, {
        method: 'POST',
        token: player2.token,
        body: { action: 'claim', characterId: 'a' },
      }),
    (error) => error.status === 409,
  )
  const claimedB = await api(`/api/rooms/${roomId}/roles`, {
    method: 'POST',
    token: player2.token,
    body: { action: 'claim', characterId: 'b' },
  })
  assert.equal(claimedB.myCharacterId, 'b')

  const gmRoles = await api(`/api/rooms/${roomId}/roles`, { token: created.gm.token })
  assert.match(gmRoles.cast.find((item) => item.id === 'a').secret, /凶手/)
  assert.match(gmRoles.cast.find((item) => item.id === 'b').secret, /侦探/)
  console.log('GM 能看到全部角色本 OK')

  const gmTruth = await api(`/api/rooms/${roomId}/truth`, { token: created.gm.token })
  assert.match(gmTruth.truth, /凶手是 A/)
  await assert.rejects(
    () => api(`/api/rooms/${roomId}/truth`, { token: player1.token }),
    (error) => error.status === 403,
  )
  console.log('汤底 / 真相只有 GM 能取 OK')

  // 私聊：玩家 → GM；第三方在历史里看不到
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: player1.token,
    body: { text: '我承认，座钟是我动的。', to: created.gm.memberId },
  })
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: created.gm.token,
    body: { text: '先别声张，继续观察 B。', to: player1.memberId },
  })
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: player1.token,
    body: { text: '大家先说说 21:10 在哪里。' },
  })
  const p2History = await api(
    `/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(player2.token)}`,
  )
  assert.equal(p2History.messages.some((item) => item.private), false, '第三方历史里不能有别人的私聊')
  const gmHistory = await api(
    `/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(created.gm.token)}`,
  )
  assert.equal(gmHistory.messages.filter((item) => item.private).length, 2, 'GM 应看到两条私聊')
  const p1History = await api(
    `/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(player1.token)}`,
  )
  assert.equal(p1History.messages.filter((item) => item.private).length, 2)
  await assert.rejects(
    () =>
      api(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        token: player1.token,
        body: { text: '偷偷告诉阿澈', to: player2.memberId },
      }),
    (error) => error.status === 403,
  )
  console.log('私聊：玩家 ↔ GM，第三方历史看不到 OK')

  // SSE：第三方连接里不应出现私聊正文
  const p2SsePromise = readSse(player2.token, roomId, 1100)
  const gmSsePromise = readSse(created.gm.token, roomId, 1100)
  await sleep(350)
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: player1.token,
    body: { text: 'SSE 私聊密钥：座钟慢十分钟。', to: created.gm.memberId },
  })
  const [p2Sse, gmSse] = await Promise.all([p2SsePromise, gmSsePromise])
  assert.equal(p2Sse.includes('SSE 私聊密钥'), false, '私聊不能广播给第三方 SSE')
  assert.equal(gmSse.includes('SSE 私聊密钥'), true, 'GM 的 SSE 应收到私聊')
  console.log('私聊 SSE 只发给 GM OK')

  // 阶段机：玩家不能切，GM 切到自我介绍会带阶段提示词
  await assert.rejects(
    () =>
      api(`/api/rooms/${roomId}/phase`, {
        method: 'POST',
        token: player1.token,
        body: { action: 'next' },
      }),
    (error) => error.status === 403,
  )
  systems.length = 0
  const nextPhase = await api(`/api/rooms/${roomId}/phase`, {
    method: 'POST',
    token: created.gm.token,
    body: { action: 'next' },
  })
  assert.equal(nextPhase.phase.id, 'intro')
  await waitFor(() => systems.length > 0, 4000, '阶段切换后的 AI 推进')
  assert.match(systems[0], /【当前阶段】自我介绍/)
  assert.match(systems[0], /现在进入「自我介绍」阶段/)
  const afterPhase = await api(`/api/rooms/${roomId}/messages?since=0&t=${encodeURIComponent(player1.token)}`)
  assert.ok(afterPhase.messages.some((item) => item.kind === 'system' && item.text.includes('自我介绍')))

  const review = await api(`/api/rooms/${roomId}/phase`, {
    method: 'POST',
    token: created.gm.token,
    body: { action: 'set', phase: 'review', narrate: false },
  })
  assert.equal(review.phase.id, 'review')
  await assert.rejects(
    () =>
      api(`/api/rooms/${roomId}/phase`, {
        method: 'POST',
        token: created.gm.token,
        body: { action: 'next' },
      }),
    (error) => error.status === 409,
  )
  console.log('阶段机：玩家 403 / GM 推进 / 复盘收尾 OK')

  // 复盘提示词里带真相，但公开消息与房间公开信息仍然不泄露
  systems.length = 0
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: created.gm.token })
  await waitFor(() => systems.length > 0, 4000, '复盘阶段 AI 推进')
  assert.match(systems[0], /【真相/)
  assert.match(systems[0], /凶手是 A/)
  const finalRoom = await api(`/api/rooms/${roomId}?t=${encodeURIComponent(created.inviteToken)}`)
  assert.equal(JSON.stringify(finalRoom).includes('凶手是 A'), false)
  console.log('复盘提示词带真相，接口仍不泄露 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
