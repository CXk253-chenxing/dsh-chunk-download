window.__ModuleLoader__.load({
  id: 'dsh-chunk-download',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /**
     * dsh-chunk-download —— 浏览器半身。
     *
     * 设计目标：把"下载在跑"这件事做得**安静但随时看得见**。
     *  - 会话标题栏（手机 / 桌面通用）：一枚进度胶囊，平时只有百分比与细进度环；
     *  - 桌面侧边栏底部：一行任务摘要 + 迷你进度条；
     *  - 点任意一处 → 浮动面板：任务列表、速度、剩余时间、暂停/取消。
     *
     * 视觉规则（与 DSH 主题对齐）：单一强调色 = brand primary；状态色只用 success / warn / error；
     * 数字用 tabular-nums；所有图标为内联 SVG，不用 emoji；动效 180ms 且尊重 reduced-motion。
     * 数据来自 Host 半身注册的同源接口：GET /chunk-download/tasks、POST /chunk-download/control。
     */

    const React = require('react')
    const h = React.createElement

    const API_TASKS = '/chunk-download/tasks'
    const API_CONTROL = '/chunk-download/control'
    const POLL_ACTIVE_MS = 1000
    const POLL_IDLE_MS = 4000

    // ---------------------------------------------------------------- 展示工具

    function fmtBytes(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      if (n < 1024) return n + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = n / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
      return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
    }

    function fmtSpeed(bytesPerSecond) {
      const n = Number(bytesPerSecond)
      if (!Number.isFinite(n) || n <= 0) return '0 B/s'
      return fmtBytes(n) + '/s'
    }

    function fmtEta(seconds) {
      const n = Number(seconds)
      if (!Number.isFinite(n) || n <= 0) return ''
      const s = Math.round(n)
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'
      return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
    }

    function ratioOf(task) {
      if (typeof task.progress === 'number' && Number.isFinite(task.progress)) return Math.max(0, Math.min(1, task.progress))
      if (task.total > 0) return Math.max(0, Math.min(1, task.downloaded / task.total))
      return 0
    }

    function pctText(task) {
      const r = ratioOf(task)
      if (task.status === 'completed') return '100%'
      if (!(task.total > 0)) return fmtBytes(task.downloaded)
      return (r * 100).toFixed(1) + '%'
    }

    const STATUS_TEXT = {
      downloading: '下载中',
      queued: '排队中',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      canceled: '已取消',
    }

    const ACTIVE = { downloading: 1, queued: 1, paused: 1 }
    const ORDER = { downloading: 0, queued: 1, paused: 2, failed: 3, completed: 4, canceled: 5 }

    // ---------------------------------------------------------------- 状态仓库

    function createStore() {
      let state = { data: null, error: null, open: false }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = Object.assign({}, state, patch)
          listeners.forEach((fn) => { try { fn() } catch {} })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    }

    const store = createStore()

    function useStore() {
      const [snap, setSnap] = React.useState(store.get())
      React.useEffect(() => store.subscribe(() => setSnap(store.get())), [])
      return snap
    }

    // ---------------------------------------------------------------- 轮询

    let pollTimer = null
    let pollRefs = 0
    let inFlight = false

    function activeCount(data) {
      const summary = data && data.summary
      if (!summary) return 0
      return (summary.downloading || 0) + (summary.queued || 0)
    }

    async function loadOnce() {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(API_TASKS, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        store.set({ data: await res.json(), error: null })
      } catch (error) {
        store.set({ error: error && error.message ? error.message : String(error) })
      } finally {
        inFlight = false
      }
    }

    function loop() {
      if (pollRefs <= 0) return
      const hidden = typeof document !== 'undefined' && document.hidden
      if (hidden) {
        pollTimer = setTimeout(loop, POLL_IDLE_MS)
        return
      }
      loadOnce().finally(() => {
        if (pollRefs <= 0) return
        pollTimer = setTimeout(loop, activeCount(store.get().data) > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS)
      })
    }

    function usePolling() {
      React.useEffect(() => {
        pollRefs += 1
        if (pollRefs === 1) loop()
        return () => {
          pollRefs -= 1
          if (pollRefs <= 0 && pollTimer) {
            clearTimeout(pollTimer)
            pollTimer = null
          }
        }
      }, [])
    }

    async function control(action, id) {
      try {
        await fetch(API_CONTROL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action }),
          signal: AbortSignal.timeout(8000),
        })
        await loadOnce()
      } catch {}
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
.cdl-scope { font-family: var(--dsw-font-family, inherit); color: var(--dsw-alias-label-primary); }
.cdl-scope * { box-sizing: border-box; }

