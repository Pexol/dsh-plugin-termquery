# dsh-plugin-termquery

> **学习与阅读提效工具** —— 给 DeepSeek Harness 的「划词快问」宿主插件：把选中的名词**直接送进 Agent**，再把回答读回来。不抢焦点、不闪屏。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f8ef7)

---

## 简介

`dsh-plugin-termquery` 是一个**学习与阅读提效工具**：它是运行在 **DeepSeek Harness（DSH）** 宿主进程里的 Cordis 插件，对外暴露一组本地 HTTP 接口，让任意「划词取词」工具把选中的名词直接投递给正在运行的 Agent，并读取它的回复。

它解决的是最影响体验的一个问题：**传统方案靠模拟 `Ctrl+C` / `Ctrl+V` / `Enter` 往别的窗口里塞文字，会抢焦点、会闪屏、还可能误发。** 这个插件改成在宿主内部调用 `ctx.agents.followup()`，消息直接进入 Agent 的收件箱——界面完全不动。

## 特性

- **零打扰投递**：调用 Agent API，而非键盘/剪贴板注入，不切窗口、不闪屏。
- **真双向对话**：通过 `session.deriveMessages()` 把助手回复读回来，不只是"发出去就不管"。
- **真实 token 压力**：用 `ctx.tokenMeter.measure()` 读取会话真实 token 占用，为"上下文溢出"提供准确依据。
- **会话归档**：一键把当前会话导出为 JSON，落在 `D:\TermQueryData\backups\`。
- **即插即用**：标准 DSH bundle，安装后出现在插件列表、可随时开关；卸载即干净移除。
- **纯回环**：只监听 `127.0.0.1`，不对外网暴露。

## 工作原理

```
┌─────────────────────┐     HTTP (loopback)      ┌──────────────────────────┐
│  取词工具 / 外部 UI   │  ───────────────────────▶ │  dsh-plugin-termquery    │
│  热键 / 剪贴板 / OCR  │  POST /termquery/ask      │  (DSH 宿主 Cordis 插件)   │
│                      │ ◀─────────────────────── │                          │
└─────────────────────┘  GET /messages /pressure  └───────────┬──────────────┘
                                                               │ ctx.agents.followup()
                                                               │ session.deriveMessages()
                                                               │ ctx.tokenMeter.measure()
                                                               ▼
                                                    ┌──────────────────────────┐
                                                    │  DSH Agent / Session     │
                                                    └──────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|---|
| 宿主 | DeepSeek Harness（Electron）+ Cordis 插件框架 |
| 运行时 | Node.js ≥ 22，ESM（`"type": "module"`） |
| 框架服务 | `@deepseek-ai/dsh-host-webserver`、`dsh-agent`、`dsh-session`、`dsh-token-meter` |
| 传输 | `node:http` 原生 HTTP + JSON（仅回环） |
| 文件 | `node:fs` / `node:path` |

## 安装

1. 把本仓库放进 DSH profile 的依赖目录：

   ```
   C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-plugin-termquery
   ```

2. 编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`：
   - 在 `dependencies` 增加 `"dsh-plugin-termquery": "0.1.0"`
   - 在 `dsh.profile.bundles` 数组加入 `"dsh-plugin-termquery"`

3. 重启 DSH。插件加载成功后：
   - 插件列表出现「dsh-plugin-termquery（启用中）」
   - 生成 `D:\TermQueryData\runtime.json`，内含实际端口

## 快速验证

```bash
cat D:/TermQueryData/runtime.json
curl http://127.0.0.1:<port>/termquery/health
```

`/health` 还会返回各框架服务是否就绪：

```json
{
  "ok": true,
  "plugin": "dsh-plugin-termquery",
  "version": "0.1.0",
  "port": 58999,
  "base": "/termquery",
  "services": { "agents": true, "sessions": true, "tokenMeter": true, "llm": true }
}
```

## API

所有接口挂在 `http://127.0.0.1:<port>/termquery` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 + 服务自检 |
| GET | `/sessions?detail=1&limit=` | 会话卡片：标题 / 预览 / 最近时间 / 已绑模型（冷会话经 `inspect()` 读日志派生，带缓存） |
| GET | `/models` | 列出可用模型（provider / model / 推理档） |
| GET | `/model-info?provider=&model=` | 读取模型能力（上下文 / 输出上限 / 推理档） |
| POST | `/select-model` | 为会话选定 `provider / model / reasoningEffort` |
| POST | `/ask` | `{ "sessionId": "...", "text": "..." }` 发送问题 |
| GET | `/messages?sessionId=&limit=` | 最近消息（live 用 `deriveMessages()`，冷会话回落 `inspect()`） |
| GET | `/events?sessionId=&limit=` | 只读：导出最近会话事件（调试/派生用） |
| GET | `/pressure?sessionId=` | 真实 token 压力 + 上下文窗口 |
| POST | `/archive` | `{ "sessionId": "..." }` 导出会话备份 JSON |

> **安全说明**：所有路由都套了异常兜底（`safe()`），任何 handler 报错只返回 500，不会终止宿主进程。`/model-info` 调用底层 `resolveModelInfo(provider, model)` **必须同时传入 provider 与 model**——裸调用会抛 `NO_ADAPTER`。

### 示例

```bash
curl -X POST http://127.0.0.1:<port>/termquery/ask \
  -H "content-type: application/json" \
  -d '{"sessionId":"<id>","text":"页表与段表是什么意思？"}'

curl "http://127.0.0.1:<port>/termquery/messages?sessionId=<id>&limit=10"
curl "http://127.0.0.1:<port>/termquery/pressure?sessionId=<id>"
curl -X POST http://127.0.0.1:<port>/termquery/archive \
  -H "content-type: application/json" -d '{"sessionId":"<id>"}'
```

Node 调用示例见 [`examples/termquery-client.mjs`](./examples/termquery-client.mjs)。

## 数据落盘

```
D:\TermQueryData\
  runtime.json     # 插件运行时信息（端口等）
  backups\         # 会话归档 JSON
```

## Roadmap

- [x] **v0.1** 宿主插件：HTTP API（投递 / 读回 / token 压力 / 归档）
- [ ] **v0.2** 服务自检 + 冷会话自动 resume
- [ ] **v0.3** 内置面板：React + `dsh-client-runtime`，把 TermQuery UI 长进 DSH
- [ ] **v0.4** 配套取词小工具：全局热键 / 剪贴板监听 / Windows OCR
- [ ] **v0.5** 结构化知识库（SQLite）+ 学科表格 + 高频/薄弱标注

## 已知限制

- `/sessions` 只列出**运行中**的 Agent；持久化但未加载的"冷会话"不会出现（v0.2 计划支持自动 resume）。
- `tokenMeter` 对中文文本的估算偏低，`/pressure` 应作为参考而非计费数据。
- 目前只覆盖 DSH；Workbuddy 等其它宿主不在本插件范围内。

## 免责声明

本项目为个人学习与效率工具，与 DeepSeek 官方无关。使用前请确认你了解本地接口的访问风险；插件仅监听回环地址。

## License

[MIT](./LICENSE)
