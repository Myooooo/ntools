# nTools

本地优先的 AI 效率工作台：**nChat 聊天 + 待办（Todo AI 识别）+ 二维码 / Markdown / 图片工具**。

纯静态 HTML，双击即用，无需服务器、安装或构建；所有数据只保存在本机浏览器。

![nTools](img/main.png)

## 使用

1. 下载整个文件夹并保持目录结构。
2. 双击 `ntools.html` 打开（推荐 Chromium 102+，支持奇安信可信浏览器 / Chrome / Edge）。
3. 首次使用：点击左下角齿轮 →「模型端点」添加一个 OpenAI 兼容端点；需要 Todo AI 时再配置「Todo AI」。
4. 环境确认：左下角「⋮」→「兼容性自检」；纯函数回归选「回归测试」。

> 不使用 ES Module、构建产物或外网资源；离线可直接运行。

## 配置

### 模型端点

- 设置 →「模型端点」→「新增端点」：填写 **Base URL**（通常以 `/v1` 结尾）、**API Key**、**Model ID**。
- 支持多个端点：可测试连接、设为当前、导入/导出；聊天与 Todo AI 共用端点。
- 每个端点可单独设置聊天系统提示词；API Key 只保存在本机。
- 旧版 nChat 的端点配置会自动合并；也可在端点列表底部点击「从旧 nChat 导入」。

### 聊天与 Todo AI

- **nChat**：流式回复、思考过程、停止生成、图片输入、Token 统计、按端点独立会话与系统提示词。
- **Todo AI**：设置 →「Todo AI」选择端点并配置系统提示词、Temperature、Top P；提示词自动注入当前日期时间、星期、时区及下班时间。

### 通用

- 设置 →「通用」：深色/浅色主题、**Light 性能模式**（关闭高级动效与页面特效）、下班时间（用于「下班前」等快捷时间）。

### 内网网关（CORS）

`file://` 打开时请求 `Origin: null`，内网网关需放行：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: authorization, content-type`
- `Access-Control-Allow-Methods: POST, OPTIONS`

## 数据与隐私

- 所有数据（端点、会话、待办）保存在本机浏览器 `localStorage`，仅访问你配置的模型端点。
- 旧版 `nchat-settings` / `nchat-conversation` 首次启动自动迁移。
- 清理浏览器或换电脑前，请在「设置 → 数据」导出备份。

## 许可

[MIT License](LICENSE)
