/**
 * dsh-galgame-room —— Host 半侧（阶段 1）。
 *
 * 只做三件事：
 *   1. 在本机起一个房间 HTTP 服务（默认 0.0.0.0:7301），房主开放端口后别人就能连；
 *   2. 每个房间一份**独立的 LLM 上下文**，不碰 DSH 主会话，人设也不会串；
 *   3. 把房间里的发言交给 ctx.llm 生成，再由房间服务广播给所有客户端。
 *
 * 模型调用的写法对齐 dsh-pet（createUserMessage / createAssistantMessage / BlockAssembler）。
 * 前端页面属于阶段 2，本文件不注册任何会话视图。
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  BlockAssembler,
  ReasoningEffortId,
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createRoomServer, normalizePublicUrl } from './room-server.js'

/** 插件版本（来自 package.json）：进房时用来要求「玩家插件版本与房主一致」 */
const PLUGIN_VERSION = (() => {
  try {
    const packageFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return String(JSON.parse(readFileSync(packageFile, 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/** 插件行 id：cordis.patch.yml 里的 `- id: galgame-room` 必须与此一致 */
export const name = 'galgame-room'

/** 依赖的宿主服务：llm（房间独立会话）+ webServer（给浏览器半侧暴露当前端口） */
export const inject = ['llm', 'webServer']

/** 本行 Config：只放会重启插件的字段（端口、人数、节奏、模型覆盖） */
export const Config = z.object({
  port: z.natural().default(7302),
  hostname: z.string().default('0.0.0.0'),
  /** 阶段 2 拼邀请链接用；留空 = 用局域网地址 */
  publicUrl: z.string().default(''),
  maxPlayers: z.natural().default(4),
  debounceMs: z.natural().default(1200),
  contextMessages: z.natural().default(30),
  aiName: z.string().default('旁白'),
  /** true = 进房必须带 clientVersion 且与房主插件版本一致（浏览器直连会被拒） */
  strictVersion: z.boolean().default(false),
  /** 调试：是否把 AI 思维链留在本机（不进 API / 客户端） */
  saveReasoning: z.boolean().default(false),
  /** 留空则跟随当前对话模型 */
  provider: z.string().default(''),
  model: z.string().default(''),
})

const TIMEOUT_MS = 60_000

/** Config 字段在 0.2.x 可能是带 .get() 的 volatile 引用，逐层解包 */
function readField(holder) {
  let current = holder
  for (let depth = 0; depth < 8; depth++) {
    if (current === undefined || current === null) return current
    if (typeof current.get !== 'function') return current
    current = current.get()
  }
  return current
}

function readConfig(config, key, fallback) {
  const value = readField(config?.[key])
  if (value === undefined || value === null || value === '') return fallback
  return value
}

/** 读取上次「开放端口」的选择（非法/缺失返回 undefined） */
function readStoredPort(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = Number(parsed?.port)
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : undefined
  } catch {
    return undefined
  }
}

/** 把端口写进 DSH 数据目录；写失败只影响“下次启动沿用”，不影响本次运行 */
function saveStoredPort(file, port) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ port }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/** 读取页面里保存的公网地址（没有则 undefined） */
function readStoredPublicUrl(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return normalizePublicUrl(parsed?.publicUrl ?? '') || undefined
  } catch {
    return undefined
  }
}

/** 保存公网地址；写失败不影响本次运行 */
function saveStoredPublicUrl(file, publicUrl) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ publicUrl }, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/** 读取房主侧设置（saveReasoning 等） */
function readStoredSettings(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 保存房主侧设置 */
function saveStoredSettings(file, settings) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/** 从 profile 的 cordis.patch.yml 读 cosplay 角色库（结果缓存 15 秒） */
let cosplayCache = { at: 0, cards: [] }

function loadCosplayCards() {
  const now = Date.now()
  if (now - cosplayCache.at < 15_000) return cosplayCache.cards
  let cards = []
  try {
    const profilesDir = join(resolveDshHome(), 'profiles')
    for (const dirName of readdirSync(profilesDir)) {
      const profileDir = join(profilesDir, dirName)
      const patchFile = join(profileDir, 'cordis.patch.yml')
      if (!existsSync(patchFile)) continue
      let yaml
      try {
        // js-yaml 跟随 profile 的依赖（dshmarket 带进来的），用 createRequire 从 profile 解析
        yaml = createRequire(join(profileDir, 'package.json'))('js-yaml')
      } catch {
        continue
      }
      let entries
      try {
        entries = yaml.load(readFileSync(patchFile, 'utf8'))
      } catch {
        continue
      }
      if (!Array.isArray(entries)) continue
      const entry = entries.find((item) => item && item.id === 'cosplay-core')
      if (!entry) continue
      cards = entry.config && Array.isArray(entry.config.roles) ? entry.config.roles : []
      break
    }
  } catch {
    cards = []
  }
  cosplayCache = { at: now, cards }
  return cards
}

function modelCandidates(ctx, provider, model) {
  const out = []
  const push = (candidate) => {
    if (!candidate?.provider || !candidate?.model) return
    if (out.some((m) => m.provider === candidate.provider && m.model === candidate.model)) return
    out.push({ provider: String(candidate.provider), model: String(candidate.model) })
  }
  push(provider && model ? { provider, model } : undefined)
  try {
    // 用 ctx.get 软取：就算没注入 agentDefaultModel 也不会抛错
    const defaultModel = ctx.get?.('agentDefaultModel', false)
    push(defaultModel?.currentSelection?.())
  } catch {
    /* 没有默认模型服务时只留配置里的候选 */
  }
  return out
}

async function supportsReasoningOff(ctx, provider, model) {
  const llm = ctx.get?.('llm', false)
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info?.reasoning?.efforts?.some((e) => e.id === 'off') ?? false
  } catch {
    return false
  }
}

async function callModel(ctx, selection, { system, messages, roomId, captureReasoning }) {
  const llm = ctx.get?.('llm', false)
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')

  const llmMessages = messages.map((message) =>
    message.role === 'assistant'
      ? createAssistantMessage({
          content: [{ type: 'text', text: message.content }],
          source: { provider: selection.provider, model: selection.model },
        })
      : createUserMessage({
          content: [{ type: 'text', text: message.content }],
          source: { kind: 'user' },
        }),
  )

  const supportsOff = await supportsReasoningOff(ctx, selection.provider, selection.model)
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    // 每个房间一个独立的会话标识：多人输入不污染主会话，也方便日后按房间排查
    sessionId: `galgame-room:${roomId}`,
    messages: llmMessages,
    system,
    temperature: 1,
    // 调试要思维链时不强制 reasoning=off，否则拿不到
    ...(supportsOff && !captureReasoning ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })) {
    assembler.push(chunk)
  }

  const blocks = assembler.blocks()
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim()
  if (!captureReasoning) return text
  const reasoning = blocks
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text ?? block.reasoning ?? '')
    .join('')
    .trim()
  return { text, reasoning }
}

