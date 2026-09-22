/**
 * 宿主半边离线测试：用假的 cordis ctx 驱动真实的 apply()，网络调用可选（有 key 时打真接口）。
 * 运行：TYPESAFE_API_KEY=xxx node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  apply,
  buildQuestions,
  latestUserText,
  renderAnalysis,
} from '../lib/index.js'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const KEY = String(process.env.TYPESAFE_API_KEY ?? '').trim()
const NS = settingsNamespace('dsh-jev')

function userMessage(text) {
  return { id: 'm-' + text.length + '-' + Math.random(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } }
}

function fakeSettings(initial = {}, { exposedKey } = {}) {
  const state = { value: { ...initial }, revision: 3 }
  const value = exposedKey
  return {
    documentPath: '/tmp/fake-settings.yaml',
    writable: true,
    describe() {
      const shown = { ...state.value }
      const secrets = []
      if (state.value.apiKey !== undefined && state.value.apiKey !== '') {
        secrets.push({ path: ['apiKey'], set: true })
        delete shown.apiKey
      }
      if (value !== undefined) shown.apiKey = value
      return [{ ns: NS, value: shown, revision: state.revision, applies: 'live', secrets }]
    },
    register() {
      return { get: () => ({ ...state.value }), watch: () => () => {}, update: async () => {}, replace: async () => {} }
    },
    async mutate(_ns, ops, expected) {
      if (expected !== undefined && expected !== state.revision) throw new Error('revision conflict')
      for (const op of ops) {
        if (op.op === 'set') state.value[op.path[0]] = op.value
        else delete state.value[op.path[0]]
      }
      state.revision += 1
    },
    async replace() { state.value = {}; state.revision += 1 },
    _state: state,
  }
}

/** 收集 apply() 注册的所有东西，供测试手动触发。 */
function fakeCtx() {
  const listeners = new Map()
  const injections = []
  const warnings = []
  return {
    logger: { warn: (message) => warnings.push(String(message)) },
    on(name, handler) { listeners.set(name, handler) },
    inject(deps, callback) { injections.push({ deps, callback }) },
    _listeners: listeners,
    _injections: injections,
    _warnings: warnings,
    wireSettings(settings) {
      for (const item of injections) if (item.deps.includes('settings')) item.callback({ settings })
    },
    /** 记录 handle() 的完整实参，用来锁住「第三个参数不能缺」这条契约。 */
    _handleCalls: [],
    wireRpc() {
      let handler
      for (const item of injections) {
        if (!item.deps.includes('connection')) continue
        item.callback({
          // webServer 必须一起给：宿主会先确认它在，再调 rpc.handle（通道最终是它的路由）。
          webServer: { register: () => () => {} },
          connection: { rpc: { handle: (channel, fn, options) => { this._handleCalls.push({ channel, options }); handler = fn; return () => {} } } },
        })
      }
      return handler
    },
  }
}

test('配置默认值覆盖文档里的示例问题', () => {
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.model, 'jev-latest')
  assert.equal(DEFAULTS.endpoint, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(DEFAULTS.questions.length, 3)
  assert.deepEqual(DEFAULTS.questions.map((q) => q.name), ['department', 'frustration', 'is_urgent'])
})

test('buildQuestions 把设置编译成 systemone 的 questions', () => {
  const questions = buildQuestions(DEFAULTS.questions)
  assert.deepEqual(questions.is_urgent, { type: 'noul', instructions: 'The message conveys urgency or time-sensitivity' })
  assert.deepEqual(questions.frustration.criteria, ['Calm, just stating facts', 'Frustrated but civil', 'Very angry, strong language'])
  assert.deepEqual(questions.department.criteria, {
    billing: 'Payment or subscription issues',
    technical: 'Bugs or integration problems',
    sales: 'Pricing or account questions',
  })
  // 无效条目被丢掉；全无效时返回 undefined（调用方跳过请求）
  assert.equal(buildQuestions([{ name: '', type: 'noul' }]), undefined)
  assert.equal(buildQuestions([{ name: 'x', type: 'choice', criteria: [] }]), undefined)
  assert.deepEqual(buildQuestions([{ name: 'flag', type: 'noul', instructions: 'yes?' }]), { flag: { type: 'noul', instructions: 'yes?' } })
})

test('latestUserText 只认真实用户消息，跳过插件注入的上下文', () => {
  const messages = [
    userMessage('第一条'),
    { role: 'user', content: [{ type: 'text', text: '插件上下文' }], source: { kind: 'plugin', plugin: 'dsh-jev', form: 'snapshot', sections: [] } },
    userMessage('第二条'),
  ]
  assert.equal(latestUserText(messages), '第二条')
  assert.equal(latestUserText([]), undefined)
  assert.equal(latestUserText([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } }]), undefined)
})

