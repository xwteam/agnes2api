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
RUN apk add --no-cache su-exec && corepack enable && addgroup -S app && adduser -S -G app app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=builder /build/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R app:app /app && chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 刻意不写 `USER app`：绑定挂载的宿主目录属主会盖过构建期的 chown，必须在运行期
# 由 entrypoint 以 root 修好属主后再 `su-exec` 降权。主进程仍然是 app 用户，不是 root。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/entry/node.js"]
