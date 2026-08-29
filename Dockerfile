FROM node:22-alpine AS builder
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
# su-exec 用于在 entrypoint 里从 root 降权到 app（alpine 上的 gosu 等价物）。
# 它现在是**运行期**依赖：没有它 entrypoint 的 exec 会失败，容器根本起不来。因此在构建期
# 就断言它装上了**并且真能用**（`su-exec nobody true` 会以 nobody 身份跑一次 `true`），
# 别把「装没装上」留到用户 `docker compose up` 的那一刻才发现。
#
# 不做版本固定：实测 `apk add 'su-exec=~0.2'` 在当前基础镜像上直接构建失败
# （alpine 已升到 su-exec-0.3-r0），把版本写死只会让基础镜像一升级就断构建，
# 而「这个二进制存在且能降权」才是这里真正要保证的东西——上面那条断言正是查这个。
RUN apk add --no-cache su-exec \
  && su-exec nobody true \
  && corepack enable && addgroup -S app && adduser -S -G app app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=builder /build/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R app:app /app && chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
# ⚠️ 这四个参数与下面那条探针命令在 `docker-compose.yml` 里**还有一份**（两处有意重复，
# 理由写在那边）。两份必须逐字节相同，由 tests/unit/repo-front-door.test.ts 的 (l) 钉着
# ——改这两行就得回去改那边，反过来也一样。
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 刻意不写 `USER app`：绑定挂载的宿主目录属主会盖过构建期的 chown，必须在运行期
# 由 entrypoint 以 root 修好属主后再 `su-exec` 降权。主进程仍然是 app 用户，不是 root。
#
# 代价（五份 DEPLOY.md 已写明）：镜像的默认用户因此是 root（`docker inspect` 的
# `.Config.User` 为空），K8s 里配了 `runAsNonRoot: true` 而没给 `runAsUser` 时 kubelet
# 会拒绝启动。这类部署需显式 `runAsUser: 100` / `runAsGroup: 101` 并自备卷属主，
# 或用 `--user` 走本 entrypoint 的非 root 分支。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/entry/node.js"]
