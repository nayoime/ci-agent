# AGENTS.md · 给改这个项目的 AI

Ciallo Agent：原生 Node.js（>=22）编程代理 + 网页界面。**零依赖、无构建**，不要引入 npm 包或打包工具（KaTeX 是唯一的第三方代码，已放在 `web/vendor/`）。

## 目录

```
src/
  server.js            网页服务与全部 HTTP 接口（只监听 127.0.0.1，令牌 + Host/Origin 校验）
  cli.js               命令行入口（调试用）
  config.js            data/config.json 读写，resolveModel() 补默认值
  mcp.js               MCP 客户端（stdio / Streamable HTTP），读根目录 mcp.json，热更新
  skills.js            技能扫描：skills/<名>/SKILL.md 与 <项目>/.ci/skills/<名>/SKILL.md
  agent/
    agent.js           代理循环：调模型 → 执行工具 → 回填，压缩、删除对话、空白提交 run(null)
    session.js         会话持久化 <项目>/.ci/sessions/<id>.jsonl（追加写，reset 记录整体替换）
    context.js         .ci 目录、AGENTS.md/CLAUDE.md、项目提示词 prompt.md、项目开关 project.json
    prompt.js          系统提示词（中文）；纯对话模式 buildChatPrompt
    compaction.js      上下文压缩
    tokens.js          token 估算
  protocol/
    index.js           按 provider.protocol 分发；思考档位映射（THINK_PRESETS / OFFICIAL_THINK）
    openai.js anthropic.js gemini.js   三种协议适配器，统一事件流
    sse.js             SSE 解析与 HTTP 错误
  tools/
    index.js           工具注册表（内置 + MCP 延迟加载）
    codec.js           工具名/参数在 native 与 claude 风格间双向映射
    read write edit bash ls glob grep subagent toolsearch compact memory .js
web/                   原生 JS 前端：app.js（全部界面逻辑）markdown.js logo.js style.css index.html
data/                  config.json（含明文 API Key）、projects.json —— 已 gitignore
skills/                全局技能
mcp.json               MCP 服务器配置
test/                  node --test
```

## 必须遵守

- **内部消息格式是协议无关的**：`{role: user|assistant|tool, content}`，助手内容块为 `text / thinking / tool_call`。协议差异只能写在 `src/protocol/*.js` 的 `toWire` 和流解析里，不要让上层知道协议。新增协议需同时改：`protocol/index.js` 分发、`config.js` 与 `server.js` 的协议校验、`web/app.js` 的协议下拉。
- **工具名经过 codec**：发给模型的名字可能是 `Read` 也可能是 `read`。提示词里引用工具用 `{read}` 占位或 `codec.wireName()`，不要写死。
- **会话文件只追加**：改上下文（压缩、删除）写 `{type:"reset", messages}`，不要重写 jsonl。消息上的 `stats`、`details` 只给界面用，适配器不能发给模型。
- **项目数据放项目自己的 `.ci/`**：会话、prompt.md、project.json、项目技能。全局数据放 `data/`。不要把项目数据写到全局。
- **系统提示词保持精简中文**，不加安全审查、冗余规则类提示词。改提示词前先问用户。
- **安全边界不能动**：只监听 127.0.0.1、令牌校验、Host/Origin 校验、CSP、静态文件路径限制、技能文件路径校验。改到这些要先说明。
- 前端无框架：用 `h()` 建 DOM；插 HTML 只能用 `renderMarkdown()` 的输出（它先转义再处理）。不要用 innerHTML 拼用户或模型内容。
- 文件可能是 CRLF 换行，脚本批量替换前确认匹配成功。

## 验证

```
npm test                       # 单元测试
node --check web/app.js        # 前端语法
node src/server.js --port 8799 --no-open   # 另起端口自测，别动用户在 8787 上跑着的服务
```

改完后端要提醒用户重启服务（`start.bat`），前端刷新即可。`start.bat` 会请求管理员权限。
