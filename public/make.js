/* 剧情包制作页：填内容 → 浏览器端零依赖打包成 zip → 下载或直接装进本机 */
(() => {
  'use strict'

  try {
    if (window.self !== window.top) document.documentElement.classList.add('embed')
  } catch {
    document.documentElement.classList.add('embed')
  }

  const $ = (id) => document.getElementById(id)

  const els = {
    packName: $('pack-name'),
    packVersion: $('pack-version'),
    packAuthor: $('pack-author'),
    packDesc: $('pack-desc'),
    packMode: $('pack-mode'),
    modeHint: $('mode-hint'),
    packIntro: $('pack-intro'),
    playersMin: $('players-min'),
    playersMax: $('players-max'),
    singlePlayer: $('single-player'),
    scenario: $('scenario'),
    charList: $('char-list'),
    addChar: $('add-char'),
    addLocation: $('add-location'),
    mapBreadcrumb: $('map-breadcrumb'),
    mapCanvas: $('map-canvas'),
    locationList: $('location-list'),
    addRoute: $('add-route'),
    routeList: $('route-list'),
    relationGraph: $('relation-graph'),
    assets: $('assets'),
    assetList: $('asset-list'),
    download: $('download'),
    install: $('install'),
    saveDraft: $('save-draft'),
    clearDraft: $('clear-draft'),
    draftStatus: $('draft-status'),
    status: $('status'),
    toasts: $('toasts'),
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

  // ---------- 人物 ----------

  const MODE_HINTS = {
    roleplay: '自由对话，AI 扮演人物推进剧情（默认）。',
    soup: '玩家提问，AI 只答「是 / 不是 / 无关」，汤底由 GM 揭晓。',
    mystery: '分阶段推进（阅读 → 自我介绍 → 搜证 → 讨论 → 投票 → 复盘），秘密只发给对应玩家（私聊能力后续版本）。',
    other: '自定义玩法，把规则写进人物的「守则」里。',
  }

  function updateModeHint() {
    els.modeHint.textContent = MODE_HINTS[els.packMode.value] || ''
  }

  els.packMode.addEventListener('change', () => {
    updateModeHint()
    scheduleDraftSave()
  })
  updateModeHint()

  for (const input of [
    els.packName,
    els.packVersion,
    els.packAuthor,
    els.packDesc,
    els.scenario,
    els.packIntro,
    els.playersMin,
    els.playersMax,
  ]) {
    input.addEventListener('input', scheduleDraftSave)
  }

  function updatePlayersMode() {
    const single = els.singlePlayer.checked
    els.playersMin.disabled = single
    els.playersMax.disabled = single
    if (single) {
      els.playersMin.value = '1'
      els.playersMax.value = '1'
    } else if (els.playersMin.value === '1' && els.playersMax.value === '1') {
      els.playersMin.value = '2'
      els.playersMax.value = '4'
    }
  }

  els.singlePlayer.addEventListener('change', () => {
    updatePlayersMode()
    scheduleDraftSave()
  })
  updatePlayersMode()

  function createCharacter() {
    return {
      id: 'c' + Math.random().toString(36).slice(2, 8),
      name: '',
      emoji: '🙂',
      gender: '',
      playedBy: 'ai',
      playerBrief: '',
      avatar: '',
      description: '',
      personality: '',
      scenario: '',
      firstMes: '',
      mesExample: '',
      rules: '',
      behavior: '',
      likes: '',
      favoritePlaces: [],
      relations: [],
    }
  }

  /** 把本地图片裁成 128×128 JPEG data URL（和房间头像同尺寸，别把包撑大） */
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

  function renderAvatarPreview(node, character) {
    node.textContent = ''
    if (character.avatar && character.avatar.startsWith('data:image/')) {
      const image = document.createElement('img')
      image.src = character.avatar
      image.alt = ''
      node.append(image)
      return
    }
    node.textContent = character.emoji || '🙂'
  }

  const state = {
    characters: [createCharacter()],
    assets: [],
    links: [],
    locations: [],
    routes: [],
    viewParent: null,
    selectedLocationId: null,
  }

  // ---------- 草稿：自动存进 localStorage，下次打开自动恢复 ----------

  const DRAFT_KEY = 'galgame-room:make-draft'
  let draftTimer = null

  function draftPayload() {
    return {
      v: 1,
      savedAt: Date.now(),
      pack: {
        name: els.packName.value,
        version: els.packVersion.value,
        author: els.packAuthor.value,
        desc: els.packDesc.value,
        mode: els.packMode.value,
        scenario: els.scenario.value,
        intro: els.packIntro.value,
        playersMin: els.playersMin.value,
        playersMax: els.playersMax.value,
        singlePlayer: els.singlePlayer.checked,
      },
      characters: state.characters,
      links: state.links,
      locations: state.locations,
      routes: state.routes,
    }
  }

  function saveDraftNow() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draftPayload()))
      els.draftStatus.textContent = `草稿已保存 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    } catch {
      els.draftStatus.textContent = '草稿保存失败（浏览器存储不可用）'
    }
  }

  function scheduleDraftSave() {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraftNow, 800)
  }

  function restoreDraft() {
    let draft = null
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
    } catch {
      draft = null
    }
    if (!draft || !draft.pack) return false
    const pack = draft.pack
    els.packName.value = pack.name || ''
    els.packVersion.value = pack.version || '1.0.0'
    els.packAuthor.value = pack.author || ''
    els.packDesc.value = pack.desc || ''
    els.packMode.value = pack.mode || 'roleplay'
    els.scenario.value = pack.scenario || ''
    els.packIntro.value = pack.intro || ''
    els.playersMin.value = pack.playersMin || '2'
    els.playersMax.value = pack.playersMax || '4'
    els.singlePlayer.checked = pack.singlePlayer === true
    if (Array.isArray(draft.characters) && draft.characters.length > 0) {
      state.characters = draft.characters.map((character) => ({
        ...createCharacter(),
        ...character,
      }))
    }
    state.links = Array.isArray(draft.links) ? draft.links : []
    state.locations = Array.isArray(draft.locations) ? draft.locations : []
    state.routes = Array.isArray(draft.routes) ? draft.routes : []
    state.viewParent = null
    updateModeHint()
    renderCharacters()
    renderLocations()
    renderRoutes()
    renderMap()
    setTimeout(() => renderGraph(), 0)
    els.draftStatus.textContent = `已恢复草稿（${new Date(draft.savedAt).toLocaleString()}）`
    return true
  }

  function dropDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* ignore */
    }
    els.draftStatus.textContent = '草稿已清除'
  }

  function renderCharacters() {
    els.charList.textContent = ''
    state.characters.forEach((character, index) => {
      const block = document.createElement('div')
      block.className = 'char-block'

      const head = document.createElement('div')
      head.className = 'char-head'
      const title = document.createElement('strong')
      title.textContent = `人物 ${index + 1}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'mini danger-mini'
      remove.textContent = '删除'
      remove.addEventListener('click', () => {
        if (state.characters.length === 1) {
          toast('至少留一个人物', 'error')
          return
        }
        state.characters.splice(index, 1)
        renderCharacters()
        renderGraph()
        scheduleDraftSave()
      })
      head.append(title, remove)
      block.append(head)

      // 头像：本地上传 → 缩成 128px → 写进人物卡的 avatar 字段
      const avatarRow = document.createElement('div')
      avatarRow.className = 'field char-avatar-row'
      const avatarCaption = document.createElement('span')
      avatarCaption.textContent = '头像（可选，本地上传）'
      const preview = document.createElement('span')
      preview.className = 'avatar avatar-lg'
      renderAvatarPreview(preview, character)
      const picker = document.createElement('input')
      picker.type = 'file'
      picker.accept = 'image/*'
      picker.className = 'file-input'
      picker.setAttribute('aria-label', '人物头像')
      picker.addEventListener('change', async () => {
        const file = picker.files && picker.files[0]
        picker.value = ''
        if (!file) return
        if (!/^image\//.test(file.type)) {
          toast('选一张图片', 'error')
          return
        }
        try {
          character.avatar = await resizeImage(file, 128)
          renderAvatarPreview(preview, character)
          scheduleDraftSave()
          toast('头像已设置')
        } catch (error) {
          toast(error.message, 'error')
        }
      })
      const clearAvatar = document.createElement('button')
      clearAvatar.type = 'button'
      clearAvatar.className = 'mini'
      clearAvatar.textContent = '清除'
      clearAvatar.addEventListener('click', () => {
        character.avatar = ''
        renderAvatarPreview(preview, character)
        scheduleDraftSave()
      })
      avatarRow.append(avatarCaption, preview, picker, clearAvatar)
      block.append(avatarRow)

      const grid = document.createElement('div')
      grid.className = 'grid-2'
      const fields = [
        ['name', '名字', 'input'],
        ['emoji', 'emoji', 'input'],
        ['gender', '性别', 'select'],
        ['playedBy', '扮演方式', 'select'],
        ['description', '人物设定', 'textarea'],
        ['personality', '性格', 'textarea'],
        ['scenario', '场景 / 关系', 'textarea'],
        ['firstMes', '开场白', 'textarea'],
        ['rules', '守则', 'textarea'],
        ['playerBrief', '玩家须知（人类扮演时给该玩家看）', 'textarea'],
        ['likes', '喜爱', 'textarea'],
        ['favoritePlaces', '常去地点', 'places'],
        ['behavior', '行为细节', 'textarea'],
        ['mesExample', '对话示例', 'textarea'],
      ]

      for (const [key, label, kind] of fields) {
        const field = document.createElement('label')
        field.className = 'field' + (kind === 'textarea' ? ' span-2' : '')
        const caption = document.createElement('span')
        caption.textContent = label

        let control
        if (kind === 'select') {
          control = document.createElement('select')
          const options =
            key === 'playedBy'
              ? [
                  ['ai', 'AI 扮演'],
                  ['human', '人类扮演'],
                  ['either', '两者皆可'],
                ]
              : [
                  ['', '未设定'],
                  ['female', '女'],
                  ['male', '男'],
                  ['other', '其他'],
                ]
          for (const [value, text] of options) {
            const option = document.createElement('option')
            option.value = value
            option.textContent = text
            control.append(option)
          }
          control.value = character[key] || ''
          control.addEventListener('change', () => {
            character[key] = control.value
            scheduleDraftSave()
          })
          field.append(caption, control)
          grid.append(field)
          continue
        }
        if (kind === 'places') {
          control = document.createElement('select')
          control.multiple = true
          control.size = Math.min(5, Math.max(3, state.locations.length))
          for (const location of state.locations) {
            const option = document.createElement('option')
            option.value = location.id
            option.textContent = locationPath(location)
              .map((item) => item.name || '未命名')
              .join(' / ')
            if ((character.favoritePlaces || []).includes(location.id)) option.selected = true
            control.append(option)
          }
          control.addEventListener('change', () => {
            character.favoritePlaces = Array.from(control.selectedOptions).map((option) => option.value)
            scheduleDraftSave()
          })
          field.append(caption, control)
          grid.append(field)
          continue
        }
        if (kind === 'textarea') {
          control = document.createElement('textarea')
          control.rows = 3
          control.placeholder = label
        } else {
          control = document.createElement('input')
          control.maxLength = key === 'emoji' ? 8 : 40
          control.placeholder = key === 'name' ? '小柚' : '🍊'
        }
        control.value = character[key] || ''
        control.addEventListener('input', () => {
          character[key] = control.value
          if (key === 'name') scheduleGraphRender()
          scheduleDraftSave()
        })
        field.append(caption, control)
        grid.append(field)
      }

      block.append(grid)
      els.charList.append(block)
    })
  }

  els.addChar.addEventListener('click', () => {
    state.characters.push(createCharacter())
    renderCharacters()
    renderGraph()
    scheduleDraftSave()
  })

  // ---------- 关系图（拖动人物 / 拉线连关系） ----------

  let graphFrame = 0
  let graphDrag = null
  let graphConnect = null
  let graphEditor = null

  function scheduleGraphRender() {
    if (graphFrame) return
    graphFrame = requestAnimationFrame(() => {
      graphFrame = 0
      renderGraph()
    })
  }

  function ensurePositions() {
    const count = Math.max(state.characters.length, 1)
    state.characters.forEach((character, index) => {
      if (!character.pos) {
        const angle = (Math.PI * 2 * index) / count - Math.PI / 2
        character.pos = { x: 0.5 + Math.cos(angle) * 0.28, y: 0.5 + Math.sin(angle) * 0.28 }
      }
    })
  }

  function dropOrphanLinks() {
    const ids = new Set(state.characters.map((item) => item.id))
    state.links = state.links.filter(
      (link) => ids.has(link.from) && ids.has(link.to) && link.from !== link.to,
    )
  }

  function graphPoint(character) {
    const rect = els.relationGraph.getBoundingClientRect()
    return {
      x: character.pos.x * rect.width,
      y: character.pos.y * rect.height,
      rect,
    }
  }

  function closeGraphEditor() {
    if (graphEditor) {
      graphEditor.remove()
      graphEditor = null
    }
  }

  function openLinkEditor(link) {
    closeGraphEditor()
    graphEditor = document.createElement('div')
    graphEditor.className = 'graph-editor'

    const title = document.createElement('strong')
    title.textContent = '关系'

    const input = document.createElement('input')
    input.placeholder = '关系类型 / 描述，比如「青梅竹马」'
    input.maxLength = 200
    input.value = link.relation || ''

    const mirrorRow = document.createElement('label')
    mirrorRow.className = 'check-row'
    const mirror = document.createElement('input')
    mirror.type = 'checkbox'
    mirror.checked = link.mirror !== false
    const mirrorText = document.createElement('span')
    mirrorText.textContent = '双向（两边都记录这条关系）'
    mirrorRow.append(mirror, mirrorText)

    const actions = document.createElement('div')
    actions.className = 'graph-editor-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost mini'
    cancel.textContent = '取消'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'mini danger-mini'
    remove.textContent = '删除'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'mini primary'
    save.textContent = '保存'

    cancel.addEventListener('click', closeGraphEditor)
    remove.addEventListener('click', () => {
      state.links = state.links.filter((item) => item.id !== link.id)
      scheduleDraftSave()
      closeGraphEditor()
      renderGraph()
    })
    save.addEventListener('click', () => {
      const text = input.value.trim()
      if (!text) {
        toast('写一下是什么关系', 'error')
        return
      }
      link.relation = text
      link.mirror = mirror.checked
      scheduleDraftSave()
      closeGraphEditor()
      renderGraph()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click()
      if (event.key === 'Escape') closeGraphEditor()
    })

    actions.append(cancel, remove, save)
    graphEditor.append(title, input, mirrorRow, actions)
    graphEditor.style.left = '10px'
    graphEditor.style.top = '10px'
    els.relationGraph.append(graphEditor)
    setTimeout(() => input.focus(), 0)
  }

  function startDrag(character, event) {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    graphDrag = { character, rect: els.relationGraph.getBoundingClientRect() }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd, { once: true })
  }

  function onDragMove(event) {
    if (!graphDrag) return
    const rect = graphDrag.rect
    graphDrag.character.pos = {
      x: Math.min(0.94, Math.max(0.06, (event.clientX - rect.left) / rect.width)),
      y: Math.min(0.9, Math.max(0.1, (event.clientY - rect.top) / rect.height)),
    }
    scheduleGraphRender()
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove)
    graphDrag = null
    scheduleDraftSave()
    renderGraph()
  }

  function startConnect(character, event) {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const svg = els.relationGraph.querySelector('svg')
    const point = graphPoint(character)
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    temp.setAttribute('class', 'graph-temp')
    temp.setAttribute('x1', point.x)
    temp.setAttribute('y1', point.y)
    temp.setAttribute('x2', point.x)
    temp.setAttribute('y2', point.y)
    if (svg) svg.append(temp)
    graphConnect = { from: character.id, temp }
    window.addEventListener('pointermove', onConnectMove)
    window.addEventListener('pointerup', onConnectEnd, { once: true })
  }

  function onConnectMove(event) {
    if (!graphConnect || !graphConnect.temp) return
    const rect = els.relationGraph.getBoundingClientRect()
    graphConnect.temp.setAttribute('x2', event.clientX - rect.left)
    graphConnect.temp.setAttribute('y2', event.clientY - rect.top)
  }

  function onConnectEnd(event) {
    window.removeEventListener('pointermove', onConnectMove)
    const from = graphConnect
    graphConnect = null
    if (!from) return
    if (from.temp) from.temp.remove()
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const node = target && target.closest ? target.closest('.graph-node') : null
    const toId = node ? node.dataset.id : ''
    if (!toId || toId === from.from) {
      renderGraph()
      return
    }
    const existing = state.links.find(
      (link) => link.from === from.from && link.to === toId,
    )
    if (existing) {
      openLinkEditor(existing)
      return
    }
    const link = {
      id: 'l' + Math.random().toString(36).slice(2, 8),
      from: from.from,
      to: toId,
      relation: '',
      mirror: true,
    }
    state.links.push(link)
    renderGraph()
    openLinkEditor(link)
  }

  function renderGraph() {
    if (!els.relationGraph) return
    ensurePositions()
    dropOrphanLinks()
    const container = els.relationGraph
    const rect = container.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return
    container.textContent = ''

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'graph-svg')
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`)
    for (const link of state.links) {
      const from = state.characters.find((item) => item.id === link.from)
      const to = state.characters.find((item) => item.id === link.to)
      if (!from || !to) continue
      const a = graphPoint(from)
      const b = graphPoint(to)
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('class', 'graph-edge')
      line.setAttribute('x1', a.x)
      line.setAttribute('y1', a.y)
      line.setAttribute('x2', b.x)
      line.setAttribute('y2', b.y)
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('class', 'graph-edge-label')
      label.setAttribute('x', (a.x + b.x) / 2)
      label.setAttribute('y', (a.y + b.y) / 2 - 6)
      label.textContent = link.relation || '（点击写关系）'
      label.addEventListener('click', () => openLinkEditor(link))
      svg.append(line, label)
    }
    container.append(svg)

    for (const character of state.characters) {
      const node = document.createElement('div')
      node.className = 'graph-node'
      node.dataset.id = character.id
      node.style.left = `${character.pos.x * 100}%`
      node.style.top = `${character.pos.y * 100}%`

      const avatar = document.createElement('span')
      avatar.className = 'avatar'
      renderAvatarPreview(avatar, character)
      const name = document.createElement('span')
      name.className = 'graph-node-name'
      name.textContent = character.name.trim() || '未命名'
      const handle = document.createElement('span')
      handle.className = 'graph-handle'
      handle.textContent = '+'
      handle.title = '从这个圆点拉线到另一个人物'
      node.append(avatar, name, handle)

      node.addEventListener('pointerdown', (event) => startDrag(character, event))
      handle.addEventListener('pointerdown', (event) => startConnect(character, event))
      container.append(node)
    }
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleGraphRender()).observe(els.relationGraph)
  }

  els.assets.addEventListener('change', () => {
    state.assets = Array.from(els.assets.files || []).slice(0, 12)
    els.assetList.textContent =
      state.assets.length > 0
        ? state.assets.map((file) => file.name).join('、')
        : '会放进 zip 的 assets/ 目录，阶段 3 的舞台用。'
  })

  // ---------- 地图 ----------

  const DIRECTIONS = [
    ['northwest', '西北', 0.16, 0.2],
    ['north', '北', 0.5, 0.12],
    ['northeast', '东北', 0.84, 0.2],
    ['west', '西', 0.12, 0.5],
    ['center', '中心', 0.5, 0.5],
    ['east', '东', 0.88, 0.5],
    ['southwest', '西南', 0.16, 0.8],
    ['south', '南', 0.5, 0.88],
    ['southeast', '东南', 0.84, 0.8],
  ]

  function directionPoint(direction, index) {
    const found = DIRECTIONS.find((item) => item[0] === direction) || DIRECTIONS[4]
    const jitter = (index % 3) * 0.05
    return {
      x: Math.min(0.94, Math.max(0.06, found[2] + jitter)),
      y: Math.min(0.94, Math.max(0.06, found[3] + jitter)),
    }
  }

  function levelLocations() {
    const parent = state.viewParent || null
    return state.locations.filter((item) => (item.parent || null) === parent)
  }

  function locationPath(location) {
    const path = []
    let current = location
    while (current) {
      path.unshift(current)
      current = current.parent
        ? state.locations.find((item) => item.id === current.parent)
        : null
    }
    return path
  }

  function enterLocation(locationId) {
    const hasChild = state.locations.some((item) => (item.parent || null) === locationId)
    if (!hasChild) {
      toast('这个地点还没有下一级，先点「添加地点」', 'error')
      return
    }
    state.viewParent = locationId
    renderBreadcrumb()
    renderMap()
    renderLocations()
    renderRoutes()
  }

  /** 改父级：parentId 为空表示顶层；会防止挂到自己的子级下面 */
  function setParent(locationId, parentId) {
    const location = state.locations.find((item) => item.id === locationId)
    if (!location) return
    if (parentId === locationId) {
      toast('不能把地点挂到它自己下面', 'error')
      return
    }
    let cursor = parentId || null
    let guard = 0
    while (cursor && guard < 50) {
      if (cursor === locationId) {
        toast('不能挂到自己的子级下面', 'error')
        return
      }
      const parent = state.locations.find((item) => item.id === cursor)
      cursor = parent ? parent.parent : null
      guard += 1
    }
    location.parent = parentId || null
    renderLocations()
    renderRoutes()
    renderCharacters()
    renderMap()
    scheduleDraftSave()
  }

  let mapMenu = null

  function closeMapMenu() {
    if (mapMenu) {
      mapMenu.remove()
      mapMenu = null
    }
  }

  function openMapMenu(event, location) {
    event.preventDefault()
    closeMapMenu()
    const menu = document.createElement('div')
    menu.className = 'map-menu'
    const add = (label, handler, danger) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      if (danger) button.className = 'danger'
      button.addEventListener('click', () => {
        closeMapMenu()
        handler()
      })
      menu.append(button)
    }
    add('进入下一级', () => enterLocation(location.id))
    add('添加子地点', () => {
      state.viewParent = location.id
      addLocation()
    })
    add('把选中的地点挂到这里', () => {
      if (!state.selectedLocationId) {
        toast('先左键点一个地点，把它选中', 'error')
        return
      }
      setParent(state.selectedLocationId, location.id)
    })
    add('上移一级', () => {
      const parent = location.parent
        ? state.locations.find((item) => item.id === location.parent)
        : null
      setParent(location.id, parent ? parent.parent : null)
    })
    add('移到顶层', () => setParent(location.id, null))
    add('按方位重置位置', () => {
      location.pos = null
      renderMap()
      scheduleDraftSave()
    })
    add('删除', () => removeLocation(location.id), true)
    document.body.append(menu)
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 260)}px`
    mapMenu = menu
  }

  document.addEventListener('click', closeMapMenu)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMapMenu()
  })

  function renderBreadcrumb() {    els.mapBreadcrumb.textContent = ''
    const root = document.createElement('button')
    root.type = 'button'
    root.className = 'mini' + (state.viewParent ? '' : ' primary')
    root.textContent = '全国'
    root.addEventListener('click', () => {
      state.viewParent = null
      renderBreadcrumb()
      renderMap()
      renderLocations()
      renderRoutes()
    })
    els.mapBreadcrumb.append(root)
    const current = state.locations.find((item) => item.id === state.viewParent)
    if (!current) return
    for (const location of locationPath(current)) {
      const sep = document.createElement('span')
      sep.className = 'muted'
      sep.textContent = '/'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini' + (location.id === state.viewParent ? ' primary' : '')
      button.textContent = location.name || '未命名'
      button.addEventListener('click', () => {
        state.viewParent = location.id
        renderBreadcrumb()
        renderMap()
        renderLocations()
        renderRoutes()
      })
      els.mapBreadcrumb.append(sep, button)
    }
  }

  function addLocation() {
    state.locations.push({
      id: 'loc' + Math.random().toString(36).slice(2, 7),
      name: '',
      description: '',
      direction: 'center',
      parent: state.viewParent || null,
    })
    renderLocations()
    renderRoutes()
    renderCharacters()
    renderMap()
    scheduleDraftSave()
  }

  function removeLocation(locationId) {
    const remove = new Set([locationId])
    let changed = true
    while (changed) {
      changed = false
      for (const location of state.locations) {
        if (location.parent && remove.has(location.parent) && !remove.has(location.id)) {
          remove.add(location.id)
          changed = true
        }
      }
    }
    state.locations = state.locations.filter((item) => !remove.has(item.id))
    state.routes = state.routes.filter(
      (route) => !remove.has(route.from) && !remove.has(route.to),
    )
    renderLocations()
    renderRoutes()
    renderCharacters()
    renderMap()
    renderBreadcrumb()
    scheduleDraftSave()
  }

  function renderLocations() {
    els.locationList.textContent = ''
    levelLocations().forEach((location) => {
      const row = document.createElement('div')
      row.className = 'location-row'

      const name = document.createElement('input')
      name.placeholder = '地点名，比如 电影院'
      name.maxLength = 40
      name.value = location.name
      name.addEventListener('input', () => {
        location.name = name.value
        scheduleDraftSave()
      })
      name.addEventListener('change', () => {
        renderCharacters()
        renderRoutes()
        renderMap()
      })

      const direction = document.createElement('select')
      for (const [value, label] of DIRECTIONS.map((item) => [item[0], item[1]])) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        direction.append(option)
      }
      direction.value = location.direction
      direction.addEventListener('change', () => {
        location.direction = direction.value
        location.pos = null
        renderMap()
        scheduleDraftSave()
      })

      const description = document.createElement('input')
      description.placeholder = '描述（可选）'
      description.maxLength = 120
      description.value = location.description
      description.addEventListener('input', () => {
        location.description = description.value
        scheduleDraftSave()
      })

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'mini danger-mini'
      remove.textContent = '删除'
      remove.addEventListener('click', () => removeLocation(location.id))

      row.append(name, direction, description, remove)
      els.locationList.append(row)
    })
  }

  function addRoute() {
    const locations = levelLocations()
    if (locations.length < 2) {
      toast('当前层级至少要有两个地点才能加关系', 'error')
      return
    }
    state.routes.push({
      id: 'route' + Math.random().toString(36).slice(2, 7),
      from: locations[0].id,
      to: locations[1].id,
      label: '',
    })
    renderRoutes()
    renderMap()
    scheduleDraftSave()
  }

  function renderRoutes() {
    els.routeList.textContent = ''
    const locations = levelLocations()
    const ids = new Set(locations.map((item) => item.id))
    state.routes
      .filter((route) => ids.has(route.from) && ids.has(route.to))
      .forEach((route) => {
      const row = document.createElement('div')
      row.className = 'location-row'

      const makeSelect = (selected) => {
        const select = document.createElement('select')
        for (const location of locations) {
          const option = document.createElement('option')
          option.value = location.id
          option.textContent = location.name || '未命名地点'
          if (location.id === selected) option.selected = true
          select.append(option)
        }
        return select
      }

      const from = makeSelect(route.from)
      from.addEventListener('change', () => {
        route.from = from.value
        renderMap()
        scheduleDraftSave()
      })
      const arrow = document.createElement('span')
      arrow.className = 'muted'
      arrow.textContent = '→'
      const to = makeSelect(route.to)
      to.addEventListener('change', () => {
        route.to = to.value
        renderMap()
        scheduleDraftSave()
      })

      const label = document.createElement('input')
      label.placeholder = '关系，比如 步行 10 分钟 / 相邻'
      label.maxLength = 60
      label.value = route.label
      label.addEventListener('input', () => {
        route.label = label.value
        renderMap()
        scheduleDraftSave()
      })

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'mini danger-mini'
      remove.textContent = '删除'
      remove.addEventListener('click', () => {
        state.routes = state.routes.filter((item) => item.id !== route.id)
        renderRoutes()
        renderMap()
        scheduleDraftSave()
      })

      row.append(from, arrow, to, label, remove)
      els.routeList.append(row)
    })
  }

  function renderMap() {
    renderBreadcrumb()
    const container = els.mapCanvas
    container.textContent = ''
    const locations = levelLocations()
    for (const [text, className] of [
      ['北', 'n'],
      ['东', 'e'],
      ['南', 's'],
      ['西', 'w'],
    ]) {
      const span = document.createElement('span')
      span.className = 'compass ' + className
      span.textContent = text
      container.append(span)
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'map-svg')
    svg.setAttribute('viewBox', '0 0 100 100')
    svg.setAttribute('preserveAspectRatio', 'none')
    const points = new Map()
    const counters = new Map()
    for (const location of locations) {
      if (location.pos && Number.isFinite(location.pos.x) && Number.isFinite(location.pos.y)) {
        points.set(location.id, {
          x: Math.min(0.94, Math.max(0.06, location.pos.x)),
          y: Math.min(0.94, Math.max(0.06, location.pos.y)),
        })
        continue
      }
      const index = counters.get(location.direction) || 0
      counters.set(location.direction, index + 1)
      points.set(location.id, directionPoint(location.direction, index))
    }
    for (const route of state.routes) {
      const a = points.get(route.from)
      const b = points.get(route.to)
      if (!a || !b) continue
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('class', 'map-edge')
      line.setAttribute('x1', a.x * 100)
      line.setAttribute('y1', a.y * 100)
      line.setAttribute('x2', b.x * 100)
      line.setAttribute('y2', b.y * 100)
      svg.append(line)
      if (route.label) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        text.setAttribute('class', 'map-edge-label')
        text.setAttribute('x', ((a.x + b.x) / 2) * 100)
        text.setAttribute('y', ((a.y + b.y) / 2) * 100 - 2)
        text.textContent = route.label
        svg.append(text)
      }
    }
    container.append(svg)
    for (const location of locations) {
      const point = points.get(location.id)
      const node = document.createElement('span')
      node.className = 'map-node'
      node.style.left = `${point.x * 100}%`
      node.style.top = `${point.y * 100}%`
      node.textContent = location.name || '未命名'
      node.title = '拖动摆位置 · 左键选中 · 右键菜单 · 双击进入下一级'
      node.classList.toggle('selected', state.selectedLocationId === location.id)
      node.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const rect = container.getBoundingClientRect()
        const start = { x: event.clientX, y: event.clientY, moved: false }
        const onMove = (ev) => {
          if (!start.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return
          start.moved = true
          location.pos = {
            x: Math.min(0.94, Math.max(0.06, (ev.clientX - rect.left) / rect.width)),
            y: Math.min(0.94, Math.max(0.06, (ev.clientY - rect.top) / rect.height)),
          }
          renderMap()
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (start.moved) scheduleDraftSave()
          else {
            state.selectedLocationId = location.id
            renderMap()
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      node.addEventListener('contextmenu', (event) => {
        state.selectedLocationId = location.id
        renderMap()
        openMapMenu(event, location)
      })
      node.addEventListener('dblclick', () => enterLocation(location.id))
      container.append(node)
    }
  }

  els.addLocation.addEventListener('click', addLocation)
  els.addRoute.addEventListener('click', addRoute)

  // ---------- 打包 ----------

  const encoder = new TextEncoder()

  async function buildFiles() {
    const name = els.packName.value.trim()
    if (!name) throw new Error('先填一个包名')
    const characters = state.characters.filter((character) => character.name.trim() !== '')
    if (characters.length === 0) throw new Error('至少给一个人物填上名字')

    const files = []
    const characterPaths = []
    for (const [index, character] of characters.entries()) {
      const path = `characters/${index + 1}.json`
      const card = {
        id: character.id,
        name: character.name.trim(),
        emoji: character.emoji.trim() || '🙂',
        gender: character.gender || '',
        playedBy: character.playedBy || 'ai',
        playerBrief: character.playerBrief.trim(),
        likes: character.likes.trim(),
        favoritePlaces: Array.isArray(character.favoritePlaces) ? character.favoritePlaces : [],
        description: character.description.trim(),
        personality: character.personality.trim(),
        scenario: character.scenario.trim(),
        first_mes: character.firstMes.trim(),
        mes_example: character.mesExample.trim(),
        system_prompt: '',
        rules: character.rules.trim(),
        behavior: character.behavior.trim(),
      }
      if (character.avatar) card.avatar = character.avatar
      // 关系来自关系图：出边，或双向边的入边
      const relations = state.links
        .filter((link) => link.relation && link.relation.trim() !== '')
        .filter(
          (link) =>
            link.from === character.id || (link.mirror !== false && link.to === character.id),
        )
        .map((link) => {
          const otherId = link.from === character.id ? link.to : link.from
          const other = characters.find((item) => item.id === otherId)
          return {
            target: otherId,
            name: other ? other.name.trim() : '',
            relation: link.relation.trim().slice(0, 200),
          }
        })
      if (relations.length > 0) card.relations = relations
      files.push({ name: path, data: encoder.encode(JSON.stringify(card, null, 2)) })
      characterPaths.push(path)
    }

    files.push({ name: 'scenario.md', data: encoder.encode(els.scenario.value.trim()) })

    const assetPaths = []
    for (const file of state.assets) {
      const safe = file.name.replace(/[\\/]/g, '_').replace(/^\.+/, '_')
      const path = `assets/${safe}`
      files.push({ name: path, data: new Uint8Array(await file.arrayBuffer()) })
      assetPaths.push(path)
    }

    const meta = {
      format: 'dsh-galgame-pack',
      formatVersion: 1,
      name,
      version: els.packVersion.value.trim() || '1.0.0',
      mode: els.packMode.value || 'roleplay',
      intro: els.packIntro.value.trim(),
      recommendedPlayers: els.singlePlayer.checked
        ? { min: 1, max: 1 }
        : {
            min: Number(els.playersMin.value) || 2,
            max: Number(els.playersMax.value) || 4,
          },
      author: els.packAuthor.value.trim() || '喵诺澪染',
      generator: 'dsh-galgame-room · B站：喵诺澪染',
      brand: 'B站：喵诺澪染',
      description: els.packDesc.value.trim(),
      scenario: 'scenario.md',
      characters: characterPaths,
      assets: assetPaths,
      map: {
        locations: state.locations.map(({ id, name, description, direction, parent, pos }) => ({
          id,
          name: name.trim(),
          description: description.trim(),
          direction,
          parent: parent || null,
          pos: pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y } : null,
        })),
        routes: state.routes.map(({ from, to, label }) => ({
          from,
          to,
          label: label.trim(),
        })),
      },
    }
    files.push({ name: 'pack.json', data: encoder.encode(JSON.stringify(meta, null, 2)) })
    return { meta, files }
  }

  async function download() {
    els.download.disabled = true
    try {
      const { meta, files } = await buildFiles()
      const blob = zipStore(files)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${meta.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      els.status.textContent = `已生成 ${files.length} 个文件（${Math.round(blob.size / 1024)} KB）`
      toast('已下载 .zip')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.download.disabled = false
    }
  }

  async function install() {
    els.install.disabled = true
    try {
      const { meta, files } = await buildFiles()
      const blob = zipStore(files)
      const response = await fetch('/api/packs', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: blob,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '安装失败')
      els.status.textContent = `已装进本机：${data.pack.name}（${data.pack.characters.length} 人）→ 回开房页在「角色」里选它`
      toast('已装进本机')
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      els.install.disabled = false
    }
  }

  els.download.addEventListener('click', download)
  els.install.addEventListener('click', install)
  els.saveDraft.addEventListener('click', saveDraftNow)
  els.clearDraft.addEventListener('click', () => {
    if (typeof window.showConfirm === 'function') {
      window
        .showConfirm({
          title: '清除草稿',
          message: '清除后无法恢复，确定吗？',
          okText: '清除',
          danger: true,
        })
        .then((ok) => {
          if (ok) dropDraft()
        })
    } else {
      dropDraft()
    }
  })
  window.addEventListener('beforeunload', saveDraftNow)

  // ---------- 零依赖 zip（stored，不压缩） ----------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    return table
  })()

  function crc32(bytes) {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  function zipStore(files) {
    const chunks = []
    const central = []
    let offset = 0

    for (const file of files) {
      const nameBytes = encoder.encode(file.name)
      const data = file.data
      const crc = crc32(data)

      const local = new Uint8Array(30 + nameBytes.length)
      const view = new DataView(local.buffer)
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 0x0800, true) // UTF-8 文件名
      view.setUint16(8, 0, true) // stored
      view.setUint16(10, 0, true)
      view.setUint16(12, 0x21, true)
      view.setUint32(14, crc, true)
      view.setUint32(18, data.length, true)
      view.setUint32(22, data.length, true)
      view.setUint16(26, nameBytes.length, true)
      view.setUint16(28, 0, true)
      local.set(nameBytes, 30)

      chunks.push(local, data)
      central.push({ nameBytes, crc, size: data.length, offset })
      offset += local.length + data.length
    }

    const centralStart = offset
    let centralSize = 0
    for (const entry of central) {
      const header = new Uint8Array(46 + entry.nameBytes.length)
      const view = new DataView(header.buffer)
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(8, 0x0800, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint16(14, 0x21, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, entry.size, true)
      view.setUint32(24, entry.size, true)
      view.setUint16(28, entry.nameBytes.length, true)
      view.setUint16(30, 0, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, entry.offset, true)
      header.set(entry.nameBytes, 46)
      chunks.push(header)
      centralSize += header.length
    }

    const eocd = new Uint8Array(22)
    const view = new DataView(eocd.buffer)
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, central.length, true)
    view.setUint16(10, central.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, centralStart, true)
    chunks.push(eocd)

    return new Blob(chunks, { type: 'application/zip' })
  }

  if (!restoreDraft()) {
    renderCharacters()
    renderLocations()
    renderRoutes()
    renderMap()
    // 图容器要先有尺寸：等一帧再画，避免 0 宽
    setTimeout(() => renderGraph(), 0)
  }
})()
