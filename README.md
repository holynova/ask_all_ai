<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Ask All AI — 一个问题，四家大模型同时回答：ChatGPT、Gemini、Grok、DeepSeek 并排流式对比">
</p>

<p align="center">
  <a href="https://xiaosang.cc/ask-all-ai/">▶ 在线预览界面 Preview UI</a>
  ·
  <a href="https://holynova.github.io/ask_all_ai/">GitHub Pages 备选镜像</a>
  ·
  <a href="https://github.com/holynova/ask_all_ai">GitHub 仓库</a>
</p>

> 在线链接是静态界面预览；完整功能（提问、流式回答）需要本地运行，并安装 OpenCLI。

Ask All AI 是命令行工具 [`@jackwener/opencli`](https://github.com/jackwener/opencli) 的可视化界面：一个问题同时发给 ChatGPT、Gemini、Grok、DeepSeek 四家大模型，回答流式并排呈现，直接对比内容、耗时与质量。本地 Node 服务零依赖，调用你本机已登录的 opencli，本项目不存任何 API 密钥。

Ask All AI is a visual front end for the [`@jackwener/opencli`](https://github.com/jackwener/opencli) CLI: ask one question and get ChatGPT, Gemini, Grok, and DeepSeek answering side by side in real time, so you can compare content, latency, and quality directly. The local Node server has zero dependencies and shells out to the opencli you already logged in with — no API keys stored here.

## 截图 / Screenshots

<p align="center">
  <img src="./assets/readme/screenshot-ui.png" width="100%" alt="真实界面：四张模型卡待命（ChatGPT、Gemini、Grok、DeepSeek），下方提问框与模型勾选">
</p>

## 功能 / Features

- **并发提问**：一次提问，四家模型同时作答；每个模型可单独勾选开关。
- **流式对比**：SSE 逐字推流，四张卡并排呈现，回答过程看得见。
- **耗时对比**：每张卡独立计时，回答快慢一目了然。
- **多轮追问**：追问沿用同一会话（opencli `--conversation`），可就某个回答继续聊。
- **两种视图**：并排对比 / 标签页对比切换。
- **Markdown 渲染**：回答按 Markdown 渲染，代码块一键复制。
- **取消与清空**：随时取消正在进行的提问；一键清空历史。
- **诊断面板**：逐个检查四家模型的可用性与登录状态（调 opencli 的 `status` 命令；Gemini 因 OpenCLI 1.8.0 未提供 status，改用 `gemini new` 检查）。
- **限制**：单个问题最长 8,000 字；单次提问超时 120 秒。`Ctrl` + `Enter` 发送。

## 本地运行 / Run Locally

前置要求：Node.js，以及全局安装并登录好的 `@jackwener/opencli`（鉴权由 opencli 负责，各模型需先在 opencli 里登录）。

```bash
npm install -g @jackwener/opencli   # 按 opencli 文档登录各模型
node server.js                       # 默认 http://localhost:3000
PORT=8080 node server.js             # 改端口
```

## 技术 / Tech

- 服务端 `server.js`：原生 Node `http` 模块，零依赖；`spawn` 调用 opencli 子进程（`opencli <模型> ask <问题> --timeout 120 -f json`），用 SSE 把输出流式推给前端。
- 接口：`GET /ask`（SSE 提问）、`GET /cancel?requestId=`（取消）、`GET /api/models`（模型列表）。
- 前端是单个 `index.html`（HTML + CSS + JS，无构建）。

```
index.html          前端：四模型卡片 / 提问框 / 诊断面板 / 历史
server.js           本地服务：零依赖，spawn opencli，SSE 推流
package.json        npm start 即 node server.js
```

## English

**Ask All AI** is a GUI for the [`@jackwener/opencli`](https://github.com/jackwener/opencli) CLI: one question goes to ChatGPT, Gemini, Grok, and DeepSeek at once, and their answers stream side by side so you can compare content, latency, and quality in real time.

- **Ask in parallel**: toggle each of the 4 models on/off; every card streams independently over SSE with its own elapsed-time readout.
- **Follow up**: follow-ups continue the same conversation (`--conversation`); cancel anytime; clear history in one click.
- **Two views**: side-by-side or tabbed comparison. Answers render as Markdown with one-click code copying.
- **Diagnostics panel**: checks each model's availability and login state (via opencli `status`; Gemini uses `gemini new` since OpenCLI 1.8.0 exposes no Gemini status).
- **Limits**: 8,000 characters per question, 120-second timeout per ask. `Ctrl` + `Enter` to send.
- **Run it**: needs Node.js plus a globally installed, logged-in `@jackwener/opencli` — auth lives in opencli, no keys stored here. `node server.js`, then open http://localhost:3000 (or set `PORT`).
- **Tech**: zero-dependency Node `http` server spawning opencli; SSE endpoints `/ask`, `/cancel`, `/api/models`; single-file frontend.
