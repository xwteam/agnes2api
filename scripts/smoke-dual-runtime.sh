#!/usr/bin/env bash
# ── agnes2api 双形态（Docker / Cloudflare Worker）真机冒烟 ───────────────────
#
# 用法：
#   bash scripts/smoke-dual-runtime.sh            # 五格全跑，末尾打一张逐格表
#   bash scripts/smoke-dual-runtime.sh --print-plan  # 干跑：只把五格的编号与标题打出来，
#                                                    # **一格都不执行**（给守卫用的机器档）
#
# **它不是单元测试的替代品，是仓里那几处「等双形态真机验收」的钉子唯一的了结方式。**
# 那几处钉子逐条写着自己为什么不能被机器测网罩住，摘要成下面这张表：
#
#   ① Docker 形态起得来        全仓没有任何一格用例构建镜像或跑容器
#   ② Worker 形态起得来        契约用例走的是进程内的 `app.request()`，
#                              **不经 workerd 的 HTTP 服务层，也不经 src/entry/worker.ts**
#   ③ 两形态的流式逐块到达      `admin-ui/js/sec-playground.js` 逐字写着
#                              「workerd 哪天改成缓冲，一格测试都不会红」
#   ④ 用量 30 天档在 Worker 上跑得完   一次 60 次 KV 子请求，而 Cloudflare 两页官方
#                              文档在「一次调用能发多少次子请求」上互相对不上
#   ⑤ 两形态的 /admin 都出得来  静态兜底在两个 entry 里是两份装配
#
# ⚠️ **一个字节的真上游都不联网**：上游一律指向本脚本自己起的 stub（下面那段
#   `UPSTREAM_STUB` 就是它的全文，收发什么一目了然）。**它验的是「两个形态自己跑不跑得
#   起来、行为一不一致」，不是「上游长什么样」。** 真上游要真凭据，而本仓的全部纪律
#   建立在「仓库零内置凭据」上。
#
# ⚠️ **同一份 stub 起两份，而这不是冗余**（本机实测出来的约束）：容器要回连宿主机得走
#   宿主机在网桥上的那个地址，而本机的 iptables INPUT 链默认 REJECT ⇒ 那条路是不通的
#   （实测：`host.docker.internal` 解析得出 172.17.0.1，连过去 fetch failed，网关如实
#   回 503 upstream_error）。**把这条依赖留着，这份冒烟就只在防火墙宽松的机器上跑得起来。**
#   ⇒ Worker 那侧连宿主机上的那份（`127.0.0.1`），Docker 那侧连 compose 网络里的那份
#   （服务名 `smoke-upstream`）。两份是同一个文件、同一套行为。
#
# ⚠️ **凭据现生成、用完即弃**：网关口令与管理口令每次跑都重新随机生成，只经由
#   `docker compose` 的 override 文件（临时目录里，收尾时删）与 `wrangler dev --var`
#   传进去，**一个字符都不写进仓库里任何被 git 跟踪的文件**。
#
# ⚠️ **开发者自己的 `./data` 与 `.env`，这份脚本一个字节都不写、也不删**
#   （这两条是本任务复评实测出来的，上一版两样都动）：
#   · `docker-compose.yml` 的 `./data:/app/data` 会让冒烟往**开发者那份 store.json**
#     里塞假 key 并把整个目录 chown 走 ⇒ override 把那条挂载改指到临时目录；
#   · `docker-compose.yml` 的 `env_file: .env` 会把开发者的真 `.env` **整份**灌进容器
#     （实测 `env_file: []` 清不掉，被合并成「基文件那一份还在」）⇒ override 用
#     compose 的 `!reset` 标记把它整条抹掉，于是这份脚本连 `.env` 存不存在都不关心
#     （上一版为了满足 `env_file:` 会现建一个空的再删掉，这一版不建了）。
#   ⚠️ **「不写」不等于「没被读到」，这半句得说准**：`.env` 还有第二条路
#     —— compose 会读它给 `${...}` **插值**（基文件里是 `${PORT:-8080}` 与
#     `${TZ:-Asia/Shanghai}` 两处）。`PORT` 由本脚本 `export` 出去、外壳压过 `.env`，
#     由下面那次回读当场证；**`TZ` 没有被压住**：开发者 `.env` 里的 `TZ` 会成为容器的 TZ。
#     ⇒ 射程如实写在这里：抹掉的是 `env_file` 那条路（**键一个都进不来**），
#     插值那条路上今天只剩 `TZ` 这一个值，它不改被测的任何一格。
#   ⚠️⚠️ 这几条都**不靠对 compose 合并语义的假定**：`cell_docker_up` 在 `up` 之前先跑一次
#     `compose config` 把合出来的那份配置读回来逐项核对（挂载指哪、环境变量有哪几个键、
#     端口是不是本次这个），核不上就当场红。**假定会静静地放行，回读不会。**
#
# ⚠️ **形态：`set -uo pipefail`，顶层没有 `-e`**，与推送前复跑脚本同一套：
#   必须**逐格跑完再汇总**，只红一格就中止的话「哪几格红」这个唯一想读出来的结论就没了。
#   每一格自己跑在 `( set -e; … )` 子壳里，格内的意外失败当场把这一格弄红。
#
# ⚠️ **收尾无条件**：`trap cleanup EXIT` 里关容器、按进程组杀 wrangler、删临时目录，
#   最后把**跑之前的 `git status --porcelain` 快照**与跑之后的比一遍——本仓的工作流
#   经常把探针留在树里，那条比对就是它的绊线。
#
# ⚠️ **它自己不是门禁的一道**，它是推送前复跑清单的第七格。
set -uo pipefail
cd "$(dirname "$0")/.."

