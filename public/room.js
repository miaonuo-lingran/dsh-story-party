/* 联机 Galgame · 房间页
 *
 * 纯浏览器端（无构建）：SSE 收消息，fetch 发消息与房主操作。
 * 身份存在 localStorage：成员令牌（发言/操作）+ 邀请令牌（拉人/重进）。
 */
(() => {
  'use strict'

  // 被 DSH 标签页以 iframe 嵌入时加 embed 类：背景透明，不盖住宿主皮肤
  try {
    if (window.self !== window.top) document.documentElement.classList.add('embed')
  } catch {
    document.documentElement.classList.add('embed')
  }

  const $ = (id) => document.getElementById(id)

  const roomMatch = location.pathname.match(/^\/room\/([^/]+)\/?$/)
  const roomId = roomMatch ? decodeURIComponent(roomMatch[1]) : ''
  const params = new URLSearchParams(location.search)
  const inviteFromUrl = params.get('t') || ''
  const clientVersion = params.get('v') || ''

  const KEY_INVITE = `galgame-room:invite:${roomId}`
  const KEY_MEMBER = `galgame-room:member:${roomId}`
  /** 本地副本：玩家打开房间时先读它，再和房主对比会话 id / 进度 */
  const KEY_CACHE = `galgame-room:cache:${roomId}`

  const ROLE_LABEL = { gm: 'GM', player: '玩家', spectator: '观众' }
  const ROLE_BADGE = { gm: 'badge-gm', player: 'badge-player', spectator: 'badge-spectator' }

  const state = {
    invite: '',
    member: null,
    room: null,
    lastSeq: 0,
    seen: new Set(),
    hydrated: false,
    history: [],
    es: null,
  }

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(KEY_CACHE) || 'null')
    } catch {
      return null
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(
        KEY_CACHE,
        JSON.stringify({
          sessionId: state.room ? state.room.sessionId ?? null : null,
          seq: state.lastSeq,
          messages: state.history.slice(-200),
          savedAt: Date.now(),
        }),
      )
    } catch {
      /* 隐私模式/配额满：不影响在线使用 */
    }
  }

  const els = {
    joinScreen: $('join-screen'),
    joinTitle: $('join-title'),
    joinSub: $('join-sub'),
    joinForm: $('join-form'),
    joinName: $('join-name'),
    joinInvite: $('join-invite'),
    inviteRow: $('invite-row'),
    joinPasswordRow: $('join-password-row'),
    joinPassword: $('join-password'),
    joinSubmit: $('join-submit'),
    joinError: $('join-error'),

    roomScreen: $('room-screen'),
    roomTitle: $('room-title'),
    roomCode: $('room-code'),
    connBadge: $('conn-badge'),
    avatarBtn: $('avatar-btn'),
    avatarPreview: $('avatar-preview'),
    avatarFile: $('avatar-file'),
    copyInvite: $('copy-invite'),
    toggleMembers: $('toggle-members'),
    linkModal: $('link-modal'),
    linkList: $('link-list'),
    linkHint: $('link-hint'),
    linkClose: $('link-close'),

    messages: $('messages'),
    thinking: $('thinking'),
    composer: $('composer'),
    composerInput: $('composer-input'),
    send: $('send'),
    composerHint: $('composer-hint'),
    voteBar: $('vote-bar'),
    voteText: $('vote-text'),
    voteAgree: $('vote-agree'),
    voteDisagree: $('vote-disagree'),
    voteCancel: $('vote-cancel'),
    startVote: $('start-vote'),
    agentField: $('agent-field'),
    agentSelect: $('agent-select'),
    speakAgent: $('speak-agent'),

    membersPanel: $('members-panel'),
    memberList: $('member-list'),
    memberCount: $('member-count'),
    gmBar: $('gm-bar'),
    advance: $('advance'),
    closeRoom: $('close-room'),

    closedScreen: $('closed-screen'),
    closedTitle: $('closed-title'),
    closedSub: $('closed-sub'),

    toasts: $('toasts'),
  }

  // ---------- 本地存储 ----------

  function readStore(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 隐私模式 / 无痕：只在内存里用 */
    }
  }

  // ---------- 机器码 / 头像 ----------

  let machineHash = ''
  let machinePromise = null

  function fingerprint() {
    return [
      navigator.userAgent,
      navigator.language,
      navigator.hardwareConcurrency || 0,
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    ].join('|')
  }

  function fallbackHash(text) {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0') + text.length.toString(16)
  }

  /** 机器码：浏览器指纹哈希（不是安全边界，只用来认回 uid/头像） */
  function ensureMachineCode() {
    if (machinePromise) return machinePromise
    machinePromise = (async () => {
      const stored = readStore('galgame-room:machine')
      if (stored) {
        machineHash = stored
        return stored
      }
      const raw = fingerprint()
      let code = ''
      try {
        if (window.crypto && crypto.subtle) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
          code = Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 32)
        }
      } catch {
        code = ''
      }
      if (!code) code = fallbackHash(raw)
      machineHash = code
      writeStore('galgame-room:machine', code)
      return code
    })()
    return machinePromise
  }

  function renderAvatar(node, options) {
    const { avatar, name = '', emoji = '' } = options || {}
    node.textContent = ''
    if (typeof avatar === 'string' && avatar.startsWith('data:image/')) {
      const image = document.createElement('img')
      image.src = avatar
      image.alt = ''
      node.append(image)
      return
    }
    node.textContent = emoji || (name ? name.slice(0, 1) : '👤')
  }

  function resizeImage(file, size) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file)
      const image = new Image()
      image.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        const side = Math.min(image.width, image.height)
        context.drawImage(
          image,
          (image.width - side) / 2,
          (image.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size,
        )
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('图片读不出来'))
      }
      image.src = objectUrl
    })
  }

  async function onAvatarFile(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file || !state.member) return
    if (!/^image\//.test(file.type)) {
      toast('选一张图片', 'error')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('图片太大了（> 8MB）', 'error')
      return
    }
    try {
      const dataUrl = await resizeImage(file, 128)
      const data = await api(roomPath('/avatar'), {
        method: 'POST',
        token: state.member.token,
        body: { dataUrl },
      })
      state.member.avatar = data.member.avatar || dataUrl
      writeStore(KEY_MEMBER, JSON.stringify(state.member))
      renderHeader()
      toast('头像已更新')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function removeStore(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }

  // ---------- 小工具 ----------

  function toast(text, kind) {
    const node = document.createElement('div')
    node.className = 'toast' + (kind === 'error' ? ' error' : '')
    node.textContent = text
    els.toasts.append(node)
    setTimeout(() => {
      node.style.transition = 'opacity .25s'
      node.style.opacity = '0'
      setTimeout(() => node.remove(), 260)
    }, 2600)
  }

  function formatTime(ts) {
    const date = new Date(ts || Date.now())
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  function showScreen(which) {
    els.joinScreen.hidden = which !== 'join'
    els.roomScreen.hidden = which !== 'room'
    els.closedScreen.hidden = which !== 'closed'
  }

  function fail(title, sub) {
    closeStream()
    els.closedTitle.textContent = title
    els.closedSub.textContent = sub || ''
    showScreen('closed')
  }

  function setConn(text, stateName) {
    els.connBadge.textContent = text
    els.connBadge.className = 'conn-badge' + (stateName ? ' ' + stateName : '')
  }

  function authToken() {
    return (state.member && state.member.token) || state.invite || ''
  }

  function roomPath(suffix) {
    return `/api/rooms/${encodeURIComponent(roomId)}${suffix || ''}`
  }

  function isGm() {
    return Boolean(state.member && state.member.role === 'gm')
  }

  // ---------- API ----------

  async function api(path, options = {}) {
    const { method = 'GET', token, body } = options
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      /* 非 JSON 响应按状态码报错 */
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || `请求失败（HTTP ${response.status}）`)
      error.status = response.status
      throw error
    }
    return data
  }

  // ---------- 启动 ----------

  async function boot() {
    if (!roomId) {
      fail('房间地址不完整', '检查一下链接里的房号。')
      return
    }
    if (inviteFromUrl) {
      state.invite = inviteFromUrl
      writeStore(KEY_INVITE, inviteFromUrl)
    } else {
      state.invite = readStore(KEY_INVITE) || ''
    }
    const saved = readStore(KEY_MEMBER)
    if (saved) {
      try {
        state.member = JSON.parse(saved)
      } catch {
        state.member = null
      }
    }
    if (state.member && !state.member.token) state.member = null

    if (!state.invite && !state.member) {
      showJoin('')
      return
    }

    try {
      const data = await api(roomPath(), { token: authToken() })
      state.room = data.room
      if (state.member) enterRoom()
      else showJoin('')
    } catch (error) {
      if (error.status === 403) {
        state.member = null
        removeStore(KEY_MEMBER)
        showJoin('邀请令牌无效或已失效，向房主再要一条吧')
      } else if (error.status === 404) {
        fail('房间不存在', '房号可能抄错了，或者这间房已经被关掉。')
      } else {
        fail('连不上房间服务', error.message)
      }
    }
  }

  // ---------- 加入 ----------

  function showJoin(message) {
    showScreen('join')
    els.joinTitle.textContent = (state.room && state.room.title) || '联机 Galgame'
    els.joinSub.textContent = state.room
      ? `房号 ${state.room.id} · ${(state.room.members || []).length} 人已在房间里`
      : '输入昵称，进入这场故事。'
    els.inviteRow.hidden = Boolean(state.invite)
    els.joinPasswordRow.hidden = !(state.room && state.room.hasPassword)
    setJoinError(message || '')
    if (!state.invite) els.joinInvite.focus()
    else els.joinName.focus()
  }

  function setJoinError(text) {
    els.joinError.hidden = !text
    els.joinError.textContent = text || ''
  }

  async function onJoin(event) {
    event.preventDefault()
    const name = els.joinName.value.trim()
    if (!name) return setJoinError('先起个名字吧')
    const invite = (els.joinInvite.value.trim() || state.invite).trim()
    if (!invite) return setJoinError('还差一个邀请令牌')
    const roleInput = document.querySelector('input[name="role"]:checked')
    const role = roleInput ? roleInput.value : 'player'
    const machineCode = await ensureMachineCode()

    els.joinSubmit.disabled = true
    setJoinError('')
    try {
      const data = await api(roomPath('/join'), {
        method: 'POST',
        body: {
          name,
          role,
          inviteToken: invite,
          ...(clientVersion ? { clientVersion } : {}),
          ...(els.joinPassword.value.trim() ? { password: els.joinPassword.value.trim() } : {}),
          ...(machineCode ? { machineCode } : {}),
        },
      })
      state.invite = invite
      writeStore(KEY_INVITE, invite)
      state.member = {
        id: data.memberId,
        token: data.token,
        role: data.role,
        name: data.member.name,
        uid: data.member.uid || '',
        avatar: data.member.avatar || '',
      }
      writeStore(KEY_MEMBER, JSON.stringify(state.member))
      state.room = data.room
      enterRoom()
    } catch (error) {
      if (String(error.message).includes('密码')) els.joinPasswordRow.hidden = false
      setJoinError(error.message)
    } finally {
      els.joinSubmit.disabled = false
    }
  }

  // ---------- 房间 ----------

  function primeFromCache() {
    const cache = loadCache()
    if (!cache || !Array.isArray(cache.messages) || cache.messages.length === 0) return
    const sameSession = (cache.sessionId ?? null) === (state.room && state.room.sessionId ? state.room.sessionId : null)
    if (!sameSession) {
      toast('本地副本来自另一个会话，正在从房主重新同步…')
      return
    }
    state.history = []
    els.messages.textContent = ''
    state.seen.clear()
    state.lastSeq = 0
    for (const message of cache.messages) addMessage(message)
    if (cache.messages.length > 0) scrollToBottom()
  }

  function enterRoom() {
    showScreen('room')
    document.title = `${(state.room && state.room.title) || '联机 Galgame'} · ${roomId}`
    state.hydrated = false
    state.lastSeq = 0
    state.seen.clear()
    state.thinking = false
    state.history = []
    els.messages.textContent = ''
    renderHeader()
    renderMembers()
    updateComposerHint()
    primeFromCache()
    connect()
  }

  function renderHeader() {
    if (!state.room) return
    els.roomTitle.textContent = state.room.title || '房间'
    els.roomCode.textContent = state.room.id
    els.gmBar.hidden = !isGm()
    const solo = Boolean(state.room.solo)
    els.copyInvite.hidden = !state.invite || solo
    els.toggleMembers.hidden = solo
    els.membersPanel.hidden = solo
    const soup = Boolean(state.room.pack && state.room.pack.mode === 'soup')
    els.startVote.hidden = !(isGm() && soup)
    renderAgents()
    renderVote()
    if (state.member) {
      const mine = (state.room.members || []).find((item) => item.id === state.member.id)
      renderAvatar(els.avatarPreview, {
        avatar: (mine && mine.avatar) || state.member.avatar,
        name: state.member.name,
      })
    }
  }

  function updateComposerHint() {
    if (!state.member) {
      els.composerHint.textContent = ''
      return
    }
    els.composerHint.textContent =
      state.member.role === 'spectator' ? '观众发言会出现在消息流里，但不会进入 AI 的剧情上下文。' : ''
  }

  function connect() {
    closeStream()
    const token = authToken()
    if (!token) return
    setConn('连接中', '')
    const url = `${roomPath('/events')}?t=${encodeURIComponent(token)}&since=${state.lastSeq}`
    const es = new EventSource(url)
    state.es = es
    es.addEventListener('open', () => setConn('已连接', 'ok'))
    es.addEventListener('error', () => setConn('重连中…', 'warn'))
    es.addEventListener('snapshot', onSnapshot)
    es.addEventListener('message', onMessageEvent)
    es.addEventListener('members', onMembersEvent)
    es.addEventListener('ai', onAiEvent)
    es.addEventListener('system', onSystemEvent)
    es.addEventListener('vote', onVoteEvent)
    es.addEventListener('room', onRoomEvent)
  }

  function closeStream() {
    if (state.es) {
      state.es.close()
      state.es = null
    }
  }

  function onSnapshot(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    state.room = data.room
    renderHeader()
    renderMembers()
    const cache = loadCache()
    const sessionChanged =
      cache &&
      Array.isArray(cache.messages) &&
      cache.messages.length > 0 &&
      (cache.sessionId ?? null) !== (data.room ? data.room.sessionId ?? null : null)
    if (!state.hydrated) {
      state.hydrated = true
      state.seen.clear()
      state.lastSeq = 0
      state.history = []
      els.messages.textContent = ''
    }
    for (const message of data.messages || []) addMessage(message)
    if (sessionChanged) toast('房主换了会话，已用房主的进度覆盖本地副本')
    saveCache()
    if (state.room && state.room.seq > state.lastSeq) state.lastSeq = state.room.seq
    if (data.ai) setAi(data.ai.status === 'thinking')
    if (data.room && data.room.closed) showClosed()
  }

  function onMessageEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    addMessage(data.message)
  }

  function onMembersEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room) state.room.members = data.members
    const me = (data.members || []).find((m) => state.member && m.id === state.member.id)
    if (state.member) {
      if (!me) {
        showKicked()
        return
      }
      if (me.role !== state.member.role) {
        state.member.role = me.role
        writeStore(KEY_MEMBER, JSON.stringify(state.member))
        updateComposerHint()
        renderHeader()
      }
    }
    renderMembers()
  }

  function onAiEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.status === 'thinking') {
      setAi(true)
      return
    }
    if (data.status === 'error') {
      setAi(false)
      toast(data.error || '旁白卡住了，再试一次', 'error')
      return
    }
    setAi(false)
  }

  function onSystemEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (!data.text) return
    addSystemLine(data.text)
    toast(data.text)
  }

  function renderAgents() {
    const agents = (state.room && state.room.agents) || []
    const visible = isGm() && agents.length > 0
    els.agentField.hidden = !visible
    els.speakAgent.hidden = !visible
    if (!visible) return
    const previous = els.agentSelect.value
    els.agentSelect.textContent = ''
    for (const agent of agents) {
      const option = document.createElement('option')
      option.value = agent.id
      option.textContent = `${agent.emoji ? agent.emoji + ' ' : ''}${agent.name}${
        agent.inScene ? '' : '（未上场）'
      }`
      els.agentSelect.append(option)
    }
    if (previous && agents.some((agent) => agent.id === previous)) els.agentSelect.value = previous
  }

  async function speakAgent() {
    const agentId = els.agentSelect.value
    if (!agentId) return
    els.speakAgent.disabled = true
    try {
      await api(roomPath('/speak'), {
        method: 'POST',
        token: state.member.token,
        body: { agentId },
      })
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.speakAgent.disabled = false
    }
  }

  function onVoteEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room) state.room.vote = data.vote || null
    renderVote()
  }

  function renderVote() {
    const vote = state.room && state.room.vote
    if (!vote) {
      els.voteBar.hidden = true
      return
    }
    els.voteBar.hidden = false
    const mine = vote.votes && state.member ? vote.votes[state.member.id] : undefined
    els.voteText.textContent = `揭晓汤底 · ${vote.agree}/${vote.total} 同意`
    els.voteAgree.hidden = !state.member
    els.voteDisagree.hidden = !state.member
    els.voteAgree.classList.toggle('primary', mine !== true)
    els.voteDisagree.classList.toggle('danger-mini', mine === false)
    els.voteCancel.hidden = !isGm()
  }

  async function castVote(agree) {
    try {
      const data = await api(roomPath('/vote'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'cast', agree },
      })
      if (state.room) state.room.vote = data.vote || null
      renderVote()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function startVote() {
    try {
      const data = await api(roomPath('/vote'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'start', kind: 'reveal' },
      })
      if (state.room) state.room.vote = data.vote || null
      renderVote()
      toast('已发起揭晓投票')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function cancelVote() {
    try {
      const data = await api(roomPath('/vote'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'cancel' },
      })
      if (state.room) state.room.vote = data.vote || null
      renderVote()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function onRoomEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.room) {
      state.room = data.room
      renderHeader()
      renderMembers()
    }
    if (data.closed) showClosed()
  }

  function showClosed() {
    closeStream()
    fail('房间已关闭', '这场故事到这里就结束了。')
  }

  function showKicked() {
    removeStore(KEY_MEMBER)
    state.member = null
    fail('你被移出了房间', '如果是一场误会，找房主要一条新的邀请链接吧。')
  }

  // ---------- 消息渲染 ----------

  function addMessage(message) {
    if (!message || typeof message.seq !== 'number') return
    if (state.seen.has(message.seq) || message.seq <= state.lastSeq) return
    const nearBottom = isNearBottom()
    state.seen.add(message.seq)
    state.lastSeq = message.seq

    let node
    if (message.kind === 'system') {
      node = document.createElement('div')
      node.className = 'msg-system'
      node.textContent = message.text
    } else {
      node = renderMessage(message)
    }
    els.messages.append(node)
    state.history.push(message)
    saveCache()
    if (nearBottom) scrollToBottom()
  }

  function renderMessage(message) {
    const article = document.createElement('article')
    article.className = 'msg'
    if (message.kind === 'ai') article.classList.add('msg-ai')
    if (state.member && message.memberId === state.member.id) article.classList.add('msg-self')

    const head = document.createElement('header')
    head.className = 'msg-head'

    const name = document.createElement('span')
    name.className = 'msg-name'
    name.textContent = message.name || (message.kind === 'ai' ? '旁白' : '')

    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    if (message.kind === 'ai') {
      renderAvatar(avatar, {
        avatar: state.room && state.room.persona && state.room.persona.avatar,
        emoji: (state.room && state.room.persona && state.room.persona.emoji) || '🎭',
      })
    } else {
      const member = ((state.room && state.room.members) || []).find((item) => item.id === message.memberId)
      renderAvatar(avatar, { avatar: member && member.avatar, name: message.name })
    }
    head.append(avatar, name)

    const badge = document.createElement('span')
    if (message.kind === 'ai') {
      badge.className = 'badge badge-ai'
      badge.textContent = 'AI'
    } else {
      badge.className = 'badge ' + (ROLE_BADGE[message.role] || 'badge-spectator')
      badge.textContent = ROLE_LABEL[message.role] || '玩家'
    }
    head.append(badge)

    if (message.kind !== 'ai' && message.role === 'spectator') {
      const note = document.createElement('span')
      note.className = 'badge badge-spectator'
      note.textContent = '不进剧情'
      note.title = '观众发言不会进入 AI 上下文'
      head.append(note)
    }

    const time = document.createElement('time')
    time.className = 'msg-time'
    time.textContent = formatTime(message.ts)
    head.append(time)

    const bubble = document.createElement('p')
    bubble.className = 'bubble'
    bubble.textContent = message.text

    article.append(head, bubble)
    return article
  }

  function addSystemLine(text) {
    const node = document.createElement('div')
    node.className = 'msg-system'
    node.textContent = text
    const nearBottom = isNearBottom()
    els.messages.append(node)
    if (nearBottom) scrollToBottom()
  }

  function isNearBottom() {
    const box = els.messages
    return box.scrollHeight - box.scrollTop - box.clientHeight < 90
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight
  }

  function setAi(thinking) {
    state.thinking = thinking
    els.thinking.hidden = !thinking
    if (thinking) scrollToBottom()
    if (isGm()) els.advance.disabled = thinking
  }

  // ---------- 参与者 ----------

  function renderMembers() {
    const members = (state.room && state.room.members) || []
    els.memberCount.textContent = members.length ? `${members.length} 人` : ''
    els.memberList.textContent = ''
    const order = { gm: 0, player: 1, spectator: 2 }
    const sorted = [...members].sort(
      (a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || (a.joinedAt || 0) - (b.joinedAt || 0),
    )
    for (const member of sorted) {
      const item = document.createElement('li')
      item.className = 'member' + (member.online ? ' online' : ' offline')

      const nameWrap = document.createElement('span')
      nameWrap.className = 'member-name'
      const avatar = document.createElement('span')
      avatar.className = 'avatar avatar-sm'
      renderAvatar(avatar, { avatar: member.avatar, name: member.name })
      const dot = document.createElement('i')
      dot.className = 'status-dot'
      const label = document.createElement('span')
      label.textContent = member.name + (state.member && member.id === state.member.id ? '（你）' : '')
      nameWrap.append(avatar, dot, label)

      const badge = document.createElement('span')
      badge.className = 'badge ' + (ROLE_BADGE[member.role] || 'badge-spectator')
      badge.textContent = ROLE_LABEL[member.role] || '玩家'

      item.append(nameWrap, badge)
      if (isGm() && member.role !== 'gm' && !(state.member && member.id === state.member.id)) {
        item.append(renderMemberActions(member))
      }
      els.memberList.append(item)
    }
  }

  function renderMemberActions(member) {
    const row = document.createElement('div')
    row.className = 'member-actions'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'mini'
    toggle.textContent = member.role === 'player' ? '设为观众' : '设为玩家'
    toggle.addEventListener('click', () =>
      changeRole(member, member.role === 'player' ? 'spectator' : 'player'),
    )

    const kick = document.createElement('button')
    kick.type = 'button'
    kick.className = 'mini danger-mini'
    kick.textContent = '踢出'
    kick.addEventListener('click', () => kickMember(member))

    row.append(toggle, kick)
    return row
  }

  async function changeRole(member, role) {
    try {
      await api(roomPath(`/members/${encodeURIComponent(member.id)}`), {
        method: 'PATCH',
        token: state.member.token,
        body: { role },
      })
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function kickMember(member) {
    const ok = await window.showConfirm({
      title: '移出成员',
      message: `把「${member.name}」移出房间？`,
      okText: '移出',
      danger: true,
    })
    if (!ok) return
    try {
      await api(roomPath(`/members/${encodeURIComponent(member.id)}`), {
        method: 'DELETE',
        token: state.member.token,
      })
      toast('已移出')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  // ---------- 房主操作 ----------

  async function advance() {
    if (!isGm()) return
    els.advance.disabled = true
    try {
      await api(roomPath('/advance'), { method: 'POST', token: state.member.token })
      toast('已让旁白往下写')
    } catch (error) {
      toast(error.message, 'error')
      els.advance.disabled = false
    }
  }

  async function closeRoom() {
    const ok = await window.showConfirm({
      title: '关闭房间',
      message: '关闭后所有人都不能继续发言，确定吗？',
      okText: '关闭房间',
      danger: true,
    })
    if (!ok) return
    try {
      await api(roomPath(), { method: 'DELETE', token: state.member.token })
      showClosed()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  // ---------- 发言 ----------

  async function sendMessage(event) {
    event.preventDefault()
    const text = els.composerInput.value.trim()
    if (!text) return
    if (!state.member) {
      toast('还没加入房间，刷新页面重新进一次', 'error')
      return
    }
    els.send.disabled = true
    try {
      await api(roomPath('/messages'), {
        method: 'POST',
        token: state.member.token,
        body: { text },
      })
      els.composerInput.value = ''
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.send.disabled = false
      els.composerInput.focus()
    }
  }

  // ---------- 邀请链接 ----------

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.append(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      }
      return true
    } catch {
      return false
    }
  }

  function buildInviteUrl(base) {
    return `${base}/room/${encodeURIComponent(roomId)}?t=${encodeURIComponent(state.invite)}`
  }

  /** 可选的邀请链接：公网（publicUrl）、各局域网网卡、本机 */
  async function inviteCandidates() {
    const links = []
    const add = (url, label) => {
      const normalized = String(url || '').replace(/\/+$/, '')
      if (!normalized || links.some((item) => item.url === normalized)) return
      links.push({ url: normalized, label })
    }
    let network = null
    try {
      network = await fetch('/api/network', { cache: 'no-store' }).then((response) =>
        response.ok ? response.json() : null,
      )
    } catch {
      network = null
    }
    const port = (network && network.port) || location.port
    if (network && typeof network.publicUrl === 'string' && network.publicUrl) {
      add(buildInviteUrl(network.publicUrl), '公网')
    }
    const interfaces = network && Array.isArray(network.interfaces) ? network.interfaces : []
    for (const iface of interfaces) {
      if (!iface || iface.virtual) continue
      if (String(iface.address).startsWith('169.254.')) continue
      if (iface.netmask === '255.255.255.255') continue
      add(`http://${iface.address}:${port}`, `局域网 · ${iface.name || iface.address}`)
    }
    add(`http://127.0.0.1:${port}`, '本机')
    return links
  }

  function closeLinkModal() {
    els.linkModal.hidden = true
  }

  async function copyInvite() {
    if (!state.invite) {
      toast('这条链接里没有邀请令牌', 'error')
      return
    }
    const links = await inviteCandidates()
    els.linkList.textContent = ''
    for (const item of links) {
      const row = document.createElement('li')
      const label = document.createElement('span')
      label.className = 'link-label'
      label.textContent = item.label
      const url = document.createElement('code')
      url.className = 'link-url'
      url.textContent = item.url
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini'
      button.textContent = '复制'
      button.addEventListener('click', async () => {
        const ok = await copyText(item.url)
        toast(ok ? `已复制「${item.label}」链接` : '复制失败，手动复制：' + item.url, ok ? undefined : 'error')
        closeLinkModal()
      })
      row.append(label, url, button)
      els.linkList.append(row)
    }
    const hasPublic = links.some((item) => item.label === '公网')
    els.linkHint.hidden = hasPublic
    els.linkHint.textContent = hasPublic
      ? ''
      : '没有公网地址：去开房页「公网地址」填隧道域名并点保存，或改插件配置后重载。'
    els.linkModal.hidden = false
  }

  // ---------- 事件绑定 ----------

  els.joinForm.addEventListener('submit', onJoin)
  els.composer.addEventListener('submit', sendMessage)
  els.avatarBtn.addEventListener('click', () => els.avatarFile.click())
  els.avatarFile.addEventListener('change', onAvatarFile)
  els.voteAgree.addEventListener('click', () => castVote(true))
  els.voteDisagree.addEventListener('click', () => castVote(false))
  els.voteCancel.addEventListener('click', () => cancelVote())
  els.startVote.addEventListener('click', () => startVote())
  els.speakAgent.addEventListener('click', speakAgent)
  els.copyInvite.addEventListener('click', copyInvite)
  els.linkClose.addEventListener('click', closeLinkModal)
  els.linkModal.addEventListener('click', (event) => {
    if (event.target === els.linkModal) closeLinkModal()
  })
  els.advance.addEventListener('click', advance)
  els.closeRoom.addEventListener('click', closeRoom)
  els.toggleMembers.addEventListener('click', () => document.body.classList.toggle('members-open'))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      document.body.classList.remove('members-open')
      closeLinkModal()
    }
  })

  boot().catch((error) => fail('房间加载失败', error.message))
})()
