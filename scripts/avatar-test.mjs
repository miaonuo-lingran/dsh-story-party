/**
 * 头像 + uid/机器码绑定测试：
 *   - 进房带 machineCode → 生成 uid
 *   - 上传头像 → 存进房间文件与成员公开信息
 *   - 同一 machineCode 再进（换个昵称）→ uid / 头像保留
 *   - 非法头像被拒
 *
 *   node scripts/avatar-test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.avatartest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.AVATAR_TEST_PORT || 7346)
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const MACHINE = 'machine-aaaa1111'

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100,
  loadCards: () => [],
  generate: async () => '旁白',
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

  const created = await api('/api/rooms', { method: 'POST', body: { gmName: '澪' } })
  const roomId = created.room.id
  const joinAs = (name, machineCode) =>
    api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { name, inviteToken: created.inviteToken, machineCode },
    })

  const first = await joinAs('小满', MACHINE)
  assert.match(first.member.uid, /^u_[0-9a-f]{10}$/)
  assert.equal(first.member.avatar, null)
  console.log('进房生成 uid OK：' + first.member.uid)

  const avatar = await api(`/api/rooms/${roomId}/avatar`, {
    method: 'POST',
    token: first.token,
    body: { dataUrl: PIXEL },
  })
  assert.equal(avatar.member.avatar, PIXEL)
  console.log('上传头像 OK')

  // 存档里有头像和 uid
  const stored = JSON.parse(readFileSync(join(workDir, 'rooms', `${roomId}.json`), 'utf8'))
  const storedMember = Object.values(stored.members).find((m) => m.uid === first.member.uid)
  assert.equal(storedMember.avatar, PIXEL)
  console.log('头像写入存档 OK')

  // 同一机器码再进：uid / 头像认回
  const again = await joinAs('小满（换了个昵称）', MACHINE)
  assert.equal(again.member.uid, first.member.uid)
  assert.equal(again.member.avatar, PIXEL)
  console.log('机器码认回 uid + 头像 OK')

  // 非法头像拒绝
  await assert.rejects(
    api(`/api/rooms/${roomId}/avatar`, {
      method: 'POST',
      token: first.token,
      body: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    }),
    (error) => error.status === 400,
  )
  console.log('svg / 非法头像被拒 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
