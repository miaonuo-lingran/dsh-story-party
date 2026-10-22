/**
 * 房间服务核心 —— 零 DSH 依赖。
 *
 * 同一份代码有两个装配方式：
 *   1) host 插件（src/index.js）：注入 ctx.llm 的生成函数，端口对局域网开放；
 *   2) standalone（src/standalone.js）：注入 mock 生成函数，用于不重启 DSH 的 curl 自检。
 *
 * 职责：
 *   - 房间生命周期：创建 / 加入 / 成员管理 / 关闭
 *   - 共享消息流：统一 seq，用户与 AI 的消息在同一条流里
 *   - 发言调度：玩家 / GM 的发言进队列，防抖合并成一轮交给 AI，由 AI 自己判断接不接话
 *   - 广播：SSE（text/event-stream）+ 增量拉取（?since=）互为兜底
 *   - 持久化：每个房间一个 JSON（原子写）
 *
 * 不负责：模型调用的细节（由外部注入 generate）、浏览器页面（阶段 2）。
 */

import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { readZip } from './zip.js'

/** 房间页静态资源根（阶段 2 的页面与脚本） */
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))
/** 允许对外提供的文件名白名单：只认这几个，不做目录穿越 */
const STATIC_FILES = {
  'dialog.js': 'text/javascript; charset=utf-8',
  'host.html': 'text/html; charset=utf-8',
  'host.js': 'text/javascript; charset=utf-8',
  'make.html': 'text/html; charset=utf-8',
  'make.js': 'text/javascript; charset=utf-8',
  'room.html': 'text/html; charset=utf-8',
  'room.css': 'text/css; charset=utf-8',
  'room.js': 'text/javascript; charset=utf-8',
}

/** 房号字符集：去掉 I/O/0/1，避免口头转述时认错 */
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_ID_LENGTH = 6

const ROLE_LABELS = { gm: 'GM', player: '玩家', spectator: '观众' }
const ASSIGNABLE_ROLES = new Set(['player', 'spectator'])
const SILENT_RE = /^\s*(?:<silent>|\[silent\]|\[静默\]|（静默）|\(静默\))\s*$/i
const ONLINE_WINDOW_MS = 30_000
const MAX_TEXT_LENGTH = 2000

const DEFAULT_SCENARIO = [
  '黄昏，旧校舍的天台。',
  '铁门上的锁已经锈坏，风一推就吱呀作响；晾着的旧窗帘鼓起来，又慢慢落回去。',
  '从栏杆边能看见操场被夕照染成橘色，楼下有人在喊谁的名字。',
  '你刚踏上最后一级台阶，听见天台另一头传来很轻的一声——像是有人把书合上了。',
].join('\n')

const DEFAULTS = {
  hostname: '0.0.0.0',
  port: 7301,
  dataDir: join(process.cwd(), 'data', 'galgame-room', 'rooms'),
  maxPlayers: 4,
  maxSpectators: 12,
  debounceMs: 1200,
  contextMessages: 30,
  rateLimitPerSec: 10,
  aiName: '旁白',
  /** 插件版本（宿主注入）：/api/version 返回，strictVersion 时用于校验进房 */
  version: '0.0.0',
  strictVersion: false,
  /** 公网地址（frp/反代域名）；拼邀请链接时优先用它 */
  publicUrl: '',
  /** 调试：是否把 AI 思维链留在房主本机（默认关；永不进 API/客户端） */
  saveReasoning: false,
  defaultScenario: DEFAULT_SCENARIO,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function newToken() {
  return randomBytes(18).toString('base64url')
}

/** 玩家唯一 id：首次进房生成，之后按机器码认回 */
function newUid() {
  return 'u_' + randomBytes(5).toString('hex')
}

/** 机器码只接受 base64url/十六进制这类字符，长度受限 */
function normalizeMachineCode(value) {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9_-]{8,96}$/.test(text) ? text : ''
}

/** 头像只接受内联图片 data URL（玩家端已缩到 128px），拒绝 svg/html */
function sanitizeAvatar(value) {
  if (typeof value !== 'string' || value.length > 160 * 1024) return ''
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : ''
}

/** 剧情包类型：默认自由角色扮演 */
const PACK_MODES = new Set(['roleplay', 'soup', 'mystery', 'other'])
const PACK_MODE_LABEL = {
  roleplay: '角色扮演',
  soup: '海龟汤',
  mystery: '剧本杀',
  other: '其他',
}
/** 不同类型给 AI 的额外规则（拼进系统提示词） */
const PACK_MODE_RULES = {
  soup: '这是海龟汤：玩家提问，你只能用「是」「不是」「无关」「无法回答」开头作答，最多再补一句话；不要主动讲汤底。只有全员在「揭晓投票」里都同意后，才完整讲出汤底。',
  mystery: '这是剧本杀：按阶段推进（阅读 → 自我介绍 → 搜证 → 讨论 → 投票 → 复盘），不要提前泄露秘密；玩家的私密信息只在其角色本里，公开消息里不出现。',
  other: '',
}

/** 剧本杀阶段机：id 写进存档，label 显示给玩家，rule 拼进系统提示词 */
const MYSTERY_PHASES = [
  {
    id: 'reading',
    label: '阅读',
    rule: '玩家在阅读自己的角色本。不要推进剧情，也不要要求他们立刻发言；可以简短说明本阶段要做什么。',
  },
  {
    id: 'intro',
    label: '自我介绍',
    rule: '引导每位玩家以角色身份做自我介绍，一次只点一个人；不要替玩家说。',
  },
  {
    id: 'search',
    label: '搜证',
    rule: '按玩家声明的地点或对象给出线索；线索要具体、可追问，但不要直接说出真相或其他人的秘密。',
  },
  {
    id: 'discuss',
    label: '讨论',
    rule: '让玩家互相质询、交换线索；你可以补充环境细节，但不要替他们推理出结论。',
  },
  {
    id: 'vote',
    label: '投票',
    rule: '请所有玩家公开指认凶手并说明理由；先收集完所有人的票，再进入复盘。',
  },
  {
    id: 'review',
    label: '复盘',
    rule: '完整讲出真相：凶手、动机、手法、时间线，以及每条线索指向什么；可以指出玩家漏掉的伏笔。',
  },
]
const MYSTERY_PHASE_IDS = new Set(MYSTERY_PHASES.map((phase) => phase.id))
const MYSTERY_PHASE_LABEL = Object.fromEntries(MYSTERY_PHASES.map((phase) => [phase.id, phase.label]))

function newId() {
  return randomBytes(9).toString('base64url')
}

function newRoomId() {
  const bytes = randomBytes(ROOM_ID_LENGTH)
  let out = ''
  for (let i = 0; i < ROOM_ID_LENGTH; i++) out += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length]
  return out
}

function clampInt(value, fallback, min, max) {
  // 注意 Number(null) === 0、Number('') === 0：缺省必须显式回落，
  // 否则 limit 会被算成 0 → clamp 到 1，历史永远只返回第一条。
  if (value === undefined || value === null || value === '') return fallback
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 定长比较，避免令牌逐字符泄漏长度/前缀 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? '玩家'
}

/** 169.254.x.x 链路本地地址：同一局域网的手机/电脑都访问不到 */
function isLinkLocalAddress(address) {
  return address.startsWith('169.254.')
}

/** 点对点地址（PPP / 宽带拨号，掩码 /32）：别的设备根本路由不到 */
function isPointToPoint(netmask) {
  return netmask === '255.255.255.255'
}

/** 虚拟网卡（VMware / VirtualBox / Hyper-V / WSL / VPN 等）：给朋友发地址时排除 */
function isVirtualInterface(name) {
  return /vmware|virtualbox|vethernet|hyper-v|wsl|loopback|tailscale|zerotier|vpn\b|tap\b|tun\b|docker/i.test(name)
}

function nowMs() {
  return Date.now()
}

/** 房间密码：只存 scrypt 哈希（salt + hash），永不落明文、不进链接 */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(password).slice(0, 128), salt, 32).toString('hex')
  return { salt, hash }
}

function verifyPassword(room, password) {
  if (!room.password) return true
  if (typeof password !== 'string' || password === '') return false
  const actual = scryptSync(password.slice(0, 128), room.password.salt, 32)
  const expected = Buffer.from(room.password.hash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function isOnline(member) {
  return nowMs() - Number(member.lastSeenAt ?? 0) < ONLINE_WINDOW_MS
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    online: isOnline(member),
    joinedAt: member.joinedAt,
    uid: member.uid ?? null,
    avatar: typeof member.avatar === 'string' && member.avatar ? member.avatar : null,
    characterId: member.characterId ?? null,
  }
}

/** 剧本杀角色名单的公开形态：谁扮演谁可见，角色本内容绝不出现 */
function publicCast(room) {
  return (room.cast || []).map((character) => {
    const assignee = character.assigneeId ? room.members[character.assigneeId] : null
    return {
      id: character.id,
      name: character.name,
      emoji: character.emoji || '',
      avatar: character.avatar || null,
      gender: character.gender || '',
      playedBy: character.playedBy || 'ai',
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    }
  })
}

/** 当前阶段（只有剧本杀有阶段机） */
function publicPhase(room) {
  if ((room.mode || 'roleplay') !== 'mystery') return null
  const index = MYSTERY_PHASES.findIndex((phase) => phase.id === room.phase)
  const phase = MYSTERY_PHASES[index >= 0 ? index : 0]
  return { id: phase.id, label: phase.label, index: index >= 0 ? index : 0, total: MYSTERY_PHASES.length }
}

/** 私聊消息只给发送者、接收者和 GM 看 */
function messageVisibleTo(message, memberId, role) {
  if (!message || message.private !== true) return true
  if (role === 'gm') return true
  if (!memberId) return false
  return message.memberId === memberId || message.to === memberId
}

/** 投票的公开形态：谁投了什么、几票同意 / 共几人（观众也算，全都同意才过） */
function publicVote(room) {
  const vote = room.vote
  if (!vote) return null
  const voters = Object.values(room.members)
  const agree = voters.filter((item) => vote.voters[item.id] === true).length
  return {
    id: vote.id,
    kind: vote.kind,
    startedAt: vote.startedAt,
    votes: vote.voters,
    agree,
    total: voters.length,
  }
}

function publicRoom(room) {
  return {
    id: room.id,
    title: room.title,
    scenario: room.scenario,
    createdAt: room.createdAt,
    closed: room.closed,
    maxPlayers: room.maxPlayers,
    seq: room.seq,
    hasPassword: Boolean(room.password),
    mode: room.mode || room.pack?.mode || 'roleplay',
    phase: publicPhase(room),
    cast: publicCast(room),
    hasTruth: Boolean(room.truth),
    ai: { status: room.ai.status, lastError: room.ai.lastError ?? null },
    aiName: room.aiName ?? null,
    persona: room.persona
      ? {
          id: room.persona.id,
          name: room.persona.name,
          emoji: room.persona.emoji,
          gender: room.persona.gender || '',
          avatar: room.persona.avatar || null,
          relations: room.persona.relations || [],
        }
      : null,
    pack: room.pack ?? null,
    sessionId: room.sessionId ?? null,
    solo: Boolean(room.solo),
    contextMessages: room.contextMessages ?? null,
    agents: (room.agents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      emoji: agent.emoji,
      inScene: Boolean(agent.inScene),
      location: agent.location || '',
    })),
    vote: publicVote(room),
    members: Object.values(room.members).map(publicMember),
  }
}

