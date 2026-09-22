/**
 * dsh-jev —— DeepSeek Harness 插件（宿主半边）
 *
 * 每轮对话把用户最新一条消息送给 typesafe.ai 的 systemone(jev) 做意图/情绪判定，
 * 再把判定结果作为一条带来源标记的上下文消息注入本步请求；设置项存在
 * settings.yaml 的 \`dsh-jev\` 命名空间里，由客户端设置页读写。
 *
 * 设计要点：
 * - 只在 \`agent/pre-step\` 的 batch 里出现**新的用户消息**时调用一次，不按步重复计费；
 * - jev 不可用（没配 key / 超时 / HTTP 错）时静默降级，绝不打断这一轮对话；
 * - 结果消息的 source.kind='plugin'，下一次 pre-step 的特征判断会跳过它，不会自激循环。
 *
 * @module dsh-jev
 */
import { randomUUID } from 'node:crypto'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-jev'

/** 依赖 agent 事件总线，才能收到 agent/pre-step。 */
export const inject = ['agents']

/** 设置命名空间（settings.yaml 里的顶层键）。 */
const NAMESPACE = 'dsh-jev'
/** 包私有 RPC 逻辑通道（设置页 ⇄ 宿主）。 */
const CHANNEL = '/dsh-jev'
/** 没在设置里配 key 时，回落到这个环境变量。 */
const ENV_API_KEY = 'TYPESAFE_API_KEY'
/** 同样的输入在这么长时间内复用上一次结果，避免重试/多步重复请求。 */
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 32
/** 设置页展示的最近调用记录条数。 */
const RECENT_MAX = 8
/** 默认注给模型的行为提示。 */
const DEFAULT_INSTRUCTION =
  '根据以上信号调整语气、优先级与详略；不要直接复述这段分析，除非用户主动问起。'

const ns = settingsNamespace(NAMESPACE)

/** jev 支持的问题类型。 */
const QUESTION_TYPES = ['noul', 'score', 'choice']

/** 出厂自带的一套问题（对应 typesafe 文档里的客服分流示例）。 */
const DEFAULT_QUESTIONS = [
  {
    name: 'department',
    type: 'choice',
    instructions: 'Which team should handle this',
    criteria: [
      'billing=Payment or subscription issues',
      'technical=Bugs or integration problems',
      'sales=Pricing or account questions',
    ],
  },
  {
    name: 'frustration',
    type: 'score',
    instructions: 'How frustrated the customer appears',
    criteria: ['Calm, just stating facts', 'Frustrated but civil', 'Very angry, strong language'],
  },
  {
    name: 'is_urgent',
    type: 'noul',
    instructions: 'The message conveys urgency or time-sensitivity',
    criteria: [],
  },
]

const QuestionSchema = z.object({
  name: z.string().default(''),
  type: z.union([z.const('noul'), z.const('score'), z.const('choice')]).default('noul'),
  instructions: z.string().default(''),
  criteria: z.array(z.string()).default([]),
})

/** 设置 schema：默认值 + 校验都在这里，settings.yaml 的用户层覆盖其上。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().role('secret').default(''),
  endpoint: z.string().default('https://api.typesafe.ai/v1/systemone'),
  model: z.string().default('jev-latest'),
  timeoutMs: z.number().step(1).min(500).max(60000).default(8000),
  maxInputChars: z.number().step(1).min(200).max(20000).default(4000),
  injectContext: z.boolean().default(true),
  instruction: z.string().default(DEFAULT_INSTRUCTION),
  questions: z.array(QuestionSchema).default(DEFAULT_QUESTIONS),
})

/** 没有 settings 服务（headless 等）时使用的纯默认值。 */
export const DEFAULTS = Object.freeze(Config({}))

// #region 纯函数（导出以便离线单测）

/** 把设置里的多行文本拆成去空行的数组。 */
function toLines(value) {
  if (Array.isArray(value)) return value.map((line) => String(line).trim()).filter((line) => line !== '')
  if (typeof value !== 'string') return []
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/**
 * 把设置里的问题列表编译成 systemone 的 questions 对象。
 * @param list - 设置里的 questions 数组。
 * @returns questions 对象；一条有效问题都没有时返回 undefined（调用方跳过请求）。
 */
export function buildQuestions(list) {
  const questions = {}
  for (const raw of Array.isArray(list) ? list : []) {
    const key = String(raw?.name ?? '').trim()
    if (key === '') continue
    const instructions = String(raw?.instructions ?? '').trim()
    const type = QUESTION_TYPES.includes(raw?.type) ? raw.type : 'noul'
    if (type === 'choice') {
      const criteria = {}
      for (const line of toLines(raw?.criteria)) {
        const at = line.indexOf('=')
        if (at > 0) criteria[line.slice(0, at).trim()] = line.slice(at + 1).trim()
        else criteria[line] = line
      }
      if (Object.keys(criteria).length === 0) continue
      questions[key] = { type, instructions, criteria }
    } else if (type === 'score') {
      const criteria = toLines(raw?.criteria)
      if (criteria.length === 0) continue
      questions[key] = { type, instructions, criteria }
    } else {
      questions[key] = { type: 'noul', instructions }
    }
  }
  return Object.keys(questions).length === 0 ? undefined : questions
}

/** 取一条消息里的纯文本正文。 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 从本步的 batch 里取最新一条**真实用户**消息（跳过插件注入的上下文）。
 * @param messages - pre-step 决定的 messages。
 * @returns 用户正文；没有则 undefined。
 */
export function latestUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== 'user') continue
    const text = textOf(message)
    if (text !== '') return text
  }
  return undefined
}