# ── 这一格要问 30 天档，而「30 天」这个数不在这里手抄 ────────────────────────
# 真源是 `admin-ui/js/pure/usage.mjs` 的 `rangeToQuery()`：它把 `30d` 这个按钮翻译成
# `from = to − (N − 1) × 86400000`。**差一天的后果不是「多一天数据」而是 `clamped` 恒为真**
# （那个函数上方写着全文），所以这里照它的算法发，不自己另发明一套。
# 这个数与真源的一致性由 `tests/unit/smoke-guard.test.ts` 的
# 「④ 那一格的天数从 admin-ui/js/pure/usage.mjs 的 rangeToQuery() 现读，不是手抄的」钉着。
USAGE_RANGE_DAYS=30
DAY_MS=86400000

# ── 每一格返回：0 = 过；非 0 = 没过 ─────────────────────────────────────────
CELL_IDS=()
declare -A CELL_TITLE=()
declare -A CELL_STATUS=()

# ── 格子怎么把「我建了什么」告诉收尾 ──────────────────────────────────────
# 每一格跑在自己的子壳里（格内 `set -e`），**子壳里的赋值出不来**。而收尾必须知道
# 「容器起没起过、wrangler 的进程组是几号、`.env` 是不是我建的」——否则它要么漏删，
# 要么删掉本来就在的东西。所以格子把这几样写进一个 `键=值` 的状态文件，
# **写在动手之前**：跑到一半被 Ctrl-C 打断时，收尾照样读得到。
export_state() { printf '%s=%s\n' "$1" "$2" >>"$TMP/state.env"; }
merge_state() {
  if [[ -s $TMP/state.env ]]; then
    # shellcheck source=/dev/null
    . "$TMP/state.env"
  fi
}

run_cell() { # $1 = 序号符 $2 = 标题 $3 = 函数名
  local id="$1" title="$2" fn="$3" rc
  CELL_IDS+=("$id")
  CELL_TITLE[$id]="$title"
  printf '\n════ %s %s ════\n' "$id" "$title"
  ( set -e; "$fn" )
  rc=$?
  merge_state
  if (( rc == 0 )); then CELL_STATUS[$id]="PASS"; else CELL_STATUS[$id]="FAIL(exit $rc)"; fi
  printf '──── %s %s\n' "$id" "${CELL_STATUS[$id]}"
}

CELL_PLAN=(
  "①	Docker 形态起得来（compose up + /health 200）	cell_docker_up"
  "②	Worker 形态起得来（wrangler dev + /health 200）	cell_worker_up"
  "③	两形态的流式都是逐块到达（量到达间隔）	cell_stream_interval"
  "④	用量 30 天档在 Worker 上跑得完	cell_usage_30d"
  "⑤	两形态的 /admin 都出得来	cell_admin_html"
)

case "${1:-}" in
  "") ;;
  --print-plan)
    # 干跑档：给守卫读的机器档，**一格都不跑**。与 `--print-gates` 同一个用途。
    for line in "${CELL_PLAN[@]}"; do
      IFS=$'\t' read -r id title _fn <<<"$line"
      printf '### CELL %s | %s\n' "$id" "$title"
    done
    exit 0
    ;;
  *)
    # 与 scripts/scan-secrets.sh 同一条规矩：手滑打错的参数不许静静跑成默认档。
    echo "❌ 认不出的参数「$1」。用法：smoke-dual-runtime.sh [--print-plan]" >&2
    exit 2
    ;;
esac

# ── 整跑档：把 stderr 并进 stdout ────────────────────────────────────────────
# 与推送前复跑脚本同一条理由：留一份日志时，两股流分开会让日志里只剩一张说「红了」
# 却不说为什么的表。**必须在参数分派之后**，干跑档的两股流不许被合并。
exec 2>&1

