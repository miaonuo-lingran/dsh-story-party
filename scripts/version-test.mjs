/**
 * 版本门禁测试：strictVersion=true 时，进房必须带与房主一致的 clientVersion。
 *
 *   node scripts/version-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.versiontest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.VERSION_TEST_PORT || 7316)
const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  version: '1.2.3',
  strictVersion: true,
  loadCards: () => [],
  generate: async () => 'ok',
})

async function api(path, options = {}) {
  const headers = {}
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

  const version = await api('/api/version')
  assert.equal(version.version, '1.2.3')
  assert.equal(version.strict, true)
  console.log('[/api/version] OK：1.2.3 strict=true')

  const created = await api('/api/rooms', { method: 'POST', body: { gmName: '澪' } })

  await assert.rejects(
    api(`/api/rooms/${created.room.id}/join`, {
      method: 'POST',
      body: { name: '小满', inviteToken: created.inviteToken },
    }),
    (error) => error.status === 409,
  )
  console.log('无版本号 → 409 OK')

  await assert.rejects(
    api(`/api/rooms/${created.room.id}/join`, {
      method: 'POST',
      body: { name: '小满', inviteToken: created.inviteToken, clientVersion: '1.2.2' },
    }),
    (error) => error.status === 409,
  )
  console.log('版本不一致 → 409 OK')

  const joined = await api(`/api/rooms/${created.room.id}/join`, {
    method: 'POST',
    body: { name: '小满', inviteToken: created.inviteToken, clientVersion: '1.2.3' },
  })
  assert.equal(joined.member.name, '小满')
  console.log('版本一致 → 进入 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
