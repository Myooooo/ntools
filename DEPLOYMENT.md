# nTools 外部部署（GCS + Cloudflare + PWA）

本项目是纯静态应用，不需要构建，也没有服务端。推荐部署结构：

```text
浏览器 / PWA
  └─ Cloudflare（DNS / 代理 / HTTPS / Access / 缓存规则）
       └─ Google Cloud Storage 静态网站（bucket）
            └─ ntools.html + css/ + js/ + img/ + manifest.webmanifest + sw.js
```

> 个人使用优先把 Cloudflare Access 打开，不要公开一个无认证的工具箱地址。
> 每台设备的数据各自保存在浏览器本地；跨设备请用「设置 → 数据」导出/导入，或手动备份 ZIP。

---

## 1. GCS bucket

### 1.1 静态网站配置

```bash
# 变量
BUCKET=your-ntools-bucket

# 入口页：ntools.html
gsutil web set -m ntools.html -e ntools.html "gs://$BUCKET"

# 允许公开读取（如果使用 Cloudflare Access 登录，GCS 这一层仍需要可被 Cloudflare 取到）
gsutil iam ch allUsers:objectViewer "gs://$BUCKET"
```

如果使用统一负载均衡/自定义域名 HTTPS，按 GCP 文档配置后端 bucket；仅有 GCS 静态网站时，自定义域名的 HTTPS 通常由 Cloudflare 代理完成。

### 1.2 上传

只上传运行所需文件，**不要上传** `docs/`、`tools/`、`.git/`、测试产物：

```bash
gcloud storage rsync . "gs://$BUCKET" \
  --recursive \
  --delete-unmatched-destination-objects \
  --exclude='(^|/)(docs|tools|checks|\.git)(/|$)' \
  --exclude='(^|/)(README\.md|DEPLOYMENT\.md|LICENSE|\.gitignore|\.gcloudignore)$' \
  --exclude='(^|/)img/main\.png$'
```

部署后必须能看到：

```text
/ntools.html
/manifest.webmanifest
/sw.js
/js/pwa.js
/css/tokens.css
/img/pwa-192.png
/img/pwa-512.png
/img/pwa-maskable-512.png
/img/apple-touch-icon.png
```

### 1.3 Content-Type

GCS 一般按扩展名推断；确认：

```bash
gsutil setmeta -h "Content-Type:application/manifest+json" "gs://$BUCKET/manifest.webmanifest"
gsutil setmeta -h "Content-Type:application/javascript" "gs://$BUCKET/sw.js"
gsutil setmeta -h "Content-Type:application/javascript" "gs://$BUCKET/js/pwa.js"
```

### 1.4 缓存头

Service Worker 和 manifest 绝不能长缓存，否则更新不生效：

```bash
gsutil setmeta -h "Cache-Control:no-cache, max-age=0, must-revalidate" "gs://$BUCKET/ntools.html"
gsutil setmeta -h "Cache-Control:no-cache, max-age=0, must-revalidate" "gs://$BUCKET/sw.js"
gsutil setmeta -h "Cache-Control:no-cache, max-age=0, must-revalidate" "gs://$BUCKET/manifest.webmanifest"
```

静态资源可以长缓存（入口页已 no-cache，且 SW 版本会更新）：

```bash
gsutil -m setmeta -h "Cache-Control:public, max-age=604800" \
  "gs://$BUCKET/css/*.css" \
  "gs://$BUCKET/js/*.js"
```

> `js/workshop/builtin/`、`js/mail/` 也按静态资源长缓存；SW 的 `CACHE_VERSION` 负责版本切换。

---

## 2. Cloudflare

### 2.1 DNS / SSL

- 域名 A/CNAME 指向 GCS（按 GCS 静态网站或负载均衡要求）。
- 代理状态：橙色云（Proxied）。
- SSL/TLS 模式：优先 **Full (strict)**（GCS 侧需支持 HTTPS）；如果源站只有 HTTP 静态网站，使用 Cloudflare 允许的模式并避免把源站 HTTP 暴露给公网，按你的 GCS/负载均衡实际配置选择。
- 开启 Always Use HTTPS、HSTS（确认所有子域都支持 HTTPS 后）。

### 2.2 缓存规则

在 Cloudflare Cache Rules 中：

| 路径 | 策略 |
| --- | --- |
| `/sw.js` | Bypass cache（必须） |
| `/manifest.webmanifest` | Bypass cache 或短缓存 |
| `/ntools.html` | Bypass cache / no-store，保证新入口 |
| `/css/*`, `/js/*`, `/img/*` | Cache eligible；部署后 Purge Everything 或按 URL purge |

部署后：

```text
Cloudflare → Caching → Purge Cache → Purge Everything
```

等 30 秒再刷新；Service Worker 的更新由 `js/pwa.js` 提示。

### 2.3 Cloudflare Access（强烈建议）

- Zero Trust → Access → Applications → 新建 Self-hosted。
- 域名：你的 nTools 域名。
- 策略：Allow，限定自己的邮箱/OTP/Google/GitHub。
- Session 时长按需要设置。
- 这样未登录访问会被 Cloudflare 拦住，PWA 安装后首次打开也会走登录；登录后 SW 缓存仍可用。

### 2.4 安全响应头（Transform Rules）

建议添加：

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

CSP 已写在 `ntools.html` 的 meta 中（包含生成工坊所需的 inline/`frame-src` 例外），Cloudflare 侧不要重复添加冲突的 CSP。

