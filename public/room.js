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
  const PROFILE_KEY = 'galgame-room:profile'

  function readProfile() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')
      if (!parsed || typeof parsed !== 'object') return null
      return {
        name: typeof parsed.name === 'string' ? parsed.name.slice(0, 16) : '',
        avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
      }
    } catch {
      return null
    }
  }

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
    stageHidden: false,
    sceneDraft: [],
    profile: readProfile(),
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
    composerTo: $('composer-to'),
    send: $('send'),
    composerHint: $('composer-hint'),
    phaseBar: $('phase-bar'),
    phaseText: $('phase-text'),
    phaseNext: $('phase-next'),
    voteBar: $('vote-bar'),
    voteText: $('vote-text'),
    voteAgree: $('vote-agree'),
    voteDisagree: $('vote-disagree'),
    voteCancel: $('vote-cancel'),
    startVote: $('start-vote'),
    storyBar: $('story-bar'),
    storyMeta: $('story-meta'),
    storyChoices: $('story-choices'),
    storyContinue: $('story-continue'),
    stage: $('stage'),
    stageBg: $('stage-bg'),
    stageSprites: $('stage-sprites'),
    stageCaption: $('stage-caption'),
    stageAudio: $('stage-audio'),
    stageBgmToggle: $('stage-bgm-toggle'),
    stageCollapse: $('stage-collapse'),
    stageBtn: $('stage-btn'),
    sceneModal: $('scene-modal'),
    sceneBackground: $('scene-background'),
    sceneBgm: $('scene-bgm'),
    sceneCaption: $('scene-caption'),
    sceneSpriteList: $('scene-sprite-list'),
    sceneAddSprite: $('scene-add-sprite'),
    sceneSave: $('scene-save'),
    sceneClose: $('scene-close'),
    sceneEdit: $('scene-edit'),
    choiceBar: $('choice-bar'),
    choiceTitle: $('choice-title'),
    choiceOptionsList: $('choice-options-list'),
    choiceCancel: $('choice-cancel'),
    choiceStart: $('choice-start'),
    choiceModal: $('choice-modal'),
    choiceOptionsInput: $('choice-options-input'),
    choiceStartSubmit: $('choice-start-submit'),
    choiceClose: $('choice-close'),
    savesBtn: $('saves-btn'),
    memoryBtn: $('memory-btn'),
    savesModal: $('saves-modal'),
    savesList: $('saves-list'),
    saveName: $('save-name'),
    saveNew: $('save-new'),
    rewindBtn: $('rewind-btn'),
    savesClose: $('saves-close'),
    memoryModal: $('memory-modal'),
    memoryFacts: $('memory-facts'),
    memoryRelations: $('memory-relations'),
    memoryAffection: $('memory-affection'),
    memoryItems: $('memory-items'),
    memorySave: $('memory-save'),
    memoryClose: $('memory-close'),
    truthBtn: $('truth-btn'),
    truthModal: $('truth-modal'),
    truthText: $('truth-text'),
    truthClose: $('truth-close'),
    rolesBtn: $('roles-btn'),
    rolesModal: $('roles-modal'),
    rolesList: $('roles-list'),
    rolesHint: $('roles-hint'),
    rolesClose: $('roles-close'),
    agentField: $('agent-field'),
    agentSelect: $('agent-select'),
    speakAgent: $('speak-agent'),

    membersPanel: $('members-panel'),
    membersHead: $('members-head'),
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
    if (
      typeof avatar === 'string' &&
      (avatar.startsWith('data:image/') || avatar.startsWith('/') || /^https?:\/\//i.test(avatar))
    ) {
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
    if (!els.joinName.value && state.profile && state.profile.name) {
      els.joinName.value = state.profile.name
    }
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
          ...(state.profile && state.profile.avatar ? { avatar: state.profile.avatar } : {}),
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
    const mine = state.member
    for (const message of cache.messages) {
      // 本地副本可能是同一台机器上一任 GM/玩家留下的：私聊只显示与自己有关的
      if (
        message.private &&
        !(mine && mine.role === 'gm') &&
        !(mine && (message.memberId === mine.id || message.to === mine.id))
      ) {
        continue
      }
      addMessage(message)
    }
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
    // 单人本不显示参与者，但 GM 控制条要保留
    els.membersPanel.hidden = false
    els.membersHead.hidden = solo
    els.memberList.hidden = solo
    els.membersPanel.classList.toggle('solo', solo)
    const soup = Boolean(state.room.pack && state.room.pack.mode === 'soup')
    els.startVote.hidden = !(isGm() && soup)
    els.truthBtn.hidden = !(isGm() && state.room.hasTruth)
    els.rolesBtn.hidden = !(Array.isArray(state.room.cast) && state.room.cast.length > 0)
    renderPhase()
    renderStory()
    renderStage()
    renderChoice()
    els.sceneEdit.hidden = !isGm()
    els.choiceStart.hidden = !isGm()
    els.savesBtn.hidden = !state.room.solo
    els.memoryBtn.hidden = !state.room.solo
    renderComposerTarget()
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
    const privateTo = els.composerTo.value
    if (privateTo) {
      const target = ((state.room && state.room.members) || []).find((item) => item.id === privateTo)
      els.composerHint.textContent = `私聊${target ? '给「' + target.name + '」' : ''}：只有你们和 GM 能看到，不会进入 AI 剧情上下文。`
      return
    }
    els.composerHint.textContent =
      state.member.role === 'spectator' ? '观众发言会出现在消息流里，但不会进入 AI 的剧情上下文。' : ''
  }

  function renderPhase() {
    const phase = state.room && state.room.phase
    if (!phase) {
      els.phaseBar.hidden = true
      return
    }
    els.phaseBar.hidden = false
    els.phaseText.textContent = `阶段 ${phase.index + 1}/${phase.total} · ${phase.label}`
    els.phaseNext.hidden = !isGm()
    els.phaseNext.disabled = phase.index >= phase.total - 1
  }

  function renderStory() {
    const story = state.room && state.room.story
    if (!story) {
      els.storyBar.hidden = true
      return
    }
    els.storyBar.hidden = false
    const chapter = story.chapter
    els.storyMeta.textContent = chapter
      ? `第 ${story.chapterIndex + 1}/${story.chapterCount} 章 · ${chapter.title || '未命名章节'}`
      : `个人本 · 第 ${story.turn || 0} 回合`
    els.storyChoices.textContent = ''
    for (const choice of story.choices || []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini story-choice'
      button.textContent = choice
      button.addEventListener('click', () => void sendText(choice))
      els.storyChoices.append(button)
    }
    els.storyContinue.hidden = false
    els.storyContinue.disabled = Boolean(state.thinking)
  }

  // ---------- 舞台 ----------

  function packAssetUrl(path) {
    const text = String(path || '')
    if (text.startsWith('data:')) return text
    const pack = state.room && state.room.pack
    if (!pack || !pack.id || !text.startsWith('assets/')) return ''
    return `/pack-assets/${encodeURIComponent(pack.id)}/${encodeURIComponent(text.slice(7))}`
  }

  function renderStage() {
    const scene = state.room && state.room.scene
    els.stageBtn.hidden = !scene
    if (!scene || state.stageHidden) {
      els.stage.hidden = true
      return
    }
    els.stage.hidden = false
    const background = packAssetUrl(scene.background)
    els.stageBg.style.backgroundImage = background
      ? `url("${background.replace(/"/g, '%22')}")`
      : 'linear-gradient(135deg, rgba(143,211,255,.12), rgba(242,184,128,.08))'
    els.stageSprites.textContent = ''
    for (const sprite of scene.sprites || []) {
      const node = document.createElement('div')
      node.className = `stage-sprite pos-${sprite.pos || 'center'}`
      if (sprite.avatar) {
        const image = document.createElement('img')
        image.src = sprite.avatar
        image.alt = ''
        node.append(image)
      } else {
        const emoji = document.createElement('span')
        emoji.className = 'stage-sprite-emoji'
        emoji.textContent = sprite.emoji || '🎭'
        node.append(emoji)
      }
      const label = document.createElement('span')
      label.className = 'stage-sprite-label'
      label.textContent = sprite.name + (sprite.emotion ? ` · ${sprite.emotion}` : '')
      node.append(label)
      els.stageSprites.append(node)
    }
    els.stageCaption.textContent = scene.caption || ''
    els.stageCaption.hidden = !scene.caption
    if (scene.bgm) {
      const url = packAssetUrl(scene.bgm)
      if (url) {
        if (els.stageAudio.getAttribute('src') !== url) {
          els.stageAudio.pause()
          els.stageAudio.src = url
        }
        els.stageBgmToggle.hidden = false
        els.stageBgmToggle.textContent = els.stageAudio.paused ? 'BGM 播放' : 'BGM 暂停'
      } else {
        els.stageBgmToggle.hidden = true
      }
    } else {
      els.stageAudio.pause()
      els.stageAudio.removeAttribute('src')
      els.stageBgmToggle.hidden = true
    }
  }

  function toggleStage() {
    state.stageHidden = !state.stageHidden
    renderStage()
  }

  function toggleStageBgm() {
    if (!els.stageAudio.getAttribute('src')) return
    if (els.stageAudio.paused) {
      els.stageAudio
        .play()
        .then(() => {
          els.stageBgmToggle.textContent = 'BGM 暂停'
        })
        .catch(() => toast('浏览器拦截了自动播放，点一下再试'))
    } else {
      els.stageAudio.pause()
      els.stageBgmToggle.textContent = 'BGM 播放'
    }
  }

  function sceneCharacters() {
    const room = state.room
    if (!room) return []
    if (Array.isArray(room.cast) && room.cast.length > 0) {
      return room.cast.map((character) => ({
        id: character.id,
        name: character.name,
        emoji: character.emoji,
        avatar: character.avatar,
      }))
    }
    if (room.persona) {
      return [
        {
          id: room.persona.id || 'persona',
          name: room.persona.name,
          emoji: room.persona.emoji,
          avatar: room.persona.avatar,
        },
      ]
    }
    return []
  }

  function fillAssetSelect(select, assets, pattern, value) {
    select.textContent = ''
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '无'
    select.append(none)
    for (const asset of assets || []) {
      const path = asset && asset.path
      if (typeof path !== 'string' || !pattern.test(path)) continue
      const option = document.createElement('option')
      option.value = path
      option.textContent = path.replace(/^assets\//, '')
      select.append(option)
    }
    select.value = value && Array.from(select.options).some((option) => option.value === value) ? value : ''
  }

  function renderSceneSpriteRows() {
    els.sceneSpriteList.textContent = ''
    const characters = sceneCharacters()
    for (const [index, sprite] of state.sceneDraft.entries()) {
      const row = document.createElement('div')
      row.className = 'scene-sprite-row'

      const character = document.createElement('select')
      character.className = 'mini'
      const empty = document.createElement('option')
      empty.value = ''
      empty.textContent = '选择角色'
      character.append(empty)
      for (const item of characters) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.name
        character.append(option)
      }
      character.value = sprite.characterId || ''
      character.addEventListener('change', () => {
        sprite.characterId = character.value
      })

      const pos = document.createElement('select')
      pos.className = 'mini'
      for (const [value, label] of [
        ['left', '左'],
        ['center', '中'],
        ['right', '右'],
      ]) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        pos.append(option)
      }
      pos.value = sprite.pos || 'center'
      pos.addEventListener('change', () => {
        sprite.pos = pos.value
      })

      const emotion = document.createElement('input')
      emotion.maxLength = 20
      emotion.placeholder = '表情'
      emotion.value = sprite.emotion || ''
      emotion.addEventListener('input', () => {
        sprite.emotion = emotion.value
      })

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'mini danger-mini'
      remove.textContent = '删除'
      remove.addEventListener('click', () => {
        state.sceneDraft.splice(index, 1)
        renderSceneSpriteRows()
      })

      row.append(character, pos, emotion, remove)
      els.sceneSpriteList.append(row)
    }
  }

  function openSceneEditor() {
    if (!isGm()) return
    const scene = (state.room && state.room.scene) || {}
    const assets = (state.room && state.room.pack && state.room.pack.assets) || []
    fillAssetSelect(els.sceneBackground, assets, /\.(png|jpe?g|webp|gif)$/i, scene.background || '')
    fillAssetSelect(els.sceneBgm, assets, /\.(mp3|ogg|wav|m4a|aac)$/i, scene.bgm || '')
    els.sceneCaption.value = scene.caption || ''
    state.sceneDraft = (scene.sprites || []).map((sprite) => ({
      characterId: sprite.characterId || '',
      pos: sprite.pos || 'center',
      emotion: sprite.emotion || '',
    }))
    renderSceneSpriteRows()
    els.sceneModal.hidden = false
  }

  function addSceneSprite() {
    const characters = sceneCharacters()
    if (characters.length === 0) {
      toast('房间里没有可用的立绘角色', 'error')
      return
    }
    state.sceneDraft.push({ characterId: characters[0].id, pos: 'center', emotion: '' })
    renderSceneSpriteRows()
  }

  async function saveScene() {
    els.sceneSave.disabled = true
    try {
      const data = await api(roomPath('/scene'), {
        method: 'POST',
        token: state.member.token,
        body: {
          background: els.sceneBackground.value,
          bgm: els.sceneBgm.value,
          caption: els.sceneCaption.value,
          sprites: state.sceneDraft
            .filter((sprite) => sprite.characterId)
            .map((sprite) => ({
              characterId: sprite.characterId,
              pos: sprite.pos,
              emotion: sprite.emotion,
            })),
        },
      })
      if (state.room) state.room.scene = data.scene
      state.stageHidden = false
      els.sceneModal.hidden = true
      renderStage()
      toast('舞台已更新')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.sceneSave.disabled = false
    }
  }

  // ---------- 选项投票 ----------

  function renderChoice() {
    const choice = state.room && state.room.choice
    if (!choice) {
      els.choiceBar.hidden = true
      return
    }
    els.choiceBar.hidden = false
    els.choiceTitle.textContent = `选项投票 · 已投 ${choice.voted}/${choice.total}`
    els.choiceOptionsList.textContent = ''
    const myVote = state.member && choice.votes ? choice.votes[state.member.id] : null
    for (const option of choice.options || []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini choice-option' + (myVote === option.id ? ' active' : '')
      button.textContent = `${option.text}（${option.votes}）`
      button.addEventListener('click', () => void castChoice(option.id))
      els.choiceOptionsList.append(button)
    }
    els.choiceCancel.hidden = !isGm()
  }

  function openChoiceModal() {
    if (!isGm()) return
    const storyChoices = (state.room && state.room.story && state.room.story.choices) || []
    els.choiceOptionsInput.value = storyChoices.join('\n')
    els.choiceModal.hidden = false
  }

  async function startChoice() {
    const options = els.choiceOptionsInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
    if (options.length < 2) {
      toast('至少写两个选项', 'error')
      return
    }
    els.choiceStartSubmit.disabled = true
    try {
      const data = await api(roomPath('/choice'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'start', options },
      })
      if (state.room) state.room.choice = data.choice
      els.choiceModal.hidden = true
      renderChoice()
      toast('已发起选项投票')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.choiceStartSubmit.disabled = false
    }
  }

  async function castChoice(optionId) {
    try {
      const data = await api(roomPath('/choice'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'cast', optionId },
      })
      if (state.room) state.room.choice = data.choice || null
      renderChoice()
      if (data.passed) toast(`投票结果：${data.winner}`)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function cancelChoice() {
    try {
      const data = await api(roomPath('/choice'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'cancel' },
      })
      if (state.room) state.room.choice = data.choice || null
      renderChoice()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function renderComposerTarget() {
    const room = state.room
    const visible = Boolean(
      room &&
        state.member &&
        room.mode === 'mystery' &&
        Array.isArray(room.cast) &&
        room.cast.length > 0,
    )
    const previous = els.composerTo.value
    els.composerTo.textContent = ''
    if (!visible) {
      els.composerTo.hidden = true
      updateComposerHint()
      return
    }
    const addOption = (value, label) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      els.composerTo.append(option)
    }
    addOption('', '公开')
    if (isGm()) {
      for (const member of room.members || []) {
        if (!member || member.role === 'gm' || member.id === state.member.id) continue
        addOption(member.id, `私聊 · ${member.name}`)
      }
    } else {
      const gm = (room.members || []).find((member) => member.role === 'gm')
      if (gm) addOption(gm.id, '私聊 GM')
    }
    els.composerTo.hidden = els.composerTo.options.length <= 1
    if (previous && Array.from(els.composerTo.options).some((option) => option.value === previous)) {
      els.composerTo.value = previous
    }
    updateComposerHint()
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
    es.addEventListener('phase', onPhaseEvent)
    es.addEventListener('roles', onRolesEvent)
    es.addEventListener('story', onStoryEvent)
    es.addEventListener('scene', onSceneEvent)
    es.addEventListener('choice', onChoiceEvent)
    es.addEventListener('restore', onRestoreEvent)
    es.addEventListener('saves', onSavesEvent)
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
    renderComposerTarget()
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

  function onPhaseEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room && data.phase) state.room.phase = data.phase
    renderPhase()
    if (!els.rolesModal.hidden) void loadRoles()
  }

  function onRolesEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room && Array.isArray(data.cast)) state.room.cast = data.cast
    renderComposerTarget()
    if (!els.rolesModal.hidden) void loadRoles()
  }

  function onStoryEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room) state.room.story = data.story || null
    renderStory()
  }

  function onSceneEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room) state.room.scene = data.scene || null
    renderStage()
  }

  function onChoiceEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (state.room) state.room.choice = data.choice || null
    renderChoice()
  }

  function onSavesEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    renderSaves(data)
  }

  function onRestoreEvent(event) {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    state.room = data.room
    state.hydrated = true
    state.seen.clear()
    state.lastSeq = 0
    state.history = []
    els.messages.textContent = ''
    for (const message of data.messages || []) addMessage(message)
    if (state.room && state.room.seq > state.lastSeq) state.lastSeq = state.room.seq
    renderHeader()
    renderMembers()
    saveCache()
    if (state.room && state.room.closed) showClosed()
  }

  // ---------- 角色本 / 阶段 / 汤底 ----------

  async function loadRoles() {
    if (!state.member) return
    try {
      const data = await api(roomPath('/roles'), { token: state.member.token })
      state.roles = data
      renderRoles()
    } catch (error) {
      els.rolesHint.textContent = error.message
    }
  }

  function renderRoles() {
    const data = state.roles
    if (!data) return
    els.rolesHint.textContent =
      data.mode === 'mystery'
        ? '剧本杀：领取一个角色才能看到对应的角色本；GM 可以指派。角色本不会出现在公开消息里。'
        : '角色本只对扮演者与 GM 可见。'
    els.rolesList.textContent = ''
    for (const role of data.cast || []) {
      const item = document.createElement('li')
      item.className = 'role-card'

      const head = document.createElement('div')
      head.className = 'role-card-head'
      const avatar = document.createElement('span')
      avatar.className = 'avatar avatar-sm'
      renderAvatar(avatar, { avatar: role.avatar, emoji: role.emoji, name: role.name })
      const name = document.createElement('strong')
      name.textContent = role.name
      const status = document.createElement('span')
      status.className = 'muted small'
      if (role.assignee) status.textContent = role.mine ? '由你扮演' : `由 ${role.assignee.name} 扮演`
      else status.textContent = role.playedBy === 'ai' ? 'AI 扮演' : '待认领'
      head.append(avatar, name, status)
      item.append(head)

      if (isGm()) {
        const row = document.createElement('div')
        row.className = 'role-assign'
        const label = document.createElement('span')
        label.className = 'muted small'
        label.textContent = '指派给'
        const select = document.createElement('select')
        select.className = 'mini'
        const none = document.createElement('option')
        none.value = ''
        none.textContent = role.playedBy === 'ai' ? '（AI 固定）' : '未指派'
        select.append(none)
        for (const member of (state.room && state.room.members) || []) {
          if (!member || member.role === 'gm') continue
          const option = document.createElement('option')
          option.value = member.id
          option.textContent = member.name
          select.append(option)
        }
        select.value = role.assignee ? role.assignee.id : ''
        select.disabled = role.playedBy === 'ai'
        select.addEventListener('change', () => void assignCharacter(role.id, select.value))
        row.append(label, select)
        item.append(row)
      } else if (!role.mine && !role.assignee && role.playedBy !== 'ai') {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'mini primary'
        button.textContent = '领取这个角色'
        button.addEventListener('click', () => void claimCharacter(role.id))
        item.append(button)
      }

      if ((role.mine || isGm()) && role.playerBrief) {
        const brief = document.createElement('p')
        brief.className = 'role-brief'
        brief.textContent = role.playerBrief
        item.append(brief)
      }
      if (role.mine && role.secret) {
        const book = document.createElement('details')
        book.className = 'role-book'
        const summary = document.createElement('summary')
        summary.textContent = '打开我的角色本'
        const pre = document.createElement('pre')
        pre.textContent = role.secret
        book.append(summary, pre)
        item.append(book)
      }
      if (isGm() && role.secret) {
        const book = document.createElement('details')
        book.className = 'role-book'
        const summary = document.createElement('summary')
        summary.textContent = role.mine ? '角色本' : 'GM 查看角色本'
        const pre = document.createElement('pre')
        pre.textContent = role.secret
        book.append(summary, pre)
        item.append(book)
      }
      if (role.mine && !isGm()) {
        const release = document.createElement('button')
        release.type = 'button'
        release.className = 'mini'
        release.textContent = '释放角色'
        release.addEventListener('click', () => void releaseCharacter())
        item.append(release)
      }
      els.rolesList.append(item)
    }
  }

  async function claimCharacter(characterId) {
    try {
      state.roles = await api(roomPath('/roles'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'claim', characterId },
      })
      renderRoles()
      toast('角色已领取，角色本在下面')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function assignCharacter(characterId, memberId) {
    try {
      state.roles = await api(roomPath('/roles'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'assign', characterId, memberId: memberId || null },
      })
      renderRoles()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function releaseCharacter() {
    try {
      state.roles = await api(roomPath('/roles'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'release' },
      })
      renderRoles()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function openRoles() {
    els.rolesModal.hidden = false
    els.rolesHint.textContent = '正在读取角色本…'
    void loadRoles()
  }

  async function openTruth() {
    try {
      const data = await api(roomPath('/truth'), { token: state.member.token })
      els.truthText.textContent = data.truth || ''
      els.truthModal.hidden = false
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function nextPhase() {
    if (!isGm()) return
    els.phaseNext.disabled = true
    try {
      const data = await api(roomPath('/phase'), {
        method: 'POST',
        token: state.member.token,
        body: { action: 'next' },
      })
      if (state.room && data.phase) state.room.phase = data.phase
      renderPhase()
    } catch (error) {
      toast(error.message, 'error')
      renderPhase()
    }
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

    if (message.private) {
      article.classList.add('msg-private')
      const note = document.createElement('span')
      note.className = 'badge badge-private'
      note.textContent = '私聊'
      note.title = '私聊内容只有发送者、接收者和 GM 能看到'
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
    if (els.storyContinue) els.storyContinue.disabled = thinking
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

  async function sendText(text) {
    const value = String(text ?? '').trim()
    if (!value) return false
    if (!state.member) {
      toast('还没加入房间，刷新页面重新进一次', 'error')
      return false
    }
    els.send.disabled = true
    const to = els.composerTo.value || ''
    try {
      await api(roomPath('/messages'), {
        method: 'POST',
        token: state.member.token,
        body: { text: value, ...(to ? { to } : {}) },
      })
      els.composerInput.value = ''
      els.composerTo.value = ''
      updateComposerHint()
      return true
    } catch (error) {
      toast(error.message, 'error')
      return false
    } finally {
      els.send.disabled = false
      els.composerInput.focus()
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    await sendText(els.composerInput.value)
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

  // ---------- 存档 / 记忆 ----------

  function saveTime(ts) {
    const date = new Date(ts || Date.now())
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
      date.getHours(),
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  function renderSaves(payload) {
    const data = payload || state.saves || { auto: null, saves: [] }
    state.saves = data
    els.savesList.textContent = ''
    const items = []
    if (data.auto) items.push(data.auto)
    for (const save of data.saves || []) items.push(save)
    if (items.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'muted small'
      empty.textContent = '还没有存档；每回合会自动存一份，也可以手动新建。'
      els.savesList.append(empty)
      els.rewindBtn.disabled = true
      return
    }
    for (const save of items) {
      const item = document.createElement('li')
      item.className = 'save-item'
      const info = document.createElement('div')
      info.className = 'save-info'
      const name = document.createElement('strong')
      name.textContent = save.name || (save.kind === 'auto' ? '自动存档' : '存档')
      const meta = document.createElement('span')
      meta.className = 'muted small'
      meta.textContent = `${save.kind === 'auto' ? '自动 · ' : ''}第 ${save.turn || 0} 回合${
        save.chapter ? ' · ' + save.chapter : ''
      } · ${save.messageCount || 0} 条 · ${saveTime(save.at)}`
      info.append(name, meta)

      const actions = document.createElement('div')
      actions.className = 'save-actions'
      const load = document.createElement('button')
      load.type = 'button'
      load.className = 'mini primary'
      load.textContent = '读取'
      load.addEventListener('click', () => void loadSave(save.id))
      actions.append(load)
      if (save.kind !== 'auto') {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'mini danger-mini'
        remove.textContent = '删除'
        remove.addEventListener('click', () => void deleteSave(save.id))
        actions.append(remove)
      }
      item.append(info, actions)
      els.savesList.append(item)
    }
    els.rewindBtn.disabled = !data.auto
  }

  async function openSaves() {
    els.savesModal.hidden = false
    els.savesList.textContent = '读取中…'
    try {
      const data = await api(roomPath('/saves'), { token: state.member.token })
      renderSaves(data)
    } catch (error) {
      els.savesList.textContent = error.message
    }
  }

  async function createSave() {
    els.saveNew.disabled = true
    try {
      const data = await api(roomPath('/saves'), {
        method: 'POST',
        token: state.member.token,
        body: { name: els.saveName.value.trim() },
      })
      els.saveName.value = ''
      renderSaves({ auto: data.auto, saves: data.saves })
      toast('已新建存档')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.saveNew.disabled = false
    }
  }

  async function loadSave(saveId) {
    try {
      await api(roomPath(`/saves/${encodeURIComponent(saveId)}/load`), {
        method: 'POST',
        token: state.member.token,
      })
      els.savesModal.hidden = true
      toast('已读档')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function deleteSave(saveId) {
    const ok = await window.showConfirm({
      title: '删除存档',
      message: '删除这个存档？不能恢复。',
      okText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      const data = await api(roomPath(`/saves/${encodeURIComponent(saveId)}`), {
        method: 'DELETE',
        token: state.member.token,
      })
      renderSaves(data)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function rewind() {
    try {
      await api(roomPath('/rewind'), { method: 'POST', token: state.member.token })
      els.savesModal.hidden = true
      toast('已回退一步')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  function linesOf(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function pairsOf(text) {
    const out = {}
    for (const line of linesOf(text)) {
      const index = line.search(/[:：]/)
      if (index <= 0) continue
      const key = line.slice(0, index).trim().slice(0, 40)
      const value = line.slice(index + 1).trim().slice(0, 200)
      if (key && value) out[key] = value
    }
    return out
  }

  async function openMemory() {
    els.memoryModal.hidden = false
    try {
      const data = await api(roomPath('/memory'), { token: state.member.token })
      const memory = data.memory || {}
      els.memoryFacts.value = (memory.facts || []).join('\n')
      els.memoryItems.value = (memory.items || []).join('\n')
      els.memoryRelations.value = Object.entries(memory.relations || {})
        .map(([name, relation]) => `${name}：${relation}`)
        .join('\n')
      els.memoryAffection.value = Object.entries(memory.affection || {})
        .map(([name, value]) => `${name}：${value}`)
        .join('\n')
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function saveMemory() {
    els.memorySave.disabled = true
    try {
      const relations = pairsOf(els.memoryRelations.value)
      const affection = {}
      for (const [name, value] of Object.entries(pairsOf(els.memoryAffection.value))) {
        const number = Number(value)
        if (Number.isFinite(number)) affection[name] = number
      }
      const data = await api(roomPath('/memory'), {
        method: 'PATCH',
        token: state.member.token,
        body: {
          facts: linesOf(els.memoryFacts.value),
          items: linesOf(els.memoryItems.value),
          relations,
          affection,
        },
      })
      if (state.room && state.room.story) state.room.story.memory = data.memory
      els.memoryModal.hidden = true
      toast('记忆已保存')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.memorySave.disabled = false
    }
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
  els.phaseNext.addEventListener('click', nextPhase)
  els.rolesBtn.addEventListener('click', openRoles)
  els.rolesClose.addEventListener('click', () => {
    els.rolesModal.hidden = true
  })
  els.rolesModal.addEventListener('click', (event) => {
    if (event.target === els.rolesModal) els.rolesModal.hidden = true
  })
  els.truthBtn.addEventListener('click', openTruth)
  els.truthClose.addEventListener('click', () => {
    els.truthModal.hidden = true
  })
  els.truthModal.addEventListener('click', (event) => {
    if (event.target === els.truthModal) els.truthModal.hidden = true
  })
  els.stageBtn.addEventListener('click', toggleStage)
  els.stageCollapse.addEventListener('click', toggleStage)
  els.stageBgmToggle.addEventListener('click', toggleStageBgm)
  els.sceneEdit.addEventListener('click', openSceneEditor)
  els.sceneAddSprite.addEventListener('click', addSceneSprite)
  els.sceneSave.addEventListener('click', saveScene)
  els.sceneClose.addEventListener('click', () => {
    els.sceneModal.hidden = true
  })
  els.sceneModal.addEventListener('click', (event) => {
    if (event.target === els.sceneModal) els.sceneModal.hidden = true
  })
  els.choiceStart.addEventListener('click', openChoiceModal)
  els.choiceStartSubmit.addEventListener('click', startChoice)
  els.choiceClose.addEventListener('click', () => {
    els.choiceModal.hidden = true
  })
  els.choiceModal.addEventListener('click', (event) => {
    if (event.target === els.choiceModal) els.choiceModal.hidden = true
  })
  els.choiceCancel.addEventListener('click', cancelChoice)
  els.savesBtn.addEventListener('click', openSaves)
  els.saveNew.addEventListener('click', createSave)
  els.rewindBtn.addEventListener('click', rewind)
  els.savesClose.addEventListener('click', () => {
    els.savesModal.hidden = true
  })
  els.savesModal.addEventListener('click', (event) => {
    if (event.target === els.savesModal) els.savesModal.hidden = true
  })
  els.memoryBtn.addEventListener('click', openMemory)
  els.memorySave.addEventListener('click', saveMemory)
  els.memoryClose.addEventListener('click', () => {
    els.memoryModal.hidden = true
  })
  els.memoryModal.addEventListener('click', (event) => {
    if (event.target === els.memoryModal) els.memoryModal.hidden = true
  })
  els.composerTo.addEventListener('change', updateComposerHint)
  els.advance.addEventListener('click', advance)
  els.storyContinue.addEventListener('click', advance)
  els.closeRoom.addEventListener('click', closeRoom)
  els.toggleMembers.addEventListener('click', () => document.body.classList.toggle('members-open'))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      document.body.classList.remove('members-open')
      closeLinkModal()
      els.rolesModal.hidden = true
      els.truthModal.hidden = true
      els.sceneModal.hidden = true
      els.choiceModal.hidden = true
      els.savesModal.hidden = true
      els.memoryModal.hidden = true
    }
  })

  boot().catch((error) => fail('房间加载失败', error.message))
})()
