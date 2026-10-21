/**
 * dsh-galgame-room —— 浏览器半侧（阶段 2.5）。
 *
 * 在会话视图最右边加一个「联机模式」标签（chat=0、轨迹=10、galgame=20、本插件=30），
 * 内容直接嵌房间服务托管的网页（默认 http://127.0.0.1:7302/）：
 *   - 开房页 → 建房 → 以 GM 进房间
 *   - 朋友拿邀请链接在浏览器里进同一个房间
 * 房间页自带完整的消息流 / 参与者 / 房主控制条，这里不需要再实现一遍 UI。
 *
 * 写法对齐 @lanxing/dsh-galgame：DSH 的 client 模块由 window.__ModuleLoader__ 加载，
 * 通过 factory 注入的 require 拿到 shell 提供的 react，不参与 npm 打包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-galgame-room',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')

    /** 兜底地址：宿主配置路由拿不到端口时用它（与插件默认值一致）。 */
    const FALLBACK_ORIGIN = 'http://127.0.0.1:7302'

    /**
     * 从 DSH 宿主读本机房间端口与插件版本；
     * 换端口后这里也能跟上，版本用于连接别人房间时先比对。
     */
    function useLocalInfo() {
      const [info, setInfo] = react.useState({ origin: FALLBACK_ORIGIN, version: '' })
      react.useEffect(() => {
        let alive = true
        fetch('/api/galgame-room/config', { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!alive || !data) return
            const port = Number(data.port)
            const origin =
              Number.isInteger(port) && port >= 1024 && port <= 65535
                ? `http://127.0.0.1:${port}`
                : FALLBACK_ORIGIN
            setInfo({ origin, version: String(data.version || '') })
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return info
    }

    const containerStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      gap: '8px',
    }

    const frameStyle = {
      flex: '1 1 auto',
      width: '100%',
      height: '100%',
      minHeight: 0,
      border: '0',
      borderRadius: '12px',
      background: 'transparent',
      colorScheme: 'dark',
    }

    const barStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      fontSize: '12px',
      padding: '6px 8px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.07)',
      background: 'rgba(0,0,0,0.18)',
    }

    const barButtonStyle = {
      padding: '6px 12px',
      border: '1px solid rgba(242,184,128,0.4)',
      borderRadius: '8px',
      background: 'rgba(242,184,128,0.14)',
      color: '#ffd9a3',
      cursor: 'pointer',
      fontSize: '12px',
    }

    const hintStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      fontSize: '12px',
      opacity: '0.75',
      padding: '0 4px',
    }

    /** 本机房间页地址；带上 ?v= 让页面知道本机插件版本、?sid= 带上当前 DSH 会话 id */
    function withVersion(origin, version, sessionId) {
      const base = String(origin || FALLBACK_ORIGIN).replace(/\/+$/, '')
      const params = []
      if (version) params.push('v=' + encodeURIComponent(version))
      if (sessionId) params.push('sid=' + encodeURIComponent(sessionId))
      return params.length > 0 ? `${base}/?${params.join('&')}` : `${base}/`
    }

    /**
     * 视图根组件：嵌本机房间页。加入别人的房间统一走页面里的「加入房间」，
     * 这里只负责把本机版本/会话 id 带进 iframe 和「回本机」。
     * 房间内容始终由**房主的机器**提供，玩家这边只是显示。
     */
    function RoomView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const local = useLocalInfo()
      const [frameSrc, setFrameSrc] = react.useState(withVersion(FALLBACK_ORIGIN, '', ''))

      react.useEffect(() => {
        setFrameSrc(withVersion(local.origin, local.version, sessionId))
      }, [local.origin, local.version, sessionId])

      return react.createElement(
        'div',
        { style: containerStyle, 'data-testid': 'galgame-room-view' },
        react.createElement(
          'div',
          { style: barStyle },
          react.createElement(
            'span',
            { style: { opacity: 0.75 } },
            local.version ? '本机 v' + local.version : '本机版本未知',
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setFrameSrc(withVersion(local.origin, local.version, sessionId)),
              style: barButtonStyle,
            },
            '回本机',
          ),
          react.createElement(
            'span',
            { style: { opacity: 0.6 } },
            '加入别人的房间：在页面「加入房间」里粘贴房主的邀请链接（会自动校验版本）。',
          ),
        ),
        react.createElement('iframe', {
          src: frameSrc,
          style: frameStyle,
          title: '联机 Galgame 房间',
          allow: 'clipboard-write',
        }),
        react.createElement(
          'div',
          { style: hintStyle },
          react.createElement('span', null, '默认显示本机房间；加入对方房间后，显示的是对方主机上的内容。 · 由 B站：喵诺澪染 制作'),
          react.createElement(
            'a',
            { href: local.origin + '/', target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } },
            '在新窗口打开',
          ),
        ),
      )
    }

    /**
     * 注册会话视图标签。slots.inject 会等 conversation.view 槽位就绪再挂；
     * 返回的 disposer 由 slots 管理，插件卸载时标签自动移除。
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'galgame-room',
            order: 30,
            label: () => '联机模式',
            // 把当前会话 id 交给视图：建房时作为房间绑定的会话，玩家本地副本按它比对
            inject: (sessionId) => ({ sessionId }),
          },
          RoomView,
        ),
      )
    }

    // cordis 服务级注入：slots 提供视图标签注册能力（缺了会被拒绝访问）
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