/** cosplay 角色卡 → 房间人设（字段截断，防止超长 prompt） */
function personaFromCard(card) {
  if (!card || typeof card !== 'object') return null
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const name = text(card.name, 40)
  if (!name) return null
  return {
    id: text(card.id, 64),
    name,
    emoji: text(card.emoji, 8),
    gender: ['female', 'male', 'other'].includes(text(card.gender, 8)) ? text(card.gender, 8) : '',
    playedBy: ['ai', 'human', 'either'].includes(text(card.playedBy, 8))
      ? text(card.playedBy, 8)
      : 'ai',
    playerBrief: text(card.playerBrief, 2000),
    /** 角色本 / 秘密：只给扮演该角色的玩家与 GM 看，绝不进公开消息 */
    secret: text(card.secret ?? card.characterBook ?? card.character_book, 6000),
    likes: text(card.likes, 2000),
    favoritePlaces: Array.isArray(card.favoritePlaces)
      ? card.favoritePlaces
          .filter((item) => typeof item === 'string')
          .slice(0, 12)
          .map((item) => item.slice(0, 40))
      : [],
    avatar:
      sanitizeAvatar(card.avatar) ||
      (typeof card.avatar === 'string' && /^assets\/[A-Za-z0-9._-]+$/.test(card.avatar.trim())
        ? card.avatar.trim()
        : ''),
    description: text(card.description, 4000),
    personality: text(card.personality, 3000),
    scenario: text(card.scenario, 4000),
    firstMes: text(card.first_mes ?? card.firstMes, 2000),
    mesExample: text(card.mes_example ?? card.mesExample, 2500),
    systemPrompt: text(card.system_prompt ?? card.systemPrompt, 3000),
    rules: text(card.rules, 2000),
    behavior: text(card.behavior, 2000),
    relations: Array.isArray(card.relations)
      ? card.relations
          .filter(
            (item) =>
              item &&
              typeof item === 'object' &&
              (typeof item.name === 'string' || typeof item.target === 'string') &&
              typeof item.relation === 'string' &&
              item.relation.trim() !== '',
          )
          .slice(0, 20)
          .map((item) => ({
            target: text(item.target, 64),
            name: text(item.name, 40),
            relation: text(item.relation, 200),
          }))
      : [],
  }
}

/** 公网地址规范化：去尾斜杠；没写协议补 http://（TCP 隧道只给「域名:端口」） */export function normalizePublicUrl(value) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text
  return text.replace(/\/+$/, '')
}

/** 剧情包摘要（列表用，不含全文） */
function packSummary(pack) {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    mode: pack.mode || 'roleplay',
    intro: pack.intro || '',
    recommendedPlayers: pack.recommendedPlayers || { min: 2, max: 4 },
    /** 汤底只告诉房主 / GM，列表里只暴露「有没有」 */
    hasTruth: Boolean(pack.truth),
    hasSecrets: (Array.isArray(pack.characters) ? pack.characters : []).some((character) =>
      Boolean(character.secret),
    ),
    mapCounts: {
      locations: Array.isArray(pack.map?.locations) ? pack.map.locations.length : 0,
      routes: Array.isArray(pack.map?.routes) ? pack.map.routes.length : 0,
    },
    humanCharacters: (Array.isArray(pack.characters) ? pack.characters : []).filter(
      (character) => character.playedBy === 'human',
    ).length,
    author: pack.author,
    generator: pack.generator || '',
    brand: pack.brand || '',
    description: pack.description,
    createdAt: pack.createdAt,
    scenarioPreview: (pack.scenario || '').slice(0, 80),
    assetCount: Array.isArray(pack.assets) ? pack.assets.length : 0,
    characters: (Array.isArray(pack.characters) ? pack.characters : []).map((character) => ({
      id: character.id,
      name: character.name,
      emoji: character.emoji,
      gender: character.gender || '',
      playedBy: character.playedBy || 'ai',
      hasPlayerBrief: Boolean(character.playerBrief),
    })),
  }
}

/** 解压后的文件 → 剧情包对象（校验 pack.json 与人物卡） */
function packFromFiles(files) {
  const map = new Map(files.map((file) => [file.name, file.data]))
  const metaBuffer = map.get('pack.json')
  if (!metaBuffer) throw new Error('缺少 pack.json')
  let meta
  try {
    meta = JSON.parse(metaBuffer.toString('utf8'))
  } catch {
    throw new Error('pack.json 不是合法 JSON')
  }
  if (meta.format !== 'dsh-galgame-pack') throw new Error('不是剧情包（pack.json 的 format 不对）')
  const name = String(meta.name ?? '').trim().slice(0, 60)
  if (!name) throw new Error('pack.json 缺少 name')

  const scenarioPath =
    typeof meta.scenario === 'string' && meta.scenario !== '' ? meta.scenario : 'scenario.md'
  const scenario = map.has(scenarioPath) ? map.get(scenarioPath).toString('utf8').slice(0, 20000) : ''
  // 海龟汤汤底 / 剧本杀真相：留给 GM 和 AI，公开列表只暴露 hasTruth
  const truthBuffer = map.get(
    typeof meta.truth === 'string' && meta.truth !== '' ? meta.truth : 'truth.md',
  )
  const truth = (
    truthBuffer ? truthBuffer.toString('utf8') : typeof meta.truth === 'string' ? meta.truth : ''
  )
    .trim()
    .slice(0, 20000)

  const characters = []
  const paths = Array.isArray(meta.characters) ? meta.characters : []
  for (const [index, path] of paths.entries()) {
    const buffer = map.get(path)
    if (!buffer) continue
    let raw
    try {
      raw = JSON.parse(buffer.toString('utf8'))
    } catch {
      continue
    }
    const persona = personaFromCard(raw)
    if (!persona) continue
    // 头像既可以是内联 data URL（制作页导出的就是这样），也可以是包内 assets/ 路径
    if (persona.avatar && persona.avatar.startsWith('assets/')) {
      const buffer = map.get(persona.avatar)
      if (buffer && buffer.length <= 160 * 1024) {
        const mime = /\.png$/i.test(persona.avatar)
          ? 'image/png'
          : /\.webp$/i.test(persona.avatar)
            ? 'image/webp'
            : 'image/jpeg'
        persona.avatar = `data:${mime};base64,${buffer.toString('base64')}`
      } else {
        persona.avatar = ''
      }
    }
    characters.push({ ...persona, id: persona.id || `c${index + 1}` })
  }
  if (characters.length === 0) throw new Error('包里没有可用的人物卡')

  const assets = files
    .filter((file) => file.name.startsWith('assets/'))
    .map((file) => ({ path: file.name, size: file.data.length }))

  // 地图：地点（按东南西北摆位）+ 地点之间的关系
  const packMap = { locations: [], routes: [] }
  if (meta.map && typeof meta.map === 'object') {
    for (const item of (Array.isArray(meta.map.locations) ? meta.map.locations : []).slice(0, 30)) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.id ?? '').trim().slice(0, 40)
      const locationName = String(item.name ?? '').trim().slice(0, 40)
      if (!id || !locationName) continue
      packMap.locations.push({
        id,
        name: locationName,
        description: String(item.description ?? '').slice(0, 200),
        direction: String(item.direction ?? 'center').slice(0, 20),
        parent: String(item.parent ?? '').trim().slice(0, 40) || null,
        pos: (() => {
          const pos = item.pos
          if (!pos || typeof pos !== 'object') return null
          const x = Number(pos.x)
          const y = Number(pos.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null
          return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
        })(),
      })
    }
    for (const item of (Array.isArray(meta.map.routes) ? meta.map.routes : []).slice(0, 60)) {
      if (!item || typeof item !== 'object') continue
      const from = String(item.from ?? '').trim().slice(0, 40)
      const to = String(item.to ?? '').trim().slice(0, 40)
      if (!from || !to || from === to) continue
      packMap.routes.push({ from, to, label: String(item.label ?? '').slice(0, 100) })
    }
    // 父级必须存在，否则按顶层处理
    const locationIds = new Set(packMap.locations.map((item) => item.id))
    for (const item of packMap.locations) {
      if (item.parent && !locationIds.has(item.parent)) item.parent = null
    }
  }

  return {
    name,
    version: String(meta.version ?? '1.0.0').slice(0, 20),
    mode: PACK_MODES.has(meta.mode) ? meta.mode : 'roleplay',
    intro: String(meta.intro ?? '').slice(0, 1200),
    recommendedPlayers: (() => {
      const raw =
        meta.recommendedPlayers && typeof meta.recommendedPlayers === 'object'
          ? meta.recommendedPlayers
          : {}
      const clamp = (value, fallback) => {
        const number = Number(value)
        return Number.isInteger(number) && number >= 1 && number <= 16 ? number : fallback
      }
      const min = clamp(raw.min, 2)
      const max = Math.max(min, clamp(raw.max, 4))
      return { min, max }
    })(),
    author: String(meta.author ?? '').slice(0, 40),
    generator: String(meta.generator ?? '').slice(0, 80),
    brand: String(meta.brand ?? '').slice(0, 40),
    description: String(meta.description ?? '').slice(0, 300),
    scenario,
    truth,
    characters,
    assets,
    map: packMap,
  }
}

/** 落盘时剔除运行期字段（_timer / _saveChain 等以下划线开头的东西） */
function serializeRoom(room) {
  const {
    _timer,
    _saveChain,
    _dirty,
    _force,
    _phaseDirective,
    _summarizing,
    _reveal,
    ...rest
  } = room
  return rest
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra })
}

