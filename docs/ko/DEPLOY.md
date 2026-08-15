# 배포 가이드

**언어:** [English](../en/DEPLOY.md) | [简体中文](../zh-CN/DEPLOY.md) | [繁體中文](../zh-TW/DEPLOY.md) | [日本語](../ja/DEPLOY.md) | 한국어

agnes2api는 동일한 코드베이스와 요청 처리 로직으로 만들어진 두 가지 배포
대상을 제공합니다. 여러분의 인프라에 맞는 쪽을 선택하면 됩니다. 두 방식의
차이는 저장소 백엔드뿐입니다. Worker는 Cloudflare KV 네임스페이스를, Docker는
마운트된 볼륨 위의 JSON 파일을 사용합니다.

## 환경 변수

| 변수 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|
| `GATEWAY_TOKEN` | **예** | – | 클라이언트가 이 게이트웨이를 호출할 때 반드시 제시해야 하는 토큰. |
| `AGNES_BASE_URL` | 아니오 | `https://apihub.agnes-ai.com/v1` | 업스트림 Agnes API의 base URL. |
| `UPSTREAM_TIMEOUT_MS` | 아니오 | `8000` | 이 시간(밀리초) 안에 첫 바이트가 도착하지 않으면 업스트림 호출을 중단. |
| `MAX_STRIKES` | 아니오 | `3` | 연속된 일시적 실패(타임아웃, 네트워크 오류, 업스트림 `5xx`)가 이 임계값에 도달하면 해당 key를 긴 쿨다운에 넣음. |
| `COOLDOWN_RATE_LIMIT_MS` | 아니오 | `60000` | 업스트림이 `429`를 반환한 뒤 해당 key에 적용되는 쿨다운 시간. |
| `COOLDOWN_PAYMENT_MS` | 아니오 | `3600000` | 업스트림이 `402`를 반환한 뒤 해당 key에 적용되는 쿨다운 시간. |
| `COOLDOWN_STRIKE_MS` | 아니오 | `1800000` | key의 일시적 실패가 `MAX_STRIKES`에 도달한 뒤의 쿨다운 시간. 만료되면 자동으로 복구됨. |
| `PORT` | 아니오 (Node/Docker 전용) | `8080` | Node 런타임의 리스닝 포트. Worker에서는 사용되지 않음. |
| `DATA_DIR` | 아니오 (Node/Docker 전용) | `/app/data` | 파일 저장소가 `store.json`을 쓰는 디렉터리. Worker에서는 사용되지 않음. |

`COOLDOWN_RATE_LIMIT_MS`와 `COOLDOWN_PAYMENT_MS`는 기본적으로
`.env.example`에 나열되어 있지 않지만, 두 배포 대상 모두 환경 변수로 읽어
들이므로 필요에 따라 설정할 수 있습니다. 위의 수치형 변수는 모두 양의 정수여야
하며, 그렇지 않으면 게이트웨이가 기동을 거부합니다.

"제거"와 "쿨다운"은 다릅니다. 위 설정과 무관하게, 업스트림 `401`/`403`은 해당
key를 **영구** 제거합니다 —— 이는 "이 key는 더 이상 유효하지 않음" 상태이며
재시도가 무의미하기 때문입니다. 일시적 실패는 결코 제거로 이어지지 않습니다.
`MAX_STRIKES`에 도달해도 `COOLDOWN_STRIKE_MS` 쿨다운에 들어갈 뿐 스스로 복구되므로,
업스트림의 일시적 장애가 key 풀을 영구히 망가뜨리는 일은 없습니다.

어떤 key도 요청을 처리할 수 없을 때 게이트웨이는 `503`과 함께 판별 가능한
`error.reason`을 반환합니다: `pool_empty`(key 미등록), `all_cooling`(모든 key가
쿨다운 중 — 자동 복구되며 `Retry-After` 헤더가 복구 시점을 알려줌),
`all_evicted`(자격 증명 실효로 모든 key가 영구 제거됨 — **자동 복구되지 않으므로**
key 교체 필요), `upstream_error`(key 자체는 정상이나 업스트림이 매번 실패).

## Cloudflare Worker

### 방법 A —— Deploy to Cloudflare 버튼

루트 [README](../../README.md)에 있는 버튼을 클릭하고 Cloudflare를 인증하면
저장소를 fork/clone하고 배포까지 자동으로 진행됩니다. 이후에도 아래의
**secret**과 **KV 네임스페이스** 단계는 직접 완료해야 합니다 —— 버튼만으로는
이 두 가지가 설정되지 않습니다.

