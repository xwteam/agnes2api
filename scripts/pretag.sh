#!/usr/bin/env bash
# ── agnes2api 打 tag 前的门禁（发版唯一入口的那一道）────────────────────────
#
# 用法：
#   bash scripts/pretag.sh                  # 判 `v$(cat VERSION)` 能不能打在 HEAD 上
#   bash scripts/pretag.sh --allow-retag    # 同上，但允许远端已经有这个 tag（重打那一次）
#   bash scripts/pretag.sh --remote <名字>  # 换一个远端名（默认 origin），只给夹具用
#
# **为什么有这个脚本。** 本仓的首个版本 v0.1.0 是这样出门的：tag 落在 `2a25550`，
# 而那个提交的 `lint-and-test` 在 GitHub 上记着 **failure**（`.github/workflows/ci.yml`
# 里 `pnpm/action-setup` 与 `packageManager` 两处都给了 pnpm 版本，
# `Error: Multiple versions of pnpm specified` ⇒ 那十三步一步没跑；修完 pnpm 之后
# 又当场露出 `tests/ui/dom` 那 7 份文件在 `node-version: 22` 上 119 格红 ——
# 而 22 正是 `Dockerfile` 的 `node:22-alpine`，也就是真正出货的那个大版本）。
# 与此同时 `origin/main` 已经比那个 tag 多了两个提交。
#
# ⚠️ **`.github/workflows/docker-publish.yml` 只有 checkout + buildx + push，
#    一道测试、一道门禁都不跑** —— 它认的只是「有人推了一个 `v*` 标签」。
#    所以 `ghcr.io` 上那三个公开标签（`x.y.z` / `x.y` / `latest`）是不是从一棵
#    过得了自己 CI 的树上构建的，**在流水线里没有任何一处把关**。这个脚本就是那一处。
#
# ⚠️ **本脚本要联网**（`git fetch` + `gh api`），所以它**不进 `scripts/prepush.sh`**：
#    那份清单必须在没网的机器上也跑得完。两者的分工是
#    「prepush = 这棵树本身合不合格」/「pretag = 这棵树是不是远端 main 那棵、且 GitHub
#    那边记着它是绿的」。**推之前跑 prepush，打 tag 之前跑本脚本，两道都不许跳。**
#
# ⚠️ 形态与 `scripts/prepush.sh` 同轨：`set -uo pipefail`，顶层没有 `-e`
#   （逐格跑完再汇总，好让人一眼看见「哪几格红」），每一格自己跑在 `( set -e; … )` 子壳里
#   （格内的意外失败必须当场把这一格弄红，不许被下一行照跑吞掉）。
#   **没有任何一格带豁免**：非 PASS 一律算没过，整体退出码一律是 1。
set -uo pipefail
cd "$(dirname "$0")/.."

REMOTE="origin"
ALLOW_RETAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-retag) ALLOW_RETAG=1; shift ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    *) printf '不认得的参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 逐格框架（与 prepush.sh 同一套，报文形态刻意一致）──────────────────────
CELL_IDS=()
declare -A CELL_TITLE=()
declare -A CELL_STATUS=()

run_cell() { # $1 = 序号符 $2 = 标题 $3 = 函数名
  local id="$1" title="$2" fn="$3" rc
  CELL_IDS+=("$id")
  CELL_TITLE[$id]="$title"
  printf '\n════ %s %s ════\n' "$id" "$title"
  ( set -e; "$fn" )
  rc=$?
  case $rc in
    0) CELL_STATUS[$id]="PASS" ;;
    *) CELL_STATUS[$id]="FAIL(exit $rc)" ;;
  esac
  printf '──── %s %s\n' "$id" "${CELL_STATUS[$id]}"
}

# ⚠️ 这三个值在**格外**算，不在格内。每一格跑在 `( set -e; … )` 子壳里，格内的赋值
#   出了子壳就没了——第一版把它们写在 ③ / ④ 里，于是 ③ 明明 PASS，⑤ 还在报
#   「tag 名还没算出来（③ 没过）」。子壳里留得下的只有**对文件系统的改动**
#   （④ 那次 `git fetch` 更新的远端引用就是靠这条留下来的），值留不下。
VERSION=""
if [ -f VERSION ]; then VERSION="$(tr -d ' \t\r\n' < VERSION)"; fi
TAG=""
if [ -n "$VERSION" ]; then TAG="v$VERSION"; fi
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"

