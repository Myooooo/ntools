#!/usr/bin/env bash
# ============================================================================
# tools/screenshot.sh — 批量截图自查（Chrome for Testing / Chromium headless）
#
# 用法：
#   tools/screenshot.sh                 # 输出到 /tmp/nc-shots
#   tools/screenshot.sh /tmp/my-shots   # 指定输出目录
#
# 产物（可直接重复执行，覆盖同名文件）：
#   <page>-<state>-<width>.png
#   page  : index | ntools | compat-check
#   state : dark | light | lite        （lite = 深色 + Lite 模式）
#   width : 1440 | 390                 （移动端高度 844，桌面 900）
#
# 说明：
# - 通过临时 seed 页写入 localStorage（nchat-theme / nchat-lite-mode）再跳转目标页，
#   因为 Chrome 的 --screenshot 不能注入脚本；file:// 下所有本地 HTML 共享存储，故生效。
# - 使用独立临时 profile，不影响本机浏览器数据；脚本结束自动清理。
# - 可覆盖环境变量：
#     CHROME_BIN        指定浏览器可执行文件
#     NC_SHOT_PAGES     逗号分隔，默认 "index.html,ntools.html,compat-check.html"
#     NC_SHOT_STATES    逗号分隔，默认 "dark,light,lite"
#     NC_SHOT_WIDTHS    逗号分隔，默认 "1440,390"
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/nc-shots}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
PAGES_CSV="${NC_SHOT_PAGES:-index.html,ntools.html,compat-check.html}"
STATES_CSV="${NC_SHOT_STATES:-dark,light,lite}"
WIDTHS_CSV="${NC_SHOT_WIDTHS:-1440,390}"

# ---------- 浏览器可执行文件 ----------
if [ ! -x "$CHROME" ]; then
    for candidate in \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/opt/homebrew/bin/chromium" \
        "$(command -v chromium 2>/dev/null || true)" \
        "$(command -v chromium-browser 2>/dev/null || true)" \
        "$(command -v google-chrome 2>/dev/null || true)"
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
    done
fi
if [ ! -x "$CHROME" ]; then
    echo "错误：找不到 Chrome/Chromium。可用 CHROME_BIN=/path/to/chrome 指定。" >&2
    exit 1
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# seed 页放临时目录（不传 --user-data-dir：Chrome for Testing 在 macOS 上
# 使用自定义 user-data-dir + headless 会有概率卡住；默认临时 profile 更稳）
SEED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nc-shots-seed.XXXXXX")"
trap 'rm -rf "$SEED_DIR"' EXIT

file_url() {
    # 转成合法 file:// URL（处理空格/中文路径）；无 python3 时退化为直接拼接
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$1" <<'PY'
import os, sys, urllib.parse
print('file://' + urllib.parse.quote(os.path.abspath(sys.argv[1])))
PY
    else
        printf 'file://%s\n' "$1"
    fi
}

# 兼容 macOS 自带 bash 3.2（不使用 mapfile）：逗号分隔 → 空格分隔
PAGES="${PAGES_CSV//,/ }"
STATES="${STATES_CSV//,/ }"
WIDTHS="${WIDTHS_CSV//,/ }"

MANIFEST="$OUT/manifest.txt"
: > "$MANIFEST"
echo "浏览器: $CHROME"
echo "输出目录: $OUT"

fails=0
total=0
started_at="$(date '+%Y-%m-%d %H:%M:%S')"

for page in $PAGES; do
    target_file="$ROOT/$page"
    if [ ! -f "$target_file" ]; then
        echo "SKIP  $page（文件不存在）"
        continue
    fi
    page_name="${page%.html}"
    target_url="$(file_url "$target_file")"

    for state in $STATES; do
        case "$state" in
            dark)  theme='dark';  lite='false' ;;
            light) theme='light'; lite='false' ;;
            lite)  theme='dark';  lite='true'  ;;
            *)     echo "SKIP  未知状态 $state（可选 dark|light|lite）"; continue ;;
        esac

        # 每一轮都重建 seed，避免重定向缓存/并发问题
        seed="$SEED_DIR/seed-${page_name}-${state}.html"
        cat > "$seed" <<EOF
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>seed</title></head>
<body>
<script>
try {
  localStorage.setItem('nchat-theme', '$theme');
  localStorage.setItem('nchat-lite-mode', '$lite');
} catch (err) { /* 存储不可用时忽略，截图仍可继续 */ }
location.replace('$target_url');
</script>
</body></html>
EOF
        seed_url="$(file_url "$seed")"

        for width in $WIDTHS; do
            case "$width" in
                1440) height=900 ;;
                390)  height=844 ;;
                *)    height=900 ;;
            esac
            name="${page_name}-${state}-${width}.png"
            shot="$OUT/$name"
            rm -f "$shot"

            "$CHROME" \
                --headless=new \
                --disable-gpu \
                --no-sandbox \
                --no-first-run \
                --no-default-browser-check \
                --disable-extensions \
                --disable-background-networking \
                --disable-sync \
                --hide-scrollbars \
                --force-device-scale-factor=1 \
                --window-size="${width},${height}" \
                --virtual-time-budget=9000 \
                --screenshot="$shot" \
                "$seed_url" >/dev/null 2>&1

            total=$((total + 1))
            if [ -s "$shot" ] && [ "$(wc -c < "$shot" | tr -d ' ')" -gt 2000 ]; then
                printf 'OK    %s\n' "$shot"
                printf '%s\t%s\t%s\t%s\n' "$name" "$state" "$width" "$(date '+%Y-%m-%d %H:%M:%S')" >> "$MANIFEST"
            else
                fails=$((fails + 1))
                printf 'FAIL  %s（未生成或文件过小）\n' "$shot" >&2
            fi
        done
    done
done

{
    echo "# nTools/nChat 截图清单"
    echo "# 开始: $started_at"
    echo "# 结束: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# 共 $total 张，失败 $fails 张"
    echo "# 名称	状态	宽度	时间"
    cat "$MANIFEST"
} > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"

echo "--------------------------------------------"
echo "共生成 $((total - fails))/$total 张截图 → $OUT"
if [ "$fails" -ne 0 ]; then
    echo "有 $fails 张失败，请检查上方日志。" >&2
    exit 1
fi
exit 0
