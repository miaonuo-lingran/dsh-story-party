/**
 * AI 画我猜（单人）—— 零 DSH 依赖的游戏核心。
 *
 * 每轮让模型出题并输出一份几何图形 JSON：
 *   { answer, aliases, hint, shapes: [...] }
 * 服务端只把 shapes + hint 发给浏览器，answer 留在服务端判分。
 *
 * 图形只允许 circle / ellipse / rect / line / polyline / polygon，
 * 不接受 text / image / path，避免把答案直接画成文字，也避免 SVG 注入。
 */

import { randomBytes } from 'node:crypto'

const MAX_SHAPES = 40
const MAX_POINTS = 40
const MAX_ANSWER = 20

/** 兜底题库：模型返回坏 JSON / 调用失败时也能继续玩 */
const FALLBACKS = [
  {
    answer: '太阳',
    aliases: ['日头', '太阳公公'],
    hint: '天上会发光，白天常见',
    shapes: [
      { type: 'circle', cx: 50, cy: 50, r: 20, fill: '#f5b942', stroke: '#c98a1f', strokeWidth: 1 },
      { type: 'line', x1: 50, y1: 18, x2: 50, y2: 8, stroke: '#f5b942', strokeWidth: 2 },
      { type: 'line', x1: 50, y1: 82, x2: 50, y2: 92, stroke: '#f5b942', strokeWidth: 2 },
      { type: 'line', x1: 18, y1: 50, x2: 8, y2: 50, stroke: '#f5b942', strokeWidth: 2 },
      { type: 'line', x1: 82, y1: 50, x2: 92, y2: 50, stroke: '#f5b942', strokeWidth: 2 },
    ],
  },
  {
    answer: '雨伞',
    aliases: ['伞', '雨伞'],
    hint: '下雨天会用到',
    shapes: [
      { type: 'polygon', points: [[50, 12], [16, 46], [84, 46]], fill: '#e05a5a', stroke: '#8a2f2f', strokeWidth: 1 },
      { type: 'line', x1: 50, y1: 46, x2: 50, y2: 88, stroke: '#6b4f2a', strokeWidth: 3 },
      { type: 'polyline', points: [[50, 88], [58, 90], [58, 82]], stroke: '#6b4f2a', strokeWidth: 3 },
    ],
  },
  {
    answer: '猫',
    aliases: ['猫咪', '小猫'],
    hint: '会喵喵叫，喜欢晒太阳',
    shapes: [
      { type: 'circle', cx: 50, cy: 46, r: 22, fill: '#d9a066', stroke: '#7a5230', strokeWidth: 1 },
      { type: 'polygon', points: [[30, 30], [36, 10], [46, 26]], fill: '#d9a066', stroke: '#7a5230', strokeWidth: 1 },
      { type: 'polygon', points: [[70, 30], [64, 10], [54, 26]], fill: '#d9a066', stroke: '#7a5230', strokeWidth: 1 },
      { type: 'circle', cx: 42, cy: 44, r: 3, fill: '#1f2937' },
      { type: 'circle', cx: 58, cy: 44, r: 3, fill: '#1f2937' },
      { type: 'line', x1: 50, y1: 50, x2: 50, y2: 56, stroke: '#7a5230', strokeWidth: 1.2 },
      { type: 'line', x1: 28, y1: 54, x2: 14, y2: 50, stroke: '#7a5230', strokeWidth: 1 },
      { type: 'line', x1: 72, y1: 54, x2: 86, y2: 50, stroke: '#7a5230', strokeWidth: 1 },
    ],
  },
  {
    answer: '鱼',
    aliases: ['小鱼', '鱼儿'],
    hint: '生活在水里，会吐泡泡',
    shapes: [
      { type: 'ellipse', cx: 46, cy: 50, rx: 28, ry: 16, fill: '#5aa9e6', stroke: '#2f6f9f', strokeWidth: 1 },
      { type: 'polygon', points: [[74, 50], [92, 34], [92, 66]], fill: '#5aa9e6', stroke: '#2f6f9f', strokeWidth: 1 },
      { type: 'circle', cx: 34, cy: 46, r: 2.5, fill: '#1f2937' },
      { type: 'circle', cx: 24, cy: 38, r: 3, fill: 'none', stroke: '#5aa9e6', strokeWidth: 1 },
    ],
  },
  {
    answer: '房子',
    aliases: ['屋子', '房屋', '家'],
    hint: '有屋顶，可以住人',
    shapes: [
      { type: 'rect', x: 24, y: 45, width: 52, height: 38, fill: '#e8d5b7', stroke: '#7a5230', strokeWidth: 1 },
      { type: 'polygon', points: [[50, 12], [14, 46], [86, 46]], fill: '#b5533c', stroke: '#7a2f1f', strokeWidth: 1 },
      { type: 'rect', x: 44, y: 60, width: 14, height: 23, fill: '#6b4f2a' },
      { type: 'rect', x: 30, y: 52, width: 10, height: 10, fill: '#a8d8ea', stroke: '#4a7a8a', strokeWidth: 1 },
    ],
  },
  {
    answer: '灯泡',
    aliases: ['电灯泡', '灯'],
    hint: '通电会亮，装在灯座上',
    shapes: [
      { type: 'circle', cx: 50, cy: 38, r: 18, fill: '#ffe08a', stroke: '#b08a2e', strokeWidth: 1 },
      { type: 'rect', x: 42, y: 56, width: 16, height: 14, fill: '#b8b8b8', stroke: '#6b6b6b', strokeWidth: 1 },
      { type: 'line', x1: 44, y1: 70, x2: 56, y2: 70, stroke: '#6b6b6b', strokeWidth: 2 },
      { type: 'line', x1: 50, y1: 12, x2: 50, y2: 4, stroke: '#b08a2e', strokeWidth: 1.5 },
      { type: 'line', x1: 28, y1: 20, x2: 22, y2: 14, stroke: '#b08a2e', strokeWidth: 1.5 },
      { type: 'line', x1: 72, y1: 20, x2: 78, y2: 14, stroke: '#b08a2e', strokeWidth: 1.5 },
    ],
  },
]

