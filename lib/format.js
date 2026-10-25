/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 人类可读格式化 + 任务卡片渲染。
 *
 * 只做展示，不参与下载逻辑：引擎返回的是纯数字（字节 / 毫秒 / 比率），
 * 这里统一翻译成"12.3 MB / 27.2 MB · 3.4 MB/s · ETA 4s"这类文案。
 */

/** 状态 → 图标 + 中文标签 */
const STATUS_META = {
  queued: { icon: '⏳', label: '排队中' },
  downloading: { icon: '▶', label: '下载中' },
  paused: { icon: '⏸', label: '已暂停' },
  completed: { icon: '✔', label: '已完成' },
  failed: { icon: '✖', label: '失败' },
  canceled: { icon: '⊘', label: '已取消' },
}

export function statusMeta(status) {
  return STATUS_META[status] ?? { icon: '?', label: String(status ?? '未知') }
}

/** 字节数 → B / KB / MB / GB（保留 1~2 位小数） */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** 瞬时速度 → "3.4 MB/s" */
export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond)
  if (!Number.isFinite(n) || n <= 0) return '0 B/s'
  return `${formatBytes(n)}/s`
}

/** 秒 → "4s" / "2m05s" / "1h02m" */
export function formatEta(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const s = Math.round(n)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

/** 毫秒 → "1.2s" / "3m04s" */
export function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)}ms`
  return formatEta(n / 1000)
}

/** 0~1 的比率 → 文本进度条 */
export function progressBar(ratio, width = 12) {
  const r = Number(ratio)
  if (!Number.isFinite(r)) return '·'.repeat(width)
  const clamped = Math.min(1, Math.max(0, r))
  const filled = Math.round(clamped * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** 百分比文案：45.2% */
export function formatPercent(ratio) {
  const r = Number(ratio)
  if (!Number.isFinite(r)) return '—'
  return `${(Math.min(1, Math.max(0, r)) * 100).toFixed(1)}%`
}

/** 单行任务摘要（列表用） */
export function formatTaskLine(task, index) {
  const meta = statusMeta(task.status)
  const order = index === undefined ? '' : `${index + 1}. `
  const name = task.filename || task.path || task.url
  const size = task.total ? formatBytes(task.total) : '大小未知'
  if (task.status === 'downloading' || task.status === 'queued' || task.status === 'paused') {
    const ratio = task.progress
    const bar = progressBar(ratio)
    const have = task.total ? `${formatBytes(task.downloaded)} / ${formatBytes(task.total)}` : formatBytes(task.downloaded)
    const tail = task.status === 'downloading'
      ? ` · ${formatSpeed(task.speed)} · ETA ${formatEta(task.etaSeconds)}`
      : ''
    return `${order}${meta.icon} ${formatPercent(ratio)} ${bar} ${have}${tail} — ${name}`
  }
  if (task.status === 'completed') {
    const tail = task.exportedPath ? ` · 已送手机 Download/DeepSeekHarness` : ''
    return `${order}${meta.icon} ${meta.label} ${size} — ${name}${tail}`
  }
  const reason = task.error ? ` · ${task.error}` : ''
  return `${order}${meta.icon} ${meta.label}${reason} — ${name}`
}

/** 多行任务详情（单任务用） */
export function formatTaskBlock(task) {
  const meta = statusMeta(task.status)
  const lines = []
  lines.push(`任务 ${task.id}  ${meta.icon} ${meta.label}`)
  lines.push(`  文件   ${task.path || task.dir || '(未确定)'}`)
  if (task.total > 0) {
    lines.push(`  进度   ${formatPercent(task.progress)} ${progressBar(task.progress, 20)}  ${formatBytes(task.downloaded)} / ${formatBytes(task.total)}`)
  } else {
    lines.push(`  进度   ${formatBytes(task.downloaded)}（服务端未返回文件大小）`)
  }
  if (task.status === 'downloading') {
    lines.push(`  速度   ${formatSpeed(task.speed)} · 剩余 ${formatEta(task.etaSeconds)}`)
  }
  if (task.mode === 'chunked') {
    const done = task.completedChunks ?? 0
    lines.push(`  分片   ${done}/${task.chunkCount} 片完成 · ${task.connections} 连接并发`)
  } else if (task.mode === 'single') {
    lines.push(`  分片   单流（服务端不支持 Range）`)
  }
  if (task.exportedPath) lines.push(`  导出   ${task.exportedPath}`)
  else if (task.exportError) lines.push(`  导出   失败：${task.exportError}`)
  if (task.error) lines.push(`  错误   ${task.error}`)
  lines.push(`  来源   ${task.url}`)
  return lines.join('\n')
}

/** 任务列表渲染 */
export function formatTaskList(tasks, { summary } = {}) {
  if (!tasks || tasks.length === 0) return '暂无下载任务。'
  const lines = []
  if (summary) {
    lines.push(
      `分片下载任务 ${summary.total} 个：下载中 ${summary.downloading} · 排队 ${summary.queued} · 暂停 ${summary.paused}`
      + ` · 完成 ${summary.completed} · 失败 ${summary.failed}`,
    )
    if (summary.activeSpeed > 0) lines.push(`当前总速度 ${formatSpeed(summary.activeSpeed)}`)
    lines.push('')
  }
  tasks.forEach((task, index) => {
    lines.push(formatTaskLine(task, index))
  })
  return lines.join('\n')
}
