#!/usr/bin/env bash
# 同步版本号到 VERSION、package.json、src/version.ts 与全部 README 徽章。
# 用法: bash scripts/set-version.sh 0.1.1
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