---

## 3. PWA

### 3.1 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.webmanifest` | 名称、图标、start_url、standalone、主题色 |
| `sw.js` | 离线壳 + 静态缓存；导航网络优先 |
| `js/pwa.js` | 注册 SW；更新提示；controllerchange 刷新 |
| `img/pwa-*.png` | 192 / 512 / maskable |
| `img/apple-touch-icon.png` | iOS 180 |

### 3.2 安装

- **iPhone/iPad**：Safari → 分享 → 添加到主屏幕。iOS 不支持安装提示，必须手动添加。
- **Android Chrome**：地址栏安装图标，或菜单 → 安装应用。
- **桌面 Chrome/Edge**：地址栏安装图标。
- 安装后以 `standalone` 打开，顶栏/底栏使用 safe-area；刘海屏由 `viewport-fit=cover` + `env()` 处理。

### 3.3 更新流程

1. 修改代码后，把 `sw.js` 中的 `CACHE_VERSION` 改成新版本（例如 `ntools-v9.0.1`）。
2. 上传新文件；清理 Cloudflare 缓存（入口/SW 必须）。
3. 已打开页面会在后台发现新 SW，弹出「新版本已就绪」提示；点「刷新」。
4. 未点刷新时，新 SW 等待所有旧页面关闭；下次打开生效。
5. 不要给 `sw.js` 设置长缓存；不要把 SW 放进 GCS 的公开长缓存。

### 3.4 离线范围

- 应用壳、CSS/JS、内置工具、邮箱页、图标会被预缓存。
- 本地待办/笔记/邮箱/设置照常可用（IndexedDB/localStorage）。
- AI 对话与任何自定义 HTTP 端点需要网络；离线时会失败，这是预期。
- 自定义生成的小工具如果是 `srcdoc`，不依赖网络；如果引外部资源，离线不可用。

### 3.5 验证

```text
Chrome DevTools → Application → Manifest：无错误
Application → Service Workers：activated and running
Application → Cache Storage：ntools-v9.0.0
Network → Offline → reload：应用壳仍打开
```

如果 SW 状态是 `waiting`：点页面提示的「刷新」，或关闭所有标签页再打开。

---

## 4. 数据与迁移

- 存储按 **origin** 隔离：`file://`、`http://旧地址`、`https://新域名` 是三份数据。
- 从本地/内网迁移到新域名：
  1. 旧地址：设置 → 数据 → 一键备份 ZIP / 导出 JSON。
  2. 新地址：设置 → 数据 → 导入。
  3. 确认待办、笔记、邮箱、创意工坊、AI 端点都在。
- 每台设备独立；不做自动同步。手机和电脑之间用备份 ZIP/JSON 手动迁移。
- API Key 在导出时是明文，妥善保管备份文件。
- 清空浏览器数据会删除本地数据与自动备份；重要数据请下载到磁盘。

---

## 5. API / CORS / 网络

- AI 端点由用户在设置里填写；浏览器直接请求，受 CORS 限制。
- 若端点只在内网，外部手机需 Tailscale/VPN 或网关反向代理；不要把内网网关无认证暴露公网。
- 公网端点需允许你的站点 origin、`authorization` / `content-type` 头、POST/OPTIONS。
- 邮箱数据不离开设备；邮件页是本地 iframe。
- 外部部署不会自动同步 API Key；手机和电脑分别配置。

---

## 6. 回滚

- 保留上一版 GCS 对象/目录（或 bucket 版本管理）。
- 回滚后清理 Cloudflare 缓存，尤其是 `ntools.html`、`sw.js`、`manifest.webmanifest`。
- 如 SW 缓存导致旧页面，关闭所有标签页再打开，或 DevTools → Application → Service Workers → Unregister，再清 Cache Storage。
- 数据迁移不删除旧 origin，可回旧地址导出。

---

## 7. 上线检查清单

- [ ] HTTPS 证书有效，HTTP 自动跳转 HTTPS
- [ ] Cloudflare Access 已开启（如需要）
- [ ] 未登录无法访问
- [ ] `/manifest.webmanifest` 200 且 MIME 正确
- [ ] `/sw.js` 200、`Cache-Control: no-cache`
- [ ] `js/pwa.js` 200，注册无 console error
- [ ] PWA 可安装，standalone 打开
- [ ] 离线重新加载应用壳
- [ ] iPhone/Android 顶栏/底栏 safe-area 正常
- [ ] 手机竖屏 9:21、横屏左导轨、设置面板、键盘可用
- [ ] AI 端点可连（或已说明需 VPN）
- [ ] 数据可导出/导入
- [ ] Cloudflare 缓存已 purge

---

## 8. 常见问题

**SW 一直 waiting**
：点「新版本已就绪」的刷新；或关闭所有标签页。确认 `sw.js` 是无缓存。

**安装了但没有离线**
：确认访问的是 HTTPS；首次加载后等 SW activated；DevTools Cache Storage 应出现 `ntools-v9.0.0`。

**更新后仍是旧页面**
：Cloudflare 缓存了 `ntools.html` 或 `sw.js`；把这两个路径设为 Bypass，purge 后重试。

**iOS 顶部/底部被刘海遮住**
：必须用 `viewport-fit=cover` + safe-area；当前代码已处理，PWA standalone 下再确认。

**手机外部打不开 AI**
：端点在内网；使用 Tailscale/VPN/网关，或换公网端点。
