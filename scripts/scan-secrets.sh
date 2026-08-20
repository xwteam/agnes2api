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
# **评审四审 B 组第 5 条：`git grep` 的退出码原来被静默吞掉。**
# 原来写的是 `if git grep …; then 命中; fi`——`git grep` 的约定是
#   0 = 有命中、1 = 没命中、**>1 = 出错**（坏的正则、坏的 pathspec、不在 git 仓库里、
#   索引损坏……）。`if` 只分"零/非零"，于是**出错被当成"没命中"**，这个脚本照样打印
# "✅ 未发现疑似凭据"并 exit 0。这是一道安全门禁，而我们刚刚才因为同一道门禁的
# `-I` 盲区吃过一次亏（见上面），"扫不动"绝不能等于"扫干净了"。
# 现在显式取退出码，只认 0 与 1 两种，其余一律 fail closed。
fail=0
for p in "${PATTERNS[@]}"; do
  git grep --untracked -nnE "$p" -- ':!scripts/scan-secrets.sh' ':!*.lock' ':!pnpm-lock.yaml'
  status=$?
  case $status in
    0)
      echo "❌ 命中疑似凭据模式: $p" >&2
      fail=1
      ;;
    1) ;; # 没有命中，正常
    *)
      echo "❌ git grep 执行失败（退出码 $status），模式: $p —— 扫不动不等于扫干净，按失败处理" >&2
      fail=1
      ;;
  esac
done

[[ $fail -eq 0 ]] && echo "✅ 未发现疑似凭据"
exit $fail
