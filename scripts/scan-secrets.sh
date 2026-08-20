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

# **评审 F3：这里原来带 `-I`，字面意思就是"跳过二进制文件"**——公开仓的
# "零内置凭据"门禁对着任何被 git 判定为二进制的跟踪文件完全失明（已实测：
# `storage-file.ts` 因为一个字面 NUL 字节被判成二进制之后，塞一段能匹配上面
# 任一条正则的假凭据进去，门禁照样放行）。去掉 `-I` 之后二进制文件里的疑似
# 凭据同样会被扫到（git grep 对二进制匹配只报"Binary file ... matches"，
# 同样会被下面的 `if` 分支捕获并让这一步失败）。`scripts/check-no-binary.mjs`
# （第 11 道门禁）从根上不让这类文件存在，这里是第二道防线，两者缺一不可——
# 万一有人绕开或跳过第 11 道门禁单独跑这个脚本，这里依然不会失明。
fail=0
for p in "${PATTERNS[@]}"; do
  if git grep --untracked -nnE "$p" -- ':!scripts/scan-secrets.sh' ':!*.lock' ':!pnpm-lock.yaml'; then
    echo "❌ 命中疑似凭据模式: $p" >&2
    fail=1
  fi
done

[[ $fail -eq 0 ]] && echo "✅ 未发现疑似凭据"
exit $fail