# ① 工作树干净：手上多出来的东西，tag 里一个字都不会有，而人会以为有。
cell_clean() {
  local dirty
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    printf '工作树不干净，这些还没提交：\n%s\n' "$dirty"
    return 1
  fi
  echo "✅ 工作树干净"
}

# ② 分支只有 main：本仓的远端只留 main，从别的分支打出来的 tag 谁都追不回去。
cell_branch() {
  local br
  br="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$br" != "main" ]; then
    printf '当前在 %s 上，本仓只在 main 上发版\n' "$br"
    return 1
  fi
  echo "✅ 在 main 上"
}

# ③ tag 名 = `v` + VERSION，且 CHANGELOG.md 里真有这个版本的条目。
#    这一格挡的是「VERSION 改了而 CHANGELOG 没跟」「手打了一个跟 VERSION 对不上的 tag」。
cell_version() {
  if [ ! -f VERSION ]; then echo "VERSION 文件不在 —— 认不出要吵"; return 1; fi
  if [ -z "$VERSION" ]; then echo "VERSION 是空的 —— 认不出要吵"; return 1; fi
  if [ ! -f CHANGELOG.md ]; then echo "CHANGELOG.md 不在 —— 认不出要吵"; return 1; fi
  if ! grep -q "^## \[$VERSION\] - " CHANGELOG.md; then
    printf 'CHANGELOG.md 里没有 `## [%s] - <日期>` 这一行 —— 这个版本没有条目\n' "$VERSION"
    return 1
  fi
  printf '✅ 版本 %s，tag %s，CHANGELOG 里有它的条目\n' "$VERSION" "$TAG"
}

# ④ HEAD 就是远端 main 那个提交。**落后 / 超前都红**：
#    落后 ⇒ 发出去的树不是别人 clone 到的那棵；超前 ⇒ 有东西还没推。
cell_head_is_remote_main() {
  if ! git fetch -q "$REMOTE" main; then
    printf 'git fetch %s main 失败 —— 拿不到远端 main，这一格无从判起\n' "$REMOTE"
    return 1
  fi
  if [ -z "$HEAD_SHA" ]; then echo "HEAD 认不出（这是个 git 仓库吗）—— 认不出要吵"; return 1; fi
  local remote_sha
  remote_sha="$(git rev-parse "$REMOTE/main")"
  if [ "$HEAD_SHA" != "$remote_sha" ]; then
    printf 'HEAD 是 %s，而 %s/main 是 %s —— 这两个必须是同一个提交\n' \
      "$HEAD_SHA" "$REMOTE" "$remote_sha"
    return 1
  fi
  printf '✅ HEAD == %s/main == %s\n' "$REMOTE" "$HEAD_SHA"
}

# ⑤ 远端还没有这个 tag。已经有的话必须显式 `--allow-retag`——
#    重打一个已经发出去的 tag 会把 ghcr 上那几个公开标签一起换掉，那是有意的动作，
#    不许是顺手的。
cell_tag_free() {
  if [ -z "$TAG" ]; then echo "tag 名算不出来（VERSION 不在或是空的）—— 这一格无从判起"; return 1; fi
  local found
  if ! found="$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")"; then
    printf 'git ls-remote %s 失败 —— 问不到远端有没有这个 tag，这一格无从判起\n' "$REMOTE"
    return 1
  fi
  if [ -n "$found" ]; then
    if [ "$ALLOW_RETAG" -eq 1 ]; then
      printf '⚠️ 远端已经有 %s（%s），--allow-retag 放行：这是一次重打\n' "$TAG" "${found%%$'\t'*}"
      return 0
    fi
    printf '远端已经有 %s（%s）—— 要重打就显式加 --allow-retag\n' "$TAG" "${found%%$'\t'*}"
    return 1
  fi
  printf '✅ 远端还没有 %s\n' "$TAG"
}

