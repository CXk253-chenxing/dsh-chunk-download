/**
 * UI 组件渲染测试（可选）：用真实 React 做服务端静态渲染，验证
 * 标题栏胶囊 / 侧边栏行 / 面板在"有任务数据"时能正确输出，不抛错。
 *
 * 依赖 react + react-dom，仓库本身不装它们（零依赖原则），所以：
 *   npm i -D react react-dom   # 或临时目录安装后在此项目里 link
 *   node --test test/render.test.mjs
 * 没装就自动 skip，CI 里不会失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

let React = null
let renderToStaticMarkup = null
try {
  React = (await import('react')).default
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup
} catch {
  React = null
}

test('UI 渲染：标题栏胶囊 / 侧边栏行 / 面板', { skip: React === null ? '未安装 react / react-dom（可选测试）' : false }, async () => {
  const code = await fsp.readFile(CLIENT_PATH, 'utf8')
  let mod = null
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: (m) => { mod = m } } }, console })

  const exportsObj = mod.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })

  const registrations = []
  const slots = {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  exportsObj.apply({ get: (key) => (key === 'slots' ? slots : undefined) })

  exportsObj.__internal.store.set({
    data: {
      summary: { total: 2, downloading: 1, queued: 0, paused: 0, completed: 1, failed: 0, canceled: 0, activeSpeed: 3.5e6 },
      tasks: [
        {
          id: 'dl_1', status: 'downloading', filename: 'node-v22.tar.gz', total: 44987783,
          downloaded: 20500000, progress: 0.4557, speed: 3500000, etaSeconds: 7,
          mode: 'chunked', chunkCount: 128, completedChunks: 58,
        },
        {
          id: 'dl_2', status: 'completed', filename: 'SHASUMS256.txt', total: 3748,
          downloaded: 3748, progress: 1, speed: 0, etaSeconds: null, verification: { ok: true },
        },
      ],
    },
    open: true,
  })

  const render = (name) => {
    const reg = registrations.find((item) => item.options.name === name)
    const element = reg.component()
    return renderToStaticMarkup(React.createElement(element.type, element.props))
  }

  const chip = render('conversation.session.header.utilities')
  assert.match(chip, /45\.6%/, '胶囊应显示百分比')
  assert.match(chip, /MB\/s/, '胶囊应显示速度')

  const row = render('sidebar.footer.action')
  assert.ok(row.includes('1 个任务'), '侧边栏行应显示活动任务数')
  assert.match(row, /role="progressbar"|cdl-bar/, '侧边栏行应有进度条')

  const panel = render('shell.overlay')
  assert.ok(panel.includes('node-v22.tar.gz'), '面板应列出任务文件名')
  assert.ok(panel.includes('role="progressbar"'), '面板每行应有进度条')
  assert.ok(panel.includes('aria-label="暂停"'), '下载中的任务应有暂停按钮')
  assert.ok(panel.includes('校验通过'), '已完成且校验通过应显示校验结果')
})
