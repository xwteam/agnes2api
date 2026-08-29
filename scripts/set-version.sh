#!/usr/bin/env bash
# 统一设置项目版本号，一处修改、多处同步：
#   - VERSION
#   - package.json 的 version
#   - src/version.ts 的 VERSION 常量
#   - 根 README 与全部多语言文档（docs/*/README.md）顶部的 version 徽章
#
# 用法: bash scripts/set-version.sh 0.1.1
#
# 发版流程：先跑本脚本同步版本 → 刷 lock 文件（脚本末尾会把这条命令打出来）→
# 更新 CHANGELOG → 提交 → 打 tag vX.Y.Z → 推送（提交与 tag 都要推）。
# 推 `v*` 标签会触发 .github/workflows/docker-publish.yml 发 GHCR 镜像
# （那份 workflow 也可以在 Actions 页手动跑一次）；README 的 version 徽章不是
# 现算的，它随本脚本改出来的那个提交一起进仓，所以顺序不能倒过来。
set -euo pipefail
V="${1:-}"
[[ -z "$V" ]] && { echo "用法: scripts/set-version.sh <version>" >&2; exit 1; }
V="${V#v}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "版本号格式不对: $V" >&2; exit 1; }

cd "$(dirname "$0")/.."
printf '%s\n' "$V" > VERSION
node -e "const f='package.json',j=require('./'+f);j.version='$V';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
printf 'export const VERSION = "%s";\n' "$V" > src/version.ts
for f in README.md docs/*/README.md; do
  [[ -f "$f" ]] && sed -i -E 's#badge/version-v[0-9A-Za-z.+-]+-success#badge/version-v'"$V"'-success#g' "$f"
done

echo "已同步版本 → v$V"
echo "  VERSION      = $(cat VERSION)"
echo "  package.json = $(node -p "require('./package.json').version")"
echo "  src/version.ts = $(grep -oE '"[^"]+"' src/version.ts)"
echo
echo "下一步必须刷新 lock 文件: pnpm install --lockfile-only"
