/**
 * 揭晓投票测试：
 *   - GM 发起投票（默认自己投同意）
 *   - 有人没投 / 投反对 → 不通过
 *   - 全员同意 → 通过，并触发 AI「揭晓汤底」指令
 *
 *   node scripts/vote-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.votetest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.VOTE_TEST_PORT || 7358)
let capturedSystem = ''

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  loadCards: () => [],
  generate: async ({ system }) => {
    capturedSystem = system
    return '（旁白）真相是……'
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

try {
  await server.start()

  const created = await api('/api/rooms', { method: 'POST', body: { gmName: '澪' } })
  const roomId = created.room.id
  const gmToken = created.gm.token
  const player = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '小满', inviteToken: created.inviteToken },
  })

  const vote = (token, body) =>
    api(`/api/rooms/${roomId}/vote`, { method: 'POST', token, body })

  // 1. 发起：GM 自动同意，1/2
  const started = await vote(gmToken, { action: 'start', kind: 'reveal' })
  assert.equal(started.vote.agree, 1)
  assert.equal(started.vote.total, 2)
  console.log('发起投票 OK：1/2 同意')

  // 2. 玩家没投 → 不通过
  const blocked = await vote(gmToken, { action: 'cast', agree: true })
  assert.equal(blocked.passed, false)
  console.log('有人没投 → 不通过 OK')

  // 3. 玩家投反对 → 不通过
  const rejected = await vote(player.token, { action: 'cast', agree: false })
  assert.equal(rejected.passed, false)
  console.log('反对 → 不通过 OK')

  // 4. 玩家改投同意 → 全票通过，AI 收到揭晓指令
  const passed = await vote(player.token, { action: 'cast', agree: true })
  assert.equal(passed.passed, true)
  assert.equal(passed.vote, null)
  await sleep(400)
  assert.match(capturedSystem, /揭晓汤底/)
  const history = await api(`/api/rooms/${roomId}/messages?since=0&t=${created.inviteToken}`)
  assert.ok(history.messages.some((message) => message.text.includes('全票通过')))
  console.log('全票通过 → 触发揭晓 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
