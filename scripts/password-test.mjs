/**
 * 房间密码测试：建房带密码 → 进房必须输对；
 * 密码只存 scrypt 哈希，房间 JSON 里不能出现明文。
 *
 *   node scripts/password-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.passwordtest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.PASSWORD_TEST_PORT || 7317)
const password = 'moe123'

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  loadCards: () => [],
  generate: async () => 'ok',
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

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { title: '带密码的房间', gmName: '澪', password },
  })
  const roomId = created.room.id
  const invite = created.inviteToken
  assert.equal(created.room.hasPassword, true)
  assert.equal(created.room.password, undefined)
  console.log('建房带密码 OK（公开信息只带 hasPassword）')

  const joinAs = (extra) =>
    api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { name: '小满', inviteToken: invite, ...extra },
    })

  await assert.rejects(joinAs({}), (error) => error.status === 403)
  console.log('不带密码 → 403 OK')

  await assert.rejects(joinAs({ password: 'wrong' }), (error) => error.status === 403)
  console.log('密码错误 → 403 OK')

  const joined = await joinAs({ password })
  assert.equal(joined.member.name, '小满')
  console.log('密码正确 → 进入 OK')

  // 落盘不能有明文
  const raw = readFileSync(join(workDir, 'rooms', `${roomId}.json`), 'utf8')
  assert.ok(!raw.includes(password), '房间 JSON 不应包含明文密码')
  assert.ok(raw.includes('"salt"') && raw.includes('"hash"'))
  console.log('落盘只有 salt/hash，无明文 OK')

  // 没设密码的房间：直接进
  const open = await api('/api/rooms', { method: 'POST', body: { gmName: '澪' } })
  await api(`/api/rooms/${open.room.id}/join`, {
    method: 'POST',
    body: { name: '阿透', inviteToken: open.inviteToken },
  })
  console.log('无密码房间直接进 OK')

  // GM 改/清密码
  await api(`/api/rooms/${roomId}`, {
    method: 'PATCH',
    token: created.gm.token,
    body: { password: 'newpass' },
  })
  await assert.rejects(joinAs({ password }), (error) => error.status === 403)
  const rejoin = await joinAs({ password: 'newpass', role: 'spectator' })
  assert.equal(rejoin.role, 'spectator')
  console.log('GM 改密码 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
