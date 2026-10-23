# ShrimpTerm

一个带 AI agent 的 SSH 客户端。多标签终端 + 每个连接独立的运维助手 + 一个掌控整个应用的全局助手。

界面参照 MobaXterm / SecureCRT 的思路，agent 参照「能看见它敲什么」的原则 —— 所有命令都打在你看得见的终端里。

```
┌ 🦐 ShrimpTerm                                    ⚙ 设置  ─  □  ✕ ┐
├──┬───────────┬──────────┬────────────────────────┬──────────────┤
│★ │ 会话    + │ 对话  «  │                        │ 本会话  记忆 » │
│▷ │ 📁 生产    │ 磁盘检查 │  ✦ Agent               │              │
│  │  ● A     │ 部署 ×   │  （全屏对话）           │  子 agent    │
│  │          │          │                        │              │
│⚙ │  文件     │          │  ┌──────────────┐ ↑   │              │
└──┴───────────┴──────────┴────────────────────────┴──────────────┘
```

## 三个组成部分

| | 位置 | 能做什么 | 记忆 |
|---|---|---|---|
| **终端** | 标签行 | 真 SSH 会话、多标签拖拽排序、镜像输入、可搜索 | — |
| **主 Agent** | `✦ Agent` 标签，全屏 | 读本机信息、**完全掌控本应用**（增删改连接/改设置/读终端/读所有对话）、联网 | 多对话，持久化 |
| **子 Agent** | 右侧「本会话」 | **只能往这一个终端打字** —— 这是唯一能真正操作服务器的 agent | 按连接持久化 |

主 agent 没有本机 shell，这是刻意的限制：它管应用，不管操作系统。

## 技术栈

**零框架。** agent 是一个手写的 tool-calling 循环（`main.js` 里的 `runAgent`，约 90 行），没有 LangChain / CrewAI / RAG / 向量库。

```
渲染进程 (Electron renderer)  ← 无网络权限，全部走 IPC
      │ window.st.ask()
      ▼
主进程 (Node)
      ├── SSH 连接池        ssh2（纯 JS，无原生模块）
      ├── LLM 调用          OpenAI 兼容 /chat/completions
      ├── 工具执行          localInfo / appAction / fetchText / writeTo
      └── 回推动作          app:cmd → 渲染进程执行
```

依赖只有 3 个运行时包：`ssh2`、`iconv-lite`、`@xterm/*`。

## 目录

```
main.js              911 行   主进程：SSH 池、agent 循环、工具、设置/主机/记忆读写
renderer/app.js     1489 行   界面逻辑：终端、标签拖拽、markdown、对话、弹窗、右键菜单
renderer/index.html  726 行   结构与样式（浅/深两套调色板）
preload.js            43 行   安全桥，暴露 22 个 IPC 通道
assets/                       🦐 图标（png / 256px / 7 尺寸 ico）
hosts.json                    连接种子（部署时复制进 app 目录）
deploy.ps1                    部署：同步 → 校验 IPC 对齐 → 重启
```

## 开发与部署

```powershell
# 安装依赖
npm install

# 部署到本机已安装的应用并重启（开发时用这个）
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

`deploy.ps1` 会做完这些：停进程 → 复制全部源码和 node_modules → **校验 preload 的每个 IPC 通道在 main 里都有 handler** → 重启。

打包产物的位置：`%LOCALAPPDATA%\Programs\shrimp-term\`。

### 首次运行

会要求填 agent API（OpenAI 兼容）：

```
Base URL   https://api.deepseek.com/v1
API Key    sk-...
模型       deepseek-flash
```

点「测试连接并进入」会真调一次 `/models` 验证；也可以点「稍后设置，先用终端」跳过。

## Agent 工具清单

**主 agent（`app_control`，24 个动作）**

```
连接   list_hosts / add_host / update_host / delete_host / add_group
会话   list_sessions / open_host / close_session / focus_session
       get_session_output / send_to_session / switch_view
对话   list_conversations / get_conversation
设置   get_settings / set_theme / set_accent / set_font_size
       set_terminal_theme / open_settings / new_conversation / clear_conversation
```

外加 `local_info`（本机 CPU/内存/磁盘/网络/系统，只读）和 `web_fetch`。

**子 agent（1 个工具）**

```
run_in_terminals(command, note)   ← 往选中的终端里打字，等输出
```

## 运行时数据

不在源码里，在安装目录的 `resources/app/` 下：

| 文件 | 内容 |
|---|---|
| `hosts.json` | 连接列表 |
| `settings.json` | 主题、字号、agent API（**API Key 明文存储**） |
| `history.json` | 所有 agent 对话记忆 |

## 已知问题

1. **子 agent 拿输出靠"等固定时间 + 抓末尾"** —— `sleep(900 + 命令长度×12)` 后取 `tail` 最后 1500 字符。慢命令或大输出会读不全。正解是按 shell 提示符切分。
2. **8 轮之外的历史不进上下文** —— 只能靠模型主动调 `get_conversation` 去读。
3. **无重试与幂等** —— 同一命令被连发两次就会执行两次。
4. **`app_control` 没有二次确认** —— agent 能删连接，一句话就删。
5. **API Key 明文存 `settings.json`** —— 未用 DPAPI 加密。
6. **不恢复上次打开的标签** —— 重启后要手动重连（记忆还在）。

## 许可

图标来自 [Microsoft fluentui-emoji](https://github.com/microsoft/fluentui-emoji)（MIT）。
