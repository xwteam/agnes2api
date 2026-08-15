#!/bin/sh
# 容器入口：必要时把数据目录的属主修成容器内的运行用户，再**降权**执行主进程。
#
# 为什么必须在运行期做：镜像里的 `chown -R app:app /app` 发生在构建期，而
# docker-compose.yml 用 `./data:/app/data` 绑定挂载，运行时宿主目录的属主（通常 uid 1000）
# 会直接盖过镜像里的结果。容器内 app 是 uid 100，于是写 store.json 报 EACCES——而 `/health`
# 压根不碰存储，容器照样报 healthy，所有 API 调用却返回 pool_empty。这是文档记载的
# `docker compose up -d` 路径上的静默失败，只能在运行期修。
#
# 主进程仍然**不以 root 运行**：root 身份只存在于本脚本的前几行，`su-exec` 之后 PID 1
# 就是 app 用户，非 root 这一既有安全性质没有被牺牲。
#
# 有副作用，DEPLOY.md 的 Docker 章节已写明：绑定挂载下 chown 改的是**宿主**上的文件，
# 你的 ./data 会从自己的 uid 变成容器内的 100:101。因此这里只在属主确实不匹配时才动手，
# 能不改就不改。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

# 非 root（`docker run --user` / compose 的 `user:`）：没有 chown 的权限，直接以当前身份
# 执行。数据目录是否可写交给启动时的存储探测去暴露（/health 会报 degraded）。
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# `set -e` 下一个失败的 mkdir 会直接把容器打进重启环，而重启环里什么诊断都留不下，
# 与本脚本「不 exit 1」的策略自相矛盾。可写性一律交给启动探测去报。
mkdir -p "$DATA_DIR" 2>/dev/null || true

# chown -R 的边界。DATA_DIR 是运维给的任意字符串：设成 `/` 会把整个 rootfs（连同本脚本
# 自己）改成 app 可写，等于在容器内造出一条提权路径。故只接受绝对路径，并挡掉根目录与
# 顶层系统目录；挡掉时不终止启动，只是不 chown。
chown_target_ok() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      return 1 ;;
  esac
  return 0
}

# 只有属主确实不匹配时才递归改写：改的是宿主的文件，无谓的 chown 会让用户的 ./data
# 莫名其妙换主人。看目录本身与 store.json 就够了——前者决定能不能建临时文件并 rename，
# 后者是唯一的数据文件。
WANT_OWNER="$(id -u app):$(id -g app)"
owner_mismatch() {
  for p in "$DATA_DIR" "$DATA_DIR/store.json"; do
    [ -e "$p" ] || continue
    [ "$(stat -c '%u:%g' "$p" 2>/dev/null)" = "$WANT_OWNER" ] || return 0
  done
  return 1
}

if ! chown_target_ok "$DATA_DIR"; then
  echo "[agnes2api] 警告：DATA_DIR=$DATA_DIR 不是可安全递归改属主的路径，已跳过 chown；若该目录对 uid $(id -u app) 不可写，/health 会报 degraded" >&2
elif owner_mismatch; then
  # chown 失败（只读挂载、不支持属主的文件系统等）不终止启动：容器起来之后
  # /health 会把存储不可写如实报成 degraded（HTTP 503），排障时能直接 curl 到原因，
  # 比在这里 exit 1 换来一个无从查起的重启循环更有用。
  chown -R app:app "$DATA_DIR" 2>/dev/null ||
    echo "[agnes2api] 警告：无法修改 $DATA_DIR 的属主，若该目录不可写，/health 会报 degraded" >&2
fi

exec su-exec app:app "$@"
