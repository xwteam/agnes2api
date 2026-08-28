#!/usr/bin/env bash
# ── agnes2api 推送前复跑清单（可执行的那一份）────────────────────────────────
#
# 用法：
#   bash scripts/prepush.sh                        # 六格全跑，末尾打一张逐格表
#   bash scripts/prepush.sh --print-gates [ci 路径] # 干跑：把从 ci.yml 抽出来的门禁原样打出来，
#                                                  # **一道都不执行**。第二个参数只给
#                                                  # tests/unit/prepush-guard.test.ts 的夹具用。
#
# **为什么有这个脚本。** 推送前的清单原来只是一份 markdown
# （`.superpowers/sdd/prepush/checklist.md`），里面写死的 HEAD / 提交数 / 邮箱分布
# **落地当天就开始过期**；而且它缺一条谁都没在守的：**工作树干净**。
# 本仓的工作流经常把变异探针留在树里（勘察实测到过 `admin-ui/js/ui.js` 被塞进一个探针
# 函数、生成物跟着漂），而 `.github/workflows/ci.yml` 那十二道门禁**没有一道**校验
# 「你手上这棵树是不是干净的」——CI 看的是已经推上去的那个提交，推之前手上多出来的东西
# 它一个字都看不见。
#
# ⚠️ **形态：`set -uo pipefail`，顶层没有 `-e`。这是有意的，加回去会毁掉这个脚本的用途。**
# 它必须**逐格跑完再汇总**，不是 fail-fast：在一次性历史重写落地之前，③④⑤ 是**已登记的
# 预期红**（③ 会红是因为 ci.yml 的凭据扫描那一步自己就把历史那一档包在里面），
# fail-fast 会在 ③ 停住，④⑤⑥ 永远拿不到证据——而「哪几格红、红的是不是已登记的那几格」
# 恰恰是推送前唯一想读出来的那个结论。
# ⚠️ 但**每一格自己跑在 `( set -e; … )` 子壳里**：格内的意外失败（git 不在、日志读不到）
# 必须当场把这一格弄红，不许被「下一行照跑」吞掉。
# ⇒ **顶层无 `-e`（所以六格都跑得完），格内有 `-e`（所以格内没有静默失败）。**
#   `grep -c` 那种「没匹配 = exit 1」的命令因此必须自己带 `|| true`，见 ⑤ 那一格。
#
# ⚠️ **「预期中的红」不是豁免**：那几格照样算没过，整体退出码照样是 1。
#   给自己开豁免的清单，下一次就会被人当成绿的。
#   每一格的预期红都带着**自己的收窄条件**（见各格），条件不成立一律按真红处理。
#
# ⚠️ **这个脚本自己不是门禁的一道**，它是把已有的十二道按 ci.yml 的顺序重跑一遍，
#   再补上 CI 结构上看不见的那几格（工作树、分支、作者身份、测试计数）。
#   十二道从 ci.yml **当场抽**，不在这里手抄一份——手抄的那份会漂，而漂了没人会发现。
set -uo pipefail
cd "$(dirname "$0")/.."

CI_FILE=".github/workflows/ci.yml"