# ⑥ GitHub 那边记着这个 sha 的每一个 CI job 都是 completed + success。
#    job 名单从 `.github/workflows/ci.yml` 现算，不手抄——改了 job 名字这里跟着走。
#    ⚠️ **认不出一律红**：gh 不在、请求失败、JSON 解析不出、某个 job 一次都没跑过，
#    统统算没过。一道安全闸在扫不动的时候报绿，比没有这道闸更坏。
cell_ci_green() {
  if [ -z "$HEAD_SHA" ]; then echo "HEAD 的 sha 认不出 —— 这一格无从判起"; return 1; fi
  local jobs
  jobs="$(awk '/^jobs:/{inj=1;next} inj && /^[^ ]/{inj=0} inj && /^  [A-Za-z0-9_-]+:[ \t]*$/{gsub(/[ :]/,"");print}' \
    .github/workflows/ci.yml)"
  if [ -z "$jobs" ]; then
    echo ".github/workflows/ci.yml 里一个 job 都认不出 —— 认不出要吵，不是「CI 绿了」"
    return 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh 不在这台机器上 —— 查不了 GitHub 记着的 CI 结论，这一格无从判起"
    return 1
  fi
  local url slug json
  # ⚠️ 用 `git config --get remote.<名>.url` 而不是 `git remote get-url`：后者会把
  #   `url.<base>.insteadOf` 的改写**展开**，拿到的可能不是登记在配置里的那个地址。
  #   要问的是「这个远端登记的是哪个 GitHub 仓库」，那是配置里那一行，不是传输层落到哪。
  if ! url="$(git config --get "remote.$REMOTE.url")" || [ -z "$url" ]; then
    printf '远端 %s 没登记 url —— 认不出要吵\n' "$REMOTE"
    return 1
  fi
  slug="$(printf '%s' "$url" | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"
  if ! printf '%s' "$slug" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    printf '从 %s 认不出 <owner>/<repo>（拿到的是「%s」）—— 认不出要吵\n' "$url" "$slug"
    return 1
  fi
  if ! json="$(gh api "repos/$slug/commits/$HEAD_SHA/check-runs" --paginate 2>&1)"; then
    printf 'gh api repos/%s/commits/%s/check-runs 失败：\n%s\n' "$slug" "$HEAD_SHA" "$json"
    return 1
  fi
  local bad=0 job out rc
  while IFS= read -r job; do
    [ -n "$job" ] || continue
    # ⚠️ 这里的 `|| rc=$?` 不是装饰：本格跑在 `( set -e; … )` 子壳里，
    #   `out="$(…)"` 一旦非零就会当场把子壳掐掉，下面那张 `case` 一行都跑不到
    #   —— 格子照样红（失败是闭的），但「红在哪一档」的报文全没了。
    rc=0
    out="$(printf '%s' "$json" | node -e '
      let s = "";
      process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => {
        let j;
        try { j = JSON.parse(s); } catch { process.exit(3); }
        const runs = (j.check_runs || []).filter((r) => r && r.name === process.argv[1]);
        if (runs.length === 0) process.exit(4);
        // 同一个 job 重跑过的话有多条，取 started_at 最大的那一条。
        runs.sort((a, b) => String(a.started_at || "").localeCompare(String(b.started_at || "")));
        const last = runs[runs.length - 1];
        process.stdout.write(`${last.status}/${last.conclusion}`);
      });
    ' "$job")" || rc=$?
    case $rc in
      0) : ;;
      3) printf '❌ %s：check-runs 的响应解析不出 JSON —— 认不出要吵\n' "$job"; bad=1; continue ;;
      4) printf '❌ %s：这个 sha 上一次都没跑过这个 job —— 认不出要吵\n' "$job"; bad=1; continue ;;
      *) printf '❌ %s：读 check-runs 时出错（exit %s）\n' "$job" "$rc"; bad=1; continue ;;
    esac
    if [ "$out" != "completed/success" ]; then
      printf '❌ %s：GitHub 记着的是 %s —— 这棵树的 CI 不是绿的，不许打 tag\n' "$job" "$out"
      bad=1
      continue
    fi
    printf '✅ %s：completed/success\n' "$job"
  done <<< "$jobs"
  [ "$bad" -eq 0 ]
}

run_cell "①" "工作树干净" cell_clean
run_cell "②" "分支只有 main" cell_branch
run_cell "③" "tag 名与 VERSION / CHANGELOG 对得上" cell_version
run_cell "④" "HEAD 就是远端 main 那个提交" cell_head_is_remote_main
run_cell "⑤" "远端还没有这个 tag" cell_tag_free
run_cell "⑥" "GitHub 记着这个 sha 的 CI 全绿" cell_ci_green

printf '\n══════════ 打 tag 前逐格表 ══════════\n'
fail=0
for id in "${CELL_IDS[@]}"; do
  printf '  %s %-30s %s\n' "$id" "${CELL_TITLE[$id]}" "${CELL_STATUS[$id]}"
  [ "${CELL_STATUS[$id]}" = "PASS" ] || fail=1
done
if [ "$fail" -eq 0 ]; then
  printf '  ⇒ 六格全过，可以打 %s 了。\n' "$TAG"
  exit 0
fi
printf '  ⇒ 不该打 tag。\n'
exit 1