/* ---- 会话标题栏胶囊 ---- */
.cdl-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; margin-right: 4px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1; cursor: pointer; user-select: none;
  transition: background 180ms ease, border-color 180ms ease;
}
.cdl-chip:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.cdl-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cdl-chip-pct { font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: .01em; }
.cdl-chip-speed { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
@media (max-width: 520px) { .cdl-chip-speed { display: none; } }

/* ---- 侧边栏底部行 ---- */
.cdl-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; text-align: left;
}
.cdl-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cdl-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.cdl-row-label { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdl-row-meta { margin-left: auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ---- 进度条 ---- */
.cdl-bar { position: relative; flex: 1 1 auto; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.cdl-bar > i { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--cdl-accent, var(--dsw-alias-brand-primary)); transition: width 180ms ease-out; }
@media (prefers-reduced-motion: reduce) { .cdl-bar > i { transition: none; } }

/* ---- 浮动面板 ---- */
.cdl-panel {
  position: fixed; z-index: 80; left: 12px; bottom: 76px;
  width: min(380px, calc(100vw - 24px)); max-height: min(70vh, 560px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px; box-shadow: var(--dsw-shadow-lv2);
}
.cdl-panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.cdl-panel-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.cdl-panel-count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cdl-panel-head-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.cdl-textbtn {
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 11px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.cdl-textbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.cdl-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.cdl-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.cdl-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cdl-list { overflow: auto; padding: 6px; }
.cdl-item { padding: 10px; border-radius: 10px; }
.cdl-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cdl-item-top { display: flex; align-items: center; gap: 8px; }
.cdl-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.cdl-name { flex: 1 1 auto; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdl-item-actions { display: flex; gap: 2px; flex: none; }
.cdl-item-meta { margin: 6px 0 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cdl-item-meta .cdl-sep { opacity: .45; }
.cdl-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cdl-empty-icon { display: block; margin: 0 auto 10px; opacity: .5; }
.cdl-mask { position: fixed; inset: 0; z-index: 79; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35)); }

@media (max-width: 860px) {
  .cdl-panel { left: 0; right: 0; bottom: 0; width: auto; max-height: 72vh; border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); box-shadow: var(--dsw-shadow-lv3); }
  .cdl-iconbtn { width: 40px; height: 40px; }
  .cdl-textbtn { padding: 10px 10px; }
  .cdl-item { padding: 12px 10px; }
}
`

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('cdl-style')) return
      const tag = document.createElement('style')
      tag.id = 'cdl-style'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------- 图标（内联 SVG）

    function Svg(props) {
      return h('svg', {
        width: props.size || 16,
        height: props.size || 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.strokeWidth || 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: props.style,
      }, props.children)
    }

    function IconDownload(props) {
      return h(Svg, props,
        h('path', { d: 'M8 2v7.5' }),
        h('path', { d: 'M4.8 6.6L8 9.8l3.2-3.2' }),
        h('path', { d: 'M3 13h10' }))
    }

    function IconPause(props) {
      return h(Svg, props,
        h('path', { d: 'M6 3.5v9' }),
        h('path', { d: 'M10 3.5v9' }))
    }

    function IconPlay(props) {
      return h(Svg, props, h('path', { d: 'M5.5 3.4l7 4.6-7 4.6z', fill: 'currentColor', stroke: 'none' }))
    }

    function IconClose(props) {
      return h(Svg, props,
        h('path', { d: 'M4 4l8 8' }),
        h('path', { d: 'M12 4l-8 8' }))
    }

    function IconCheck(props) {
      return h(Svg, props, h('path', { d: 'M3.5 8.4l3 3 6-6.4' }))
    }

    /** 标题栏里的环形进度：小、克制、只在有任务时出现。 */
    function Ring(props) {
      const r = 6
      const c = 2 * Math.PI * r
      const p = Math.max(0, Math.min(1, props.ratio || 0))
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: r, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 2 }),
        h('circle', {
          cx: 8, cy: 8, r: r, fill: 'none',
          stroke: 'var(--cdl-accent, var(--dsw-alias-brand-primary))',
          strokeWidth: 2, strokeLinecap: 'round',
          strokeDasharray: c, strokeDashoffset: c * (1 - p),
          transform: 'rotate(-90 8 8)',
          style: { transition: 'stroke-dashoffset 180ms ease-out' },
        }))
    }

    function accentOf(status) {
      if (status === 'completed') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'failed') return 'var(--dsw-alias-state-error-primary)'
      if (status === 'paused') return 'var(--dsw-alias-state-warn-primary)'
      if (status === 'queued') return 'var(--dsw-alias-state-idle-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    // ---------------------------------------------------------------- 组件

    function currentTask(data) {
      const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
      const running = tasks.filter((t) => t.status === 'downloading')
      if (running.length > 0) return running[0]
      const queued = tasks.filter((t) => t.status === 'queued')
      return queued[0] || null
    }

    /** 会话标题栏胶囊：手机与桌面都在这里，安静地显示"正在下什么、到哪了"。 */
    function HeaderChip() {
      usePolling()
      const s = useStore()
      const data = s.data
      const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
      const unfinished = tasks.filter((t) => ACTIVE[t.status])
      if (unfinished.length === 0) return null
      const task = currentTask(data) || unfinished[0]
      const ratio = ratioOf(task)
      const extra = unfinished.length > 1 ? ` +${unfinished.length - 1}` : ''
      return h('button', {
        type: 'button',
        className: 'cdl-scope cdl-chip',
        title: `${task.filename} · ${STATUS_TEXT[task.status] || task.status}${extra}`,
        'aria-label': `下载任务 ${unfinished.length} 个，${task.filename} ${pctText(task)}`,
        onClick: () => store.set({ open: !store.get().open }),
      },
        h(Ring, { ratio: ratio }),
        h('span', { className: 'cdl-chip-pct' }, unfinished.length > 1 ? `${unfinished.length} 个` : pctText(task)),
        unfinished.length === 1 && task.status === 'downloading'
          ? h('span', { className: 'cdl-chip-speed' }, fmtSpeed(task.speed))
          : null)
    }

    /** 桌面侧边栏底部：一行摘要 + 迷你进度条。 */
    function SidebarRow() {
      usePolling()
      const s = useStore()
      const tasks = s.data && Array.isArray(s.data.tasks) ? s.data.tasks : []
      const unfinished = tasks.filter((t) => ACTIVE[t.status])
      if (tasks.length === 0) return null
      const task = currentTask(s.data) || unfinished[0] || tasks[0]
      const ratio = task ? ratioOf(task) : 0
      const label = unfinished.length > 0
        ? `下载 · ${unfinished.length} 个任务`
        : `下载 · 已完成 ${s.data.summary.completed || 0}`
      return h('button', {
        type: 'button',
        className: 'cdl-scope cdl-row',
        onClick: () => store.set({ open: !store.get().open }),
        'aria-label': '打开下载面板',
      },
        h(IconDownload, { size: 14 }),
        h('span', { className: 'cdl-row-label' }, label),
        unfinished.length > 0
          ? h('span', { className: 'cdl-bar', style: { maxWidth: 56 } }, h('i', { style: { width: `${ratio * 100}%`, background: accentOf(task.status) } }))
          : null,
        h('span', { className: 'cdl-row-meta' }, task ? pctText(task) : ''))
    }

    function TaskItem(props) {
      const task = props.task
      const ratio = ratioOf(task)
      const running = task.status === 'downloading'
      const accent = accentOf(task.status)
      const meta = []
      if (task.total > 0) meta.push(`${fmtBytes(task.downloaded)} / ${fmtBytes(task.total)}`)
      else meta.push(fmtBytes(task.downloaded))
      if (running) {
        meta.push(fmtSpeed(task.speed))
        const eta = fmtEta(task.etaSeconds)
        if (eta) meta.push(`剩余 ${eta}`)
      } else if (task.status === 'failed' && task.error) {
        meta.push(String(task.error).slice(0, 60))
      } else if (task.status === 'completed' && task.verification) {
        meta.push(task.verification.ok ? '校验通过' : '校验失败')
      }
      return h('div', { className: 'cdl-item' },
        h('div', { className: 'cdl-item-top' },
          h('span', { className: 'cdl-dot', style: { background: accent } }),
          h('span', { className: 'cdl-name', title: task.path || task.url }, task.filename || task.url),
          h('div', { className: 'cdl-item-actions' },
            running
              ? h('button', { type: 'button', className: 'cdl-iconbtn', title: '暂停', 'aria-label': '暂停', onClick: () => control('pause', task.id) }, h(IconPause, { size: 14 }))
              : (task.status === 'paused' || task.status === 'failed')
                ? h('button', { type: 'button', className: 'cdl-iconbtn', title: '继续', 'aria-label': '继续', onClick: () => control('resume', task.id) }, h(IconPlay, { size: 14 }))
                : null,
            (task.status === 'downloading' || task.status === 'queued' || task.status === 'paused')
              ? h('button', { type: 'button', className: 'cdl-iconbtn', title: '取消', 'aria-label': '取消', onClick: () => control('cancel', task.id) }, h(IconClose, { size: 14 }))
              : null)),
        h('div', { className: 'cdl-item-meta' },
          h('span', null, pctText(task)),
          meta.map((text, index) => h(React.Fragment, { key: index },
            h('span', { className: 'cdl-sep' }, '·'),
            h('span', null, text)))),
        h('div', { className: 'cdl-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ratio * 100) },
          h('i', { style: { width: `${ratio * 100}%`, background: accent } })))
    }

    function Panel() {
      const s = useStore()
      const tasks = (s.data && Array.isArray(s.data.tasks) ? s.data.tasks : []).slice()
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') store.set({ open: false }) }
        if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
        return () => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey) }
      }, [])
      const sorted = tasks.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
      const running = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length
      return h('div', { className: 'cdl-scope' },
        h('div', { className: 'cdl-mask', onClick: () => store.set({ open: false }) }),
        h('div', { className: 'cdl-panel', role: 'dialog', 'aria-label': '下载任务' },
          h('div', { className: 'cdl-panel-head' },
            h(IconDownload, { size: 15 }),
            h('span', { className: 'cdl-panel-title' }, '下载'),
            h('span', { className: 'cdl-panel-count' }, `${tasks.length}`),
            h('div', { className: 'cdl-panel-head-actions' },
              running > 0
                ? h('button', { type: 'button', className: 'cdl-textbtn', onClick: () => control('pauseAll') }, '全部暂停')
                : h('button', { type: 'button', className: 'cdl-textbtn', onClick: () => control('resumeAll') }, '全部恢复'),
              h('button', { type: 'button', className: 'cdl-textbtn', onClick: () => control('clear') }, '清理已完成'),
              h('button', { type: 'button', className: 'cdl-iconbtn', title: '关闭', 'aria-label': '关闭', onClick: () => store.set({ open: false }) }, h(IconClose, { size: 14 })))),
          h('div', { className: 'cdl-list' },
            sorted.length === 0
              ? h('div', { className: 'cdl-empty' },
                h('span', { className: 'cdl-empty-icon' }, h(IconCheck, { size: 22 })),
                '暂无下载任务')
              : sorted.map((task) => h(TaskItem, { key: task.id || task.url, task }))))
      )
    }

    function OverlayHost() {
      const s = useStore()
      usePolling()
      if (!s.open) return null
      return h(Panel, null)
    }

    // ---------------------------------------------------------------- 注册

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      injectStyle()

      // 手机 + 桌面：会话标题栏右侧的进度胶囊（不遮挡任何宿主 chrome）
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'chunk-download', order: 6, label: '下载进度' },
        () => h(HeaderChip, null),
      ))

      // 桌面：侧边栏底部一行任务摘要
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'chunk-download', order: 6, label: '下载' },
        () => h(SidebarRow, null),
      ))

      // 任意处点击后弹出的浮动面板 / 手机底部抽屉
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'chunk-download', order: 24 },
        () => h(OverlayHost, null),
      ))
    }

    exports.apply = apply
    exports.__internal = { fmtBytes, fmtSpeed, fmtEta, ratioOf, pctText }

    return module.exports
  },
})