/** 从 legend 里取分数对应的说明：优先精确命中，否则取最接近的整数档。 */
function legendLabel(legend, score) {
  if (legend === null || typeof legend !== 'object' || typeof score !== 'number') return ''
  const exact = legend[String(score)]
  if (typeof exact === 'string') return exact
  let best = ''
  let bestDistance = Infinity
  for (const [key, value] of Object.entries(legend)) {
    const at = Number(key)
    if (!Number.isFinite(at) || typeof value !== 'string') continue
    const distance = Math.abs(at - score)
    if (distance < bestDistance) {
      bestDistance = distance
      best = value
    }
  }
  return best
}

/** 数值保留两位且去掉多余的 0。 */
function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  return Number(value.toFixed(3)).toString()
}

/** 概率表渲染成 "a 85% / b 15%"。 */
function renderProbabilities(probabilities) {
  if (probabilities === null || typeof probabilities !== 'object') return ''
  const parts = Object.entries(probabilities)
    .filter(([, value]) => typeof value === 'number')
    .sort((left, right) => right[1] - left[1])
    .map(([key, value]) => key + ' ' + Math.round(value * 100) + '%')
  return parts.length === 0 ? '' : '（' + parts.join(' / ') + '）'
}

/**
 * 把 jev 的原始响应渲染成注入给模型的一段文字。
 * @param payload - systemone 的响应体。
 * @param instruction - 追加的行为提示，空串表示不加。
 * @returns 注入正文。
 */
export function renderAnalysis(payload, instruction = DEFAULT_INSTRUCTION) {
  const answers = payload?.answers !== null && typeof payload?.answers === 'object' ? payload.answers : {}
  const lines = ['jev(systemone) 对用户最新一条消息的判定 · ' + String(payload?.model ?? 'unknown')]
  let rendered = 0
  for (const [key, answer] of Object.entries(answers)) {
    if (answer === null || typeof answer !== 'object') continue
    if (answer.type === 'noul') {
      rendered += 1
      lines.push('- ' + key + '：' + num(answer.noul))
      continue
    }
    if (answer.type === 'score') {
      rendered += 1
      const label = legendLabel(answer.legend, answer.score)
      lines.push(
        '- ' + key + '（score）：' + num(answer.score) + (label === '' ? '' : ' 即 ' + label) +
        '，置信度 ' + num(answer.confidence) + renderProbabilities(answer.probabilities),
      )
      continue
    }
    if (answer.type === 'choice') {
      rendered += 1
      lines.push(
        '- ' + key + '（choice）：' + String(answer.choice ?? '') +
        '，置信度 ' + num(answer.confidence) + renderProbabilities(answer.probabilities),
      )
      continue
    }
    rendered += 1
    lines.push('- ' + key + '：' + JSON.stringify(answer))
  }
  if (rendered === 0) lines.push('- （响应里没有可识别的答案）')
  return lines.join('\n')
}

// #endregion

/** 构造一条插件来源的上下文消息（注入后模型可见、界面标为运行时上下文）。 */
function contextMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: NAMESPACE, text }] },
  })
}

/** 把一次调用结果折算成缓存键。 */
function cacheKey(config, state) {
  return JSON.stringify([config.endpoint, config.model, config.questions, state])
}

