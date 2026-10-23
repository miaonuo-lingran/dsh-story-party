/**
 * AI 画我猜（单人）测试：
 *   - 创建 session、首题 shapes/hint 下发，answer 不下发
 *   - 猜错 / 猜对（含别名）计分
 *   - 下一题、提示字数、跳过、结算
 *   - 模型返回坏 JSON 时用内置题库兜底
 *
 *   node scripts/draw-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from '../src/room-server.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(root, '.drawtest')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(join(workDir, 'rooms'), { recursive: true })

const port = Number(process.env.DRAW_TEST_PORT || 7396)
let badJson = false

const server = createRoomServer({
  port,
  hostname: '127.0.0.1',
  dataDir: join(workDir, 'rooms'),
  debounceMs: 100000,
  loadCards: () => [],
  generate: async ({ system }) => {
    if (!String(system).includes('画我猜')) return '房间回复'
    if (badJson) return '这不是 JSON，模型画砸了'
    return JSON.stringify({
      answer: '雨伞',
      aliases: ['伞'],
      hint: '下雨天会用到',
      shapes: [
        {
          type: 'polygon',
          points: [
            [50, 12],
            [16, 46],
            [84, 46],
          ],
          fill: '#e05a5a',
          stroke: '#8a2f2f',
          strokeWidth: 1,
        },
        { type: 'line', x1: 50, y1: 46, x2: 50, y2: 88, stroke: '#6b4f2a', strokeWidth: 3 },
        { type: 'text', value: '雨伞' },
      ],
    })
  },
})

async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
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

  const created = await api('/api/draw/sessions', { method: 'POST', body: { rounds: 2 } })
  const session = created.session
  assert.ok(session.id)
  assert.equal(session.round, 1)
  assert.equal(session.total, 2)
  assert.equal(session.status, 'playing')
  assert.equal(session.answer, null, '未猜出时不能下发答案')
  assert.equal(session.hint, '下雨天会用到')
  assert.equal(session.shapes.length, 2, 'text 形状应被过滤')
  assert.equal(session.shapes[0].type, 'polygon')
  console.log('创建游戏 + 首题 shapes/hint OK')

  const fetched = await api(`/api/draw/sessions/${session.id}`)
  assert.equal(fetched.session.round, 1)
  assert.equal(fetched.session.answer, null)

  const wrong = await api(`/api/draw/sessions/${session.id}/guess`, {
    method: 'POST',
    body: { text: '雨衣' },
  })
  assert.equal(wrong.correct, false)
  assert.equal(wrong.attempts, 1)
  assert.equal(wrong.answer, null)

  const right = await api(`/api/draw/sessions/${session.id}/guess`, {
    method: 'POST',
    body: { text: '伞' },
  })
  assert.equal(right.correct, true)
  assert.equal(right.answer, '雨伞')
  assert.equal(right.score, 80, '第二次猜对应得 80 分')
  assert.equal(right.solved, true)
  console.log('猜错 / 别名猜对 / 计分 OK')

  const next = await api(`/api/draw/sessions/${session.id}/next`, { method: 'POST' })
  assert.equal(next.session.round, 2)
  assert.equal(next.session.answer, null)
  assert.ok(next.session.shapes.length > 0)
  console.log('下一题 OK')

  const hint = await api(`/api/draw/sessions/${session.id}/hint`, { method: 'POST' })
  assert.equal(hint.length, 2)
  assert.equal(hint.first, '', '没猜错两次前不透露首字')

  await api(`/api/draw/sessions/${session.id}/guess`, { method: 'POST', body: { text: '不对' } })
  await api(`/api/draw/sessions/${session.id}/guess`, { method: 'POST', body: { text: '还不对' } })
  const hint2 = await api(`/api/draw/sessions/${session.id}/hint`, { method: 'POST' })
  assert.equal(hint2.first, '雨')
  assert.match(hint2.message, /第一个字是「雨」/)

  const skipped = await api(`/api/draw/sessions/${session.id}/skip`, { method: 'POST' })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.answer, '雨伞')
  assert.equal(skipped.finished, true, '两题结束应完成')
  assert.equal(skipped.status, 'finished')
  console.log('提示字数 / 跳过 / 结算 OK')

  // 已结束的 session 不能再猜
  await assert.rejects(
    () => api(`/api/draw/sessions/${session.id}/guess`, { method: 'POST', body: { text: '雨伞' } }),
    (error) => error.status === 409,
  )

  // 坏 JSON → 兜底题库
  badJson = true
  const fallback = await api('/api/draw/sessions', { method: 'POST', body: { rounds: 1 } })
  assert.ok(fallback.session.shapes.length > 0, '坏 JSON 时应该有兜底图形')
  assert.equal(fallback.session.answer, null)
  assert.ok(fallback.session.hint.length > 0)
  console.log('坏 JSON 兜底题库 OK')

  // 不存在的 session
  await assert.rejects(
    () => api('/api/draw/sessions/nope'),
    (error) => error.status === 404,
  )
  console.log('不存在 session → 404 OK')

  console.log('\n全部通过 ✓')
} finally {
  await server.stop()
  rmSync(workDir, { recursive: true, force: true })
}
