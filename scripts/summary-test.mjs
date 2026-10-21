/**
 * 长局滚动摘要测试：
 *   - 攒够消息后自动生成摘要，存进房间文件
 *   - 之后的系统提示里带上【剧情摘要】
 *
 *   node scripts/summary-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.summarytest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.SUMMARY_TEST_PORT || 7370)
const SUMMARY = '摘要：他们在公寓里发现了旧照片，门外有人敲门。'
let lastSystem = ''

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  rateLimitPerSec: 100,
  loadCards: () => [],
  generate: async ({ system }) => {
    lastSystem = system
    if (system.includes('剧情记录员')) return SUMMARY
    return '（旁白）门开了。'
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

  const created = await api('/api/rooms', {
    method: 'POST',
    body: { gmName: '澪', contextMessages: 10, autoSummary: true },
  })
  const roomId = created.room.id
  const gmToken = created.gm.token

  for (let index = 0; index < 21; index += 1) {
    await api(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      token: gmToken,
      body: { text: `第 ${index + 1} 句` },
    })
  }
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: gmToken })
  await sleep(900)

  const stored = JSON.parse(readFileSync(join(workDir, 'rooms', `${roomId}.json`), 'utf8'))
  assert.equal(stored.summary, SUMMARY)
  assert.ok(stored.summarySeq > 0)
  console.log('攒够消息后生成摘要 OK（summarySeq=' + stored.summarySeq + '）')

  // 再推一轮：系统提示里应该带摘要
  await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: gmToken })
  await sleep(400)
  assert.match(lastSystem, /【之前剧情摘要】/)
  assert.ok(lastSystem.includes(SUMMARY))
  console.log('之后系统提示带摘要 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