/**
 * 宿主插件入口。
 * @param ctx - cordis 宿主上下文。
 * @param config - 组合层配置（cordis.patch.yml 里的 config 段，可省）。
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  /** 设置服务句柄，settings 服务出现后才有值。 */
  let settings
  /** 本命名空间的所有者视图（get/watch/update）。 */
  let scope
  /** 最近一次调用的事实，供设置页显示。 */
  const runtime = { recent: [], calls: 0, errors: 0, lastError: null }
  /** 相同输入的结果缓存。 */
  const cache = new Map()

  const base = config !== null && typeof config === 'object' ? config : {}

  ctx.inject(['settings'], (sctx) => {
    settings = sctx.settings
    try {
      scope = sctx.settings.register(ns, Config, Object.keys(base).length === 0 ? {} : { base })
    } catch (error) {
      log.warn?.('dsh-jev: 设置命名空间注册失败，改用内置默认值：' + String(error?.message ?? error))
    }
  })

  /** 当前生效的配置：用户层 > 组合层 > schema 默认。 */
  function resolveConfig() {
    if (scope !== undefined) {
      try {
        return { ...DEFAULTS, ...scope.get() }
      } catch (error) {
        log.warn?.('dsh-jev: 读取设置失败，改用内置默认值：' + String(error?.message ?? error))
      }
    }
    return { ...DEFAULTS, ...base }
  }

  /** 记一条调用事实。 */
  function note(entry) {
    runtime.recent.unshift({ at: Date.now(), ...entry })
    if (runtime.recent.length > RECENT_MAX) runtime.recent.length = RECENT_MAX
    if (entry.ok === true) runtime.calls += 1
    else if (entry.ok === false && entry.skipped !== true) {
      runtime.errors += 1
      runtime.lastError = String(entry.error ?? '')
    }
  }

  /**
   * 调一次 jev。
   * @param cfg - 当前配置。
   * @param state - 待判定的用户消息。
   * @param signal - 本步的取消信号。
   * @param options - { force } 跳过缓存（设置页的「测试」用）。
   * @returns { text, payload, ms } 或 undefined（跳过/失败）。
   */
  async function analyze(cfg, state, signal, options = {}) {
    const apiKey = String(cfg.apiKey || process.env[ENV_API_KEY] || '').trim()
    if (apiKey === '') {
      note({ ok: false, skipped: true, reason: 'no-api-key' })
      return undefined
    }
    const questions = buildQuestions(cfg.questions)
    if (questions === undefined) {
      note({ ok: false, skipped: true, reason: 'no-questions' })
      return undefined
    }
    const trimmed = state.slice(0, cfg.maxInputChars)
    const key = cacheKey({ ...cfg, questions }, trimmed)
    if (options.force !== true) {
      const hit = cache.get(key)
      if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit
    }

    const timer = new AbortController()
    const handle = setTimeout(() => timer.abort(new Error('jev request timed out')), cfg.timeoutMs)
    const abort = signal === undefined ? timer.signal : AbortSignal.any([signal, timer.signal])
    const started = Date.now()
    try {
      const response = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: trimmed, model: cfg.model, questions }),
        signal: abort,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error('HTTP ' + response.status + ' ' + detail.slice(0, 300))
      }
      const payload = await response.json()
      const text = renderAnalysis(payload, String(cfg.instruction ?? ''))
      const record = { at: Date.now(), text, payload, ms: Date.now() - started }
      cache.set(key, record)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      note({ ok: true, ms: record.ms, input: trimmed.slice(0, 200), payload, text })
      return record
    } catch (error) {
      if (signal?.aborted !== true) {
        note({ ok: false, ms: Date.now() - started, input: trimmed.slice(0, 200), error: String(error?.message ?? error) })
        log.warn?.('dsh-jev: 调用失败（本轮跳过注入）：' + String(error?.message ?? error))
      }
      return undefined
    } finally {
      clearTimeout(handle)
    }
  }

  // 每轮对话：在 pre-step 决策进入后追加一条判定上下文。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      try {
        if (decision === null || decision?.kind !== 'enter') return decision
        const cfg = resolveConfig()
        if (cfg.enabled !== true) return decision
        const state = latestUserText(decision.messages)
        if (state === undefined) return decision
        const run = await analyze(cfg, state, payload?.signal)
        if (run === undefined || payload?.signal?.aborted === true) return decision
        if (cfg.injectContext !== true) return decision
        return { kind: 'enter', messages: [...decision.messages, contextMessage(run.text)] }
      } catch (error) {
        log.warn?.('dsh-jev: pre-step 注入失败（本轮忽略）：' + String(error?.message ?? error))
        return decision
      }
    },
    { prepend: true },
  )

  // #region 设置页 RPC

  function ok(value) {
    return { ok: true, value }
  }

  /** 按 DSH 的 rpcErrorSchema 造错误（code 取自闭合集合）。 */
  function fail(code, message) {
    if (code === 'cancelled') return { ok: false, error: { code: 'cancelled', message, details: {} } }
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } }
  }

  /** 给设置页的完整视图：脱敏后的值 + revision + key 是否已配置。 */
  function view() {
    // 传给浏览器的值必须去掉密钥：settings.describe 的脱敏只作用于它自己的返回值。
    const resolved = resolveConfig()
    const value = { ...resolved, apiKey: undefined }
    delete value.apiKey
    const envKey = String(process.env[ENV_API_KEY] ?? '').trim() !== ''
    if (settings === undefined) {
      return { value, revision: undefined, keySet: resolved.apiKey !== '' || envKey, envKey, documentPath: undefined, writable: false, runtime: runtimeView() }
    }
    const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns)
    const secrets = Array.isArray(descriptor?.secrets) ? descriptor.secrets : []
    const storedKey = secrets.some((secret) => {
      const path = Array.isArray(secret?.path) ? secret.path.join('.') : String(secret?.path ?? '')
      return path === 'apiKey' && secret?.set === true
    })
    return {
      value,
      revision: descriptor?.revision,
      base: descriptor?.base,
      user: descriptor?.user,
      keySet: storedKey || envKey || String(resolved.apiKey ?? '') !== '',
      storedKey,
      envKey,
      applies: descriptor?.applies ?? 'live',
      documentPath: settings.documentPath,
      writable: settings.writable !== false,
      runtime: runtimeView(),
    }
  }

  function runtimeView() {
    return {
      calls: runtime.calls,
      errors: runtime.errors,
      lastError: runtime.lastError,
      recent: runtime.recent.map((entry) => ({
        at: entry.at,
        ok: entry.ok,
        ms: entry.ms,
        skipped: entry.skipped === true,
        reason: entry.reason,
        error: entry.error,
        input: entry.input,
        text: entry.text,
      })),
    }
  }

  /** 设置页写入的补丁只允许这些键。 */
  const PATCH_KEYS = [
    'enabled', 'apiKey', 'endpoint', 'model', 'timeoutMs', 'maxInputChars', 'injectContext', 'instruction', 'questions',
  ]

  async function handle(endpoint, payload = {}, signal) {
    if (signal?.aborted === true) return fail('cancelled', 'The request was cancelled.')
    try {
      if (endpoint === 'jev.view') return ok(view())

      if (endpoint === 'jev.update' || endpoint === 'jev.reset' || endpoint === 'jev.clearKey') {
        if (settings === undefined) return fail('bad-request', '当前部署没有挂载 settings 服务，无法保存设置')
        const expectedRevision = typeof payload?.expectedRevision === 'number' ? payload.expectedRevision : undefined
        if (endpoint === 'jev.clearKey') {
          await settings.mutate(ns, [{ op: 'unset', path: ['apiKey'] }], expectedRevision)
          return ok(view())
        }
        if (endpoint === 'jev.reset') {
          await settings.replace(ns, {}, expectedRevision)
          return ok(view())
        }
        const patch = payload?.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          return fail('bad-request', 'patch 必须是一个普通对象')
        }
        const ops = []
        for (const [key, value] of Object.entries(patch)) {
          if (!PATCH_KEYS.includes(key)) continue
          if (value === undefined) continue
          ops.push({ op: 'set', path: [key], value })
        }
        if (ops.length === 0) return fail('bad-request', 'patch 里没有可写入的字段')
        await settings.mutate(ns, ops, expectedRevision)
        return ok(view())
      }

      if (endpoint === 'jev.test') {
        const cfg = resolveConfig()
        const text = String(payload?.state ?? '').trim()
        if (text === '') return fail('bad-request', '请输入一段测试文本')
        const run = await analyze(cfg, text, signal, { force: true })
        if (run === undefined) {
          return ok({ ok: false, error: runtime.lastError ?? '调用失败：请检查 API Key / 网络 / 问题配置' })
        }
        return ok({ ok: true, ms: run.ms, text: run.text, payload: run.payload })
      }

      return fail('bad-request', '未知的设置接口：' + String(endpoint))
    } catch (error) {
      return fail('bad-request', String(error?.message ?? error))
    }
  }

  // 设置页通道：必须同时等 connection（rpc 注册表）与 webServer（通道最终是挂在它上面的一条路由），
  // 第三个参数是 register() 的必填项——缺了它会在读 options.authority 时直接抛 TypeError。
  ctx.inject(['connection', 'webServer'], (cctx) => {
    if (cctx.connection?.rpc?.handle === undefined || cctx.webServer === undefined) {
      log.warn?.('dsh-jev: 缺少 connection.rpc / webServer，设置页通道不可用（判定注入不受影响）')
      return undefined
    }
    try {
      return cctx.connection.rpc.handle(CHANNEL, handle, { authority: 'loopback' })
    } catch (error) {
      log.warn?.('dsh-jev: 设置页通道注册失败：' + String(error?.message ?? error))
      return undefined
    }
  })

  // #endregion
}

export { CHANNEL, NAMESPACE }
