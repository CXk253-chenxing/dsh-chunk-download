/**
 * 客户端半身冒烟测试：不跑浏览器，只验证
 *  - 模块加载格式（window.__ModuleLoader__.load）
 *  - 三个槽位注册（会话标题栏 / 侧边栏 / 浮层）
 *  - 无数据时不渲染、格式化函数正确
 * 这样在没有浏览器的情况下也能挡住语法与注册错误。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

async function loadClientModule() {
  const code = await fsp.readFile(CLIENT_PATH, 'utf8')
  let loaded = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
    console,
  }
  vm.runInNewContext(code, sandbox)
  assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
  return loaded
}

/** 极简 React 替身：只保证组件函数可调用。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    Fragment: 'Fragment',
  }
}

test('客户端半身：加载格式 + 三个槽位注册', async () => {
  const mod = await loadClientModule()
  assert.equal(mod.id, 'dsh-chunk-download')

  const exportsObj = mod.factory((name) => {
    assert.equal(name, 'react', `客户端只应 require('react')，实际 require(${name})`)
    return fakeReact()
  })
  assert.equal(typeof exportsObj.apply, 'function')

  const registrations = []
  const slots = {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  exportsObj.apply({ get: (key) => (key === 'slots' ? slots : undefined) })

  assert.deepEqual(
    registrations.map((r) => r.options.name),
    ['conversation.input.dock', 'sidebar.footer.action', 'conversation.session.header.utilities'],
  )
  assert.ok(
    !registrations.some((r) => r.options.name === 'shell.overlay'),
    '不得占用 shell.overlay（会盖住桌宠等悬浮层）',
  )
  for (const reg of registrations) {
    assert.ok(reg.options.id, '每个槽位都要有稳定 id')
    assert.equal(typeof reg.component, 'function')
    // 槽位注册的是"返回元素"的函数；把组件真正调一次，无数据时应安静返回 null
    const element = reg.component()
    assert.ok(element && typeof element.type === 'function', `${reg.options.name} 应返回一个 React 元素`)
    const rendered = element.type(element.props)
    assert.equal(rendered, null, `${reg.options.name} 在无数据时应返回 null`)
  }
})

test('客户端半身：格式化函数与主题令牌', async () => {
  const mod = await loadClientModule()
  const exportsObj = mod.factory(() => fakeReact())
  const internal = exportsObj.__internal
  assert.equal(typeof internal.fmtBytes, 'function')

  assert.equal(internal.fmtBytes(0), '0 B')
  assert.equal(internal.fmtBytes(1536), '1.5 KB')
  assert.equal(internal.fmtBytes(50 * 1024 * 1024), '50.0 MB')
  assert.equal(internal.fmtSpeed(1024), '1.0 KB/s')
  assert.equal(internal.fmtEta(45), '45s')
  assert.equal(internal.fmtEta(125), '2m05s')

  assert.equal(internal.ratioOf({ progress: 0.25 }), 0.25)
  assert.equal(internal.ratioOf({ downloaded: 5, total: 10 }), 0.5)
  assert.equal(internal.pctText({ status: 'completed', progress: 1, total: 10, downloaded: 10 }), '100%')
  assert.equal(internal.pctText({ status: 'downloading', progress: 0.4567, total: 10, downloaded: 4 }), '45.7%')

  const code = await fsp.readFile(CLIENT_PATH, 'utf8')
  for (const token of ['--dsw-alias-brand-primary', '--dsw-alias-state-success-primary', '--dsw-alias-border-l1']) {
    assert.ok(code.includes(token), `样式应只用主题令牌，缺少 ${token}`)
  }
})