# ── 从 ci.yml 抽门禁 ────────────────────────────────────────────────────────
# 抽出来的是**每一步的 `run:` 块原文**加上**它该用哪个 shell 跑**。
# GitHub 对 `run:` 的默认 shell 是 `bash -e {0}`；显式写了 `shell: bash` 的那几步是
# `bash --noprofile --norc -eo pipefail {0}`（多一个 `pipefail`）。
# ⚠️ **这两句是 GitHub 文档写的值，本机没有 runner，验不到**（同 ci.yml 里
#    `actions/checkout` 默认浅仓那一条，登记在案）。本机验得到的是下面这半句：
#    本仓有**两步**靠 `pipefail` 才成立（`pnpm … 2>&1 | tee` 那两条管道——没有它，
#    `pnpm` 失败会被 `tee` 的 0 盖掉），凭据扫描那一步靠的是 `-e`（第一条失败就中断），
#    这三步因此都在 ci.yml 里**显式**写了 `shell: bash`。
# 所以这里**按每一步自己声明的 shell 分档**，不是一律用同一套 flag——
# 一律 `-eo pipefail` 会让这份复跑比 CI 严，一律 `-e` 会让它比 CI 松，两种都不对。
#
# ⚠️ **「一共几道」是推出来的，不是写死的**：步名形如 `N/M`，判据要求所有 M 相同、
#   条数恰好等于 M、编号 1..M 各出现一次且按序。CI 里增删一步而没改名，这里当场吵；
#   整体改名成新的 M，这里跟着走，不用回来改这个脚本。
extract_gates() { # $1 = ci.yml 路径，$2 = 输出目录；stdout = 每道一行 `编号<TAB>flags<TAB>步名`
  LC_ALL=C awk -v out="$2" '
    {
      # 多行 `run: |` 块的续行：缩进 10 个空格（或空行）。剥掉那 10 个空格原样落盘。
      if (blk == 1) {
        if ($0 == "" || $0 ~ /^          /) { line = $0; sub(/^          /, "", line); print line > f; next }
        blk = 0; close(f); f = ""; num = ""
      }
      # 一个新的列表项（`- uses:` / `- name:` …）无条件重置状态：
      # 上一步的 `shell:` 绝不许漏到下一步身上。
      if ($0 ~ /^      - /) { num = ""; flags = "-e" }
      if ($0 ~ /^      - name: [0-9]+\/[0-9]+ /) {
        nm = substr($0, 15)                       # `      - name: ` 之后
        n = nm; sub(/\/.*$/, "", n)               # `N/M …` 的 N
        d = nm; sub(/^[0-9]+\//, "", d); sub(/ .*$/, "", d)   # 同一处的 M
        num = n; name[num] = nm; den[num] = d; order[++cnt] = num
        next
      }
      if (num != "" && $0 ~ /^        shell: bash[ \t]*$/) { flags = "-eo pipefail"; next }
      if (num != "" && $0 ~ /^        run: /) {
        rest = substr($0, 14)                     # `        run: ` 之后
        f = out "/" num ".sh"
        fl[num] = flags
        if (rest == "|") { blk = 1; next }        # 多行块，下面接着收
        print rest > f                            # 单行命令，就这一行
        close(f); f = ""; num = ""
        next
      }
    }
    END {
      if (blk == 1) close(f)
      for (i = 1; i <= cnt; i++) { k = order[i]; printf "%s\t%s\t%s\t%s\n", k, den[k], fl[k], name[k] }
    }
  ' "$1"
}

GATE_DIR=""
cleanup() { if [[ -n $GATE_DIR && -d $GATE_DIR ]]; then rm -rf "$GATE_DIR"; fi }
trap cleanup EXIT

GATE_MANIFEST=()
# 抽 + 自检。**认不出要吵，不能装没看见**：抽歪了最坏的形态是「少抽几行还照样 exit 0」，
# 那会让这份复跑安安静静地比 CI 少跑一截。
load_gates() { # $1 = ci.yml 路径
  local ci="$1" line num den flags name expect="" i=0
  if [[ ! -f $ci ]]; then
    echo "❌ 读不到 $ci —— 十二道是从它当场抽的，抽不到就没有可跑的东西" >&2
    return 2
  fi
  GATE_DIR=$(mktemp -d)
  GATE_MANIFEST=()
  while IFS= read -r line; do GATE_MANIFEST+=("$line"); done < <(extract_gates "$ci" "$GATE_DIR")
  if (( ${#GATE_MANIFEST[@]} == 0 )); then
    echo "❌ 从 $ci 里一道门禁都没抽出来 —— 判据认不出它的形态了（步名该长成 `N/M 说明`）" >&2
    return 2
  fi
  for line in "${GATE_MANIFEST[@]}"; do
    IFS=$'\t' read -r num den flags name <<<"$line"
    i=$((i + 1))
    if [[ -z $expect ]]; then expect="$den"; fi
    if [[ $den != "$expect" ]]; then
      echo "❌ $ci 里的门禁总数自相矛盾：有的步名说共 $expect 道，「$name」说共 $den 道" >&2
      return 2
    fi
    if [[ $num != "$i" ]]; then
      echo "❌ $ci 的门禁编号不是 1..$expect 顺序各一次：第 $i 个抽到的是「$name」" >&2
      return 2
    fi
    if [[ ! -s $GATE_DIR/$num.sh ]]; then
      echo "❌ 「$name」抽出来是空的 —— 它的 run: 块没被收进来，照这样跑等于少跑一道" >&2
      return 2
    fi
  done
  if (( ${#GATE_MANIFEST[@]} != expect )); then
    echo "❌ $ci 步名说共 $expect 道，实际只抽到 ${#GATE_MANIFEST[@]} 道 —— 少的那几道不会被跑到" >&2
    return 2
  fi
  return 0
}

# ── 干跑：只打印，不执行 ────────────────────────────────────────────────────
print_gates() { # $1 = ci.yml 路径
  local line num den flags name rc
  # ⚠️ 这里不写 `if ! load_gates …; then return $?; fi`：`!` 会把退出码取反，
  #    `$?` 在 then 分支里恒是 0 —— 抽歪了照样 exit 0，正是这个模式该防的那件事。
  load_gates "$1"
  rc=$?
  if (( rc != 0 )); then return "$rc"; fi
  for line in "${GATE_MANIFEST[@]}"; do
    IFS=$'\t' read -r num den flags name <<<"$line"
    printf '### GATE %s | %s | %s\n' "$num" "$flags" "$name"
    cat "$GATE_DIR/$num.sh"
  done
  return 0
}

case "${1:-}" in
  "") ;;
  --print-gates)
    print_gates "${2:-$CI_FILE}"
    exit $?
    ;;
  *)
    # 与 scripts/scan-secrets.sh 同一条规矩：手滑打错的参数不许静静跑成默认档。
    echo "❌ 认不出的参数「$1」。用法：prepush.sh [--print-gates [ci 路径]]" >&2
    exit 2
    ;;
esac

# ── 从 ci.yml 抄下来的三个常量，以及它们各自的核对方式 ──────────────────────
# 抄来的东西会漂，所以 ⑥ 那一格开头会回到 ci.yml 抽出来的真源上核对这三个值还在被用
# ——对不上就红在「⑥ 的常量与 ci.yml 对不上」，而不是安安静静地去读一个没人写的日志。
NODE_LOG="/tmp/test-node.log"
WORKERS_LOG="/tmp/test-workers.log"
BANNER='[collection-guard] ✅'

# ⚠️ **基线数：Task 35 之前最后一次全量跑当场取的，随取随改，它不是一个恒定常量。**
# 取法：跑一次 `pnpm test` / `pnpm test:workers`，抄尾部那两行
# `Test Files  N passed (N)` / `Tests  N passed (N)`。
# ⚠️ **写等号，绝不写 `>=`。** 本仓在这上面栽过一次，事情记在
# `tests/unit/docs-parity.test.ts` 的文件头：判据当时是「每种语言各自至少出现 N 次」，
# 把其中一处数字悄悄改错之后计数从 3 掉到 2、仍然满足「≥ 1」，门禁一声不吭。
# 推送前的仓库状态是确定的，一个确定的数才拦得住「悄悄少了一格用例」；
# 数字变了就该有人来改这四行。
EXPECT_NODE_FILES=133
EXPECT_NODE_TESTS=3632
EXPECT_WORKERS_FILES=38
EXPECT_WORKERS_TESTS=709

# ── 逐格框架 ────────────────────────────────────────────────────────────────
# 每一格返回：0 = 过；35 = **已登记的预期红**（历史重写落地前的 ④⑤，编号取自那个任务
# 的序号，好记且不会被别的命令意外撞上）；其余非 0 = 真的坏了。
EXPECTED_RED=35
MARK="EXPECTED-RED-UNTIL-TASK-35"

CELL_IDS=()
declare -A CELL_TITLE=()
declare -A CELL_STATUS=()

run_cell() { # $1 = 序号符 $2 = 标题 $3 = 函数名
  local id="$1" title="$2" fn="$3" rc
  CELL_IDS+=("$id")
  CELL_TITLE[$id]="$title"
  printf '\n════ %s %s ════\n' "$id" "$title"
  # 格内 `set -e`：格子里任何一条没被 `if` 接住的命令失败，这一格当场停并记红。
  ( set -e; "$fn" )
  rc=$?
  case $rc in
    0)               CELL_STATUS[$id]="PASS" ;;
    "$EXPECTED_RED") CELL_STATUS[$id]="$MARK" ;;
    *)               CELL_STATUS[$id]="FAIL(exit $rc)" ;;
  esac
  printf '──── %s %s\n' "$id" "${CELL_STATUS[$id]}"
}

# ── ① 工作树干净 ───────────────────────────────────────────────────────────
cell_worktree() {
  local dirty
  dirty=$(git status --porcelain)
  if [[ -n $dirty ]]; then
    printf '%s\n' "$dirty" >&2
    echo "❌ 工作树不干净，推送前不许有未提交改动 —— 上面每一行都是一处。" >&2
    echo "   本仓最常见的成因是变异探针没撤干净（改了 admin-ui/ 还会连带 src/ui/assets.generated.ts 一起漂）。" >&2
    echo "   ⚠️ 这一格是 ci.yml 那十二道结构上看不见的：CI 看的是已经推上去的提交，不是你手上这棵树。" >&2
    return 1
  fi
  echo "✅ git status --porcelain 无输出"
  return 0
}

# ── ② 只有 main ────────────────────────────────────────────────────────────
# 用户的硬约束：只留 main，不许开分支。
# 远端跟踪分支（`origin/main` 那种）单独放行——公开仓推出去之后它必然存在，
# 而它不是「开了一个分支」。放行判据按 `git remote` 当场列出来的远端名拼，
# 不写死 `origin`；`origin/feat/x` 这种照样打红。
# ⚠️ **那一支今天一次都没跑到过**：本仓至今没有远端（`git remote` 无输出），
#    所以这一格实际验过的只有「只有 main ⇒ 绿」。推仓当天第一次复跑要盯一眼这一格。
cell_branch() {
  local head branches b bad=0 remotes r ok
  head=$(git rev-parse --abbrev-ref HEAD)
  if [[ $head != main ]]; then
    echo "❌ 当前分支是「$head」，不是 main" >&2
    bad=1
  fi
  branches=$(git branch -a --format='%(refname:short)')
  remotes=$(git remote)
  while IFS= read -r b; do
    if [[ -z $b ]]; then continue; fi
    if [[ $b == main ]]; then continue; fi
    ok=0
    while IFS= read -r r; do
      if [[ -n $r && $b == "$r/main" ]]; then ok=1; fi
    done <<<"$remotes"
    if (( ok == 0 )); then
      echo "❌ 除 main 之外还有分支「$b」" >&2
      bad=1
    fi
  done <<<"$branches"
  if (( bad != 0 )); then
    echo "   用户的硬约束是只留 main、不开分支（远端跟踪的 <远端>/main 除外）。" >&2
    return 1
  fi
  echo "✅ HEAD = main；git branch -a 除 main 与远端跟踪的 <远端>/main 外无它"
  return 0
}

# ── ③ 十二道门禁，按 ci.yml 同序 ───────────────────────────────────────────
# ⚠️ 这里跑的是**从 ci.yml 当场抽出来的那几行原文**，不是本地另写的一套等价命令。
# 「本地那套和 CI 那套慢慢长歪」是这份清单最容易犯的错，抽真源就没有这个可能。
cell_gates() {
  local line num den flags name grc
  local -a fl failed=()
  for line in "${GATE_MANIFEST[@]}"; do
    IFS=$'\t' read -r num den flags name <<<"$line"
    fl=()
    read -r -a fl <<<"$flags"
    printf '\n>>> %s（bash %s）\n' "$name" "$flags"
    if bash "${fl[@]}" "$GATE_DIR/$num.sh"; then
      printf '<<< %s exit 0 ✅\n' "$name"
    else
      grc=$?
      printf '<<< %s exit %s ❌\n' "$name" "$grc" >&2
      failed+=("$num")
    fi
  done
  if (( ${#failed[@]} == 0 )); then
    echo "✅ ${#GATE_MANIFEST[@]} 道全过（顺序与退出码逐道见上）"
    return 0
  fi
  # ⚠️ **这一格在历史重写落地之前不可能全绿，而这不是本脚本的选择**：ci.yml 的凭据扫描
  #    那一步自己就把历史那一档包在里面，历史里那个泄漏 blob 还在，那一步就必红。
  #    直接记 FAIL 的代价是「每一次推送前复跑都带着一格 FAIL」——人会学会无视 FAIL，
  #    那比不报还糟。所以这里认这一种、且**只认这一种**：
  #    · 红的**只有一道**，而且红的正是把 `--history` 包在里面的那一步；
  #    · 同一个脚本的**工作树档单独跑是绿的**（多跑一次，秒级，换的是「不猜」）。
  #    两条都成立才算已登记的预期红——它照样不是 PASS，整体退出码照样是 1。
  #    ⚠️ 只要**还有第二道红**，一律按真红处理：预期那一格绝不许替别的红打掩护。
  if (( ${#failed[@]} == 1 )) && grep -qF -- "scan-secrets.sh --history" "$GATE_DIR/${failed[0]}.sh"; then
    if bash scripts/scan-secrets.sh >/dev/null 2>&1; then
      echo "⚠️ 唯一没过的那一道是把历史凭据扫描包在里面的那一步，而同一个脚本的工作树档单独跑是绿的" >&2
      echo "   ⇒ 这是**已登记的预期红**：历史里那个泄漏 blob 还在，处置是那次一次性历史重写。" >&2
      echo "   ④ 那一格把两条命令拆开单独记账，命中的原文在那里。" >&2
      return "$EXPECTED_RED"
    fi
    echo "❌ 那一道红，而且工作树档单独跑也是红的 ⇒ 这不是历史那笔欠账，是真回归" >&2
    return 1
  fi
  echo "❌ 有 ${#failed[@]} 道没过（编号 ${failed[*]}）—— 每一道的退出码就在它自己那一行" >&2
  return 1
}

# ── ④ 凭据扫描：两档分开记账 ───────────────────────────────────────────────
# ③ 里已经跑过 ci.yml 的凭据扫描那一步了，但那一步把两条命令合成一步：**红了分不清是
# 工作树回归还是历史那笔欠账**。这一格把两条拆开各自取退出码，因为这两件事的处置完全不同：
# · 工作树档红 ⇒ **真回归**，现在就得改；
# · 只有历史档红 ⇒ 历史里那个泄漏 blob 还在，处置是那次一次性历史重写
#   （见 `.superpowers/sdd/prepush/history-leak.md`），**不是放宽这道门禁**。
cell_secrets() {
  local wt hist
  echo "· 工作树档：bash scripts/scan-secrets.sh"
  if bash scripts/scan-secrets.sh; then wt=0; else wt=$?; fi
  echo "· 历史档：bash scripts/scan-secrets.sh --history"
  if bash scripts/scan-secrets.sh --history; then hist=0; else hist=$?; fi
  echo "   工作树档 exit $wt / 历史档 exit $hist"
  if (( wt != 0 )); then
    echo "❌ 工作树档红了 —— 这是真回归，与历史那笔欠账无关，现在就得改" >&2
    return 1
  fi
  if (( hist != 0 )); then
    echo "⚠️ 历史档红、工作树档绿 ⇒ 这是**已登记的预期红**：历史里那个泄漏 blob 还在。" >&2
    echo "   处置是那次一次性历史重写（它必须是推送前最后一步），不是放宽这道门禁。" >&2
    echo "   命中的原文见上面 stderr；边界与欠账见 scripts/scan-secrets.sh 文件头。" >&2
    return "$EXPECTED_RED"
  fi
  echo "✅ 两档都 exit 0"
  return 0
}

# ── ⑤ 无 AI 署名尾注；作者/提交者邮箱去重 = 1 ──────────────────────────────
# 坑 1：`grep -c .` 在**没有匹配**时 exit 1 —— 而「没有匹配」正是我们要的结果。
#   格内是 `set -e`，它会在一个完全健康的仓库上把这一格弄挂。
#   这是本仓方法论第 6 条的**镜像故障**：退出码 0 不等于事情做了，
#   **退出码非 0 也不等于事情坏了**。所以那个 `|| true` 不是装饰。
# 坑 2：作者邮箱今天是 2，历史重写的 `--mailmap` 之后才是 1。
#   只给 ④ 打「预期红」的补丁而漏了 ⑤，这个脚本一落地就有一格不该红的红。
#
# ⚠️ 「= 2 就算预期」不许写成一个裸的数字对比：**2 个邮箱里混进一个别人的**同样是 2。
#   所以下面还要求每一个邮箱都是 `xwteam@` 开头（提交作者一律 xwteam，是硬约束），
#   否则一律按真红处理。这一格的测法：历史重写落地后 authors 变 1 ⇒ 自动转 PASS，
#   预期红那一支再也不会触发；多出第三个邮箱或出现非 xwteam 的 ⇒ FAIL。
cell_authorship() {
  local trailers authors committers stray
  trailers=$(git log --all --format='%(trailers)' | grep -c . || true)
  authors=$(git log --all --format='%ae' | sort -u | wc -l)
  committers=$(git log --all --format='%ce' | sort -u | wc -l)
  stray=$(git log --all --format='%ae%n%ce' | sort -u | grep -cv '^xwteam@' || true)
  echo "   尾注非空行数 = $trailers（要求 0）"
  echo "   作者邮箱去重 = $authors / 提交者邮箱去重 = $committers（要求各 1）"
  git log --all --format='%ae%n%ce' | sort -u | sed 's/^/   · /'
  if (( trailers != 0 )); then
    git log --all --format='%h %(trailers)' | grep . >&2 || true
    echo "❌ 全历史出现了 $trailers 行尾注 —— 公开仓的提交绝不许带 AI 署名尾注" >&2
    return 1
  fi
  if (( stray != 0 )); then
    echo "❌ 有 $stray 个不是 xwteam@ 开头的作者/提交者邮箱（逐条见上）—— 这不是历史重写能顺手解决的那类" >&2
    return 1
  fi
  if (( authors == 1 && committers == 1 )); then
    echo "✅ 尾注 0；作者与提交者邮箱各只有一个"
    return 0
  fi
  if (( authors == 2 && committers == 2 )); then
    echo "⚠️ 尾注 0，但邮箱还没并成一个 ⇒ 这是**已登记的预期红**：" >&2
    echo "   两个邮箱都归 xwteam，要到那次一次性历史重写的 --mailmap 才合并。" >&2
    return "$EXPECTED_RED"
  fi
  echo "❌ 邮箱去重数既不是 1（已合并）也不是 2（已登记的待合并）—— 先搞清楚多出来的是谁" >&2
  return 1
}

# ── ⑥ 测试数与横幅同时校验 ─────────────────────────────────────────────────
# ⚠️ **不另发明一套取数方式**：③ 跑 ci.yml 那两步时已经用 `tee` 把两份日志落了盘、
#   并各自 `grep -qF` 过收集门禁的横幅。这一格读的就是那两份日志，在横幅之外再多问一句
#   「用例数对不对」——横幅只证明门禁跑过，证不了没人悄悄删掉一格用例。
# ⚠️ **不用 `| tail` 取结论**（本仓吃过退出码的亏），用锚到行首行尾的 `grep -c`，
#   并且要求**恰好一行**：日志里出现两行「Tests …」本身就是异常。
# ⚠️ 两份日志在脚本开头被删过一次，所以「日志不在」只有一个意思：③ 那两步根本没跑到 tee。
cell_counts() {
  local bad=0
  if ! assert_ci_still_uses "pnpm test 2>&1" "$NODE_LOG"; then bad=1; fi
  if ! assert_ci_still_uses "pnpm test:workers 2>&1" "$WORKERS_LOG"; then bad=1; fi
  if (( bad != 0 )); then
    echo "❌ ⑥ 抄在本脚本里的日志路径/横幅与 ci.yml 对不上了 —— 先去核对，别读一份没人写的日志" >&2
    return 1
  fi
  if ! check_log "$NODE_LOG" "Node 运行时" "$EXPECT_NODE_FILES" "$EXPECT_NODE_TESTS"; then bad=1; fi
  if ! check_log "$WORKERS_LOG" "workerd 运行时" "$EXPECT_WORKERS_FILES" "$EXPECT_WORKERS_TESTS"; then bad=1; fi
  if (( bad != 0 )); then return 1; fi
  echo "✅ 两个运行时的文件数、用例数与收集门禁横幅都对得上"
  return 0
}

# ci.yml 里跑 `$1` 的那一步，是不是仍然 tee 到 `$2`、并仍然 grep 同一条横幅。
assert_ci_still_uses() { # $1 = 命令锚 $2 = 期望的日志路径
  local anchor="$1" log="$2" f found=""
  for f in "$GATE_DIR"/*.sh; do
    if grep -qF -- "$anchor" "$f"; then found="$f"; fi
  done
  if [[ -z $found ]]; then
    echo "❌ ci.yml 里没有任何一步跑「$anchor」了" >&2
    return 1
  fi
  if ! grep -qF -- "tee $log" "$found"; then
    echo "❌ 跑「$anchor」那一步不再 tee 到 $log —— ⑥ 读的那份日志已经不是它写的了" >&2
    return 1
  fi
  if ! grep -qF -- "grep -qF '$BANNER'" "$found"; then
    echo "❌ 跑「$anchor」那一步不再 grep 收集门禁横幅 —— ⑥ 抄的横幅字样与 ci.yml 对不上" >&2
    return 1
  fi
  return 0
}

check_log() { # $1 = 日志 $2 = 人话标签 $3 = 期望文件数 $4 = 期望用例数
  local log="$1" label="$2" files="$3" tests="$4" bad=0 n
  if [[ ! -f $log ]]; then
    echo "❌ $label：日志 $log 不在。本脚本开头删过它一次 ⇒ 那一步根本没跑到 tee" >&2
    return 1
  fi
  if ! grep -qF "$BANNER" "$log"; then
    echo "❌ $label：日志里没有收集门禁的成功横幅，它可能被静默跳过了" >&2
    bad=1
  fi
  n=$(grep -acE "^ +Test Files +${files} passed \(${files}\)\$" "$log" || true)
  if [[ $n != 1 ]]; then
    echo "❌ $label：期望恰好一行「Test Files  ${files} passed (${files})」，实际 $n 行" >&2
    bad=1
  fi
  n=$(grep -acE "^ +Tests +${tests} passed \(${tests}\)\$" "$log" || true)
  if [[ $n != 1 ]]; then
    echo "❌ $label：期望恰好一行「Tests  ${tests} passed (${tests})」，实际 $n 行" >&2
    bad=1
  fi
  if (( bad != 0 )); then
    echo "   日志里实际那两行是：" >&2
    grep -aE '^ +(Test Files|Tests) ' "$log" >&2 || true
    echo "   ⚠️ 数字对不上不等于「把脚本里那个数改成新的」就完事：先弄清楚多/少的是哪几格。" >&2
    echo "   确认是有意增删之后，再回来改 scripts/prepush.sh 里 EXPECT_* 那四行。" >&2
    return 1
  fi
  echo "✅ $label：${files} 个文件 / ${tests} 格用例，横幅在"
  return 0
}

# ── 跑 ──────────────────────────────────────────────────────────────────────
if ! load_gates "$CI_FILE"; then exit 2; fi
rm -f "$NODE_LOG" "$WORKERS_LOG"

run_cell "①" "工作树干净"                     cell_worktree
run_cell "②" "分支只有 main"                  cell_branch
run_cell "③" "门禁按 ci.yml 同序跑完"         cell_gates
run_cell "④" "凭据扫描（工作树 / 历史各一档）" cell_secrets
run_cell "⑤" "无署名尾注、作者身份唯一"        cell_authorship
run_cell "⑥" "测试数与横幅同时校验"           cell_counts

# ── 逐格表 ──────────────────────────────────────────────────────────────────
pass=0; expected=0; failed=0
printf '\n══════════ 推送前逐格表 ══════════\n'
for id in "${CELL_IDS[@]}"; do
  printf '  %s %-28s %s\n' "$id" "${CELL_TITLE[$id]}" "${CELL_STATUS[$id]}"
  case "${CELL_STATUS[$id]}" in
    PASS)   pass=$((pass + 1)) ;;
    "$MARK") expected=$((expected + 1)) ;;
    *)      failed=$((failed + 1)) ;;
  esac
done
printf '  ── %s 格 PASS / %s 格 %s / %s 格 FAIL\n' "$pass" "$expected" "$MARK" "$failed"

if (( expected != 0 )); then
  printf '  ⚠️ %s 也算没过：整体退出码仍然是 1。\n' "$MARK"
  printf '     放行它就等于给推送前清单开一个豁免，而那正是这份清单存在的理由的反面。\n'
fi
if (( failed != 0 || expected != 0 )); then
  printf '  ⇒ 不该推。\n'
  exit 1
fi
printf '  ⇒ 六格全过。\n'
exit 0
