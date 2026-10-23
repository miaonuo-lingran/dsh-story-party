/* 开房页逻辑：创建 / 加入 两种模式；创建页里可以开放（切换）本机端口 */
(() => {
  'use strict'

  // 被 DSH 标签页以 iframe 嵌入时加 embed 类：背景透明，不盖住宿主皮肤
  try {
    if (window.self !== window.top) document.documentElement.classList.add('embed')
  } catch {
    document.documentElement.classList.add('embed')
  }

  const $ = (id) => document.getElementById(id)
  const search = new URLSearchParams(location.search)
  const clientVersion = search.get('v') || ''
  const hostSessionId = search.get('sid') || ''
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

  const profile = readProfile()

  const els = {
    modalButtons: Array.from(document.querySelectorAll('.mode-btn')),
    createPanel: $('create-panel'),
    joinPanel: $('join-panel'),
    soloPanel: $('solo-panel'),
    soloForm: $('solo-form'),
    soloName: $('solo-name'),
    soloCharacter: $('solo-character'),
    soloStart: $('solo-start'),
    soloError: $('solo-error'),
    createForm: $('create-form'),
    titleInput: $('room-title-input'),
    gmNameInput: $('gm-name'),
    passwordInput: $('room-password'),
    characterSelect: $('character-select'),
    packFile: $('pack-file'),
    packImport: $('pack-import'),
    soloPackFile: $('solo-pack-file'),
    soloPackImport: $('solo-pack-import'),
    createButton: $('create'),
    errorBox: $('error'),
    portInput: $('port-input'),
    portApply: $('port-apply'),
    portStatus: $('port-status'),
    publicUrl: $('public-url'),
    publicUrlSave: $('public-url-save'),
    publicUrlStatus: $('public-url-status'),
    saveReasoning: $('save-reasoning'),
    contextMessages: $('context-messages'),
    autoSummary: $('auto-summary'),
    contextHelp: $('context-help'),
    contextHelpModal: $('context-help-modal'),
    contextHelpClose: $('context-help-close'),
    addrList: $('addr-list'),
    roomList: $('room-list'),
    roomEditModal: $('room-edit-modal'),
    roomEditTitle: $('room-edit-title'),
    roomEditPort: $('room-edit-port'),
    roomEditPublicUrl: $('room-edit-public-url'),
    roomEditSave: $('room-edit-save'),
    roomEditCancel: $('room-edit-cancel'),
    createTipModal: $('create-tip-modal'),
    createTipRemember: $('create-tip-remember'),
    createTipGo: $('create-tip-go'),
    createTipCancel: $('create-tip-cancel'),
    joinForm: $('join-form'),
    joinLink: $('join-link'),
    joinError: $('join-error'),
    toasts: $('toasts'),
  }

  let currentPort = Number(location.port) || 7302
  let currentPublicUrl = ''

  function applyProfile() {
    if (!profile) return
    if (profile.name) {
      if (!els.gmNameInput.value) els.gmNameInput.value = profile.name
      if (!els.soloName.value) els.soloName.value = profile.name
    }
  }

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

  function showError(box, text) {
    box.hidden = !text
    box.textContent = text || ''
  }

  // ---- 模式切换 -----------------------------------------------------------

  function setMode(mode) {
    for (const button of els.modalButtons) {
      const active = button.dataset.mode === mode
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', String(active))
    }
    els.createPanel.hidden = mode !== 'create'
    els.joinPanel.hidden = mode !== 'join'
    els.soloPanel.hidden = mode !== 'solo'
  }

  for (const button of els.modalButtons) {
    button.addEventListener('click', () => setMode(button.dataset.mode))
  }

  // ---- 复制 -----------------------------------------------------------------

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
      toast('已复制')
    } catch {
      toast('复制失败：' + text, 'error')
    }
  }

  // ---- 端口 / 地址 ----------------------------------------------------------

  function usableInterfaces(data) {
    const list = Array.isArray(data.interfaces) ? data.interfaces : []
    if (list.length > 0) {
      return list.filter(
        (item) =>
          item &&
          !item.virtual &&
          !String(item.address).startsWith('169.254.') &&
          item.netmask !== '255.255.255.255',
      )
    }
    // 旧版服务端只返回 addresses
    return (data.addresses || []).map((address) => ({ address, name: '' }))
  }

  function renderAddresses(data, port) {
    const usable = usableInterfaces(data)
    els.addrList.textContent = ''
    if (data.publicUrl) {
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = data.publicUrl
      const tag = document.createElement('em')
      tag.className = 'addr-tag'
      tag.textContent = '公网'
      text.append(' ', tag)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini'
      button.textContent = '复制'
      button.addEventListener('click', () => copyText(data.publicUrl))
      item.append(text, button)
      els.addrList.append(item)
    }
    if (usable.length === 0 && !data.publicUrl) {
      const item = document.createElement('li')
      item.className = 'addr-empty'
      item.textContent = '电脑还没连上 Wi-Fi 或手机热点——手机和电脑必须在同一个网络里，才能用这些地址互相访问。'
      els.addrList.append(item)
      return
    }
    for (const iface of usable.slice(0, 6)) {
      const url = `http://${iface.address}:${port}`
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = url
      if (iface.name) {
        const tag = document.createElement('em')
        tag.className = 'addr-tag'
        tag.textContent = iface.name
        text.append(' ', tag)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini'
      button.textContent = '复制'
      button.addEventListener('click', () => copyText(url))
      item.append(text, button)
      els.addrList.append(item)
    }
  }

  function populateCharacterSelect(select, cards, packs) {
    if (!select) return
    const previous = select.value
    select.textContent = ''
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '不用，走内置剧本'
    select.append(none)

    if (cards.length > 0) {
      const group = document.createElement('optgroup')
      group.label = '人设卡（cosplay / 内置）'
      for (const card of cards) {
        const option = document.createElement('option')
        option.value = 'cos:' + card.id
        option.textContent = (card.emoji ? card.emoji + ' ' : '') + card.name
        group.append(option)
      }
      select.append(group)
    }

    const MODE_LABEL = { roleplay: '角色扮演', soup: '海龟汤', mystery: '剧本杀', other: '其他' }
    for (const pack of packs) {
      const group = document.createElement('optgroup')
      const mode = MODE_LABEL[pack.mode] || '角色扮演'
      const players = pack.recommendedPlayers
        ? `${pack.recommendedPlayers.min}-${pack.recommendedPlayers.max} 人`
        : ''
      group.label = `剧情包 · ${pack.name}（${mode} · ${pack.characters.length} 人${players ? ' · 建议 ' + players : ''}）`
      for (const character of pack.characters) {
        const option = document.createElement('option')
        option.value = `pack:${pack.id}:${character.id}`
        option.textContent = (character.emoji ? character.emoji + ' ' : '') + character.name
        group.append(option)
      }
      select.append(group)
    }

    if (cards.length === 0 && packs.length === 0) {
      const empty = document.createElement('option')
      empty.value = ''
      empty.disabled = true
      empty.textContent = '（还没有人设卡或剧情包）'
      select.append(empty)
    } else if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous
    }
  }

  async function loadCharacters() {
    const [cardsData, packsData] = await Promise.all([
      fetch('/api/cards', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { cards: [] }))
        .catch(() => ({ cards: [] })),
      fetch('/api/packs', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { packs: [] }))
        .catch(() => ({ packs: [] })),
    ])
    const cards = Array.isArray(cardsData.cards) ? cardsData.cards : []
    const packs = Array.isArray(packsData.packs) ? packsData.packs : []
    // 创建房间 / 自我游玩 共用同一份数据，避免两次请求各拉一半
    populateCharacterSelect(els.characterSelect, cards, packs)
    populateCharacterSelect(els.soloCharacter, cards, packs)
  }

  async function importPack(fileInput, select, button) {
    const file = fileInput.files && fileInput.files[0]
    if (!file) {
      toast('先选一个 .zip 文件', 'error')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('剧情包太大（上限 8MB）', 'error')
      return
    }
    if (button) button.disabled = true
    try {
      const response = await fetch('/api/packs', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '导入失败')
      await loadCharacters()
      const first = data.pack.characters && data.pack.characters[0]
      if (first) select.value = `pack:${data.pack.id}:${first.id}`
      toast(`已导入「${data.pack.name}」`)
      fileInput.value = ''
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      if (button) button.disabled = false
    }
  }

  async function loadRooms() {
    let rooms = []
    try {
      const response = await fetch('/api/rooms', { cache: 'no-store' })
      if (response.ok) {
        const data = await response.json()
        rooms = Array.isArray(data.rooms) ? data.rooms : []
      }
    } catch {
      rooms = []
    }
    els.roomList.textContent = ''
    if (rooms.length === 0) {
      const item = document.createElement('li')
      item.className = 'room-empty'
      item.textContent = '还没有开过房间。'
      els.roomList.append(item)
      return
    }
    rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    for (const room of rooms.slice(0, 8)) {
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.className = 'room-line'
      const title = document.createElement('strong')
      title.textContent = room.title || room.id
      const meta = document.createElement('span')
      meta.className = 'room-meta'
      meta.textContent = `#${room.id} · ${room.seq || 0} 条 · ${room.members || 0} 人${room.closed ? ' · 已关闭' : ''}`
      text.append(title, ' ', meta)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini'
      const invite = localStorage.getItem(`galgame-room:invite:${room.id}`)
      if (room.closed) {
        button.textContent = '重新开放'
        button.addEventListener('click', () => reopenRoom(room))
      } else if (invite) {
        button.textContent = '继续'
        button.addEventListener('click', () => {
          location.href = `/room/${encodeURIComponent(room.id)}?t=${encodeURIComponent(invite)}`
        })
      } else {
        button.textContent = '无邀请令牌'
        button.disabled = true
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'mini danger-mini'
      remove.textContent = '删除'
      remove.addEventListener('click', () => purgeRoom(room))
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'mini'
      edit.textContent = '编辑'
      edit.addEventListener('click', () => openEditRoom(room))
      item.append(text, button, edit, remove)
      els.roomList.append(item)
    }
  }

  let editingRoom = null

  function openEditRoom(room) {
    editingRoom = room
    els.roomEditTitle.value = room.title || ''
    els.roomEditPort.value = String(currentPort)
    els.roomEditPublicUrl.value = currentPublicUrl
    els.roomEditModal.hidden = false
    setTimeout(() => els.roomEditTitle.focus(), 0)
  }

  function closeEditRoom() {
    editingRoom = null
    els.roomEditModal.hidden = true
  }

  async function saveEditRoom() {
    if (!editingRoom) return
    const title = els.roomEditTitle.value.trim()
    if (!title) {
      toast('房间名不能为空', 'error')
      return
    }
    const nextPort = Number(els.roomEditPort.value.trim() || currentPort)
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      toast('端口要填 1024–65535 之间的整数', 'error')
      return
    }
    const nextPublicUrl = els.roomEditPublicUrl.value.trim()

    // 公网地址（整机设置）
    if (nextPublicUrl !== currentPublicUrl) {
      try {
        const response = await fetch('/api/public-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: nextPublicUrl }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || '公网地址保存失败')
        currentPublicUrl = data.publicUrl || ''
        els.publicUrl.value = currentPublicUrl
        toast(currentPublicUrl ? '公网地址已更新' : '已清空公网地址')
      } catch (error) {
        toast(error.message, 'error')
      }
    }

    // 房间名（需要这间房的 GM 令牌）
    if (title !== (editingRoom.title || '')) {
      let token = ''
      try {
        const raw = localStorage.getItem(`galgame-room:member:${editingRoom.id}`)
        const member = raw ? JSON.parse(raw) : null
        token = (member && member.token) || ''
      } catch {
        token = ''
      }
      if (!token) {
        toast('这间房不是在当前浏览器开的，没法改名', 'error')
      } else {
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(editingRoom.id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ title }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '改名失败')
          toast('房间名已更新')
        } catch (error) {
          toast(error.message, 'error')
        }
      }
    }

    closeEditRoom()
    await loadRooms()

    // 端口（整机设置，放最后：成功会跳转到新地址）
    if (nextPort !== currentPort) {
      try {
        const response = await fetch('/api/port', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port: nextPort }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || '换端口失败')
        toast(`已切到端口 ${data.port}，正在跳转…`)
        setTimeout(() => {
          location.href = `${location.protocol}//${location.hostname}:${data.port}/`
        }, 500)
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  }

  async function purgeRoom(room) {
    const ok = await window.showConfirm({
      title: '删除房间',
      message: `彻底删除「${room.title || room.id}」？消息记录会一起删掉，不能恢复。`,
      okText: '删除',
      danger: true,
    })
    if (!ok) return
    let token = ''
    try {
      const raw = localStorage.getItem(`galgame-room:member:${room.id}`)
      const member = raw ? JSON.parse(raw) : null
      token = (member && member.token) || ''
    } catch {
      token = ''
    }
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/purge`, {
        method: 'POST',
        headers,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '删除失败')
      for (const key of ['member', 'invite', 'cache']) {
        try {
          localStorage.removeItem(`galgame-room:${key}:${room.id}`)
        } catch {
          /* ignore */
        }
      }
      toast('房间已删除')
      await loadRooms()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function reopenRoom(room) {
    let member = null
    try {
      const raw = localStorage.getItem(`galgame-room:member:${room.id}`)
      member = raw ? JSON.parse(raw) : null
    } catch {
      member = null
    }
    if (!member || !member.token || member.role !== 'gm') {
      toast('这间房不是在当前浏览器开的，没法重新开放', 'error')
      return
    }
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` },
        body: JSON.stringify({ closed: false }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '重新开放失败')
      toast('房间已重新开放')
      await loadRooms()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  async function savePublicUrl() {
    els.publicUrlSave.disabled = true
    try {
      const response = await fetch('/api/public-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: els.publicUrl.value.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '保存失败')
      els.publicUrlStatus.textContent = data.publicUrl
        ? `公网地址已设为 ${data.publicUrl}`
        : '已清空公网地址，将使用当前页面地址'
      toast(data.publicUrl ? '公网地址已保存' : '已清空公网地址')
      await loadNetwork()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.publicUrlSave.disabled = false
    }
  }

  async function loadSettings() {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      els.saveReasoning.checked = data.saveReasoning === true
    } catch {
      /* ignore */
    }
  }

  async function saveSettings() {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ saveReasoning: els.saveReasoning.checked }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '保存失败')
      toast(data.saveReasoning ? '已开启思维链记录（只存本机）' : '已关闭思维链记录')
    } catch (error) {
      toast(error.message, 'error')
      els.saveReasoning.checked = !els.saveReasoning.checked
    }
  }

  async function loadNetwork() {
    try {
      const response = await fetch('/api/network', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      currentPort = Number(data.port) || currentPort
      currentPublicUrl = data.publicUrl || ''
      els.portInput.value = String(currentPort)
      els.portStatus.textContent = `当前监听 ${currentPort}；换端口会让已经在房间里的朋友断开，要重新发链接。`
      els.publicUrl.value = data.publicUrl || ''
      renderAddresses(data, currentPort)
    } catch {
      els.portStatus.textContent = '拿不到当前端口，先确认房间服务在运行。'
    }
  }

  async function openPort() {
    const value = Number(els.portInput.value.trim())
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      toast('端口要填 1024–65535 之间的整数', 'error')
      return
    }
    els.portApply.disabled = true
    try {
      const response = await fetch('/api/port', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: value }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '开放失败')
      if (Number(data.port) === currentPort) {
        toast(`端口 ${data.port} 本来就在用`)
        return
      }
      toast(`已切到端口 ${data.port}，正在跳转…`)
      const next = `${location.protocol}//${location.hostname}:${data.port}/`
      setTimeout(() => {
        location.href = next
      }, 500)
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.portApply.disabled = false
    }
  }

  // ---- 创建 -----------------------------------------------------------------

  async function createSolo(event) {
    event.preventDefault()
    const gmName = els.soloName.value.trim()
    if (!gmName) {
      showError(els.soloError, '先起个名字吧')
      return
    }
    els.soloStart.disabled = true
    showError(els.soloError, '')
    try {
      const selection = els.soloCharacter.value
      const payload = { gmName, solo: true }
      if (profile && profile.avatar) payload.avatar = profile.avatar
      if (hostSessionId) payload.sessionId = hostSessionId
      if (selection.startsWith('cos:')) {
        payload.cardId = selection.slice(4)
      } else if (selection.startsWith('pack:')) {
        const rest = selection.slice(5)
        const separator = rest.indexOf(':')
        payload.packId = rest.slice(0, separator)
        payload.characterId = rest.slice(separator + 1)
      }
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '创建失败')
      const roomId = data.room.id
      localStorage.setItem(`galgame-room:invite:${roomId}`, data.inviteToken)
      localStorage.setItem(
        `galgame-room:member:${roomId}`,
        JSON.stringify({ id: data.gm.memberId, token: data.gm.token, role: 'gm', name: gmName }),
      )
      location.href = `/room/${encodeURIComponent(roomId)}?t=${encodeURIComponent(data.inviteToken)}`
    } catch (error) {
      showError(els.soloError, error.message)
    } finally {
      els.soloStart.disabled = false
    }
  }

  const CREATE_TIP_KEY = 'galgame-room:create-tip-ack'

  async function createRoom(event) {
    event.preventDefault()
    const gmName = els.gmNameInput.value.trim()
    if (!gmName) {
      showError(els.errorBox, '先起个名字吧')
      return
    }
    if (!localStorage.getItem(CREATE_TIP_KEY)) {
      els.createTipModal.hidden = false
      return
    }
    await doCreateRoom(gmName)
  }

  async function doCreateRoom(gmName) {
    els.createButton.disabled = true
    showError(els.errorBox, '')
    try {
      const selection = els.characterSelect.value
      const payload = { title: els.titleInput.value.trim(), gmName }
      if (profile && profile.avatar) payload.avatar = profile.avatar
      const contextValue = Number(els.contextMessages.value)
      if (Number.isInteger(contextValue)) payload.contextMessages = contextValue
      payload.autoSummary = els.autoSummary.checked
      if (hostSessionId) payload.sessionId = hostSessionId
      if (els.passwordInput.value.trim()) payload.password = els.passwordInput.value.trim()
      if (selection.startsWith('cos:')) {
        payload.cardId = selection.slice(4)
      } else if (selection.startsWith('pack:')) {
        const rest = selection.slice(5)
        const separator = rest.indexOf(':')
        payload.packId = rest.slice(0, separator)
        payload.characterId = rest.slice(separator + 1)
      }
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '创建失败')
      const roomId = data.room.id
      localStorage.setItem(`galgame-room:invite:${roomId}`, data.inviteToken)
      localStorage.setItem(
        `galgame-room:member:${roomId}`,
        JSON.stringify({ id: data.gm.memberId, token: data.gm.token, role: 'gm', name: gmName }),
      )
      location.href = `/room/${encodeURIComponent(roomId)}?t=${encodeURIComponent(data.inviteToken)}`
    } catch (error) {
      showError(els.errorBox, error.message)
    } finally {
      els.createButton.disabled = false
    }
  }

  // ---- 加入 -----------------------------------------------------------------

  function parseInvite(value) {
    let text = String(value || '').trim()
    if (!text) return null
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text
    let url
    try {
      url = new URL(text)
    } catch {
      return null
    }
    return /\/room\/[^/]+\/?$/.test(url.pathname) ? url : null
  }

  async function joinRoom(event) {
    event.preventDefault()
    const url = parseInvite(els.joinLink.value)
    if (!url) {
      showError(els.joinError, '这不像一条邀请链接，示例：http://10.0.0.2:7302/room/ABC123?t=...')
      return
    }
    showError(els.joinError, '')
    // 来自 DSH 标签页时带着本机版本（?v=）：加入别人的主机前先比对，版本不一致不跳
    if (clientVersion && url.origin !== location.origin) {
      try {
        const response = await fetch(url.origin + '/api/version', { cache: 'no-store' })
        if (!response.ok) throw new Error('主机没有返回版本信息')
        const remote = await response.json()
        if (String(remote.version) !== clientVersion) {
          showError(
            els.joinError,
            `版本不一致：主机 v${remote.version}，本机 v${clientVersion}——双方要用同一版本`,
          )
          return
        }
      } catch (error) {
        showError(els.joinError, '连不上主机：' + (error && error.message ? error.message : '网络错误'))
        return
      }
    }
    if (clientVersion) url.searchParams.set('v', clientVersion)
    location.href = url.href
  }

  els.createForm.addEventListener('submit', createRoom)
  els.joinForm.addEventListener('submit', joinRoom)
  els.soloForm.addEventListener('submit', createSolo)
  els.portApply.addEventListener('click', openPort)
  els.publicUrlSave.addEventListener('click', savePublicUrl)
  els.saveReasoning.addEventListener('change', saveSettings)
  els.packImport.addEventListener('click', () =>
    importPack(els.packFile, els.characterSelect, els.packImport),
  )
  els.soloPackImport.addEventListener('click', () =>
    importPack(els.soloPackFile, els.soloCharacter, els.soloPackImport),
  )
  els.roomEditSave.addEventListener('click', saveEditRoom)
  els.roomEditCancel.addEventListener('click', closeEditRoom)
  els.roomEditModal.addEventListener('click', (event) => {
    if (event.target === els.roomEditModal) closeEditRoom()
  })
  els.roomEditTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveEditRoom()
    if (event.key === 'Escape') closeEditRoom()
  })
  els.createTipGo.addEventListener('click', () => {
    if (els.createTipRemember.checked) {
      try {
        localStorage.setItem(CREATE_TIP_KEY, '1')
      } catch {
        /* 隐私模式忽略 */
      }
    }
    els.createTipModal.hidden = true
    const name = els.gmNameInput.value.trim() || '主持人'
    doCreateRoom(name)
  })
  els.createTipCancel.addEventListener('click', () => {
    els.createTipModal.hidden = true
  })
  els.createTipModal.addEventListener('click', (event) => {
    if (event.target === els.createTipModal) els.createTipModal.hidden = true
  })
  els.contextHelp.addEventListener('click', () => {
    els.contextHelpModal.hidden = false
  })
  els.contextHelpClose.addEventListener('click', () => {
    els.contextHelpModal.hidden = true
  })
  els.contextHelpModal.addEventListener('click', (event) => {
    if (event.target === els.contextHelpModal) els.contextHelpModal.hidden = true
  })

  applyProfile()
  loadNetwork()
  loadCharacters()
  loadRooms()
  loadSettings()
})()