### 방법 B —— 수동 배포

1. 저장소를 클론하고 의존성을 설치합니다.

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   pnpm install
   ```

2. key 풀을 위한 KV 네임스페이스를 만들고 `POOL`로 바인딩합니다.

   ```bash
   npx wrangler kv namespace create POOL
   ```

   반환된 네임스페이스 `id`를 `wrangler.toml`에 붙여넣어
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`를 대체합니다.

   ```toml
   [[kv_namespaces]]
   binding = "POOL"
   id = "your-namespace-id"
   ```

3. 게이트웨이 토큰을 Worker secret으로 설정합니다(`wrangler.toml`에
   절대 커밋하지 마세요).

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

4. 배포합니다.

   ```bash
   npx wrangler deploy
   ```

### 태그 push 시 자동 배포

`.github/workflows/deploy-worker.yml`은 `v*` 태그가 push될 때마다 Worker를
자동으로 배포합니다. 단, 저장소의 **Settings → Secrets and variables →
Actions**에 `CLOUDFLARE_API_TOKEN`이 설정되어 있어야 합니다. 설정되어 있지
않으면 워크플로가 경고를 출력하고 배포 단계를 건너뛸 뿐, 전체 실행이
실패하지는 않습니다.

### 로컬 개발

```bash
npx wrangler dev
```

`GATEWAY_TOKEN`은 `wrangler.toml`과 같은 디렉터리에 있는 로컬 `.dev.vars`
파일(이미 `.gitignore`에 포함됨)에 작성하세요 —— 비밀 값을 `wrangler.toml`에
직접 쓰지 마세요.

## Docker

1. 저장소를 클론하고 환경 변수 파일을 준비합니다.

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   cp .env.example .env
   ```

2. `.env`를 편집해 최소한 `GATEWAY_TOKEN`을 설정합니다. 나머지 변수는 위의
   [환경 변수](#환경-변수) 표를 참고하세요.

3. 컨테이너를 시작합니다.

   ```bash
   docker compose up -d
   ```

   `docker-compose.yml`은 기본적으로 `8080` 포트를 게시하며(`.env`의
   `PORT`로 재정의 가능), `./data`를 컨테이너 내부의 `/app/data`에
   마운트합니다 —— `store.json`(key 풀 및 영속화된 설정)이 여기에
   저장됩니다. 재시작/업그레이드 시에도 이 디렉터리를 반드시 유지하세요.
   임포트된 key 풀의 유일한 사본입니다.

4. 컨테이너가 정상적으로 기동했는지 확인합니다.

   ```bash
   curl http://localhost:8080/health
   ```

   이미지에는 `HEALTHCHECK`가 내장되어 있어 Docker가 이를 기준으로 컨테이너
   상태를 보고합니다.

## 업스트림 Agnes key 임포트

현재 버전의 게이트웨이는 key를 풀에 추가하기 위한 HTTP 엔드포인트를 제공하지
않습니다. 저장소 백엔드에 직접 기록해야 합니다. 각 항목은 `key:<id>`를
키로 하는 JSON 객체이며, `<id>`는 풀 내에서 고유하기만 하면 어떤 문자열이든
가능합니다(게이트웨이가 스스로 레코드를 생성할 때는 key의 해시값에서
파생하지만, 읽을 때 이 값을 검증하지는 않으므로 수동 임포트 시에는 고유한
식별자면 무엇이든 사용할 수 있습니다).

```json
{
  "id": "1a2b3c4d5e6f7a8b",
  "key": "실제-agnes-api-key",
  "addedAt": 1735689600000,
  "lastUsedAt": null,
  "cooldownUntil": 0,
  "strikes": 0,
  "evicted": false,
  "evictedReason": null
}
```

### Docker

실행 중인 프로세스와의 쓰기 경합을 피하기 위해 먼저 컨테이너를 중지한 뒤,
호스트에서 `./data/store.json`을 편집해 `"key:1a2b3c4d5e6f7a8b"` 키
아래에 위와 같은 레코드를 추가하고, 다시 컨테이너를 시작합니다.

```bash
docker compose stop
# ./data/store.json 편집
docker compose start
```

`./data/store.json`이 아직 없다면, `key:<id>` 형식의 키를 갖는 단일 JSON
객체로 새로 만들면 됩니다.

### Cloudflare Worker

wrangler로 레코드를 `POOL` KV 네임스페이스에 직접 씁니다.

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"실제-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

`--remote`를 생략하면 프로덕션이 아니라 `wrangler dev`가 사용하는 로컬
네임스페이스에 기록됩니다.
