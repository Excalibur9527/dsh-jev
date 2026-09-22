/**
 * 手动试跑：走插件自己的代码路径（配置解析 → buildQuestions → systemone → renderAnalysis），
 * 也就是设置页「运行测试」按钮背后的那条 jev.test 通道。
 *
 * 用法：
 *   node scripts/try.mjs                       # 跑内置的几段样例
 *   node scripts/try.mjs "你的文本" "另一段"    # 跑指定文本
 *
 * API Key 取值顺序：环境变量 TYPESAFE_API_KEY → ~/.dsh/settings.yaml 的 dsh-jev.apiKey。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 从 settings.yaml 里抠出 dsh-jev 段的 apiKey（只为试跑脚本服务，不做完整 YAML 解析）。 */
function savedApiKey() {
  try {
    const text = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    const at = text.indexOf('\ndsh-jev:')
    if (at < 0) return ''
    const match = /^\s+apiKey:\s*(\S+)\s*$/m.exec(text.slice(at))
    return match === null ? '' : match[1]
  } catch {
    return ''
  }
}

const key = String(process.env.TYPESAFE_API_KEY ?? '').trim() || savedApiKey()
if (key === '') {
  console.error('没有 API Key：设置 TYPESAFE_API_KEY，或先在设置页里保存一个。')
  process.exit(1)
}
process.env.TYPESAFE_API_KEY = key

/** 最小假 ctx：只要够 apply() 跑起来、并能拿到 RPC 处理函数。 */
const injections = []
const warnings = []
const ctx = {
  logger: { warn: (message) => warnings.push(String(message)) },
  on() {},
  inject(deps, callback) { injections.push({ deps, callback }) },
}
apply(ctx, {})

let handle
for (const item of injections) {
  if (item.deps.includes('connection')) {
    item.callback({
      // 宿主会先确认 webServer 在，再调 rpc.handle（第三个参数 options 是必填）。
      webServer: { register: () => () => {} },
      connection: { rpc: { handle: (_channel, fn) => { handle = fn; return () => {} } } },
    })
  }
}

const SAMPLES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  '测试一下 jev',
  '我都等了三天了！你们这个破接口一直报错，订单一直在丢，再没人管我就直接退款走人了！',
  '请问你们的 API 支持哪些付款方式？',
  '我不太确定这个配置是不是写错了……能帮我看看吗，有点慌。',
]

console.log('Key 来源：' + (process.env.TYPESAFE_API_KEY === savedApiKey() ? '~/.dsh/settings.yaml' : 'TYPESAFE_API_KEY 环境变量'))
console.log('')

for (const state of SAMPLES) {
  const started = Date.now()
  const result = await handle('jev.test', { state })
  if (result.ok !== true) {
    console.log('✖ RPC 失败：' + JSON.stringify(result.error))
    continue
  }
  const value = result.value
  console.log('──────── ' + JSON.stringify(state.slice(0, 46) + (state.length > 46 ? '…' : '')) + '  (' + (Date.now() - started) + 'ms)')
  if (value.ok !== true) {
    console.log('  ✖ ' + value.error)
    continue
  }
  for (const line of String(value.text).split('\n')) console.log('  ' + line)
  console.log('')
}

if (warnings.length > 0) console.log('warn: ' + warnings.join(' | '))