# ── 现生成的两把口令 ────────────────────────────────────────────────────────
# 管理口令的形态约束（至少 24 位、首尾无空白、不得与网关口令相同）写在 .env.example 里，
# 不满足时面板整棵树不注册、⑤ 会直接 404 —— 那是这两行长度的来由。
rand_token() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "$1"; }
GATEWAY_TOKEN="gw-$(rand_token 32)"
ADMIN_TOKEN="ad-$(rand_token 40)"
if (( ${#GATEWAY_TOKEN} < 20 || ${#ADMIN_TOKEN} < 24 )); then
  echo "❌ 随机口令没生成出来（拿到 ${#GATEWAY_TOKEN} / ${#ADMIN_TOKEN} 位）—— 不许拿一个短口令继续跑" >&2
  exit 2
fi

# ── 端口：一律现问系统要空的，不写死 ────────────────────────────────────────
# 写死端口的脚本在一台跑着别的东西的机器上会莫名其妙地红，而红的原因与被测物无关。
free_port() {
  node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'0.0.0.0',()=>{const p=s.address().port;s.close(()=>console.log(p));});"
}
STUB_PORT=$(free_port)
DOCKER_PORT=$(free_port)
WORKER_PORT=$(free_port)
# compose 网络里那份 stub 的端口不用现问系统要：它在容器自己的网络命名空间里，
# 不与宿主机上任何东西抢，也不往宿主机发布。
STUB_PORT_IN_NET=8099
for p in "$STUB_PORT" "$DOCKER_PORT" "$WORKER_PORT"; do
  if [[ ! $p =~ ^[0-9]+$ ]]; then
    echo "❌ 要不到空闲端口（拿到「$p」）—— node 不在，或系统拒绝了监听" >&2
    exit 2
  fi
done

TMP=$(mktemp -d)
STUB_LOG="$TMP/stub.log"
WRANGLER_LOG="$TMP/wrangler.log"
OVERRIDE="$TMP/compose.override.yml"
COMPOSE_PROJECT="agnes2api-smoke"
# 容器写存储的地方。**必须落在临时目录，不许用仓库根下的 `./data`**：
# 那是开发者自己那份 store.json 的位置（key 池的唯一副本），而冒烟会往里塞一把假 key、
# 还会让容器的 entrypoint 把它整个 chown 走 —— 本任务复评实测过：假 key
# `sk-smoke-upstream-stub` 与它的用量统计被写进了真 store.json，属主从 `ubuntu:ubuntu`
# 变成容器里那个 uid，而屏幕上照样打「工作树与开跑前逐字一致」（`data/` 在 .gitignore 第 4 行，
# **那句话对 git 是真的，对机器是假的**）。
SMOKE_DATA_DIR="$TMP/data"
# 容器内那条路径**从基文件现读，不在这里手抄 `/app/data`**：compose 合并 `volumes` 是
# **按容器内的目标路径认同一条**（实测：目标相同 ⇒ override 那条替换掉基文件那条）。
# 基文件哪天把目标改到别处，手抄的这一份就对不上 ⇒ 合出来会是**两条**挂载，
# 开发者的 `./data` 又回来了，而屏幕上什么都不会说。
COMPOSE_DATA_TARGET=$(grep -oE '^[[:space:]]*-[[:space:]]*\./data:/[^[:space:]":]+' docker-compose.yml | head -n 1 | sed 's#.*\./data:##')
if [[ -z $COMPOSE_DATA_TARGET ]]; then
  echo '❌ docker-compose.yml 里认不出 ./data 那条绑定挂载 —— 判据坏了，不许静默照跑（照跑的后果是开发者那份 store.json 被写脏）' >&2
  exit 2
fi

# 收尾要用的状态。**每一项都在建立之前先记下来**：只删自己造出来的东西。
STUB_PID=""
WRANGLER_PID=""
WRANGLER_PGID=""
COMPOSE_UP=0
WRANGLER_DIR_CREATED=0
GIT_BASELINE=$(git status --porcelain 2>/dev/null || true)

DOCKER_OK=0
WORKER_OK=0
DOCKER_BASE="http://127.0.0.1:$DOCKER_PORT"
WORKER_BASE="http://127.0.0.1:$WORKER_PORT"

compose() { docker compose -p "$COMPOSE_PROJECT" -f docker-compose.yml -f "$OVERRIDE" "$@"; }

cleanup() {
  local after
  echo ""
  echo "──── 收尾 ────"
  # 被打断时格子的状态还没被 run_cell 合并进来，这里再合一次。
  merge_state
  if (( COMPOSE_UP == 1 )); then
    compose down -v --remove-orphans >/dev/null 2>&1 || echo "⚠️ docker compose down 没跑成，容器可能还在"
  fi
  if [[ -n $WRANGLER_PGID ]]; then
    # **按进程组杀，不按名字匹配**：wrangler 会 fork 出 workerd，只杀父进程会留下一个
    # 占着端口的孤儿；而按名字匹配（`pkill -f wrangler`）会误伤这台机器上别人的 wrangler。
    # 进程组号是起完之后从 `ps` 现读的，不是「假定 setsid 一定成功」——
    # 万一它没成功、读回来的正是本脚本自己的组号，那就退回只杀那一个 PID
    # （杀自己的组等于把这次收尾连同它自己一起干掉，容器就留在机器上了）。
    if [[ $WRANGLER_PGID == "$$" || $WRANGLER_PGID == "$(ps -o pgid= -p $$ | tr -d ' ')" ]]; then
      echo "⚠️ wrangler 没能自成进程组，退回只杀 PID $WRANGLER_PID"
      kill -TERM "$WRANGLER_PID" 2>/dev/null || true
    else
      kill -TERM -- "-$WRANGLER_PGID" 2>/dev/null || true
      sleep 2
      kill -KILL -- "-$WRANGLER_PGID" 2>/dev/null || true
    fi
  fi
  if [[ -n $STUB_PID ]]; then kill -TERM "$STUB_PID" 2>/dev/null || true; fi
  if (( WRANGLER_DIR_CREATED == 1 )); then rm -rf .wrangler; fi
  # 临时 DATA_DIR 里的文件属主被 entrypoint 改成了容器内的 app（宿主上看是一个陌生 uid），
  # 连那个目录本身也被 chown 走 ⇒ 宿主这边 `rm -rf` 会 Permission denied。
  # 借同一个镜像以 root 身份把它整个删掉，再由宿主删父目录。
  if [[ -d $SMOKE_DATA_DIR ]]; then
    docker run --rm --entrypoint sh -v "$TMP:/t" ghcr.io/xwteam/agnes2api:latest \
      -c 'rm -rf /t/data' >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  # **删没删掉要当场说**：这份脚本每跑一次就建一个临时目录，静默失败会在 /tmp 里
  # 攒出一堆谁也不认识的残留（而它们里面装着这次跑出来的 store.json）。
  if [[ -d $TMP ]]; then
    echo "⚠️ 临时目录没删干净，请手动看一眼：$TMP"
  fi
  after=$(git status --porcelain 2>/dev/null || true)
  if [[ $after != "$GIT_BASELINE" ]]; then
    echo "❌ 工作树与开跑前不一样了 —— 这次冒烟往树里留下了东西，收尾没做干净：" >&2
    diff <(printf '%s\n' "$GIT_BASELINE") <(printf '%s\n' "$after") >&2 || true
    exit 1
  fi
  echo "✅ 收尾完成，工作树与开跑前逐字一致"
}
trap cleanup EXIT

# ── 假上游 ──────────────────────────────────────────────────────────────────
# **本脚本唯一的「上游」，全文就在下面。** 它只认一条路径（`…/chat/completions`，
# 网关对四条协议一律转成这一条内部规范请求），并且：
# · `stream: true` 时按 `GAP_MS` 一块一块地发 `CHUNKS` 块；
# · 否则回一个最小的非流式响应。
#
# ⚠️⚠️ **每一块的正文就是它自己发出去那一刻的毫秒时间戳**，这不是装饰：
#   ③ 要比的两个时刻因此**都由客户端那一侧读到**——「最后一块**发出**」的时刻是它
#   自己带过来的，「第一行**到达**」的时刻由客户端现打。**两侧不需要共享任何文件**，
#   于是 stub 跑在宿主机上还是跑在容器里，判据一个字都不用改。
cat >"$TMP/upstream-stub.mjs" <<'UPSTREAM_STUB'
import { createServer } from "node:http";

const PORT = Number(process.argv[2]);
const GAP_MS = Number(process.argv[3]);
// ⚠️ **块数从命令行来，不在这里手抄一个字面量**：③ 的判据要拿它当「该到几块」的期望值，
//   而两处手抄的数会各自漂。改 stub 的块数而判据没跟上时，报文会说
//   「少于上游发的 4 块」，把人指去查网关 —— 真因却在 stub（本任务复评实测过这条）。
const CHUNKS = Number(process.argv[4]);
if (!Number.isInteger(CHUNKS) || CHUNKS < 2) {
  // 少于 2 块时「首末两块的到达间隔」这个观测量根本不存在 ⇒ ③ 会变成零鉴别力。
  console.error(`stub: 块数必须是 ≥2 的整数，拿到 ${JSON.stringify(process.argv[4])}`);
  process.exit(2);
}

/** 一条上游 SSE 增量行（内部规范格式 = OpenAI chat 增量块）。 */
const delta = (text) =>
  `data: ${JSON.stringify({ id: "smoke", choices: [{ delta: { content: text } }] })}\n\n`;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const b of req) body += b;
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"stub 只认 /chat/completions"}');
    return;
  }
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* 形状不对就当非流式处理 */ }
  if (parsed.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "smoke", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (let i = 0; i < CHUNKS; i++) {
    // 正文 = 这一块**发出去的那一刻**。客户端拿到的最后一块里那个数，
    // 就是「上游最后一块发出」的时刻，不需要第二条通道把它送过去。
    res.write(delta(String(Date.now())));
    if (i < CHUNKS - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  res.write(`data: ${JSON.stringify({ id: "smoke", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
server.listen(PORT, "0.0.0.0", () => console.log(`stub listening on ${PORT}`));
UPSTREAM_STUB

# ── ③ 那一格的三个数，一处定义、四处引用 ────────────────────────────────────
# 上游把 STUB_CHUNKS 块正文按 STUB_GAP_MS 的间隔发出去 ⇒ 逐块透传时，客户端读到的
# **正文首块与末块**之间会铺开约 (STUB_CHUNKS − 1) × STUB_GAP_MS；整体缓冲时它们挤在
# 几毫秒里一起到。门槛取那个跨度的一半：健康态余量约 2 倍，缓冲态差两个数量级
# ——**它不是一个手抄的阈值，改上面两个数它自己会跟着动**。
# ⚠️ 这三个数与 check_stream 里的引用由 tests/unit/smoke-guard.test.ts 的「stub 发几块……三者同出 STUB_CHUNKS / STUB_GAP_MS 这一份定义」钉着：
#   块数只许有这一份，判据里不许再出现第二个写死的块数。
STUB_CHUNKS=4
STUB_GAP_MS=1000
STREAM_SPREAD_MIN_MS=$(( (STUB_CHUNKS - 1) * STUB_GAP_MS / 2 ))
if (( STUB_CHUNKS < 2 || STREAM_SPREAD_MIN_MS < 1 )); then
  echo "❌ ③ 的门槛算出来是 ${STREAM_SPREAD_MIN_MS}ms（块数 $STUB_CHUNKS、间隔 ${STUB_GAP_MS}ms）—— 那一格会变成零鉴别力，不许这么跑" >&2
  exit 2
fi
node "$TMP/upstream-stub.mjs" "$STUB_PORT" "$STUB_GAP_MS" "$STUB_CHUNKS" >"$STUB_LOG" 2>&1 &
STUB_PID=$!
sleep 1
if ! kill -0 "$STUB_PID" 2>/dev/null; then
  echo "❌ 宿主机上那份假上游没起来：" >&2
  cat "$STUB_LOG" >&2
  exit 2
fi
echo "· 假上游（宿主机，给 Worker 用）PID $STUB_PID，端口 $STUB_PORT"

# ── 小工具 ──────────────────────────────────────────────────────────────────
LAST_CODE=""
wait_http() { # $1 = url $2 = 秒数上限；把最后一次拿到的状态码放进 LAST_CODE
  local url="$1" limit="$2" i=0
  while (( i < limit )); do
    LAST_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    if [[ $LAST_CODE == 200 ]]; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

import_key() { # $1 = 形态的基址；给池子里塞一把 key，否则转发路径直接 pool_empty
  local base="$1" out
  out=$(curl -s --max-time 10 -X POST "$base/admin/api/keys" \
    -H "x-admin-key: $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"keys":["sk-smoke-upstream-stub"]}' 2>/dev/null || true)
  printf '%s' "$out"
}

STREAM_BODY='{"model":"agnes-2.0-flash","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"ping"}]}'

# ── override 真的生效了吗：把合出来的那份配置读回来核 ────────────────────────
# ⚠️ **这一步不是形式**：override 能不能压住基文件，取决于 compose 的合并语义
#   （`volumes` 按目标路径认、`env_file` 只有 `!reset` 抹得掉、`ports` 走外壳插值），
#   而**假定错了不会报错，会静静地放行** —— 放行的后果是开发者的 `./data` 被写脏、
#   真 `.env` 被灌进容器，两件事屏幕上都不会有一个字。所以在 `up` 之前先回读一次。
# 允许出现的环境变量键：override 写的那五个 + 基文件 `environment:` 里的 TZ。
# **多出任何一个键**都意味着 `env_file` 那条没被抹掉 ⇒ 当场红。
assert_override_took() {
  local cfg
  if ! cfg=$(compose config --format json 2>&1); then
    echo "❌ docker compose config 没跑通 —— 合出来的配置根本不成立：" >&2
    printf '%s\n' "$cfg" | head -20 >&2
    return 1
  fi
  CFG="$cfg" WANT_SRC="$SMOKE_DATA_DIR" WANT_TGT="$COMPOSE_DATA_TARGET" WANT_PORT="$DOCKER_PORT" node -e '
    const cfg = JSON.parse(process.env.CFG);
    const tgt = process.env.WANT_TGT, src = process.env.WANT_SRC, port = process.env.WANT_PORT;
    const svc = cfg.services && cfg.services.agnes2api;
    const bad = [];
    if (!svc) bad.push("合出来的配置里没有 agnes2api 这个服务");
    else {
      const hits = (svc.volumes || []).filter((v) => v.target === tgt);
      if (hits.length !== 1) {
        bad.push(`挂到 ${tgt} 的挂载有 ${hits.length} 条（应恰好 1 条）⇒ override 没有替换掉基文件那条，开发者的 ./data 会被写进去`);
      } else if (hits[0].source !== src) {
        bad.push(`${tgt} 的宿主侧是 ${hits[0].source}，不是本次的临时目录 ${src} ⇒ 冒烟会往开发者那份 store.json 里写`);
      }
      const allowed = new Set(["PORT", "GATEWAY_TOKEN", "ADMIN_TOKEN", "AGNES_BASE_URL", "USAGE_STATS_ENABLED", "TZ"]);
      const extra = Object.keys(svc.environment || {}).filter((k) => !allowed.has(k));
      if (extra.length > 0) {
        bad.push(`容器里多出这些环境变量键：${extra.join(", ")} ⇒ 开发者的 .env 被整份灌进来了（env_file 那条 !reset 没生效）`);
      }
      const published = (svc.ports || []).map((p) => String(p.published));
      if (!published.includes(String(port))) {
        bad.push(`发布的端口是 [${published.join(", ")}]，里面没有本次的 ${port} ⇒ 外壳里的 PORT 没被插值用上`);
      }
    }
    if (bad.length) { console.error("❌ override 没按预期合上去：\n   · " + bad.join("\n   · ")); process.exit(1); }
    console.log(`· override 已回读核对：${tgt} ← ${src}；环境变量键 ${Object.keys(svc.environment || {}).sort().join(",")}；发布端口 ${port}`);
  ' || return 1
  return 0
}

# ── ① Docker 形态起得来 ─────────────────────────────────────────────────────
# ⚠️ **`--build` 不是可选的**：`docker-compose.yml` 写的是一个已发布镜像的 tag，
#   不带 `--build` 时 compose 会拿本机上那份旧的跑 ⇒ 这一格验的就不是**这棵树**了
#   （而「验了个旧镜像还全绿」正是这种冒烟最容易的死法）。
# override 加的是下面这五样，一样不多一样不少（照着 `cat >"$OVERRIDE"` 那段逐项数得出来）：
#   1. `container_name` —— 项目内的容器名，免得撞上这台机器上真在跑的那个 agnes2api；
#   2. 五个环境变量 —— 两把现生成的口令、本次的端口、指向 **compose 网络里那份 stub**
#      的上游基址、以及打开用量统计（④ 要它）；
#   3. `env_file: !reset []` —— 把开发者自己的 `.env` 整条抹掉（见文件头那段）；
#   4. `/app/data` 那条绑定挂载改指到临时目录 —— 不碰开发者的 `./data`；
#      ⚠️ **代价要说清**：五份 DEPLOY.md 写的那个副作用（`./data` 与其中文件的属主会从你的
#      uid 变成容器里那个 uid）**因此不在这一格的射程里**了。这是有意换的：
#      验它就必须往开发者的真 store.json 上跑。已登记进计划 §「今天仍然欠着的」第 13 条。
#   5. 整个 `smoke-upstream` 服务 —— compose 网络里的那份假上游。
# ⚠️ **没有 `ports:`、也没有 `extra_hosts`**：前者的理由见下面那段，后者是因为这份脚本
#   走的是 compose 网络内的服务名（`smoke-upstream`），**不依赖 `host.docker.internal`**
#   ——文件头第 28 行那句「实测它不通」说的正是这件事。
cell_docker_up() {
  # `ports:` 刻意**不在 override 里重写**：基文件那一行是 `"${PORT:-8080}:${PORT:-8080}"`，
  # 而 compose 的插值读的是**外壳环境**（外壳里的值压过 `.env` 里的同名值）。这里导出 PORT
  # 就让那一行原样用上本次的端口，override 再写一遍会变成两条映射抢同一个宿主端口、自己撞自己。
  # ⇒ 「它真的用上了本次这个端口」由下面那次 `compose config` 回读来证，不靠这段话。
  export PORT="$DOCKER_PORT"
  mkdir -p "$SMOKE_DATA_DIR"
  # compose 网络里那份假上游：镜像直接复用刚构建出来的这一个（它就是 node:22-alpine
  # 打底的，有 node），脚本以只读挂进去。**它不往宿主机发布任何端口**，
  # 只有同一个 compose 网络里的网关连得到它。
  cat >"$OVERRIDE" <<YML
services:
  agnes2api:
    container_name: ${COMPOSE_PROJECT}
    env_file: !reset []
    environment:
      PORT: "${DOCKER_PORT}"
      GATEWAY_TOKEN: "${GATEWAY_TOKEN}"
      ADMIN_TOKEN: "${ADMIN_TOKEN}"
      AGNES_BASE_URL: "http://smoke-upstream:${STUB_PORT_IN_NET}/docker/v1"
      USAGE_STATS_ENABLED: "true"
    volumes:
      - "${SMOKE_DATA_DIR}:${COMPOSE_DATA_TARGET}"
  smoke-upstream:
    image: ghcr.io/xwteam/agnes2api:latest
    entrypoint: ["node", "/stub/upstream-stub.mjs", "${STUB_PORT_IN_NET}", "${STUB_GAP_MS}", "${STUB_CHUNKS}"]
    volumes:
      - "${TMP}/upstream-stub.mjs:/stub/upstream-stub.mjs:ro"
    restart: "no"
YML
  if ! assert_override_took; then return 1; fi
  echo "· docker compose up -d --build（项目 $COMPOSE_PROJECT，端口 $DOCKER_PORT）"
  export_state COMPOSE_UP 1
  if ! compose up -d --build; then
    echo "❌ docker compose up 失败 —— 镜像构建或容器启动那一步就没过去" >&2
    return 1
  fi
  if ! wait_http "$DOCKER_BASE/health" 60; then
    echo "❌ /health 在 60 秒里没回过 200（最后一次是 ${LAST_CODE:-无响应}）" >&2
    compose logs --tail=40 >&2 || true
    return 1
  fi
  echo "· /health 200："
  curl -s --max-time 5 "$DOCKER_BASE/health"
  echo ""
  export_state DOCKER_OK 1
  echo "✅ Docker 形态起得来"
  return 0
}

# ── ② Worker 形态起得来 ─────────────────────────────────────────────────────
# ⚠️ 这一格要的是**真 workerd**：契约用例走的是进程内的 `app.request()`，请求对象直接
#   交给 Hono、响应对象直接拿回来，**HTTP 服务层与 `src/entry/worker.ts` 一个字节都没跑到**。
# 口令走 `--var`，不落任何文件；`.wrangler/` 是 wrangler 自己建的本地状态目录，
# 只有本次跑之前它不存在时才在收尾里删掉。
cell_worker_up() {
  local pid pgid
  if [[ ! -d .wrangler ]]; then export_state WRANGLER_DIR_CREATED 1; fi
  echo "· wrangler dev（端口 $WORKER_PORT）"
  # ⚠️ `--no-install`：裸 `npx wrangler` 在**仓外**跑会去下载一个最新版
  #   （本机实测：仓内 4.123.0、仓外 4.127.1）⇒ 那样这一格验的就不是 package.json
  #   钉住的那个 wrangler 了。这里只认 node_modules 里的那一份，不在就当场吵。
  setsid npx --no-install wrangler dev --port "$WORKER_PORT" --ip 127.0.0.1 \
    --var "GATEWAY_TOKEN:$GATEWAY_TOKEN" \
    --var "ADMIN_TOKEN:$ADMIN_TOKEN" \
    --var "AGNES_BASE_URL:http://127.0.0.1:$STUB_PORT/worker/v1" \
    --var "USAGE_STATS_ENABLED:true" \
    >"$WRANGLER_LOG" 2>&1 &
  pid=$!
  export_state WRANGLER_PID "$pid"
  sleep 1
  # **进程组号现读，不假定 setsid 一定成了**（见收尾里那段）。
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  export_state WRANGLER_PGID "${pgid:-}"
  echo "· wrangler PID $pid，进程组 ${pgid:-读不到}"
  if ! wait_http "$WORKER_BASE/health" 90; then
    echo "❌ /health 在 90 秒里没回过 200（最后一次是 ${LAST_CODE:-无响应}）" >&2
    tail -40 "$WRANGLER_LOG" >&2 || true
    return 1
  fi
  echo "· /health 200："
  curl -s --max-time 5 "$WORKER_BASE/health"
  echo ""
  export_state WORKER_OK 1
  echo "✅ Worker 形态起得来（真 workerd）"
  return 0
}

# ── ③ 两形态的流式都是逐块到达 ─────────────────────────────────────────────
# ⚠️⚠️ **判据是「到达间隔」，不是「拿到了几块」。**
#   一次性缓冲的实现**最终也会把全部内容交出来** ⇒ 只看总量是零鉴别力
#   （与明令禁止的「往单块表里加一行 CRLF 样本」是同一条）。
#
# ⚠️⚠️ **而「第一行」也不是那个观测点** —— 这是本任务复评实测出来的一条洞：
#   `/v1/messages` 那条流的头两行是 `message_start` 与 `content_block_start`，
#   `src/core/protocol/anthropic.ts` 的 `toAnthropicStream()` 里逐字写着它们
#   「**必须在读取上游之前产出**」⇒ 它们的到达时刻与「正文有没有逐块流出来」在构造上无关。
#   实测：把正文增量攒完再一次性吐出来（preamble 保持早发），第一行照样在 +7ms 到，
#   这一格**照样全绿**，屏幕上还打出一句「⇒ 都是逐块透传」。
#   ⇒ 三个时刻**一律只从带上游时间戳的那几行正文里取**：
#     · `first_ms` —— 客户端读到**第一块正文**的时刻（`curl -N` 出来的每一行现打时间戳）；
#     · `last_ms`  —— 客户端读到**最后一块正文**的时刻；
#     · `sent_ms`  —— 假上游把**最后一块**发出去的时刻（**它就写在那一块的正文里**）。
#   两条判据，都必须过：
#     · `spread = last_ms − first_ms` ≥ `STREAM_SPREAD_MIN_MS`
#       —— 逐块透传时它约等于 (块数−1) × 间隔（健康态余量约 2 倍），
#          整体缓冲时几块挤在几毫秒里一起到（差两个数量级）。**这是鉴别力所在。**
#     · `lead = sent_ms − first_ms` > 0
#       —— 第一块正文比上游发完最后一块还早。它在缓冲态只差几毫秒（余量薄），
#          所以**它是佐证不是主判据**；两条一起读才说得清是哪一种形态。
#   下面那句「到齐了几块」同样是**内容侧的陪衬，不是鉴别力所在**：它在缓冲实现下照样绿，
#   留着只是为了把「一块都没到」与「到了但一次性到」这两种红分开说。
stream_probe() { # $1 = 基址 $2 = 输出文件
  # `|| [[ -n $line ]]`：最后一段没有换行时 `read` 返回非 0，但 `$line` 里是有东西的
  # ——不接这一句，一个**单行且不带换行**的错误响应体会被读成「一行都没返回」，
  # 报文就会把人指去查上游，而实际上网关明明白白回了一条 503（本机实测踩过）。
  curl -sN --max-time 60 -X POST "$1/v1/messages" \
    -H "x-api-key: $GATEWAY_TOKEN" -H 'content-type: application/json' \
    -d "$STREAM_BODY" \
    | while IFS= read -r line || [[ -n $line ]]; do
        printf '%s\t%s\n' "$(date +%s%3N)" "$line"
      done >"$2"
}

check_stream() { # $1 = 形态名 $2 = 探针输出
  local label="$1" out="$2" body first_ms last_ms sent_ms deltas spread lead bad=0
  # **只留带上游时间戳的那几行**（= 正文增量）。preamble 那两行不在这里，理由见上面那段。
  body=$(grep -E '"text":"[0-9]{10,}"' "$out" || true)
  deltas=$(printf '%s' "$body" | grep -c . || true)
  if (( deltas == 0 )); then
    if [[ ! -s $out ]]; then
      echo "❌ $label：这次请求一行都没返回 —— 先看它是不是根本没到上游" >&2
    else
      echo "❌ $label：正文里一个上游时间戳都没有 —— 这一趟根本没走到 stub 的流式分支：" >&2
      head -c 400 "$out" >&2
    fi
    return 1
  fi
  first_ms=$(printf '%s\n' "$body" | head -n 1 | cut -f1)
  last_ms=$(printf '%s\n' "$body" | tail -n 1 | cut -f1)
  # 每一块的正文就是它发出去那一刻的毫秒时间戳；取最后一块那个。
  sent_ms=$(printf '%s\n' "$body" | tail -n 1 | grep -oE '"text":"[0-9]{10,}"' | tr -cd '0-9')
  spread=$((last_ms - first_ms))
  lead=$((sent_ms - first_ms))
  echo "   $label：正文首块到达 $first_ms、末块到达 $last_ms（铺开 ${spread}ms，门槛 ${STREAM_SPREAD_MIN_MS}ms）；上游末块发出 $sent_ms（首块领先 ${lead}ms）；正文增量 $deltas 块"
  if (( deltas != STUB_CHUNKS )); then
    echo "❌ $label：正文到了 $deltas 块，而本次让 stub 发的是 $STUB_CHUNKS 块 —— 内容侧就已经不对了" >&2
    echo "   ⇒ 两个数同出一处（脚本里的 STUB_CHUNKS），对不上时先看网关有没有丢块或补块。" >&2
    bad=1
  fi
  if (( spread < STREAM_SPREAD_MIN_MS )); then
    echo "❌ $label：正文首末两块只铺开 ${spread}ms，不到门槛 ${STREAM_SPREAD_MIN_MS}ms" >&2
    echo "   ⇒ 这一趟是**整体缓冲**：内容最后照样全给了，但流式开关在面板上就是一句假话。" >&2
    bad=1
  fi
  if (( lead <= 0 )); then
    echo "❌ $label：正文首块到达（$first_ms）不早于上游最后一块发出（$sent_ms）" >&2
    echo "   ⇒ 同上：第一块正文是等上游全发完之后才出现的。" >&2
    bad=1
  fi
  return $bad
}

cell_stream_interval() {
  local bad=0
  if (( DOCKER_OK == 1 )); then
    stream_probe "$DOCKER_BASE" "$TMP/stream-docker.txt" || true
    if ! check_stream "Docker" "$TMP/stream-docker.txt"; then bad=1; fi
  else
    echo "❌ Docker 形态没起来，这一格在它上面没有观测面（不是「跳过」，是没验到）" >&2
    bad=1
  fi
  if (( WORKER_OK == 1 )); then
    stream_probe "$WORKER_BASE" "$TMP/stream-worker.txt" || true
    if ! check_stream "Worker" "$TMP/stream-worker.txt"; then bad=1; fi
  else
    echo "❌ Worker 形态没起来，这一格在它上面没有观测面（不是「跳过」，是没验到）" >&2
    bad=1
  fi
  if (( bad != 0 )); then return 1; fi
  echo "✅ 两个形态的正文首末块都铺开到了 ${STREAM_SPREAD_MIN_MS}ms 以上，且首块早于上游末块发出 ⇒ 都是逐块透传"
  return 0
}

# ── ④ 用量 30 天档在 Worker 上跑得完 ───────────────────────────────────────
# 这一档一次要发 `USAGE_DAY_RETAIN × USAGE_SLOTS` = 60 次 KV get，而 Cloudflare 的两页
# 官方文档在「一次调用能发多少次子请求」上互相对不上（Workers limits 页免费档 50、
# KV limits 页 1,000，而前者没有定义 KV 绑定调用算哪一行）。
# ⚠️ **判据是「那次请求真的返回了完整的 30 天」**，不是「进程没崩」：
#   · `tier` 必须是 `tier2` —— 是 `off` 的话 handler 在扇出**之前**就 return 了，
#     那 60 次 get 一次都没发生，这一格等于空转；
#   · `note` 不许是 `read_failed` —— 那正是扇出失败时「失败得诚实」的那条路；
#   · `days` 必须恰好 30 段、`range.clamped` 必须是 false —— 少一段就说明窗口被夹小了，
#     发出去的根本不是 60 次。
cell_usage_30d() {
  local to from resp
  if (( WORKER_OK != 1 )); then
    echo "❌ Worker 形态没起来，这一格没有观测面（这一档要验的就是 Worker 那一侧）" >&2
    return 1
  fi
  to=$(date +%s%3N)
  from=$(( to - (USAGE_RANGE_DAYS - 1) * DAY_MS ))
  echo "· GET /admin/api/usage?from=$from&to=$to（$USAGE_RANGE_DAYS 天档）"
  resp=$(curl -s --max-time 30 -H "x-admin-key: $ADMIN_TOKEN" \
    "$WORKER_BASE/admin/api/usage?from=$from&to=$to" 2>/dev/null || true)
  printf '   响应：%s\n' "${resp:0:400}"
  RESP="$resp" EXPECT_DAYS="$USAGE_RANGE_DAYS" node -e '
    const r = JSON.parse(process.env.RESP || "null");
    const want = Number(process.env.EXPECT_DAYS);
    const bad = [];
    if (r === null) bad.push("响应根本不是 JSON（多半是这次请求没返回）");
    else {
      if (r.tier !== "tier2") bad.push(`tier 是 ${JSON.stringify(r.tier)}，不是 tier2 ⇒ 那 60 次 get 一次都没发生`);
      if (r.note === "read_failed") bad.push("note 是 read_failed ⇒ 读扇出真的失败了（它失败得诚实，但这一档没跑完）");
      if (!Array.isArray(r.days) || r.days.length !== want) {
        bad.push(`days 不是 ${want} 段（拿到 ${Array.isArray(r.days) ? r.days.length : JSON.stringify(r.days)}）`);
      }
      if (r.range && r.range.clamped !== false) bad.push("range.clamped 不是 false ⇒ 窗口被夹小了，发出去的不是那 60 次");
    }
    if (bad.length) { console.error("❌ " + bad.join("；")); process.exit(1); }
    console.log(`   tier=${r.tier} note=${r.note} days=${r.days.length} clamped=${r.range.clamped}`);
  ' || return 1
  echo "✅ 本次实测在 wrangler dev 起的 workerd 上跑得完（官方两页文档口径仍对不上，见 src/core/admin/usage-stats.ts 的 USAGE_DAY_RETAIN 上方那段）"
  return 0
}

# ── ⑤ 两形态的 /admin 都出得来 ─────────────────────────────────────────────
# 静态兜底在两个 entry 里是两份装配，而它排错位置的失败形态是**整棵 /admin 变 404**。
check_admin() { # $1 = 形态名 $2 = 基址
  local label="$1" base="$2" code head
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/admin" 2>/dev/null || true)
  head=$(curl -s --max-time 10 "$base/admin" 2>/dev/null | head -c 200 || true)
  echo "   $label：HTTP $code；开头 200 字节 = $(printf '%s' "$head" | head -c 60)…"
  if [[ $code != 200 ]]; then
    echo "❌ $label：/admin 回的是 $code，不是 200" >&2
    return 1
  fi
  if [[ $head != *"<!doctype html>"* || $head != *"agnes2api"* ]]; then
    echo "❌ $label：/admin 回的不是面板 HTML" >&2
    return 1
  fi
  return 0
}

cell_admin_html() {
  local bad=0
  if (( DOCKER_OK == 1 )); then
    if ! check_admin "Docker" "$DOCKER_BASE"; then bad=1; fi
  else
    echo "❌ Docker 形态没起来，这一格在它上面没有观测面" >&2
    bad=1
  fi
  if (( WORKER_OK == 1 )); then
    if ! check_admin "Worker" "$WORKER_BASE"; then bad=1; fi
  else
    echo "❌ Worker 形态没起来，这一格在它上面没有观测面" >&2
    bad=1
  fi
  if (( bad != 0 )); then return 1; fi
  echo "✅ 两个形态的 /admin 都是面板 HTML"
  return 0
}

# ── 跑 ──────────────────────────────────────────────────────────────────────
for line in "${CELL_PLAN[@]}"; do
  IFS=$'\t' read -r id title fn <<<"$line"
  run_cell "$id" "$title" "$fn"
  # 两个形态起来之后各塞一把 key：转发路径没有可用 key 时会直接 pool_empty，
  # ③ 就永远走不到上游。**放在这里而不是各自格子里**，是为了让 ① ② 只回答
  # 「起没起得来」这一件事。
  if [[ $id == "②" ]]; then
    if (( DOCKER_OK == 1 )); then echo "· Docker 导入 key：$(import_key "$DOCKER_BASE")"; fi
    if (( WORKER_OK == 1 )); then echo "· Worker 导入 key：$(import_key "$WORKER_BASE")"; fi
  fi
done

# ── 逐格表 ──────────────────────────────────────────────────────────────────
# 补齐的那一列必须是 ASCII 状态、不是按字节补不准的中日韩标题（与推送前复跑脚本同一条）。
pass=0; failed=0
printf '\n══════════ 双形态冒烟逐格表 ══════════\n'
for id in "${CELL_IDS[@]}"; do
  printf '  %s %-16s %s\n' "$id" "${CELL_STATUS[$id]}" "${CELL_TITLE[$id]}"
  case "${CELL_STATUS[$id]}" in
    PASS) pass=$((pass + 1)) ;;
    *)    failed=$((failed + 1)) ;;
  esac
done
printf '  ── %s 格 PASS / %s 格 FAIL\n' "$pass" "$failed"
if (( failed != 0 )); then
  printf '  ⇒ 双形态没验过。\n'
  exit 1
fi
printf '  ⇒ %s 格全过。\n' "$pass"
exit 0
