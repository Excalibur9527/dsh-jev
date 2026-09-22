/**
 * 给「link: 安装方式」的开发态插件补一个本地 node_modules：
 * 把宿主依赖(@deepseek-ai/dsh-llm / dsh-settings / schemastery …)软链到
 * 当前 DSH 安装自带的同名包上，这样插件放在 profile 目录之外也能解析裸包名。
 *
 * 用法：node scripts/link-deps.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/schemastery',
]

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const anchor = process.env.DSH_RESOLVE_ANCHOR ?? join(homedir(), '.dsh', 'profiles')
const require = createRequire(join(anchor, 'noop.js'))

let linked = 0
for (const spec of PACKAGES) {
  let entry
  try {
    entry = require.resolve(spec, { paths: [anchor] })
  } catch (error) {
    console.error('跳过 ' + spec + '：在 ' + anchor + ' 下解析不到（' + error.code + '）')
    continue
  }
  const packageDir = dirname(dirname(entry))
  const target = join(pluginDir, 'node_modules', ...spec.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) rmSync(target, { recursive: true, force: true })
  symlinkSync(packageDir, target, 'dir')
  console.log('链接 ' + spec + ' -> ' + packageDir)
  linked += 1
}
console.log('完成：' + linked + '/' + PACKAGES.length)
