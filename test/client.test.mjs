/**
 * 客户端半边的渲染测试：不开浏览器，用最小 React 桩把设置页组件跑一遍。
 * 覆盖：模块工厂形状、settings.section 注册参数、首屏渲染、保存补丁内容、试跑按钮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** 最小 React 桩：createElement 造普通对象，useState/useEffect/useCallback 用固定槽位。 */
function makeReact() {
  let cells = []
  let effects = []
  let cursor = 0
  const flatten = (children) => children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  const React = {
    createElement(type, props) {
      const children = flatten(Array.prototype.slice.call(arguments, 2))
      const merged = Object.assign({}, props === null || props === undefined ? {} : props)
      // 像 React 一样把子节点同时放进 props.children，函数组件才能读到它们。
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in cells)) cells[index] = initial
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useEffect(fn) { effects.push(fn) },
    useCallback(fn) { return fn },
  }
  return {
    React,
    reset() { cursor = 0; effects = [] },
    drain(render) {
      for (const effect of effects) effect()
      effects = []
      cursor = 0
      return render()
    },
    fresh() { cells = [] },
  }
}

/**
 * 反复「跑 effect → 重渲染」直到异步加载稳定下来（组件里 load() 是 promise 链）。
 * @returns 稳定后的元素树。
 */
async function mount(harness, Component, props) {
  const render = () => expand(Component(props))
  let tree = null
  for (let index = 0; index < 4; index += 1) {
    tree = harness.drain(render)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return tree
}

/**
 * 把函数组件的元素就地展开成宿主元素（React 渲染器在真实环境里做的事）。
 * 只适用于无 hook 的子组件（本插件的 QuestionRow 正是如此）。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return Object.assign({}, node, { children: (node.children || []).map(expand) })
}

/** 把元素树里的字符串拼起来，方便断言。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** 在树里找第一个满足条件的元素。 */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return find(node.children, predicate)
}

/** 加载客户端包并取出工厂产物。 */
function loadBundle() {
  let captured
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  // 包体是给浏览器用的普通脚本：这里用 Function 执行，避免污染 ESM 解析语义。
  new Function('window', SOURCE)(globalThis.window)
  return captured
}

const VIEW = {
  value: {
    enabled: true,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    timeoutMs: 8000,
    maxInputChars: 4000,
    injectContext: true,
    instruction: '调整语气',
    questions: [{ name: 'is_urgent', type: 'noul', instructions: '是否紧急', criteria: [] }],
  },
  revision: 7,
  storedKey: true,
  keySet: true,
  envKey: false,
  documentPath: '/Users/x/.dsh/settings.yaml',
  writable: true,
  runtime: { calls: 2, errors: 0, lastError: null, recent: [{ at: Date.now(), ok: true, ms: 812, input: '你好' }] },
}

function setup() {
  const definition = loadBundle()
  const harness = makeReact()
  const runtime = []
  const module_ = definition.factory((spec) => {
    if (spec !== 'react') throw new Error('unexpected require: ' + spec)
    return harness.React
  })
  const calls = []
  const ctx = {
    slots: {
      inject(slot, callback) {
        runtime.push({ slot, callback })
      },
      register(options, Component) {
        runtime.push({ options, Component })
        return () => {}
      },
    },
    connection: {
      rpc: {
        call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          if (endpoint === 'jev.view') return Promise.resolve({ ok: true, value: VIEW })
          if (endpoint === 'jev.update' || endpoint === 'jev.reset' || endpoint === 'jev.clearKey') {
            return Promise.resolve({ ok: true, value: VIEW })
          }
          if (endpoint === 'jev.test') return Promise.resolve({ ok: true, value: { ok: true, ms: 500, text: '测试文本', payload: { model: 'jev-1.13.0' } } })
          return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'unknown' } })
        },
      },
    },
  }
  module_.apply(ctx)
  return { definition, module_, harness, runtime, calls, ctx }
}

test('包体形状：window.__ModuleLoader__.load 注册 dsh-jev 工厂，导出 name/inject/apply', () => {
  const definition = loadBundle()
  assert.equal(definition.id, 'dsh-jev')
  assert.equal(typeof definition.factory, 'function')
  const module_ = definition.factory((spec) => (spec === 'react' ? makeReact().React : null))
  assert.equal(module_.name, 'dsh-jev')
  assert.deepEqual(module_.inject, ['slots', 'connection'])
  assert.equal(typeof module_.apply, 'function')
})

