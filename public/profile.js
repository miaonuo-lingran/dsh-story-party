/* 联机 Galgame · 个人资料：昵称 + 头像，存在本机浏览器，开房/进房时自动带上 */
(() => {
  'use strict'

  try {
    if (window.self !== window.top) document.documentElement.classList.add('embed')
  } catch {
    document.documentElement.classList.add('embed')
  }

  const $ = (id) => document.getElementById(id)
  const KEY = 'galgame-room:profile'

  const els = {
    avatar: $('profile-avatar'),
    pick: $('profile-pick'),
    clear: $('profile-clear'),
    file: $('profile-file'),
    name: $('profile-name'),
    previewAvatar: $('preview-avatar'),
    previewName: $('preview-name'),
    save: $('profile-save'),
    status: $('profile-status'),
  }

  const state = {
    name: '',
    avatar: '',
  }

  function setStatus(text, error) {
    els.status.textContent = text || ''
    els.status.className = 'muted small' + (error ? ' error' : '')
  }

  function renderAvatar(node, avatar) {
    node.textContent = ''
    if (typeof avatar === 'string' && avatar.startsWith('data:image/')) {
      const image = document.createElement('img')
      image.src = avatar
      image.alt = ''
      node.append(image)
      return
    }
    node.textContent = '👤'
  }

  function render() {
    renderAvatar(els.avatar, state.avatar)
    renderAvatar(els.previewAvatar, state.avatar)
    els.previewName.textContent = state.name.trim() || '你的昵称'
  }

  function readProfile() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || 'null')
      if (!parsed || typeof parsed !== 'object') return null
      return {
        name: typeof parsed.name === 'string' ? parsed.name.slice(0, 16) : '',
        avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
      }
    } catch {
      return null
    }
  }

  function writeProfile(name, avatar) {
    const data = { name: name.slice(0, 16), avatar, updatedAt: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(data))
    return data
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

  async function onFile(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    if (!/^image\//.test(file.type)) {
      setStatus('选一张图片', true)
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus('图片太大了（> 8MB）', true)
      return
    }
    try {
      state.avatar = await resizeImage(file, 128)
      render()
      setStatus('头像已选好，记得点保存')
    } catch (error) {
      setStatus(error.message, true)
    }
  }

  function save() {
    const name = els.name.value.trim()
    if (!name) {
      setStatus('先起个昵称吧', true)
      els.name.focus()
      return
    }
    try {
      const data = writeProfile(name, state.avatar)
      state.name = data.name
      state.avatar = data.avatar
      els.name.value = data.name
      render()
      setStatus('已保存；回开房页就能直接用这个昵称和头像。')
    } catch {
      setStatus('浏览器存储不可用，可能是无痕模式', true)
    }
  }

  const profile = readProfile()
  if (profile) {
    state.name = profile.name
    state.avatar = profile.avatar
    els.name.value = profile.name
  }
  render()
  setStatus(
    profile && (profile.name || profile.avatar)
      ? '这是这台浏览器上次保存的资料。'
      : '资料只存在这台浏览器，不会上传到房主机器。',
  )

  els.pick.addEventListener('click', () => els.file.click())
  els.file.addEventListener('change', onFile)
  els.clear.addEventListener('click', () => {
    state.avatar = ''
    render()
    setStatus('头像已移除，记得点保存')
  })
  els.name.addEventListener('input', () => {
    state.name = els.name.value
    render()
  })
  els.save.addEventListener('click', save)
})()