function newId() {
  return 'draw_' + randomBytes(5).toString('hex')
}

function pickFallback(history) {
  const used = new Set((history || []).map((item) => item.answer))
  const fresh = FALLBACKS.filter((item) => !used.has(item.answer))
  const pool = fresh.length > 0 ? fresh : FALLBACKS
  return pool[Math.floor(Math.random() * pool.length)]
}

function number(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function color(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text
  if (text === 'none') return 'none'
  return fallback
}

function points(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const pair of value.slice(0, MAX_POINTS)) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const x = Number(pair[0])
    const y = Number(pair[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push([Math.min(100, Math.max(0, x)), Math.min(100, Math.max(0, y))])
  }
  return out.length >= 2 ? out : null
}

function sanitizeShape(raw) {
  if (!raw || typeof raw !== 'object') return null
  const type = String(raw.type ?? '')
  const stroke = color(raw.stroke, '#334155')
  const strokeWidth = number(raw.strokeWidth, 0.4, 10, 1.2)
  if (type === 'circle') {
    return {
      type,
      cx: number(raw.cx, 0, 100, 50),
      cy: number(raw.cy, 0, 100, 50),
      r: number(raw.r, 1, 60, 10),
      fill: color(raw.fill, 'none'),
      stroke,
      strokeWidth,
    }
  }
  if (type === 'ellipse') {
    return {
      type,
      cx: number(raw.cx, 0, 100, 50),
      cy: number(raw.cy, 0, 100, 50),
      rx: number(raw.rx, 1, 60, 12),
      ry: number(raw.ry, 1, 60, 8),
      fill: color(raw.fill, 'none'),
      stroke,
      strokeWidth,
    }
  }
  if (type === 'rect') {
    return {
      type,
      x: number(raw.x, 0, 100, 20),
      y: number(raw.y, 0, 100, 20),
      width: number(raw.width, 1, 100, 30),
      height: number(raw.height, 1, 100, 30),
      rx: number(raw.rx, 0, 30, 0),
      fill: color(raw.fill, 'none'),
      stroke,
      strokeWidth,
    }
  }
  if (type === 'line') {
    return {
      type,
      x1: number(raw.x1, 0, 100, 10),
      y1: number(raw.y1, 0, 100, 10),
      x2: number(raw.x2, 0, 100, 90),
      y2: number(raw.y2, 0, 100, 90),
      stroke,
      strokeWidth,
    }
  }
  if (type === 'polyline' || type === 'polygon') {
    const list = points(raw.points)
    if (!list) return null
    return {
      type,
      points: list,
      fill: type === 'polygon' ? color(raw.fill, '#cfe3f7') : 'none',
      stroke,
      strokeWidth,
    }
  }
  return null
}

function sanitizeShapes(value) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_SHAPES)
    .map((shape) => sanitizeShape(shape))
    .filter(Boolean)
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 把模型回复解析成出题对象；失败返回 null */
export function parsePuzzle(reply) {
  let source = String(reply ?? '').trim()
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) source = fence[1]
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const answer = text(parsed.answer, MAX_ANSWER)
  if (!answer) return null
  const shapes = sanitizeShapes(parsed.shapes)
  if (shapes.length === 0) return null
  const aliases = (Array.isArray(parsed.aliases) ? parsed.aliases : [])
    .map((item) => text(item, MAX_ANSWER))
    .filter(Boolean)
    .slice(0, 6)
  let hint = text(parsed.hint, 80)
  // 提示里如果直接带了答案，换成模糊提示
  if (hint.includes(answer)) hint = '这个答案和日常生活有关'
  return { answer, aliases, hint, shapes }
}

