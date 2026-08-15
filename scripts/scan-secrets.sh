#!/usr/bin/env bash
# 扫描仓库中是否混入真实凭据或私有部署细节。CI 与提交前均应运行。
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'
  'AC-[0-9a-f]{20,}'
  'mk_[A-Za-z0-9_-]{20,}'
  'g2a_[A-Za-z0-9_-]{20,}'
  '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}'
)

fail=0
for p in "${PATTERNS[@]}"; do
  if git grep --untracked -nInE "$p" -- ':!scripts/scan-secrets.sh' ':!*.lock' ':!pnpm-lock.yaml'; then
    echo "❌ 命中疑似凭据模式: $p" >&2
    fail=1
  fi
done

[[ $fail -eq 0 ]] && echo "✅ 未发现疑似凭据"
exit $fail
