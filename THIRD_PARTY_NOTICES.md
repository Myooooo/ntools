# 第三方依赖与许可

本项目为纯静态、离线可用的 HTML 应用，所有第三方依赖均已本地化（`js/` 目录），不依赖 CDN 或外网。

| 库 | 版本 | 许可 | 用途 | 文件 |
|---|---|---|---|---|
| marked | 15.0.12 | MIT | Markdown → HTML | `js/marked.min.js` |
| DOMPurify | 3.4.9 | Apache-2.0 OR MPL-2.0 | HTML/Markdown XSS 净化 | `js/purify.min.js` |
| KaTeX | 0.16.22 | MIT | 聊天/Markdown 的数学公式渲染（**按需加载**，不在首屏） | `js/katex.min.js`、`css/katex.min.css`、`css/fonts/KaTeX_*.woff2` |
| qrcode.js | 未标注（上游 davidshimjs/qrcodejs） | MIT | 二维码生成（**按需加载**，不在首屏） | `js/qrcode.min.js` |
| Lucide 图标（子集） | 随包内联，未标注版本 | ISC | 邮件管理页的图标 | `js/mail/mail-icons.js` |

## 文件校验和（SHA-256）

```
3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c  js/marked.min.js
28f64e54ad69c75e5659f98731460af569fd691051872818d7a1314a90082222  js/purify.min.js
c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36  js/qrcode.min.js
e8d885505949f3a5f4abdd5dd0d53696bd1371ad26ffbf4f310dcd77c8cdae89  js/katex.min.js
19095127357ed6d29fe0a63a6b000c913a89f7f1963b765dd3715e97c9852e75  css/katex.min.css
```

## 升级与来源记录

- `marked.min.js`：v15.0.12，来源 npm 包 `marked@15.0.12`（MIT）。
- `purify.min.js`：v3.4.9，来源 `dompurify@3.4.9`（Apache-2.0 OR MPL-2.0），升级原因：3.0.6 受 CVE-2024-47875 等 mXSS 影响。仅删除文件末尾的 `sourceMappingURL` 注释（未随包提供 .map，留着会让 DevTools 报 404），代码未改动。
- `katex.min.js` / `katex.min.css`：v0.16.22，来源 npm 包 `katex@0.16.22`（MIT），2026-11 补登；字体只保留 `woff2`（Chromium 102 支持），首屏不加载。
- `qrcode.min.js`：项目历史文件（davidshimjs/qrcodejs 风格实现），未标注版本；v5.4 起改为**按需加载**，首屏不再解析。如需审计建议替换为带版本号的上游构建。
- `js/mail/mail-icons.js` 的 Lucide 图标子集：上游 ISC 许可；v5.12 起从 HTML 内联块抽成独立文件。相关改造计划见 `docs/audit-and-refactor-plan.md` §5。

## 注意

- 不要为 vendor 文件添加 SRI（`integrity`）：`file://` 下无 CORS 响应头，SRI 校验会失败并阻止脚本加载。
- vendor 文件保持原样，不二次压缩/改写；升级时同步更新本文件的版本与 SHA-256。
- 本项目自有代码采用 MIT License，见 `LICENSE`。
