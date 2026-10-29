# 更新日志

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.0.0] - 2026-10-29

首个公开版本。

### 新增

- **四种对局模式**：我执白、我执黑、AI 对 AI、双人本地。
- **四类接口**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini 原生 API。
- **实时思维链**：模型支持时逐字显示推理过程，并展示每步耗时、HTTP 状态与 token 用量。
- **摆棋编辑器**：开局前或对局中途都能改局面，支持载入与复制 FEN，局面不合法会明确拦下。
- **五档思考强度**：低、中、高、极高、最大，另可填写自定义强度文本；按服务商与模型代次自动映射到
  `reasoning_effort`、`output_config.effort`、`thinkingBudget` 或 `thinkingLevel`。
- **多套接口配置**：白方与黑方可各挑一套，AI 对 AI 时两边能跑不同模型。
- **完整对局管理**：悔棋、暂停、翻转、走子动画、上一步高亮、可走位置提示、升变选择。
- 安装包与免安装压缩包两种分发形式，均附带 SHA256 校验文件。

### 安全

- 配置文件使用 Windows DPAPI 加密，只有当前 Windows 用户能解密。
- 合法着法白名单加三级解析：模型只能从实际合法着法中选，解析依次尝试 JSON 字段、UCI 坐标、SAN 词元。
- 悔棋、暂停、结束、摆棋会立即作废在途请求，旧着法不会落到新局面。
- 请求由 Rust 侧发出，前端不接触 API Key 之外的凭据，也不受浏览器 CORS 限制。

### 说明

- 仅支持 Windows x64，需要 WebView2 运行时。
- 未附代码签名证书，首次运行会触发 SmartScreen 提示。
- 不含自动更新，升级方式是重新下载。