test('renderAnalysis 渲染 choice / score / noul 三类答案', () => {
  const text = renderAnalysis({
    model: 'jev-1.13.0',
    answers: {
      department: { type: 'choice', choice: 'technical', confidence: 0.78, probabilities: { technical: 0.85, billing: 0.15, sales: 0 } },
      frustration: { type: 'score', score: 1, confidence: 1, legend: { 0: 'Calm', 1: 'Frustrated but civil', 2: 'Angry' }, probabilities: { 0: 0, 1: 1, 2: 0 } },
      is_urgent: { type: 'noul', noul: 1 },
    },
  })
  assert.match(text, /jev\(systemone\)/)
  assert.match(text, /department（choice）：technical/)
  assert.match(text, /frustration（score）：1 即 Frustrated but civil/)
  assert.match(text, /is_urgent：1/)
})

test('pre-step：没有 key 时原样放行，且不打断对话', async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  try {
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.wireSettings(fakeSettings({ enabled: true, questions: DEFAULTS.questions }))
  const handler = ctx._listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [userMessage('你好')] }
  const out = await handler({ agent: {}, turn: 1, step: 1, signal: undefined }, async () => decision)
  assert.equal(out, decision)
  assert.ok(ctx._warnings.length === 0, '没有 key 不应该告警')
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved
  }
})

test('pre-step：接口报错时也原样放行', async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.wireSettings(fakeSettings({ enabled: true, apiKey: 'bad-key', endpoint: 'http://127.0.0.1:9/nope', timeoutMs: 1500, questions: DEFAULTS.questions }))
  const handler = ctx._listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [userMessage('你好')] }
  const out = await handler({ agent: {}, turn: 1, step: 1, signal: undefined }, async () => decision)
  assert.equal(out, decision)
})

test('pre-step：关闭开关时不调用接口', async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.wireSettings(fakeSettings({ enabled: false, apiKey: 'whatever', questions: DEFAULTS.questions }))
  const handler = ctx._listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [userMessage('你好')] }
  const out = await handler({ agent: {}, turn: 1, step: 1, signal: undefined }, async () => decision)
  assert.equal(out, decision)
})

test('RPC 注册契约：注入 connection+webServer，且 handle 必须带 options.authority', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  const item = ctx._injections.find((entry) => entry.deps.includes('connection'))
  assert.ok(item, '必须注入 connection')
  assert.ok(item.deps.includes('webServer'), '通道最终挂在 webServer 上，必须一起等它')
  ctx.wireRpc()
  const call = ctx._handleCalls[0]
  assert.ok(call, 'handle() 必须被调用')
  assert.equal(call.channel, '/dsh-jev')
  // connection.rpc.register 会无条件读 options.authority；漏传第三个参数会在宿主里抛
  // TypeError，通道静默不注册（设置页表现成永远“正在读取”），所以这条断言不能省。
  assert.deepEqual(call.options, { authority: 'loopback' })
})

test('RPC：jev.view / jev.update / jev.clearKey 走通', async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  const settings = fakeSettings({ enabled: true, apiKey: 'stored-key', questions: DEFAULTS.questions })
  ctx.wireSettings(settings)
  const handler = ctx.wireRpc()
  assert.equal(typeof handler, 'function')

  const view = await handler('jev.view', {})
  assert.equal(view.ok, true)
  assert.equal(view.value.keySet, true)
  assert.equal(view.value.value.apiKey, undefined, 'API Key 不能经 RPC 回传')

  const updated = await handler('jev.update', { patch: { model: 'jev-latest', timeoutMs: 3000 }, expectedRevision: view.value.revision })
  assert.equal(updated.ok, true)
  assert.equal(updated.value.value.model, 'jev-latest')
  assert.equal(settings._state.value.model, 'jev-latest')

  const cleared = await handler('jev.clearKey', {})
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.storedKey, false)
  assert.equal(settings._state.value.apiKey, undefined)

  const bad = await handler('jev.unknown', {})
  assert.equal(bad.ok, false)
})

test('pre-step：真实调用 jev 并注入一条插件来源的上下文（需要 TYPESAFE_API_KEY）', { skip: KEY === '' }, async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  ctx.wireSettings(fakeSettings({ enabled: true, apiKey: KEY, questions: DEFAULTS.questions, timeoutMs: 20000 }))
  const handler = ctx._listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [userMessage('这个 Stripe 集成已经失败了三天，我一直在丢订单，麻烦立刻帮我处理！')] }
  const out = await handler({ agent: {}, turn: 1, step: 1, signal: undefined }, async () => decision)
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 2, '应该追加一条上下文消息')
  const injected = out.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'plugin')
  assert.equal(injected.source.plugin, 'dsh-jev')
  assert.match(injected.content[0].text, /is_urgent/)
  assert.ok(typeof injected.id === 'string' && injected.id.length > 0)
  assert.ok(ctx._warnings.length === 0)
})
