#!/bin/sh
# 容器入口：先把数据目录的属主修成容器内的运行用户，再**降权**执行主进程。
#
# 为什么必须在运行期做：镜像里的 `chown -R app:app /app` 发生在构建期，而
# docker-compose.yml 用 `./data:/app/data` 绑定挂载，运行时宿主目录的属主（通常 uid 1000）
# 会直接盖过镜像里的结果。容器内 app 是 uid 100，于是写 store.json 报 EACCES——而 `/health`
# 压根不碰存储，容器照样报 healthy，所有 API 调用却返回 pool_empty。这是文档记载的
# `docker compose up -d` 路径上的静默失败，只能在运行期修。
#
# 主进程仍然**不以 root 运行**：root 身份只存在于本脚本的前几行，`su-exec` 之后 PID 1
# 就是 app 用户，非 root 这一既有安全性质没有被牺牲。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # chown 失败（只读挂载、不支持属主的文件系统等）不终止启动：容器起来之后
  # /health 会把存储不可写如实报成 degraded（HTTP 503），排障时能直接 curl 到原因，
  # 比在这里 exit 1 换来一个无从查起的重启循环更有用。
  chown -R app:app "$DATA_DIR" 2>/dev/null ||
    echo "[agnes2api] 警告：无法修改 $DATA_DIR 的属主，若该目录不可写，/health 会报 degraded" >&2
  exec su-exec app:app "$@"
fi

# 已经被 `docker run --user` 或 compose 的 `user:` 指定成非 root：没有 chown 的权限，
# 直接以当前身份执行。数据目录是否可写交给启动时的存储探测去暴露。
exec "$@"
