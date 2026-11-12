# 第三方依赖与许可

本项目为纯静态、离线可用的 HTML 应用，所有第三方依赖均已本地化（`js/` 目录），不依赖 CDN 或外网。

| 库 | 版本 | 许可 | 用途 | 文件 |
|---|---|---|---|---|
| marked | 15.0.12 | MIT | Markdown → HTML | `js/marked.min.js` |
| DOMPurify | 3.4.9 | Apache-2.0 OR MPL-2.0 | HTML/Markdown XSS 净化 | `js/purify.min.js` |
| qrcode.js | 未标注（上游 davidshimjs/qrcodejs） | MIT | 二维码生成 | `js/qrcode.min.js` |

## 文件校验和（SHA-256）

```
3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c  js/marked.min.js
3c16cc90eb152b823b71b8585cd79e7fb7cd7a380157a800dfbd9459aad5f726  js/purify.min.js
c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36  js/qrcode.min.js
```

## 升级与来源记录

- `marked.min.js`：v15.0.12，来源 npm 包 `marked@15.0.12`（MIT）。
- `purify.min.js`：v3.4.9，来源 `dompurify@3.4.9`（Apache-2.0 OR MPL-2.0），升级原因：3.0.6 受 CVE-2024-47875 等 mXSS 影响。
- `qrcode.min.js`：项目历史文件（davidshimjs/qrcodejs 风格实现），未标注版本；如需审计建议替换为带版本号的上游构建。

## 注意

- 不要为 vendor 文件添加 SRI（`integrity`）：`file://` 下无 CORS 响应头，SRI 校验会失败并阻止脚本加载。
- vendor 文件保持原样，不二次压缩/改写；升级时同步更新本文件的版本与 SHA-256。
- 本项目自有代码采用 MIT License，见 `LICENSE`。
