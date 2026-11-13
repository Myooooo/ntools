#!/usr/bin/env bash
# tools/check.sh — 一键验收：语法 + 页面级 + 交互 E2E + 纯函数断言
# 用法：bash tools/check.sh
# 可用环境变量：CHROME=<Chrome/Chromium 可执行文件路径>
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== 1/7 语法检查 =="
for f in js/*.js; do
    if ! node --check "$f"; then
        echo "  FAIL  $f"
        fail=1
    fi
done
[ "$fail" -eq 0 ] && echo "  全部通过"

echo
echo "== 2/7 页面级验收（verify.js：ntools + checks/compat-check + checks/tests） =="
node tools/verify.js || fail=1

echo
echo "== 3/7 交互 E2E（e2e.js） =="
node tools/e2e.js || fail=1

echo
echo "== 4/7 新功能 E2E（e2e-features.js） =="
node tools/e2e-features.js || fail=1

echo
echo "== 5/7 全景时间线 E2E（e2e-timeline.js） =="
node tools/e2e-timeline.js || fail=1

echo
echo "== 6/7 v4.1 交互 / Todo 新功能 E2E（e2e-v41.js） =="
node tools/e2e-v41.js || fail=1

echo
echo "== 7/7 纯函数回归（checks/tests.html 无头运行） =="
node tools/run-tests.js || fail=1

echo
if [ "$fail" -eq 0 ]; then
    echo "✅ 全部验收通过"
else
    echo "❌ 存在失败项（见上方输出；详情 /tmp/nc-verify.json）"
fi
exit "$fail"
