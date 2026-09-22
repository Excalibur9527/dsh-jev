# dsh-jev

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 **JEV 情绪 / 意图判定**插件。

每一轮对话，插件会把用户**最新一条消息**发给 [typesafe.ai](https://typesafe.ai) 的 `systemone`(jev) 接口，
按你配置的问题集合拿到判定结果（情绪、紧急度、分流部门……），再把结果作为一条**带来源标记的运行时上下文**
注入本步请求，让模型据此调整语气与优先级。所有参数都在 GUI 的 **设置 → JEV 情绪分析** 里配置。

```
用户消息 ──► agent/pre-step ──► jev /v1/systemone ──► 判定结果(fragment)
                                                   └──► 追加一条 user 消息（source.kind='plugin'）──► 模型
```

## 安装

```bash
# 方式一：走 dsh 自带的插件管理（推荐，会写进 profile 的 dependencies 与 bundles）
dsh plugin --profile web add /path/to/dsh-jev

# 方式二（本机开发态 link 装法）：直接软链 + 改 profile 清单
ln -sfn /path/to/dsh-jev ~/.dsh/profiles/web/node_modules/dsh-jev
# 然后在 ~/.dsh/profiles/web/package.json 里：
#   dependencies:  "dsh-jev": "link:/path/to/dsh-jev"      # 必须是绝对路径
#   dsh.profile.bundles: 追加 "dsh-jev"
```

更省事的一种：克隆到固定位置后，把仓库目录本身当作插件路径传给 `dsh plugin add`。

**装完必须重启 `dsh web` 宿主进程**：profile 的层栈在启动时组装，运行中的 loader 不会自动接入新插件。

> link 安装时插件目录在 profile 之外，裸包名（`@deepseek-ai/dsh-llm` 等）解析不到，
> 需要先跑一次 `node scripts/link-deps.mjs` 把依赖软链到本插件自己的 `node_modules`。

## 设置页

重启后在 **设置 → JEV 情绪分析** 里配置：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 启用 JEV 判定 | 开 | 关掉后完全不再调用接口 |
| 把判定结果注入模型上下文 | 开 | 关掉后仍然调用并记录，但不往请求里塞内容 |
| API Key | 空 | 存在 `~/.dsh/settings.yaml` 的 `dsh-jev.apiKey`，schema 标了 `role('secret')`，**不会**经浏览器的 RPC 回传；没配时回落到环境变量 `TYPESAFE_API_KEY` |
| 接口地址 | `https://api.typesafe.ai/v1/systemone` | 自建/代理时改这里 |
| 模型 | `jev-latest` | 接口的 `model` 字段 |
| 超时（毫秒） | 8000 | 超时即跳过本轮注入，不阻塞对话 |
| 最大输入字符 | 4000 | 超出部分截断后再发 |
| 附加给模型的行为提示 | 见默认值 | 跟在判定结果后面一起注入 |
| 判定问题 questions | 部门/情绪/紧急度三条 | 支持 `noul`（是/否）、`score`（评分，criteria 每行一档）、`choice`（单选，criteria 每行 `键=说明`） |

设置页还有：**运行测试**（用当前配置真打一次接口，展示渲染结果与原始 JSON）、**最近调用**（时间/耗时/结果/最近错误）。

## 工作方式与取舍

- **只在有新用户消息的那一步调用**：`agent/pre-step` 的 batch 里出现 `source.kind === 'user'` 的消息时才调；
  工具步、插件自己注入的上下文都不会再触发。
- **不打断对话**：没配 key、接口 4xx/5xx、超时、网络错，统统只记一条 `warn` 并原样放行。
- **不会自激**：注入消息的 `source.kind === 'plugin'`，下一轮的特征判断会跳过它。
- **相同输入 5 分钟内复用结果**，避免重试或多步重复计费（设置页的「运行测试」不走缓存）。
- 判定长度计入上下文，压缩前会一直留在历史里；不想要就关掉「注入模型上下文」。

## 开发

```bash
node scripts/try.mjs                            # 手动试跑几段样例（走设置页「运行测试」同一条通道）
node scripts/try.mjs "你这破接口又挂了！"        # 或指定要判定的文本
node scripts/link-deps.mjs                      # 软链宿主依赖（link 安装时必须）
node --check lib/index.js && node --check client/client.js
TYPESAFE_API_KEY=xxx node --test test/host.test.mjs test/client.test.mjs
```

- `lib/index.js` —— 宿主半边：`agent/pre-step` 注入、settings 命名空间、`/dsh-jev` 的包私有 RPC。
- `client/client.js` —— 浏览器半边：手写的 CJS 工厂包（`window.__ModuleLoader__.load`），
  注册进 `settings.section` 槽位，**不需要打包器**。
- `test/` —— 宿主用假 cordis ctx 驱动真实的 `apply()`（含真接口调用）；客户端用最小 React 桩真实渲染组件。
- `scripts/try.mjs` —— 命令行试跑：Key 取 `TYPESAFE_API_KEY` 或 settings.yaml 里存的那个。

## 已知限制

- 判定结果只作为自然语言上下文注入，不改变任何工具的必填字段（比如 tool 的参数不会被自动填）。
- 分数型问题返回的是连续值（例如 `1.42`），注入文本里的档位说明取最接近的整数档。
- 只在 Web profile 验证过；headless/TUI 里注入照常工作，但设置页需要 Web GUI。
- 设置页通道注册成 `{ authority: 'loopback' }`（与 dsh-pocket 一致，也和 DSH 自己对 settings 平面的限制一致）：
  只有从本机 loopback 打开的页面能读写设置，经局域网/隧道打开时会明确报错而不是静默失败。
- 通道注册依赖 `connection` 与 `webServer` 两个服务；宿主不再同时提供它们时，注入照常工作，
  只有设置页不可用，并在宿主日志里留一条 warn。
