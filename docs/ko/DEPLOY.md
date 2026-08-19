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
| `UPSTREAM_TIMEOUT_MS` | 아니오 | `8000` | **스트리밍** 응답과 비디오 폴링의 첫 바이트 타임아웃. 이 시간(밀리초) 안에 업스트림의 첫 바이트가 도착하지 않으면 호출을 중단. |
| `UPSTREAM_SYNC_TIMEOUT_MS` | 아니오 | `120000` | **동기** 엔드포인트의 전체 타임아웃 예산. "첫 바이트가 업스트림이 결과 전체를 계산한 뒤에야 도착하는" 요청에만 적용됨: 이미지 생성, 비디오 작업 생성, 그리고 모든 **비스트리밍** 대화. 아래 설명 참조. |
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

### 레지스트라 관련 변수(선택 사항, 기본값은 비활성화)

레지스트라는 선택적인 자동 키 풀 보충 구성 요소로, 기본값은 비활성화이며 게이트웨이의
핵심 전달 기능에는 영향을 주지 않습니다. 아래는 변수 빠른 참조용 표일 뿐이며, 동작
원리, 두 메일함 채널을 고르는 방법, Cloudflare Cron의 월클록 상한 등 전체 설명은
[REGISTRAR.md](REGISTRAR.md)를 참고하세요.

| 변수 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | 아니오 | `false` | 마스터 스위치. `true`여야 레지스트라가 활성화됨. |
| `REGISTRAR_PRIMARY` | 활성화 시 필수 | 없음 | 주 채널, `yyds` 또는 `moemail`. 둘은 대등하며 기본값 없음. |
| `REGISTRAR_FALLBACK` | 아니오 | 공백(폴백 없음) | 보조 채널, `yyds` 또는 `moemail`. |
| `TARGET_KEYS` | 아니오 | `20` | 목표로 하는 사용 가능 key 수. |
| `MINT_BATCH` | 아니오 | `5` | 한 라운드에서 발급할 key의 최대 개수. |
| `TEND_INTERVAL_MS` | 아니오(Node/Docker 전용) | `1800000` | Node 측 보충 간격. Worker 측은 `wrangler.toml`의 Cron이 대신 결정. |
| `CODE_TIMEOUT_MS` | 아니오 | `120000` | 인증 코드를 기다리는 타임아웃. |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | 아니오 | `2000` / `5000` | 발급 시도 사이의 무작위 대기 시간. |
| `MAX_DOMAIN_ATTEMPTS` | 아니오 | `8` | 한 번의 발급 시도에서 시도할 도메인의 최대 개수. |
| `REGISTRAR_TOKEN_NAME` | 아니오 | `auto` | 발급된 key가 Agnes 대시보드에 표시되는 이름. |
| `AGNES_PLATFORM_URL` | 아니오 | `https://platform-backend.agnes-ai.com` | 등록에 사용하는 Agnes 플랫폼 백엔드. |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | 아니오 / 채널이 yyds일 때 필수 | `https://maliapi.215.im` / 공백 | YYDS Mail 채널 자격 증명. |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | 채널이 moemail일 때 필수 | 공백 / 공백 | MoeMail 채널 자격 증명(자체 호스팅, 기본 주소 없음). |

### 두 가지 타임아웃 예산의 역할

기준은 "업스트림의 첫 바이트가 언제 도착할 수 있는가"이지 엔드포인트의 이름이
아닙니다:

| 예산 | 대상 엔드포인트 | 변수 |
|---|---|---|
| 첫 바이트 | **스트리밍** 대화(`stream: true`), 비디오 폴링 `GET /v1/videos/{id}` | `UPSTREAM_TIMEOUT_MS` |
| 동기 | 이미지 생성, 비디오 작업 생성, **모든 비스트리밍 대화**(네 프로토콜 모두) | `UPSTREAM_SYNC_TIMEOUT_MS` |

비스트리밍 요청은 업스트림이 답변 전체를 생성한 뒤에야 응답 헤더를 보냅니다. 이미지
생성과 완전히 같은 지연 특성이므로, 8초짜리 첫 바이트 예산으로 자르면 정상적인 요청이
대량으로 실패하고 key 풀까지 함께 망가집니다.

`UPSTREAM_SYNC_TIMEOUT_MS`는 **요청 한 건의 총예산**, 즉 클라이언트의 최악 대기 시간이며
"풀 크기 × 예산"이 아닙니다. 게이트웨이는 이 예산에서 key 하나에 최대 절반만 쓰고, 나머지는
다른 key로 재시도하는 데 남겨 둡니다. 그래야 풀에 멈춘 key(연결은 되지만 절대 응답하지
않는)가 있어도 요청 하나를 통째로 잡아먹지 않습니다. 따라서 **단일 호출의 최악 소요 시간의
2배 이상**으로 설정하세요.