export function normalizeGuess(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

export function isCorrect(puzzle, guess) {
  const value = normalizeGuess(guess)
  if (!value) return false
  const answers = [puzzle.answer, ...(puzzle.aliases || [])].map(normalizeGuess).filter(Boolean)
  if (answers.includes(value)) return true
  if (value.length >= 2) {
    if (answers.some((answer) => answer.includes(value) || value.includes(answer))) return true
  }
  return false
}

function promptFor(session) {
  const past = session.history.map((item) => item.answer).filter(Boolean)
  return [
    '你是一个「AI 画我猜」的出题人。请想一个常见、容易用简单几何图形画出来的中文词语（2–4 字）。',
    '用最多 24 个几何图形把它画出来，再给一句不直接说出答案的提示。',
    `这是第 ${session.round + 1}/${session.rounds} 题。`,
    past.length > 0 ? `已经出过：${past.join('、')}，不要重复。` : '',
    '',
    '只输出一行 JSON，不要 markdown、不要解释：',
    '{"answer":"雨伞","aliases":["伞"],"hint":"下雨天会用到","shapes":[',
    '{"type":"polygon","points":[[50,12],[16,46],[84,46]],"fill":"#e05a5a","stroke":"#8a2f2f","strokeWidth":1},',
    '{"type":"line","x1":50,"y1":46,"x2":50,"y2":88,"stroke":"#6b4f2a","strokeWidth":3}]}',
    '',
    '坐标范围 0–100；shape.type 只能是 circle / ellipse / rect / line / polyline / polygon；',
    '不要使用 text、image、path；不要把答案写进图形或提示里。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function publicSession(session) {
  const puzzle = session.puzzle
  return {
    id: session.id,
    round: session.round,
    total: session.rounds,
    score: session.score,
    status: session.status,
    finished: session.status === 'finished',
    attempts: puzzle && !puzzle.solved ? session.attempts : 0,
    hint: puzzle ? puzzle.hint : '',
    shapes: puzzle ? puzzle.shapes : [],
    solved: Boolean(puzzle && puzzle.solved),
    answer: puzzle && puzzle.solved ? puzzle.answer : null,
    history: session.history.map((item) => ({
      answer: item.answer,
      correct: item.correct,
      skipped: Boolean(item.skipped),
      points: item.points || 0,
    })),
  }
}

/**
 * @param {object} options
 * @param {(input: object) => Promise<string|{text:string}>} options.generate 宿主模型调用
 * @param {number} [options.maxSessions]
 */
export function createDrawGame({ generate, maxSessions = 40 } = {}) {
  if (typeof generate !== 'function') throw new TypeError('createDrawGame: generate 必须是函数')
  const sessions = new Map()

  function prune() {
    if (sessions.size <= maxSessions) return
    const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    for (const session of oldest.slice(0, sessions.size - maxSessions)) sessions.delete(session.id)
  }

  async function makePuzzle(session) {
    try {
      const reply = await generate({
        system: promptFor(session),
        messages: [{ role: 'user', content: '请出下一题。' }],
        force: true,
        roomId: `draw:${session.id}`,
        captureReasoning: false,
      })
      const parsed = parsePuzzle(typeof reply === 'string' ? reply : reply?.text || '')
      if (parsed) return parsed
    } catch {
      /* 模型失败时走兜底题库 */
    }
    return pickFallback(session.history)
  }

  async function create(rounds = 5) {
    const total = Math.min(10, Math.max(1, Number(rounds) || 5))
    const session = {
      id: newId(),
      rounds: total,
      round: 0,
      score: 0,
      status: 'playing',
      puzzle: null,
      attempts: 0,
      history: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.set(session.id, session)
    prune()
    session.round = 1
    session.puzzle = await makePuzzle(session)
    session.attempts = 0
    session.updatedAt = Date.now()
    return publicSession(session)
  }

  function get(id) {
    const session = sessions.get(String(id ?? ''))
    return session ? publicSession(session) : null
  }

  async function next(id) {
    const session = sessions.get(String(id ?? ''))
    if (!session) return null
    if (session.status === 'finished') return publicSession(session)
    if (session.puzzle && !session.puzzle.solved) {
      return { error: '这一题还没猜出来，先猜或跳过' }
    }
    if (session.round >= session.rounds) {
      session.status = 'finished'
      session.updatedAt = Date.now()
      return publicSession(session)
    }
    session.round += 1
    session.puzzle = await makePuzzle(session)
    session.attempts = 0
    session.updatedAt = Date.now()
    return publicSession(session)
  }

  function guess(id, value) {
    const session = sessions.get(String(id ?? ''))
    if (!session) return null
    if (!session.puzzle || session.puzzle.solved) return { error: '这一题已经结束了' }
    const guessText = String(value ?? '').trim()
    if (!guessText) return { error: '先输入一个答案' }
    session.attempts += 1
    session.updatedAt = Date.now()
    if (isCorrect(session.puzzle, guessText)) {
      const points = Math.max(10, 100 - (session.attempts - 1) * 20)
      session.puzzle.solved = true
      session.score += points
      session.history.push({
        answer: session.puzzle.answer,
        correct: true,
        attempts: session.attempts,
        points,
      })
      if (session.round >= session.rounds) session.status = 'finished'
      return {
        ...publicSession(session),
        correct: true,
        points,
        message: `猜对了！答案是「${session.puzzle.answer}」`,
      }
    }
    return {
      ...publicSession(session),
      correct: false,
      message: '不对，再想想',
    }
  }

  function skip(id) {
    const session = sessions.get(String(id ?? ''))
    if (!session) return null
    if (!session.puzzle || session.puzzle.solved) return { error: '这一题已经结束了' }
    session.puzzle.solved = true
    session.history.push({ answer: session.puzzle.answer, correct: false, skipped: true, points: 0 })
    if (session.round >= session.rounds) session.status = 'finished'
    session.updatedAt = Date.now()
    return {
      ...publicSession(session),
      correct: false,
      skipped: true,
      message: `这题是「${session.puzzle.answer}」`,
    }
  }

  function hint(id) {
    const session = sessions.get(String(id ?? ''))
    if (!session || !session.puzzle || session.puzzle.solved) return null
    const answer = session.puzzle.answer
    return {
      length: answer.length,
      first: session.attempts >= 2 ? answer.slice(0, 1) : '',
      message:
        session.attempts >= 2
          ? `答案有 ${answer.length} 个字，第一个字是「${answer.slice(0, 1)}」`
          : `答案有 ${answer.length} 个字`,
    }
  }

  return { create, get, next, guess, skip, hint }
}