/**
 * 把 DSH 的模型服务包装成房间服务需要的 generate()。
 * 候选链：配置里的 provider/model → 当前对话模型；前者失败回落后者。
 */
function createGenerate(ctx, config) {
  return async ({ system, messages, force, roomId, captureReasoning }) => {
    const provider = String(readConfig(config, 'provider', ''))
    const model = String(readConfig(config, 'model', ''))
    const candidates = modelCandidates(ctx, provider, model)
    if (candidates.length === 0) {
      throw new Error('房间没有可用模型：请在插件配置里填 provider/model，或先在 DSH 里选一个对话模型')
    }
    let lastError
    for (const selection of candidates) {
      try {
        return await callModel(ctx, selection, { system, messages, roomId, captureReasoning })
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('模型调用失败')
  }
}

export function apply(ctx, config) {
  console.log('[dsh-galgame-room] 作者：B站：喵诺澪染 · 开源免费，禁止倒卖')
  const configuredPort = Number(readConfig(config, 'port', 7302))
  const hostname = String(readConfig(config, 'hostname', '0.0.0.0'))
  const maxPlayers = Number(readConfig(config, 'maxPlayers', 4))
  const debounceMs = Number(readConfig(config, 'debounceMs', 1200))
  const contextMessages = Number(readConfig(config, 'contextMessages', 30))
  const aiName = String(readConfig(config, 'aiName', '旁白'))
  const strictVersion = readConfig(config, 'strictVersion', false) === true

  let roomHome
  let dataDir
  try {
    roomHome = join(resolveDshHome(), 'galgame-room')
    dataDir = join(roomHome, 'rooms')
  } catch {
    roomHome = join(homedir(), '.dsh', 'galgame-room')
    dataDir = join(roomHome, 'rooms')
  }
  const portFile = join(roomHome, 'port.json')
  const publicUrlFile = join(roomHome, 'publicUrl.json')
  const settingsFile = join(roomHome, 'settings.json')

  // 「开放端口」的选择要跨重启保留：优先用 port.json，其次插件配置
  const initialPort = readStoredPort(portFile) ?? configuredPort
  // 公网地址：页面里改过的（publicUrl.json）优先，其次插件配置
  const publicUrl =
    readStoredPublicUrl(publicUrlFile) ?? normalizePublicUrl(readConfig(config, 'publicUrl', ''))
  // 调试开关：页面里改过的（settings.json）优先，其次插件配置
  const storedSettings = readStoredSettings(settingsFile)
  const saveReasoning =
    typeof storedSettings.saveReasoning === 'boolean'
      ? storedSettings.saveReasoning
      : readConfig(config, 'saveReasoning', false) === true

  const roomServer = createRoomServer({
    port: initialPort,
    hostname,
    dataDir,
    maxPlayers,
    debounceMs,
    contextMessages,
    aiName,
    generate: createGenerate(ctx, config),
    onPortChange: (nextPort) => saveStoredPort(portFile, nextPort),
    onPublicUrlChange: (next) => saveStoredPublicUrl(publicUrlFile, next),
    loadCards: loadCosplayCards,
    version: PLUGIN_VERSION,
    strictVersion,
    publicUrl,
    saveReasoning,
    onSettingsChange: (next) =>
      saveStoredSettings(settingsFile, { ...storedSettings, ...next }),
  })

  // 浏览器半侧（会话标签页）用它来拼 iframe 地址，换端口后也能跟上
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: '/api/galgame-room/config',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const body = JSON.stringify({
          port: roomServer.port ?? initialPort,
          version: PLUGIN_VERSION,
          protocol: 1,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })
  }, 'galgame-room: 客户端配置路由')

  ctx.effect(() => {
    let disposed = false
    let retryTimer
    let attempts = 0
    // 端口被占（常见：另一个 standalone 还开着）时每 5 秒重试一次，最多 10 分钟；
    // 这样「先开 standalone 再切到插件」不用重启 DSH 也能自己接上端口。
    const MAX_RETRIES = 120
    const RETRY_DELAY_MS = 5000

    const attempt = () => {
      if (disposed) return
      roomServer
        .start()
        .then((info) => {
          if (disposed) return
          attempts = 0
          ctx.logger?.info?.(`[galgame-room] 房间服务已监听 ${info.hostname}:${info.port}，入口 POST /api/rooms`)
        })
        .catch((error) => {
          if (disposed) return
          const message = error instanceof Error ? error.message : String(error)
          if (error && error.code === 'EADDRINUSE' && attempts < MAX_RETRIES) {
            attempts += 1
            ctx.logger?.warn?.(
              `[galgame-room] 端口 ${initialPort} 被占用，${RETRY_DELAY_MS / 1000} 秒后重试（第 ${attempts}/${MAX_RETRIES} 次）`,
            )
            retryTimer = setTimeout(attempt, RETRY_DELAY_MS)
            retryTimer.unref?.()
            return
          }
          ctx.logger?.error?.(`[galgame-room] 端口 ${initialPort} 监听失败：${message}（房间功能不可用，其余功能不受影响）`)
        })
    }

    attempt()
    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      void roomServer.stop()
    }
  }, 'galgame-room: 房间 HTTP 服务')
}