/** 提供房间页静态资源（只认 STATIC_FILES 白名单里的文件） */
async function serveStatic(res, name) {
  const contentType = STATIC_FILES[name]
  if (!contentType) return sendError(res, 404, 'not found')
  try {
    const data = await readFile(join(PUBLIC_DIR, name))
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(data)
  } catch {
    sendError(res, 404, 'not found')
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`文件太大（上限 ${Math.round(limit / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeSse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    /* 客户端已断开：交给 close 事件清理 */
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {object} options 见 DEFAULTS；另外必须提供 generate({system,messages,force,roomId}) => Promise<string>
 */
export function createRoomServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  if (typeof cfg.generate !== 'function') {
    throw new TypeError('createRoomServer: options.generate 必须是函数')
  }
  const rooms = new Map()
  /** roomId -> Set<ServerResponse>（SSE 长连接） */
  const clients = new Map()
  /** 机器码 → { uid, avatar, name }，按房间隔离；落盘 identities.json */
  const identitiesFile = join(dirname(cfg.dataDir), 'identities.json')
  let identities = {}
  try {
    identities = JSON.parse(readFileSync(identitiesFile, 'utf8'))
  } catch {
    identities = {}
  }
  let identityTimer = null
  function identityKey(roomId, machineCode) {
    return `${roomId}:${machineCode}`
  }
  function rememberIdentity(roomId, machineCode, patch) {
    if (!machineCode) return
    const key = identityKey(roomId, machineCode)
    identities[key] = { ...(identities[key] || {}), ...patch }
    clearTimeout(identityTimer)
    identityTimer = setTimeout(() => {
      try {
        writeFileSync(identitiesFile, JSON.stringify(identities), 'utf8')
      } catch {
        /* 写不进去只影响「下次认回」，不影响本次 */
      }
    }, 200)
    if (typeof identityTimer.unref === 'function') identityTimer.unref()
  }
  /** ip -> { windowStart, count }（发言限流） */
  const rate = new Map()
  let httpServer
  let started = false
  /** 当前监听端口（可被 /api/port 运行时修改） */
  let listenPort = cfg.port
  /** 剧情包目录（与 rooms 同级） */
  const packsDir = join(dirname(cfg.dataDir), 'packs')

  // ---- 持久化 -------------------------------------------------------------

  async function loadRooms() {
    await mkdir(cfg.dataDir, { recursive: true })
    let names = []
    try {
      names = (await readdir(cfg.dataDir)).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    for (const name of names) {
      try {
        const raw = await readFile(join(cfg.dataDir, name), 'utf8')
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.id !== 'string' || !parsed.members) continue
        parsed.ai = { status: 'idle', cursor: Number(parsed.ai?.cursor ?? parsed.seq ?? 0), lastError: null }
        parsed.closed = parsed.closed === true
        rooms.set(parsed.id, parsed)
      } catch (error) {
        console.warn(`[galgame-room] 房间文件损坏，已跳过：${name}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }

  function persist(room) {
    const run = async () => {
      const file = join(cfg.dataDir, room.id + '.json')
      const tmp = file + '.tmp'
      try {
        await writeFile(tmp, JSON.stringify(serializeRoom(room), null, 2), 'utf8')
        await rename(tmp, file)
      } catch (error) {
        // 写盘失败（磁盘满 / 目录被删 / 权限）不能把宿主进程带崩：
        // 内存里的房间仍然可用，下次成功写盘会覆盖。
        console.warn(
          `[galgame-room] 房间 ${room.id} 写盘失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    // 每房间串行写盘，避免并发 rename 交错
    room._saveChain = (room._saveChain ?? Promise.resolve()).then(run, run)
    return room._saveChain
  }

  // ---- 剧情包 -------------------------------------------------------------

  async function loadPack(id) {
    try {
      const raw = await readFile(join(packsDir, `${id}.json`), 'utf8')
      const pack = JSON.parse(raw)
      return pack && typeof pack.id === 'string' ? pack : null
    } catch {
      return null
    }
  }

  async function listPacks() {
    await mkdir(packsDir, { recursive: true })
    let names = []
    try {
      names = (await readdir(packsDir)).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const packs = []
    for (const name of names) {
      try {
        const pack = JSON.parse(await readFile(join(packsDir, name), 'utf8'))
        packs.push(packSummary(pack))
      } catch {
        /* 坏文件跳过 */
      }
    }
    return packs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  async function importPack(req, res) {
    let buffer
    try {
      buffer = await readRawBody(req, 8 * 1024 * 1024)
    } catch (error) {
      return sendError(res, 413, error instanceof Error ? error.message : '上传失败')
    }
    let files
    try {
      files = readZip(buffer)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : '不是有效的 zip')
    }
    let built
    try {
      built = packFromFiles(files)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : '剧情包内容不合格')
    }

    const id = 'pack-' + newId().slice(0, 10)
    const stored = {
      id,
      createdAt: Date.now(),
      name: built.name,
      version: built.version,
      mode: built.mode || 'roleplay',
      intro: built.intro || '',
      recommendedPlayers: built.recommendedPlayers,
      author: built.author,
      generator: built.generator || '',
      brand: built.brand || '',
      description: built.description,
      scenario: built.scenario,
      truth: built.truth || '',
      characters: built.characters,
      map: built.map,
      assets: built.assets,
    }
    await mkdir(packsDir, { recursive: true })
    await writeFile(join(packsDir, `${id}.json`), JSON.stringify(stored, null, 2), 'utf8')

    // 素材落盘（阶段 3 的立绘/背景用；文件名去掉路径分隔符）
    if (built.assets.length > 0) {
      const assetDir = join(packsDir, id, 'assets')
      await mkdir(assetDir, { recursive: true })
      for (const file of files) {
        if (!file.name.startsWith('assets/')) continue
        const base = file.name.slice('assets/'.length).replace(/[\\/]/g, '_')
        if (!base || base.includes('..')) continue
        await writeFile(join(assetDir, base), file.data)
      }
    }

    return sendJson(res, 201, { pack: packSummary(stored) })
  }

  // ---- 广播 ---------------------------------------------------------------

  function broadcast(roomId, event, data, filter) {
    const set = clients.get(roomId)
    if (!set || set.size === 0) return
    for (const client of set) {
      if (filter && !filter(client)) continue
      writeSse(client.res, event, data)
    }
  }

  function broadcastMembers(room) {
    broadcast(room.id, 'members', { members: Object.values(room.members).map(publicMember) })
  }

  function closeRoomStreams(roomId) {
    const set = clients.get(roomId)
    if (!set) return
    for (const client of set) {
      try {
        client.res.end()
      } catch {
        /* ignore */
      }
    }
    clients.delete(roomId)
  }

  /** 开房页展示的局域网地址（给手机/朋友输网址用） */
  function networkInfo() {
    const address = httpServer?.address()
    const port = address && typeof address === 'object' ? address.port : cfg.port
    const interfaces = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' || item.internal) continue
        interfaces.push({
          address: item.address,
          netmask: item.netmask,
          name,
          virtual: isVirtualInterface(name),
        })
      }
    }
    // 手机只能访问「同一局域网里的真实网卡地址」：
    // 排除 169.254 自分配、PPP/拨号的 /32、VMware/Hyper-V/WSL 等虚拟网卡
    const usable = interfaces.filter(
      (item) => !isLinkLocalAddress(item.address) && !item.virtual && !isPointToPoint(item.netmask),
    )
    return {
      port,
      publicUrl: cfg.publicUrl || '',
      // 兼容旧字段：只给手机能用的地址
      addresses: usable.map((item) => item.address),
      // 带网卡名的明细，开房页按这个显示
      interfaces,
    }
  }

  // ---- 消息 ---------------------------------------------------------------

  function appendMessage(room, data) {
    const message = {
      id: newId(),
      seq: (room.seq += 1),
      kind: data.kind,
      memberId: data.memberId ?? null,
      name: data.name ?? '',
      role: data.role ?? 'player',
      text: String(data.text ?? ''),
      ts: nowMs(),
      inAiContext: data.inAiContext !== false,
      private: data.private === true,
      to: data.to ?? null,
    }
    room.messages.push(message)
    broadcast(room.id, 'message', { message }, (client) => {
      if (!message.private) return true
      const member = client.memberId ? room.members[client.memberId] : null
      return messageVisibleTo(message, client.memberId, member ? member.role : null)
    })
    return message
  }

  function buildAiContext(room) {
    const limit =
      Number.isInteger(room.contextMessages) && room.contextMessages >= 0
        ? room.contextMessages
        : cfg.contextMessages
    const all = room.messages.filter((m) => m.inAiContext)
    // 0 = 全部历史（房主自己承担 token 成本）
    const messages = limit > 0 ? all.slice(-limit) : all
    return messages.map((m) =>
      m.kind === 'ai'
        ? { role: 'assistant', content: m.text }
        : { role: 'user', content: `${m.name}（${roleLabel(m.role)}）：${m.text}` },
    )
  }

  function broadcastVote(room) {
    broadcast(room.id, 'vote', { vote: publicVote(room) })
  }

  function buildSystemPrompt(room, force, reveal, phaseDirective = '') {
    const roster = Object.values(room.members)
      .map((m) => `- ${m.name}（${roleLabel(m.role)}）`)
      .join('\n')
    const persona = room.persona
    const mode = room.mode || room.pack?.mode || 'roleplay'
    const phase = publicPhase(room)
    const phaseRule = phase ? MYSTERY_PHASES.find((item) => item.id === phase.id)?.rule || '' : ''
    const head = []
    if (persona) {
      const genderLabel = { female: '女', male: '男', other: '其他' }[persona.gender] || ''
      head.push(
        `你正在主持一场多人联机的文字冒险（Galgame 风格）。你要扮演「${persona.name}」${
          genderLabel ? `（${genderLabel}）` : ''
        }，同时承担旁白。`,
      )
      head.push('', '【角色设定】', persona.description || '（未填写）')
      if (persona.personality) head.push('', '【性格】', persona.personality)
      if (persona.systemPrompt) head.push('', '【角色指令】', persona.systemPrompt)
      if (persona.rules) head.push('', '【角色守则】', persona.rules)
      if (persona.behavior) head.push('', '【行为细节】', persona.behavior)
      if (Array.isArray(persona.relations) && persona.relations.length > 0) {
        const lines = persona.relations
          .map((item) => `- ${persona.name} 与 ${item.name || item.target || '对方'}：${item.relation}`)
          .join('\n')
        head.push('', '【人物关系】', lines)
      }
      if (persona.mesExample) head.push('', '【对话示例】', persona.mesExample)
    } else {
      head.push(`你正在主持一场多人联机的文字冒险（Galgame 风格）。你是这个房间的${cfg.aiName}。`)
    }
    const cast = Array.isArray(room.cast) ? room.cast : []
    const base = [
      ...head,
      '',
      `【房间】${room.title}`,
      '【参与者】',
      roster || '（暂无）',
      ...(mode === 'mystery' && cast.length > 0
        ? [
            '',
            '【角色与扮演者】',
            ...cast.map((character) => {
              const assignee = character.assigneeId ? room.members[character.assigneeId] : null
              const who =
                character.playedBy === 'ai'
                  ? '（AI 扮演）'
                  : assignee
                    ? `（由 ${assignee.name} 扮演）`
                    : '（暂无人扮演）'
              return `- ${character.name}${who}`
            }),
          ]
        : []),
      ...(mode === 'mystery' && cast.some((character) => character.secret)
        ? [
            '',
            '【角色本（最高机密，只有你知道；不要公开别人的秘密）】',
            ...cast
              .filter((character) => character.secret)
              .map((character) => `- ${character.name}：${character.secret}`),
          ]
        : []),
      '',
      '【世界观与设定】',
      room.scenario || cfg.defaultScenario,
      ...(room.pack?.map && Array.isArray(room.pack.map.locations) && room.pack.map.locations.length > 0
        ? [
            '',
            '【地图】',
            ...room.pack.map.locations.map((location) => {
              const all = room.pack.map.locations
              const path = []
              let current = location
              let guard = 0
              while (current && guard < 10) {
                path.unshift(current.name)
                current = current.parent
                  ? all.find((item) => item.id === current.parent)
                  : null
                guard += 1
              }
              return `- ${path.join(' / ')}（${location.direction || '中心'}）${
                location.description ? '：' + location.description : ''
              }`
            }),
          ]
        : []),
      ...(room.summary ? ['', '【之前剧情摘要】', room.summary] : []),
      ...(Array.isArray(room.agents) && room.agents.length > 0
        ? [
            '',
            '【你的子代理】',
            ...room.agents.map(
              (agent) =>
                `- ${agent.name}（${agent.inScene ? '已在场' : '未上场'}${agent.location ? ` · 在${agent.location}` : ''}${agent.plan ? ` · 打算：${agent.plan}` : ''}）——由子代理扮演，你不要替她写台词；需要她说话时用 <speak 角色名> 点她，或等 GM 点名。`,
            ),
          ]
        : []),
      ...(room.truth && mode === 'soup'
        ? [
            '',
            '【汤底（最高机密，只有你知道）】',
            room.truth,
            '在全员投票揭晓前，绝不能用任何方式直接或间接说出汤底；回答只能以「是」「不是」「无关」「无法回答」开头。',
          ]
        : []),
      ...(room.truth && mode === 'mystery'
        ? ['', '【真相（最高机密，复盘阶段才可完整讲出）】', room.truth]
        : []),
      ...(phase
        ? [
            '',
            `【当前阶段】${phase.label}（${phase.index + 1}/${phase.total}）`,
            phaseRule,
          ]
        : []),
      '',
      '【行为规则】',
      '1. 用第三人称旁白推进剧情，可以写环境、NPC 的反应与对白；单次回复控制在 200 字以内。',
      '2. 消息里形如「昵称（职位）：内容」的是玩家发言；可以称呼他们的名字，但不要复述原话。',
      '3. 选择性接话：玩家只是互相寒暄、闲聊、讨论与剧情无关的事时，你只输出 <silent>，不要输出任何其他内容。',
      '4. 只有剧情需要推进、玩家在向剧情或你提问、或玩家角色在等待回应时，才用自然的文字回应。',
      '5. 不解释规则、不自称 AI、不输出元信息。',
      ...(Array.isArray(room.agents) && room.agents.length > 0
        ? [
            '6. 需要某个子代理开口时，在回复最后单独一行写 <speak 角色名>；系统会转给她，你不要替她写台词。这个标记不会显示给玩家。',
          ]
        : []),
      ...(mode === 'mystery'
        ? [
            '7. 公开消息里不出现任何角色本内容；玩家私聊给你的秘密不要复述给其他玩家；只有复盘阶段才能完整讲出真相。',
          ]
        : []),
      ...(room.pack && PACK_MODE_RULES[room.pack.mode] && PACK_MODE_RULES[room.pack.mode] !== ''
        ? ['', '【模式】' + PACK_MODE_RULES[room.pack.mode]]
        : []),
    ].join('\n')
    const instructions = []
    if (reveal) {
      instructions.push(
        '现在揭晓汤底：完整、清楚地讲出真相，让所有玩家明白谜面与谜底如何对应。' +
          (room.truth ? `\n汤底原文（照这个讲，不要编造）：\n${room.truth}` : ''),
      )
    }
    if (phaseDirective && phase) {
      instructions.push(
        `现在进入「${phase.label}」阶段：${phaseRule} 先用一句话交代阶段目标，再让玩家行动。`,
      )
    } else if (force && !reveal) {
      instructions.push('现在立即推进剧情：给出新的场景、事件或对话，让故事往前走一步。')
    }
    return instructions.length > 0
      ? `${base}\n\n【主持人指令】${instructions.join('\n')}`
      : base
  }

  function normalizeAiText(text) {
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '') return ''
    return value.slice(0, 4000)
  }

  /** 主代理输出里的 <speak 角色名> 指令：从正文里剥掉，只留第一个角色名 */
  function extractSpeakDirective(text) {
    let name = ''
    const cleaned = String(text ?? '')
      .replace(/<\s*speak(?:\s+([^<>]*?))?\s*\/?>(?:\s*<\/\s*speak\s*>)?/gi, (_, arg) => {
        if (!name && typeof arg === 'string') {
          name = arg
            .trim()
            .replace(/^["'「『]|["'」』]$/g, '')
            .slice(0, 40)
        }
        return ''
      })
      .trim()
    return { text: cleaned, name }
  }

  function findAgentByName(room, name) {
    const key = String(name ?? '').trim().toLowerCase()
    if (!key) return null
    return (
      (room.agents || []).find(
        (agent) => String(agent.id).toLowerCase() === key || String(agent.name).toLowerCase() === key,
      ) || null
    )
  }

  function hasPendingOnline(room) {
    return room.messages.some((m) => m.seq > room.ai.cursor && m.inAiContext)
  }

  /**
   * 长局滚动摘要：攒够一批未摘要的消息后，让模型压成一段放在系统提示里，
   * 之后只需要「摘要 + 最近 N 条」，比每次重发全量便宜，也不丢早期剧情。
   */
  async function maybeSummarize(room) {
    if (room.closed || room.autoSummary === false || room._summarizing) return
    const limit =
      Number.isInteger(room.contextMessages) && room.contextMessages > 0
        ? room.contextMessages
        : cfg.contextMessages
    const threshold = Math.max(20, limit)
    const pending = room.messages.filter(
      (m) => m.seq > (room.summarySeq || 0) && m.inAiContext,
    )
    if (pending.length < threshold) return
    room._summarizing = true
    try {
      const lines = pending.map((m) =>
        m.kind === 'ai' ? `旁白：${m.text}` : `${m.name}：${m.text}`,
      )
      const system = [
        '你是剧情记录员。把下面这段对话压缩成一段不超过 300 字的中文剧情摘要，',
        '只保留关键事件、人物关系变化、伏笔和未解决的事，不要评论、不要逐句复述。',
        room.summary ? '已有摘要（请合并更新）：' + room.summary : '目前还没有摘要。',
      ].join('\n')
      const reply = await cfg.generate({
        system,
        messages: [{ role: 'user', content: lines.join('\n') }],
        force: true,
        roomId: room.id,
        captureReasoning: false,
      })
      const text = normalizeAiText(typeof reply === 'string' ? reply : reply?.text || '')
      if (text) {
        room.summary = text.slice(0, 600)
        room.summarySeq = pending[pending.length - 1].seq
        await persist(room)
      }
    } catch {
      /* 摘要失败不影响正片 */
    } finally {
      room._summarizing = false
    }
  }

  /**
   * 发言调度：同一批发言合并成一轮。
   * - 普通消息：等 debounceMs，把窗口内的发言一起交给 AI；
   * - GM「推进」：不等，立即跑一轮，并强制 AI 开口。
   */
  function scheduleAi(room, { force = false } = {}) {
    if (room.closed) return
    if (force) room._force = true
    if (room.ai.status === 'thinking') {
      // 正在生成：记一笔，等这一轮结束后立刻补跑
      room._dirty = true
      return
    }
    if (room._timer) clearTimeout(room._timer)
    room._timer = setTimeout(
      () => {
        room._timer = null
        void runAiTurn(room)
      },
      force ? 0 : cfg.debounceMs,
    )
    room._timer.unref?.()
  }

  async function runAiTurn(room) {
    if (room.closed) return
    if (room.ai.status === 'thinking') {
      room._dirty = true
      return
    }
    const force = room._force === true
    room._force = false
    const reveal = room._reveal === true
    room._reveal = false
    // 刚切换阶段时给模型一句额外指令（只生效这一轮）
    const phaseDirective = room._phaseDirective || ''
    room._phaseDirective = ''

    const batch = room.messages.filter((m) => m.seq > room.ai.cursor && m.inAiContext)
    if (batch.length === 0 && !force) return

    room.ai.status = 'thinking'
    broadcast(room.id, 'ai', { status: 'thinking', seq: room.seq })

    let replyText = ''
    let replyReasoning = ''
    try {
      const reply = await cfg.generate({
        system: buildSystemPrompt(room, force, reveal, phaseDirective),
        messages: buildAiContext(room),
        force,
        roomId: room.id,
        // 开启调试时才要求模型保留思维链（并因此不再强制 reasoning=off）
        captureReasoning: cfg.saveReasoning === true,
      })
      if (reply && typeof reply === 'object') {
        replyText = typeof reply.text === 'string' ? reply.text : ''
        replyReasoning = typeof reply.reasoning === 'string' ? reply.reasoning : ''
      } else {
        replyText = typeof reply === 'string' ? reply : ''
      }
    } catch (error) {
      room.ai.status = 'idle'
      room.ai.lastError = error instanceof Error ? error.message : String(error)
      broadcast(room.id, 'ai', { status: 'error', error: room.ai.lastError, seq: room.seq })
      await persist(room)
      if (room._dirty || room._force) {
        room._dirty = false
        scheduleAi(room, { force: room._force === true })
      }
      return
    }

    const parsedReply = extractSpeakDirective(replyText)
    const text = normalizeAiText(parsedReply.text)
    if (room.closed) {
      // 生成期间房间被关掉：不往已关闭的房间追加消息
      room.ai.status = 'idle'
      return
    }
    const silent = text === '' || SILENT_RE.test(text)
    if (!silent) {
      appendMessage(room, { kind: 'ai', name: room.aiName ?? cfg.aiName, role: 'ai', text, inAiContext: true })
    }
    // 主代理用 <speak 角色名> 点名：自动让子代理接一句（每轮最多一次）
    let autoSpeakFailed = false
    if (parsedReply.name) {
      const agent = findAgentByName(room, parsedReply.name)
      if (agent) {
        try {
          await runSpeakTurn(room, agent)
        } catch (error) {
          autoSpeakFailed = true
          room.ai.lastError = error instanceof Error ? error.message : String(error)
        }
      }
    }
    // 这一批消息不论 AI 是否接话都算「看过」，否则 <silent> 之后会反复重发
    room.ai.cursor = room.seq
    room.ai.status = 'idle'
    if (!autoSpeakFailed) room.ai.lastError = null
    // 思维链只在房主本机留痕：不进 publicRoom、不进 messages、不进 SSE
    if (cfg.saveReasoning === true && replyReasoning) {
      room.debug = Array.isArray(room.debug) ? room.debug : []
      room.debug.push({ ts: nowMs(), roomSeq: room.seq, reasoning: replyReasoning.slice(0, 8000) })
      room.debug = room.debug.slice(-20)
    }
    broadcast(room.id, 'ai', { status: 'idle', seq: room.seq, silent })
    await persist(room)
    void maybeSummarize(room)

    if (room._dirty || room._force) {
      room._dirty = false
      scheduleAi(room, { force: room._force === true })
    } else if (hasPendingOnline(room)) {
      scheduleAi(room)
    }
  }

  // ---- 鉴权 ---------------------------------------------------------------

  function tokenOf(req, url) {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    const q = url.searchParams.get('t')
    return q && q.trim() !== '' ? q.trim() : ''
  }

  function findMember(room, token) {
    if (!token) return undefined
    return Object.values(room.members).find((m) => safeEqual(m.token, token))
  }

  function inviteOk(room, req, url, body) {
    const token =
      (body && typeof body.inviteToken === 'string' ? body.inviteToken : '') ||
      url.searchParams.get('t') ||
      String(req.headers['x-invite-token'] ?? '')
    return token.trim() !== '' && safeEqual(token.trim(), room.inviteToken)
  }

  // ---- 限流 ---------------------------------------------------------------

  function rateLimited(req) {
    const key = req.socket.remoteAddress ?? 'unknown'
    const now = nowMs()
    const entry = rate.get(key)
    if (!entry || now - entry.windowStart >= 1000) {
      rate.set(key, { windowStart: now, count: 1 })
      return false
    }
    entry.count += 1
    return entry.count > cfg.rateLimitPerSec
  }

  // ---- 路由 ---------------------------------------------------------------

  async function route(req, res) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-invite-token')
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    let parts
    try {
      parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
    } catch {
      return sendError(res, 400, 'bad path')
    }

    if (req.method === 'GET' && parts.length === 0) {
      return serveStatic(res, 'host.html')
    }
    if (req.method === 'GET' && parts[0] === 'make' && parts.length === 1) {
      return serveStatic(res, 'make.html')
    }
    if (req.method === 'GET' && parts[0] === 'room' && parts.length === 2) {
      return serveStatic(res, 'room.html')
    }
    if (req.method === 'GET' && parts[0] === 'room-assets' && parts.length === 2) {
      return serveStatic(res, parts[1])
    }
    if (parts[0] !== 'api') return sendError(res, 404, 'not found')
    if (parts[1] === 'health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        rooms: rooms.size,
        author: 'B站：喵诺澪染',
        plugin: 'dsh-story-party',
      })
    }
    if (parts[1] === 'version' && parts.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, { version: cfg.version, protocol: 1, strict: cfg.strictVersion === true })
    }
    if (parts[1] === 'network' && parts.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, networkInfo())
    }
    if (parts[1] === 'port' && parts.length === 2) {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
      }
      try {
        const result = await setPort(body.port)
        return sendJson(res, 200, {
          port: result.port,
          hostname: result.hostname,
          addresses: networkInfo().addresses,
        })
      } catch (error) {
        return sendError(res, 400, error instanceof Error ? error.message : String(error))
      }
    }
    // 运行时改公网地址（樱花隧道重建后地址会变，不想重载插件就用这个）
    if (parts[1] === 'public-url' && parts.length === 2) {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
      }
      const next = normalizePublicUrl(body.url ?? body.publicUrl ?? '')
      if (next !== '' && !/^https?:\/\//i.test(next)) {
        return sendError(res, 400, '公网地址要是 http(s) 开头的 URL')
      }
      cfg.publicUrl = next
      cfg.onPublicUrlChange?.(next)
      return sendJson(res, 200, { publicUrl: next })
    }
    // 房主侧的调试开关（思维链只留在本机，不对外）
    if (parts[1] === 'settings' && parts.length === 2) {
      if (req.method === 'GET') return sendJson(res, 200, { saveReasoning: cfg.saveReasoning === true })
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
      }
      if (typeof body.saveReasoning === 'boolean') {
        cfg.saveReasoning = body.saveReasoning
        cfg.onSettingsChange?.({ saveReasoning: cfg.saveReasoning })
      }
      return sendJson(res, 200, { saveReasoning: cfg.saveReasoning === true })
    }
    if (parts[1] === 'cards' && parts.length === 2 && req.method === 'GET') {
      let cards = []
      if (typeof cfg.loadCards === 'function') {
        try {
          cards = (await cfg.loadCards()) || []
        } catch {
          cards = []
        }
      }
      return sendJson(res, 200, {
        cards: cards
          .map((card) => personaFromCard(card))
          .filter(Boolean)
          // 开房页只需要选卡信息；角色本不经这里下发
          .map(({ secret, playerBrief, ...safe }) => safe),
      })
    }
    if (parts[1] === 'packs') {
      if (parts.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, { packs: await listPacks() })
        if (req.method === 'POST') return importPack(req, res)
        return sendError(res, 405, 'method not allowed')
      }
      if (parts.length === 3) {
        const packId = parts[2]
        if (req.method === 'GET') {
          const pack = await loadPack(packId)
          if (!pack) return sendError(res, 404, '剧情包不存在')
          // 汤底 / 真相只给 GM：普通详情只返回 hasTruth，不返回正文
          const { truth, ...safe } = pack
          return sendJson(res, 200, {
            pack: {
              ...safe,
              hasTruth: Boolean(truth),
              // 角色本只经房间的角色接口按身份下发，详情里统一剥掉
              characters: (Array.isArray(pack.characters) ? pack.characters : []).map(
                ({ secret, playerBrief, ...rest }) => rest,
              ),
            },
          })
        }
        if (req.method === 'DELETE') {
          const pack = await loadPack(packId)
          if (!pack) return sendError(res, 404, '剧情包不存在')
          await rm(join(packsDir, `${packId}.json`), { force: true })
          await rm(join(packsDir, packId), { recursive: true, force: true })
          return sendJson(res, 200, { deleted: true })
        }
        return sendError(res, 405, 'method not allowed')
      }
      return sendError(res, 404, 'not found')
    }
    if (parts[1] !== 'rooms') return sendError(res, 404, 'not found')

    // POST /api/rooms —— 建房
    if (parts.length === 2) {
      if (req.method === 'POST') return createRoom(req, res)
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          rooms: [...rooms.values()].map((r) => ({
            id: r.id,
            title: r.title,
            closed: r.closed,
            members: Object.keys(r.members).length,
            createdAt: r.createdAt,
            seq: r.seq,
            aiName: r.aiName ?? null,
            sessionId: r.sessionId ?? null,
            personaName: r.persona ? r.persona.name : null,
          })),
        })
      }
      return sendError(res, 405, 'method not allowed')
    }

    const room = rooms.get(parts[2])
    if (!room) return sendError(res, 404, 'room not found')
    const sub = parts[3]

    if (sub === 'join' && req.method === 'POST') return joinRoom(req, res, room, url)
    if (sub === 'events' && req.method === 'GET') return openEvents(req, res, room, url)
    if (sub === 'messages') {
      if (req.method === 'GET') return listMessages(req, res, room, url)
      if (req.method === 'POST') return postMessage(req, res, room, url)
      return sendError(res, 405, 'method not allowed')
    }
    if (sub === 'members') {
      if (parts.length === 4) {
        if (req.method === 'GET') {
          if (!inviteOk(room, req, url) && !findMember(room, tokenOf(req, url))) {
            return sendError(res, 403, '需要邀请令牌或成员令牌')
          }
          return sendJson(res, 200, { members: Object.values(room.members).map(publicMember) })
        }
        return sendError(res, 405, 'method not allowed')
      }
      if (parts.length === 5) {
        if (req.method === 'PATCH') return setRole(req, res, room, url, parts[4])
        if (req.method === 'DELETE') return kickMember(req, res, room, url, parts[4])
      }
      return sendError(res, 405, 'method not allowed')
    }
    if (sub === 'advance' && req.method === 'POST') return advance(req, res, room, url)
    if (sub === 'purge' && req.method === 'POST') return purgeRoom(req, res, room, url)
    if (sub === 'avatar' && req.method === 'POST') return setAvatar(req, res, room, url)
    if (sub === 'vote' && req.method === 'POST') return roomVote(req, res, room, url)
    if (sub === 'speak' && req.method === 'POST') return speakAgent(req, res, room, url)
    if (sub === 'truth' && req.method === 'GET') return roomTruth(req, res, room, url)
    if (sub === 'roles') {
      if (req.method === 'GET') return getRoles(req, res, room, url)
      if (req.method === 'POST') return setRoles(req, res, room, url)
      return sendError(res, 405, 'method not allowed')
    }
    if (sub === 'phase' && req.method === 'POST') return roomPhase(req, res, room, url)
    if (sub === 'leave' && req.method === 'POST') return leaveRoom(req, res, room, url)

    // /api/rooms/:id 本身
    if (parts.length === 3) {
      if (req.method === 'GET') {
        if (!inviteOk(room, req, url) && !findMember(room, tokenOf(req, url))) {
          return sendError(res, 403, '需要邀请令牌或成员令牌')
        }
        return sendJson(res, 200, { room: publicRoom(room) })
      }
      if (req.method === 'PATCH') return patchRoom(req, res, room, url)
      if (req.method === 'DELETE') return closeRoom(req, res, room, url)
      return sendError(res, 405, 'method not allowed')
    }

    return sendError(res, 404, 'not found')
  }

  // ---- 处理器 -------------------------------------------------------------

  async function createRoom(req, res) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    let cards = []
    if (!body.packId && typeof cfg.loadCards === 'function') {
      try {
        cards = (await cfg.loadCards()) || []
      } catch {
        cards = []
      }
    }
    let persona = null
    let packInfo = null
    let packCharacters = []
    let packScenario = ''
    let packTruth = ''
    let packMode = 'roleplay'
    let defaultTitle = ''
    if (body.packId) {
      const pack = await loadPack(String(body.packId))
      if (!pack) return sendError(res, 400, '剧情包不存在')
      const characters = Array.isArray(pack.characters) ? pack.characters : []
      packCharacters = characters
      const character = characters.find((item) => item.id === body.characterId) || characters[0]
      if (!character) return sendError(res, 400, '剧情包里没有人物')
      persona = personaFromCard(character)
      if (!persona) return sendError(res, 400, '剧情包里的人物卡不完整')
      packScenario = pack.scenario || ''
      packTruth = typeof pack.truth === 'string' ? pack.truth : ''
      packMode = PACK_MODES.has(pack.mode) ? pack.mode : 'roleplay'
      defaultTitle = `${pack.name} · ${character.name}`
      packInfo = {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        mode: packMode,
        intro: pack.intro || '',
        recommendedPlayers: pack.recommendedPlayers || { min: 2, max: 4 },
        hasTruth: Boolean(packTruth),
        map: pack.map || { locations: [], routes: [] },
      }
      // 剧本杀里如果选中的人类角色只是「玩家位」，AI 就当 GM/旁白，
      // 不要把该角色变成 AI 的化身；AI 角色仍可被选中当主角。
      if (packMode === 'mystery' && persona.playedBy === 'human') {
        persona = null
        defaultTitle = pack.name
      }
    } else if (body.cardId) {
      persona = personaFromCard(cards.find((card) => card && card.id === body.cardId))
      if (!persona) return sendError(res, 400, '找不到这张人设卡（cosplay 角色库可能已更新）')
    }

    // 剧本杀角色名单：所有人物都在，角色本只存在房间 JSON 里
    const cast = packCharacters
      .map((character) => personaFromCard(character))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        name: item.name,
        emoji: item.emoji,
        avatar: item.avatar || '',
        gender: item.gender || '',
        playedBy: item.playedBy || 'ai',
        playerBrief: item.playerBrief || '',
        secret: item.secret || '',
        assigneeId: null,
      }))

    const id = newRoomId()
    const gm = {
      id: newId(),
      name: String(body.gmName ?? '').trim().slice(0, 32) || '主持人',
      role: 'gm',
      token: newToken(),
      joinedAt: nowMs(),
      lastSeenAt: nowMs(),
    }
    const passwordText = String(body.password ?? '').trim()
    // 宿主绑定的 DSH 会话 id：玩家本地副本按它比对，变了就整份重新同步
    const sessionId = String(body.sessionId ?? '').trim().slice(0, 80) || null
    // 自我游玩：单人房间，只有 GM 和 AI
    const solo = body.solo === true
    // AI 读取历史条数：0 = 全部；不传 = 用插件默认
    const requestedContext = Number(body.contextMessages)
    const contextMessages =
      body.contextMessages === undefined || body.contextMessages === null || body.contextMessages === ''
        ? null
        : Number.isInteger(requestedContext)
          ? Math.max(0, Math.min(1000, requestedContext))
          : null
    const room = {
      id,
      solo,
      contextMessages,
      mode: packMode,
      // 剧本杀阶段机：其余模式为 null
      phase: packMode === 'mystery' ? 'reading' : null,
      // 汤底 / 真相：只留在房主主机与系统提示词里，不进 publicRoom
      truth: packTruth.slice(0, 20000),
      cast,
      // 长局滚动摘要：默认开，房主可关
      autoSummary: body.autoSummary !== false,
      summary: '',
      summarySeq: 0,
      // 子代理名册：剧情包里除主角外的 AI 角色，各管各的台词
      agents: packCharacters
        .map((character) => personaFromCard(character))
        .filter((item) => item && item.playedBy !== 'human' && item.id !== persona?.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          emoji: item.emoji,
          avatar: item.avatar || '',
          inScene: false,
          lastSeenSeq: 0,
          location: '',
          plan: '',
          persona: item,
        })),
      title:
        String(body.title ?? '').trim().slice(0, 60) ||
        defaultTitle ||
        (solo ? '单人游玩' : persona ? `与${persona.name}的同居日常` : '未命名房间'),
      scenario:
        String(body.scenario ?? '').trim().slice(0, 8000) ||
        packScenario ||
        persona?.scenario ||
        cfg.defaultScenario,
      aiName: persona?.name || cfg.aiName,
      persona,
      pack: packInfo,
      createdAt: nowMs(),
      closed: false,
      maxPlayers: solo ? 1 : clampInt(body.maxPlayers, cfg.maxPlayers, 2, 16),
      seq: 0,
      members: { [gm.id]: gm },
      messages: [],
      ai: { status: 'idle', cursor: 0, lastError: null },
      vote: null,
      password: passwordText ? hashPassword(passwordText) : null,
      sessionId,
      inviteToken: newToken(),
    }
    rooms.set(id, room)
    // 剧情包的开场说明：固定第一条，之后才是人物开场白 / 背景故事
    if (packInfo?.intro) {
      appendMessage(room, {
        kind: 'ai',
        name: room.aiName,
        role: 'ai',
        text: packInfo.intro,
        inAiContext: true,
      })
    }
    // 人设卡自带开场白：建房后直接把这一句作为旁白的开场放进消息流
    if (persona?.firstMes) {
      appendMessage(room, { kind: 'ai', name: room.aiName, role: 'ai', text: persona.firstMes, inAiContext: true })
    }
    await persist(room)
    return sendJson(res, 201, {
      room: publicRoom(room),
      inviteToken: room.inviteToken,
      gm: { memberId: gm.id, token: gm.token },
      joinPath: `/room/${id}?t=${room.inviteToken}`,
    })
  }

  async function joinRoom(req, res, room, url) {
    if (room.closed) return sendError(res, 410, '房间已关闭')
    if (room.solo) return sendError(res, 403, '这是单人房间，别人进不来')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    if (!inviteOk(room, req, url, body)) return sendError(res, 403, '邀请令牌不正确')
    if (!verifyPassword(room, body.password)) {
      return sendError(res, 403, '需要房间密码（或密码不正确）', { code: 'PASSWORD_REQUIRED' })
    }
    if (cfg.strictVersion === true && String(body.clientVersion ?? '') !== String(cfg.version)) {
      return sendError(
        res,
        409,
        `插件版本不一致：房间需要 v${cfg.version}，当前 v${String(body.clientVersion || '未知')}（双方要用同一版本）`,
      )
    }

    const role = ASSIGNABLE_ROLES.has(body.role) ? body.role : 'player'
    const machineCode = normalizeMachineCode(body.machineCode)
    const identity = machineCode ? identities[identityKey(room.id, machineCode)] : null
    const members = Object.values(room.members)
    if (role === 'player') {
      const seats = members.filter((m) => m.role === 'gm' || m.role === 'player').length
      if (seats >= room.maxPlayers) return sendError(res, 409, '房间已满')
    } else {
      const spectators = members.filter((m) => m.role === 'spectator').length
      if (spectators >= cfg.maxSpectators) return sendError(res, 409, '观众席已满')
    }

    const member = {
      id: newId(),
      name: String(body.name ?? '').trim().slice(0, 32) || `玩家${members.length}`,
      role,
      // 同一台机器再次进同一间房：沿用 uid / 头像
      uid: (identity && typeof identity.uid === 'string' && identity.uid) || newUid(),
      avatar: identity && typeof identity.avatar === 'string' ? identity.avatar : '',
      machineCode,
      token: newToken(),
      joinedAt: nowMs(),
      lastSeenAt: nowMs(),
    }
    room.members[member.id] = member
    rememberIdentity(room.id, machineCode, {
      uid: member.uid,
      avatar: member.avatar,
      name: member.name,
    })
    await persist(room)
    broadcast(room.id, 'system', { text: `${member.name} 加入了房间`, member: publicMember(member) })
    broadcastMembers(room)
    return sendJson(res, 200, {
      memberId: member.id,
      member: publicMember(member),
      token: member.token,
      role: member.role,
      room: publicRoom(room),
    })
  }

  async function listMessages(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member && !inviteOk(room, req, url)) return sendError(res, 403, '需要邀请令牌或成员令牌')
    if (member) member.lastSeenAt = nowMs()
    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') ?? 0)) || 0)
    const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000)
    const messages = room.messages
      .filter((m) => m.seq > since && messageVisibleTo(m, member?.id, member?.role))
      .slice(0, limit)
    return sendJson(res, 200, {
      roomId: room.id,
      seq: room.seq,
      ai: { status: room.ai.status, lastError: room.ai.lastError ?? null },
      messages,
    })
  }

  async function postMessage(req, res, room, url) {
    if (room.closed) return sendError(res, 410, '房间已关闭')
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    if (rateLimited(req)) return sendError(res, 429, '发得太快了，歇一口气')

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const text = String(body.text ?? '').trim()
    if (text === '') return sendError(res, 400, 'text 不能为空')
    if (text.length > MAX_TEXT_LENGTH) return sendError(res, 413, `单条不能超过 ${MAX_TEXT_LENGTH} 字`)

    // 私聊：玩家只能私聊 GM，GM 可以私聊任意成员；私聊不进 AI 上下文
    const to = String(body.to ?? '').trim()
    let target = null
    if (to !== '') {
      target = room.members[to]
      if (!target) return sendError(res, 404, '私聊对象不在房间里')
      if (target.id === member.id) return sendError(res, 400, '不能私聊自己')
      if (member.role !== 'gm' && target.role !== 'gm') {
        return sendError(res, 403, '玩家只能私聊 GM')
      }
    }
    const isPrivate = Boolean(target)

    member.lastSeenAt = nowMs()
    // 观众的发言进消息流、但不进 AI 上下文，也永远不触发模型
    const inAiContext = !isPrivate && member.role !== 'spectator'
    const message = appendMessage(room, {
      kind: 'user',
      memberId: member.id,
      name: member.name,
      role: member.role,
      text,
      inAiContext,
      private: isPrivate,
      to: target ? target.id : null,
    })
    await persist(room)
    if (inAiContext) scheduleAi(room)
    return sendJson(res, 202, { message, seq: room.seq })
  }

  async function advance(req, res, room, url) {
    if (room.closed) return sendError(res, 410, '房间已关闭')
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    if (member.role !== 'gm') return sendError(res, 403, '只有 GM 能推进剧情')
    member.lastSeenAt = nowMs()
    if (room.ai.status === 'thinking') {
      room._dirty = true
      room._force = true
      return sendJson(res, 202, { queued: true, ai: { status: room.ai.status } })
    }
    scheduleAi(room, { force: true })
    return sendJson(res, 202, { queued: true, ai: { status: room.ai.status } })
  }

  async function patchRoom(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member || member.role !== 'gm') return sendError(res, 403, '只有 GM 能修改房间')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    if (typeof body.title === 'string' && body.title.trim() !== '') room.title = body.title.trim().slice(0, 60)
    if (typeof body.scenario === 'string') room.scenario = body.scenario.trim().slice(0, 8000)
    if (typeof body.password === 'string') {
      const next = body.password.trim()
      room.password = next ? hashPassword(next) : null
    }
    // GM 可以重新开放已关闭的房间（继续上次没玩完的局）
    if (body.closed === false) room.closed = false
    member.lastSeenAt = nowMs()
    await persist(room)
    broadcast(room.id, 'room', { room: publicRoom(room) })
    return sendJson(res, 200, { room: publicRoom(room) })
  }

  async function closeRoom(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member || member.role !== 'gm') return sendError(res, 403, '只有 GM 能关闭房间')
    room.closed = true
    await persist(room)
    broadcast(room.id, 'room', { closed: true })
    closeRoomStreams(room.id)
    return sendJson(res, 200, { closed: true })
  }

  /** 本机（回环）请求：房主在自己机器上清理房间时不必持有 GM 令牌 */
  function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress || ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  /** 永久删除房间：房间对象、JSON 文件、SSE 连接一起清掉（关闭只是打标记） */
  async function purgeRoom(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    const allowed = (member && member.role === 'gm') || isLoopbackRequest(req)
    if (!allowed) return sendError(res, 403, '只有 GM 或房主本机可以删除房间')
    rooms.delete(room.id)
    closeRoomStreams(room.id)
    try {
      await rm(join(cfg.dataDir, `${room.id}.json`), { force: true })
    } catch {
      /* 文件可能已不存在 */
    }
    return sendJson(res, 200, { deleted: true })
  }

  /** 投票：GM 发起 / 成员投票 / GM 取消；全员同意才生效（揭晓汤底） */
  /** 子代理说一轮：先出意图，再由主代理写成最终消息（手动点名与自动 <speak> 共用） */
  async function runSpeakTurn(room, agent) {
    const outcome = await runSubAgent(room, agent)
    if (outcome.location) agent.location = outcome.location
    if (outcome.plan) agent.plan = outcome.plan
    const directive = [
      `【接下来由子代理「${agent.name}」接话】`,
      `她现在在：${agent.location || '未说明'}；她接下来的打算：${agent.plan || '未说明'}。`,
      `她的意图（不要照抄）：${outcome.brief}`,
      `请以旁白/「${agent.name}」的口吻写成一条最终消息，200 字以内，只输出正文。`,
    ].join('\n')
    const reply = await cfg.generate({
      system: buildSystemPrompt(room, false) + '\n\n' + directive,
      messages: buildAiContext(room),
      force: true,
      roomId: `${room.id}#${agent.id}`,
      captureReasoning: cfg.saveReasoning === true,
    })
    const text = normalizeAiText(typeof reply === 'string' ? reply : reply?.text || '')
    if (text) {
      appendMessage(room, {
        kind: 'ai',
        name: agent.name,
        role: 'ai',
        text,
        inAiContext: true,
      })
    }
    agent.inScene = true
    agent.lastSeenSeq = room.seq
    return text
  }

  /** GM 点名一个子代理接话：子代理只出意图，主代理定稿成一条消息 */
  async function speakAgent(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member || member.role !== 'gm') return sendError(res, 403, '只有 GM 能点名')
    if (room.closed) return sendError(res, 410, '房间已关闭')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const agent = (room.agents || []).find((item) => item.id === String(body.agentId ?? ''))
    if (!agent) return sendError(res, 404, '房间里没有这个子代理')
    if (room.ai.status === 'thinking') return sendError(res, 409, '旁白正在生成，稍等再点名')

    room.ai.status = 'thinking'
    broadcast(room.id, 'ai', { status: 'thinking', seq: room.seq })
    try {
      const text = await runSpeakTurn(room, agent)
      room.ai.cursor = room.seq
      room.ai.status = 'idle'
      room.ai.lastError = null
      broadcast(room.id, 'ai', { status: 'idle', seq: room.seq, silent: text === '' })
      await persist(room)
      return sendJson(res, 200, {
        message: text || null,
        agent: { id: agent.id, name: agent.name, inScene: true },
      })
    } catch (error) {
      room.ai.status = 'idle'
      room.ai.lastError = error instanceof Error ? error.message : String(error)
      broadcast(room.id, 'ai', { status: 'error', error: room.ai.lastError, seq: room.seq })
      await persist(room)
      return sendError(res, 502, '子代理生成失败：' + room.ai.lastError)
    }
  }

  /** 子代理只思考：读自己的文档 + 自己的位置/打算 + 摘要 + 增量消息，输出意图与去向 */
  async function runSubAgent(room, agent) {
    const persona = agent.persona || {}
    const system = [
      '你是一个角色代理，只负责思考「这一刻你会说什么、做什么、接下来去哪里」。',
      '不要写旁白、不要代替其他角色、不要解释规则。',
      `角色名：${agent.name}`,
      persona.description ? `设定：${persona.description}` : '',
      persona.personality ? `性格：${persona.personality}` : '',
      persona.rules ? `守则：${persona.rules}` : '',
      persona.secret ? `你的秘密（不要公开说出，除非剧情已经揭晓）：${persona.secret}` : '',
      persona.playerBrief ? `须知：${persona.playerBrief}` : '',
      persona.likes ? `喜爱：${persona.likes}` : '',
      room.pack?.map?.locations?.length
        ? `常去：${(persona.favoritePlaces || [])
            .map((id) => {
              const all = room.pack.map.locations
              let current = all.find((location) => location.id === id)
              const path = []
              let guard = 0
              while (current && guard < 10) {
                path.unshift(current.name)
                current = current.parent
                  ? all.find((item) => item.id === current.parent)
                  : null
                guard += 1
              }
              return path.join(' / ') || id
            })
            .slice(0, 8)
            .join('、') || '未指定'}`
        : '',
      agent.location ? `你现在在：${agent.location}` : '',
      agent.plan ? `你之前的打算：${agent.plan}` : '',
      room.summary ? `之前剧情摘要：${room.summary}` : '',
      room.scenario ? `世界观：${room.scenario}` : '',
      '输出格式：只输出一行 JSON，形如 {"line":"你想说的要点","location":"你现在所在的位置","plan":"你接下来要去做什么"}，不要输出其他内容。',
    ]
      .filter(Boolean)
      .join('\n')
    const incremental = room.messages
      .filter((m) => m.seq > (agent.lastSeenSeq || 0) && m.inAiContext)
      .slice(-30)
      .map((m) => (m.kind === 'ai' ? `旁白：${m.text}` : `${m.name}：${m.text}`))
    const reply = await cfg.generate({
      system,
      messages:
        incremental.length > 0
          ? [{ role: 'user', content: incremental.join('\n') }]
          : [{ role: 'user', content: '（还没有新消息，可以先按人设准备一句开场）' }],
      force: true,
      roomId: `${room.id}#${agent.id}`,
      captureReasoning: false,
    })
    const text = normalizeAiText(typeof reply === 'string' ? reply : reply?.text || '')
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      return {
        brief: String(parsed.line ?? '').trim().slice(0, 600) || '（沉默）',
        location: String(parsed.location ?? '').trim().slice(0, 40),
        plan: String(parsed.plan ?? '').trim().slice(0, 120),
      }
    }
    return { brief: text || '（沉默）', location: '', plan: '' }
  }

  /** 汤底 / 真相：只有 GM 能取；永不出现在 publicRoom */
  async function roomTruth(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member || member.role !== 'gm') return sendError(res, 403, '只有 GM 能看汤底')
    if (!room.truth) return sendError(res, 404, '这个房间没有汤底 / 真相')
    return sendJson(res, 200, { truth: room.truth })
  }

  /** 角色本：GM 看全部，玩家只看自己的；别人的 secret 直接不返回 */
  function rolesPayload(room, member) {
    const isGm = member.role === 'gm'
    return {
      mode: room.mode || 'roleplay',
      phase: publicPhase(room),
      myCharacterId: member.characterId ?? null,
      cast: (room.cast || []).map((character) => {
        const assignee = character.assigneeId ? room.members[character.assigneeId] : null
        const mine = character.assigneeId === member.id
        const canSee = isGm || mine
        return {
          id: character.id,
          name: character.name,
          emoji: character.emoji || '',
          avatar: character.avatar || null,
          gender: character.gender || '',
          playedBy: character.playedBy || 'ai',
          assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
          mine,
          hasSecret: Boolean(character.secret),
          playerBrief: canSee ? character.playerBrief || '' : '',
          secret: canSee ? character.secret || '' : '',
        }
      }),
    }
  }

  async function getRoles(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌才能看角色本')
    member.lastSeenAt = nowMs()
    return sendJson(res, 200, rolesPayload(room, member))
  }

  /** 领角色 / GM 指派 / 释放；一个成员同时只持有一个角色 */
  async function setRoles(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const action = String(body.action ?? '')
    const cast = Array.isArray(room.cast) ? room.cast : []
    const target = cast.find((character) => character.id === String(body.characterId ?? ''))
    if (action !== 'release' && !target) return sendError(res, 404, '房间里没有这个角色')

    if (action === 'claim') {
      if (member.role === 'gm') return sendError(res, 403, 'GM 不扮演玩家角色')
      if (member.role === 'spectator') return sendError(res, 403, '观众不能领取角色，请让 GM 把你改成玩家')
      if (!target) return sendError(res, 404, '房间里没有这个角色')
      if (target.playedBy === 'ai') return sendError(res, 409, '这个角色由 AI 扮演，不能领取')
      if (target.assigneeId && target.assigneeId !== member.id) {
        return sendError(res, 409, '这个角色已经有人领取了')
      }
      for (const character of cast) {
        if (character.assigneeId === member.id && character.id !== target.id) character.assigneeId = null
      }
      target.assigneeId = member.id
      member.characterId = target.id
    } else if (action === 'assign') {
      if (member.role !== 'gm') return sendError(res, 403, '只有 GM 能指派角色')
      if (!target) return sendError(res, 404, '房间里没有这个角色')
      const targetMember = body.memberId ? room.members[String(body.memberId)] : null
      if (body.memberId && !targetMember) return sendError(res, 404, '成员不存在')
      if (targetMember && targetMember.role === 'gm') return sendError(res, 409, 'GM 不扮演玩家角色')
      if (targetMember && targetMember.role === 'spectator') {
        return sendError(res, 409, '观众不能扮演角色，请先改成玩家')
      }
      if (targetMember && target.playedBy === 'ai') {
        return sendError(res, 409, '这个角色由 AI 扮演，不能指派给玩家')
      }
      // 目标成员原来持有的角色先释放
      if (targetMember && targetMember.characterId && targetMember.characterId !== target.id) {
        const previous = cast.find((character) => character.id === targetMember.characterId)
        if (previous) previous.assigneeId = null
      }
      // 角色原来的持有人先释放
      if (target.assigneeId && target.assigneeId !== (targetMember ? targetMember.id : null)) {
        const previousHolder = room.members[target.assigneeId]
        if (previousHolder && previousHolder.characterId === target.id) previousHolder.characterId = null
      }
      target.assigneeId = targetMember ? targetMember.id : null
      if (targetMember) targetMember.characterId = target.id
    } else if (action === 'release') {
      const targetMember =
        member.role === 'gm' && body.memberId ? room.members[String(body.memberId)] : member
      if (!targetMember) return sendError(res, 404, '成员不存在')
      if (member.role !== 'gm' && targetMember.id !== member.id) {
        return sendError(res, 403, '只能释放自己的角色')
      }
      for (const character of cast) {
        if (character.assigneeId === targetMember.id) character.assigneeId = null
      }
      targetMember.characterId = null
    } else {
      return sendError(res, 400, '未知的角色操作')
    }

    member.lastSeenAt = nowMs()
    await persist(room)
    broadcast(room.id, 'roles', { cast: publicCast(room) })
    broadcast(room.id, 'room', { room: publicRoom(room) })
    return sendJson(res, 200, rolesPayload(room, member))
  }

  /** 剧本杀阶段机：GM 点「下一阶段」或直接跳到某个阶段 */
  async function roomPhase(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member || member.role !== 'gm') return sendError(res, 403, '只有 GM 能切换阶段')
    if ((room.mode || 'roleplay') !== 'mystery') return sendError(res, 409, '这个房间不是剧本杀')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const action = String(body.action ?? 'next')
    let next = null
    if (action === 'next') {
      const index = MYSTERY_PHASES.findIndex((phase) => phase.id === room.phase)
      next = MYSTERY_PHASES[index >= 0 ? index + 1 : 0] || null
      if (!next) return sendError(res, 409, '已经是最后一个阶段（复盘）')
    } else if (action === 'set') {
      next = MYSTERY_PHASES.find((phase) => phase.id === String(body.phase ?? '')) || null
      if (!next) return sendError(res, 400, '未知的阶段')
    } else {
      return sendError(res, 400, '未知的阶段操作')
    }
    const changed = next.id !== room.phase
    if (changed) {
      room.phase = next.id
      // 这一轮提示词里交代阶段目标
      room._phaseDirective = next.id
      appendMessage(room, {
        kind: 'system',
        text: `进入「${next.label}」阶段`,
        inAiContext: false,
      })
      broadcast(room.id, 'phase', { phase: publicPhase(room) })
      broadcast(room.id, 'room', { room: publicRoom(room) })
    }
    member.lastSeenAt = nowMs()
    await persist(room)
    if (changed && body.narrate !== false) scheduleAi(room, { force: true })
    return sendJson(res, 200, { phase: publicPhase(room), changed })
  }

  async function roomVote(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const action = String(body.action ?? '')

    if (action === 'start') {
      if (member.role !== 'gm') return sendError(res, 403, '只有 GM 能发起投票')
      if (room.vote) return sendError(res, 409, '已有进行中的投票')
      room.vote = {
        id: newId(),
        kind: String(body.kind ?? 'reveal').slice(0, 20),
        startedAt: nowMs(),
        voters: { [member.id]: true },
      }
      await persist(room)
      broadcastVote(room)
      return sendJson(res, 200, { vote: publicVote(room) })
    }

    if (action === 'cast') {
      if (!room.vote) return sendError(res, 409, '没有进行中的投票')
      room.vote.voters[member.id] = body.agree === true
      const voters = Object.values(room.members)
      const passed = voters.length > 0 && voters.every((item) => room.vote.voters[item.id] === true)
      if (!passed) {
        await persist(room)
        broadcastVote(room)
        return sendJson(res, 200, { vote: publicVote(room), passed: false })
      }
      const kind = room.vote.kind
      room.vote = null
      appendMessage(room, {
        kind: 'system',
        text: '全票通过：揭晓汤底',
        inAiContext: false,
      })
      broadcastVote(room)
      if (kind === 'reveal') {
        room._reveal = true
        scheduleAi(room, { force: true })
      }
      await persist(room)
      return sendJson(res, 200, { vote: null, passed: true })
    }

    if (action === 'cancel') {
      if (member.role !== 'gm') return sendError(res, 403, '只有 GM 能取消投票')
      room.vote = null
      await persist(room)
      broadcastVote(room)
      return sendJson(res, 200, { vote: null })
    }

    return sendError(res, 400, '未知的投票操作')
  }
  async function setAvatar(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    const avatar = sanitizeAvatar(body.dataUrl ?? body.avatar ?? '')
    if (!avatar) return sendError(res, 400, '头像格式不对（png/jpeg/webp，≤ 120KB）')
    member.avatar = avatar
    member.lastSeenAt = nowMs()
    rememberIdentity(room.id, member.machineCode, { uid: member.uid, avatar })
    await persist(room)
    broadcastMembers(room)
    return sendJson(res, 200, { member: publicMember(member) })
  }

  async function leaveRoom(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member) return sendError(res, 403, '需要成员令牌')
    if (member.role === 'gm') return sendError(res, 409, 'GM 不能离开自己的房间，请关闭房间')
    for (const character of room.cast || []) {
      if (character.assigneeId === member.id) character.assigneeId = null
    }
    delete room.members[member.id]
    await persist(room)
    broadcast(room.id, 'system', { text: `${member.name} 离开了房间` })
    broadcastMembers(room)
    broadcast(room.id, 'roles', { cast: publicCast(room) })
    return sendJson(res, 200, { left: true })
  }

  async function setRole(req, res, room, url, memberId) {
    const gm = findMember(room, tokenOf(req, url))
    if (!gm || gm.role !== 'gm') return sendError(res, 403, '只有 GM 能调整职位')
    const target = room.members[memberId]
    if (!target) return sendError(res, 404, '成员不存在')
    if (target.role === 'gm') return sendError(res, 409, '不能修改 GM 的职位')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : 'bad body')
    }
    if (!ASSIGNABLE_ROLES.has(body.role)) return sendError(res, 400, 'role 只能是 player 或 spectator')
    target.role = body.role
    // 降为观众时释放角色，避免角色本留在已不能行动的人手里
    if (target.role === 'spectator') {
      for (const character of room.cast || []) {
        if (character.assigneeId === target.id) character.assigneeId = null
      }
      target.characterId = null
    }
    await persist(room)
    broadcastMembers(room)
    broadcast(room.id, 'roles', { cast: publicCast(room) })
    broadcast(room.id, 'system', { text: `${target.name} 现在的职位是「${roleLabel(target.role)}」` })
    return sendJson(res, 200, { member: publicMember(target) })
  }

  async function kickMember(req, res, room, url, memberId) {
    const gm = findMember(room, tokenOf(req, url))
    if (!gm || gm.role !== 'gm') return sendError(res, 403, '只有 GM 能踢人')
    if (memberId === gm.id) return sendError(res, 409, '不能踢自己')
    const target = room.members[memberId]
    if (!target) return sendError(res, 404, '成员不存在')
    for (const character of room.cast || []) {
      if (character.assigneeId === target.id) character.assigneeId = null
    }
    delete room.members[memberId]
    await persist(room)
    broadcast(room.id, 'system', { text: `${target.name} 被移出了房间` })
    broadcastMembers(room)
    broadcast(room.id, 'roles', { cast: publicCast(room) })
    return sendJson(res, 200, { kicked: true })
  }

  function openEvents(req, res, room, url) {
    const member = findMember(room, tokenOf(req, url))
    if (!member && !inviteOk(room, req, url)) return sendError(res, 403, '需要邀请令牌或成员令牌')
    if (member) member.lastSeenAt = nowMs()

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')

    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') ?? 0)) || 0)
    writeSse(res, 'snapshot', {
      room: publicRoom(room),
      ai: { status: room.ai.status, lastError: room.ai.lastError ?? null },
      messages: room.messages.filter(
        (m) => m.seq > since && messageVisibleTo(m, member?.id, member?.role),
      ),
    })

    let set = clients.get(room.id)
    if (!set) {
      set = new Set()
      clients.set(room.id, set)
    }
    const client = { res, memberId: member?.id ?? null }
    set.add(client)

    const heartbeat = setInterval(() => {
      // SSE 连着就说明人还在：刷新在线时间，避免空闲 30s 后被参与者列表标成离线
      if (member) member.lastSeenAt = nowMs()
      try {
        res.write(': ping\n\n')
      } catch {
        /* ignore */
      }
    }, 15_000)
    heartbeat.unref?.()

    req.on('close', () => {
      clearInterval(heartbeat)
      set.delete(client)
      if (set.size === 0) clients.delete(room.id)
    })
  }

  // ---- 生命周期 -----------------------------------------------------------

  function createHttpServer() {
    return createServer((req, res) => {
      // 署名水印：所有响应都带作者头（ASCII，避免 header 编码问题）
      res.setHeader('X-Plugin-Author', 'bilibili:miao-nuo-lian-ran')
      res.setHeader('X-Plugin-Name', 'dsh-story-party')
      route(req, res).catch((error) => {
        if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error))
        else res.end()
      })
    })
  }

  return {
    rooms,
    get started() {
      return started
    },
    get port() {
      return currentPort()
    },
    start: startServer,
    stop: stopServer,
    setPort,
    // 测试/阶段 2 用：不开端口也能直接拿房间数据
    snapshot(roomId) {
      const room = rooms.get(roomId)
      return room ? { room: publicRoom(room), messages: room.messages } : undefined
    },
  }

  // ---- 监听与换端口 -------------------------------------------------------

  function currentPort() {
    const address = httpServer?.address()
    return address && typeof address === 'object' ? address.port : undefined
  }

  /** 在指定端口起一个新的 listener；失败时抛出（旧 listener 不受影响） */
  function listenOn(port) {
    const instance = createHttpServer()
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        instance.removeListener('listening', onListening)
        instance.close(() => {})
        reject(error)
      }
      const onListening = () => {
        instance.removeListener('error', onError)
        httpServer = instance
        resolve(instance)
      }
      instance.once('error', onError)
      instance.once('listening', onListening)
      instance.listen(port, cfg.hostname)
    })
  }

  async function startServer() {
    if (started) return { port: currentPort(), hostname: cfg.hostname }
    await loadRooms()
    await listenOn(listenPort)
    started = true
    return { port: listenPort, hostname: cfg.hostname }
  }

  async function stopServer() {
    if (!started) return
    started = false
    for (const roomId of [...clients.keys()]) closeRoomStreams(roomId)
    for (const room of rooms.values()) {
      if (room._timer) clearTimeout(room._timer)
      room._timer = null
    }
    await new Promise((resolve) => httpServer?.close(() => resolve()) ?? resolve())
    httpServer = undefined
  }

  /**
   * 运行时换端口：先在新端口起 listener，成功后再关旧的；
   * 失败（被占/无权限）时旧端口继续服务，房间与消息不受影响。
   * SSE 会断开（客户端自动重连到新地址）。
   */
  async function setPort(nextPort) {
    const value = Number(nextPort)
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      const error = new Error('端口必须是 1024–65535 之间的整数')
      error.code = 'EINVALIDPORT'
      throw error
    }
    if (started && value === listenPort) return { port: listenPort, hostname: cfg.hostname }
    if (!started) {
      listenPort = value
      cfg.port = value
      return { port: listenPort, hostname: cfg.hostname }
    }

    const previous = httpServer
    await listenOn(value) // 失败会抛，previous 仍在监听
    listenPort = value
    cfg.port = value
    for (const roomId of [...clients.keys()]) closeRoomStreams(roomId)
    if (previous) {
      try {
        previous.close()
      } catch {
        /* ignore */
      }
    }
    cfg.onPortChange?.(value)
    return { port: listenPort, hostname: cfg.hostname }
  }
}
