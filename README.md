# ShrimpTerm

[![CI](https://github.com/cb-Lobster/shrimp-term/actions/workflows/ci.yml/badge.svg)](https://github.com/cb-Lobster/shrimp-term/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cb-Lobster/shrimp-term?include_prereleases&label=release)](https://github.com/cb-Lobster/shrimp-term/releases)
![license](https://img.shields.io/badge/license-MIT-green)

ShrimpTerm 是一款面向个人的 Windows SSH 工作区。可以在同一标签里分屏运行 Vim 和日志窗口，同时让助手在后台查询主机。任务输出留在状态栏的「后台任务」，终端键盘继续由你使用。

## 使用

1. 在主机库搜索主机，或输入 `user@host` 后按 Enter 填写连接配置。支持分组、网格与列表、收藏和最近连接。按 `Ctrl+K` 搜索并切换已打开的标签。
2. 第一次连接时，通过可信渠道核验窗格提供的 SHA256 指纹，再点「信任并连接」。发现已记录的目标指纹变化时，应用会阻止连接；核实服务器确实更换密钥后，可在用户目录的 `known-hosts.json` 移除对应地址的旧条目，再走首次核验。
3. 点「分屏」可左右或上下打开另一条 SSH 会话。拖动分隔线调整大小。断线后点「重新连接」，在原窗格的新 Shell 继续使用，之前的滚动历史会保留。
4. 在「设置 → Agent API」配置 OpenAI 兼容接口。按 `Ctrl+Shift+A` 打开助手，例如问「根分区还剩多少空间？」。内置磁盘、内存和运行时长查询在后台运行。其他命令先生成任务卡，确认后执行。
5. 在底部「后台任务」查看命令、主机、标准输出、错误输出和退出状态。后台任务使用提问时的 SSH 登录目标。前台 `cd`、`sudo`、tmux、二次 SSH 和编辑器未保存的内容均独立于任务通道。
6. 连接后点顶部「SFTP」浏览当前窗格对应的主机。输入绝对路径或双击文件夹，使用「上传」和「下载」传输单个文件，进度和取消按钮在面板底部。
7. 从主机库或快速切换菜单打开「常用命令」，保存、编辑或复制命令片段。终端搜索使用 `Ctrl+Shift+F`。

镜像输入仅对手动选定的窗格生效。Agent 命令始终走后台通道。

## 开发与安装

需要 Node.js 20 或以上。Windows 安装包由 NSIS 生成，默认按当前用户安装。

~~~powershell
npm ci
npm start              # 构建工作区组件，运行 Electron
npm run check          # IPC 契约、TypeScript、后台任务和 SSH 回归
npm run smoke          # 隔离数据目录中的 Electron 冒烟测试（模拟 SSH 和模型）
npm run installer      # 生成 dist 中的 Windows 安装包
~~~

运行时数据位于 `%APPDATA%\ShrimpTerm`。v0.5 沿用旧主机、偏好设置和对话历史。SSH 密码和 API Key 使用 Electron safeStorage。任务记录可在应用内查看，删除对话时可一并清理已完成任务。

## 架构与回归

~~~text
窗口中的窗格 → xterm.js → IPC → SSH shell（带 PTY）
助手发起的操作 → 任务策略 → 同一 SSH 连接的独立 exec → 后台任务记录
用户操作文件 → 同一 SSH 连接的独立 SFTP 通道 → 目录 / 传输记录
~~~

主进程持有 SSH 客户端、凭据和任务策略。主机库、分屏布局和任务视图由 React / TypeScript / Vite 构建，xterm 实例按窗格管理。后台任务通过 SSH 退出状态结算，断线后不会重放。

- **手动复现**　连接测试主机 A 后，在 Vim 插入模式留一行未保存的文字。在助手中提交磁盘查询并收起助手，切到主机 B 再返回。检查任务仍归 A，Vim 模式、光标及缓冲区保持原样。
- **自动联调**　在有 OpenSSH 和 Vim 的 Linux 上运行 `npm run test:ssh`。用例创建一次性 SSH 密钥、回环监听和临时 Vim 配置，CI 中单列该测试。详见 [v0.5 开发规格](agent.md)。

## 许可

本项目使用 [MIT](LICENSE)。工作区交互参考 [NetCatty](https://github.com/binaricat/Netcatty)。虾图标来自 [Microsoft fluentui-emoji](https://github.com/microsoft/fluentui-emoji)。