동기 예산에서의 타임아웃은 즉시 key를 처벌하지 않습니다. 같은 요청 안에서 바꿔 쓴 다른
key가 실제로 성공했을 때에만 먼저 타임아웃된 key에 책임을 지웁니다(`MAX_STRIKES`에
도달하면 쿨다운). 그 요청에서 모든 key가 타임아웃했다면 하나도 처벌하지 않습니다 ——
예산이 너무 작거나 업스트림 전체가 느릴 가능성이 더 크기 때문입니다.

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
   상태를 보고합니다. 데이터 디렉터리에 쓸 수 없으면 `/health`는 `status`가
   `degraded`인 `503`을 반환하고 컨테이너는 unhealthy로 표시됩니다. 구체적인 원인은
   컨테이너 로그를 확인하세요.

### 컨테이너가 `./data`의 소유자를 바꿉니다 (먼저 확인하세요)

컨테이너는 **root로 entrypoint에 진입**해 두 가지를 한 뒤 권한을 낮춥니다:

- `DATA_DIR`(기본 `/app/data`)의 소유자가 컨테이너 내 실행 사용자 `app`
  (**uid 100 / gid 101**)과 다를 때에만 그 디렉터리를 재귀적으로 `chown`합니다.
  소유자가 이미 일치하면 아무것도 바꾸지 않습니다.
- 그다음 `su-exec`로 권한을 낮추므로 **메인 프로세스(PID 1)는 root가 아니라 app**으로
  실행됩니다.

런타임에 해야 하는 이유는, 바인드 마운트에서는 호스트 디렉터리의 소유자가 이미지 빌드
시점의 `chown`을 덮어쓰기 때문입니다. 그러면 컨테이너 안의 app이 `store.json`에 쓸 수 없고,
이 실패는 조용합니다(모든 API가 `pool_empty`를 반환).

**부작용**: 바인드 마운트에서 바뀌는 것은 **호스트**의 파일입니다. `docker compose up -d`
이후 여러분의 `./data`와 그 안의 파일 소유자는 본인 uid에서 `100:101`로 바뀌며, 이후
호스트에서 읽고 쓰거나 백업하려면 `sudo`가 필요합니다. 원하지 않는다면 `--user`(또는
compose의 `user:`)로 비 root 실행을 지정하세요. 그러면 entrypoint는 chown을 전혀 하지
않으며, 데이터 디렉터리의 소유자와 쓰기 가능 여부는 직접 준비하게 됩니다.

같은 이유로 이미지에는 **`USER app`이 없습니다**. 기본 사용자는 root입니다
(`docker inspect --format '{{.Config.User}}' <image>`는 빈 값을 출력). 이는 Kubernetes에
영향을 줍니다: `runAsNonRoot: true`를 설정하고 `runAsUser`를 명시하지 않으면 kubelet이
컨테이너 기동을 거부합니다. 그런 배포에서는 `runAsUser: 100`, `runAsGroup: 101`(또는 원하는
uid)을 명시하고 볼륨 소유자를 직접 준비하세요 —— 비 root로 기동하면 entrypoint는
"chown 없이 그대로 실행" 분기를 탑니다.

안전 경계: `DATA_DIR`이 `/`나 최상위 시스템 디렉터리(`/etc`, `/usr` 등)로 설정되면
entrypoint는 그 위에서의 재귀 chown을 거부합니다(경고만 출력하고 기동은 계속). 컨테이너
파일 시스템 전체가 app 쓰기 가능해지는 것을 막기 위함입니다.

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

이렇게 가져온 key는 바로 다음 요청부터 적용됩니다. 게이트웨이는 풀의 id 목록을
`pool:index` 키에 보관하며(전달 요청마다 KV `list`를 쓰지 않기 위해서입니다. 무료
등급의 list 할당량은 하루 1,000회뿐입니다), 색인이 모르는 수동 가져오기 레코드는
자동으로 감지되어 색인에 채워집니다.

레지스트라를 쓰지 않더라도 `wrangler.toml`의 `[triggers]` 블록을 지우지 마십시오.
이 cron은 `pool:index`와 실제 `key:` 레코드를 대조해 고치는 유일한 경로이며,
`REGISTRAR_ENABLED` 값과 무관하게 실행됩니다.