test('注册进 settings.section，且注册参数符合槽位契约', () => {
  const { runtime } = setup()
  const injected = runtime.find((item) => item.slot === 'settings.section')
  assert.ok(injected, '必须 inject settings.section')
  assert.doesNotThrow(() => injected.callback())
  const registration = runtime.find((item) => item.options !== undefined)
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'dsh-jev')
  assert.equal(typeof registration.options.order, 'number')
  assert.equal(registration.options.label(), 'JEV 情绪分析')
  const props = registration.options.inject()
  assert.equal(typeof props.call, 'function')
  assert.equal(typeof registration.Component, 'function')
})

test('首屏渲染：读设置 → 展示状态、接口、问题定义与最近调用', async () => {
  const { harness, runtime, calls } = setup()
  const injected = runtime.find((item) => item.slot === 'settings.section')
  injected.callback()
  const registration = runtime.find((item) => item.options !== undefined)
  const props = registration.options.inject()

  harness.fresh()
  const first = harness.drain(() => registration.Component(props))
  assert.match(textOf(first), /正在读取 JEV 设置/, '首帧是加载态')

  const tree = await mount(harness, registration.Component, props)
  const text = textOf(tree)
  assert.equal(calls[0].endpoint, 'jev.view')
  assert.match(text, /JEV 情绪 \/ 意图判定/)
  assert.match(text, /Key 已配置/)
  assert.match(text, /revision 7/)
  assert.ok(find(tree, (node) => node.props && node.props.value === 'https://api.typesafe.ai/v1/systemone'), '接口地址要回填到输入框')
  assert.ok(find(tree, (node) => node.props && node.props.value === 'is_urgent'), '问题字段名要回填到输入框')
  assert.ok(find(tree, (node) => node.props && node.props.checked === true), '启用开关要反映已保存的值')
  assert.match(text, /最近调用 · 成功 2 次/)
})

test('读设置失败时必须显示错误与重试，而不是永远停在加载态', async () => {
  const { harness, runtime, ctx } = setup()
  runtime.find((item) => item.slot === 'settings.section').callback()
  const registration = runtime.find((item) => item.options !== undefined)
  const props = registration.options.inject()
  // 复现线上症状：宿主通道没注册时 call 会 reject（路由落到静态资源返回 405）。
  ctx.connection.rpc.call = (channel, endpoint) => Promise.reject(new Error('request to /dsh-jev/jev.view failed: 405'))

  harness.fresh()
  const tree = await mount(harness, registration.Component, props)
  const text = textOf(tree)
  assert.doesNotMatch(text, /^正在读取 JEV 设置…$/, '失败后不能还显示加载态')
  assert.match(text, /读取设置失败/)
  assert.match(text, /405/)
  const retry = find(tree, (node) => node.type === 'button' && textOf(node) === '重试')
  assert.ok(retry, '失败时要有重试按钮')
})

test('保存：只提交可写字段，未输入新 Key 时不覆盖已存密钥', async () => {
  const { harness, runtime, calls } = setup()
  runtime.find((item) => item.slot === 'settings.section').callback()
  const registration = runtime.find((item) => item.options !== undefined)
  const props = registration.options.inject()
  harness.fresh()
  const tree = await mount(harness, registration.Component, props)

  const saveButton = find(tree, (node) => node.type === 'button' && textOf(node) === '保存')
  assert.ok(saveButton, '找不到保存按钮')
  saveButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const update = calls.find((item) => item.endpoint === 'jev.update')
  assert.ok(update, '保存必须调用 jev.update')
  assert.equal(update.payload.expectedRevision, 7, '必须带上 revision 做并发保护')
  assert.equal(update.payload.patch.apiKey, undefined, '没输入新 Key 时不能把空的 apiKey 写回去')
  assert.equal(update.payload.patch.endpoint, 'https://api.typesafe.ai/v1/systemone')
  assert.deepEqual(update.payload.patch.questions, [{ name: 'is_urgent', type: 'noul', instructions: '是否紧急', criteria: [] }])
});

test('测试按钮：把文本发给 jev.test 并渲染结果', async () => {
  const { harness, runtime, calls } = setup()
  runtime.find((item) => item.slot === 'settings.section').callback()
  const registration = runtime.find((item) => item.options !== undefined)
  const props = registration.options.inject()
  harness.fresh()
  let tree = await mount(harness, registration.Component, props)

  const runButton = find(tree, (node) => node.type === 'button' && textOf(node) === '运行测试')
  assert.ok(runButton, '找不到运行测试按钮')
  runButton.props.onClick()
  tree = await mount(harness, registration.Component, props)

  const testCall = calls.find((item) => item.endpoint === 'jev.test')
  assert.ok(testCall)
  assert.ok(typeof testCall.payload.state === 'string' && testCall.payload.state.length > 0)
  assert.match(textOf(tree), /测试文本/)
});

test('清理：没有 window 时包体不会在导入期报错（工厂仍然可调用）', () => {
  assert.equal(typeof globalThis.window.__ModuleLoader__.load, 'function')
});
