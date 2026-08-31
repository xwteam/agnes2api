<div align="center">

<img src="../logo.png" width="128" height="128" alt="agnes2api">

<h1>agnes2api</h1>
<h3>멀티 프로토콜 AI 릴레이 · Agnes 백엔드</h3>
<p>하나의 코드베이스로 OpenAI / Anthropic / OpenAI-Responses / Gemini 네 가지 주요 AI SDK 방언을 모두 소화하고, Agnes AI를 백엔드로 삼아 대화와 이미지·동영상 생성을 함께 제공합니다. Cloudflare Worker와 Node 두 런타임이 같은 전달 커널을 공유하며, Docker라면 명령 한 줄로 배포할 수 있습니다.</p>

<p>
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Cloudflare%20Workers-edge-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Docker-20.10+-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-4285F4?style=flat-square&logo=linux&logoColor=white" alt="Arch">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/version-v0.1.0-success?style=flat-square" alt="Version">
</p>

<p>
  <a href="#-최근-업데이트">최근 업데이트</a> &bull;
  <a href="#-핵심-기능">핵심 기능</a> &bull;
  <a href="#-시스템-요구사항">시스템 요구사항</a> &bull;
  <a href="#-빠른-배포">빠른 배포</a> &bull;
  <a href="#-통합-예제">통합 예제</a> &bull;
  <a href="#-api-엔드포인트">API 엔드포인트</a> &bull;
  <a href="#-설정">설정</a> &bull;
  <a href="#-주의사항">주의사항</a> &bull;
  <a href="#-로드맵">로드맵</a>
</p>

<p>
  📖 문서 언어: <a href="../zh-CN/README.md">简体中文</a> | <a href="../zh-TW/README.md">繁體中文</a> | <a href="../en/README.md">English</a> | <a href="../ja/README.md">日本語</a> | 한국어
</p>

<br>

<a href="https://github.com/xwteam/agnes2api/issues"><img src="https://img.shields.io/github/issues/xwteam/agnes2api?style=flat-square" alt="Issues"></a>
<a href="https://github.com/xwteam/agnes2api/stargazers"><img src="https://img.shields.io/github/stars/xwteam/agnes2api?style=flat-square" alt="Stars"></a>

</div>

---

> [!NOTE]
> 본 프로젝트는 연구와 학습만을 목적으로 합니다. 상식적인 범위에서 이용해 주세요. 상업적 용도로는 권장하지 않습니다.

> [!WARNING]
> 본 프로젝트는 Agnes AI와 아무런 제휴 관계가 없으며 Agnes AI의 승인을 받은 것도 아닙니다. Agnes AI 서비스를 멀티 프로토콜 호환 API로 감싸는 것이며, 이런 사용 방식은 업스트림 이용약관에 어긋날 수 있습니다. 무료 할당량을 대량으로 확보하는 방식 역시 업스트림 약관과 상충되는 면이 있습니다. 이용에 따르는 위험은 본인이 부담하며, 계정 제재나 데이터 손실에 대해 작성자는 책임지지 않습니다.

> [!TIP]
> 업스트림은 Agnes API key 풀이 공급합니다. 대화는 `agnes-2.0-flash`, 이미지는 `agnes-image-2.1-flash`와 `agnes-image-2.0-flash`, 동영상은 `agnes-video-v2.0`(작업 생성 + 폴링 2단계)을 씁니다. key 풀은 스스로 회복합니다 —— 업스트림의 `429`/`402`는 해당 키를 쿨다운시키고, `401`/`403`은 영구히 제거하며, 일시적 실패가 연달아 `MAX_STRIKES`에 닿으면 제거가 아니라 긴 쿨다운(`COOLDOWN_STRIKE_MS`, 기본 30분)에 넣습니다. 시간이 지나면 저절로 돌아오는 부류에는 사람 손이 필요 없습니다.

> [!IMPORTANT]
> **이 게이트웨이는 fail-closed입니다. 토큰을 설정하지 않은 채로 트래픽을 처리하는 동작 모드는 존재하지 않습니다.** `GATEWAY_TOKEN`은 필수 항목이라 값이 없으면 게이트웨이는 **기동 자체를 거부**합니다(`src/core/config.ts`가 `缺少 GATEWAY_TOKEN，网关无法启动`를 던집니다). 다만 이 기동 경로는 **존재 여부만 보고 길이는 보지 않습니다**. 짧은 토큰으로도 게이트웨이는 올라오므로 강도를 챙기는 일은 이용자의 몫입니다. 관리 패널은 기본적으로 **존재하지 않습니다**. `ADMIN_TOKEN`을 설정하지 않으면 `/admin` 트리 자체가 등록되지 않아 접근하면 404가 돌아옵니다. 설정하더라도 24자 미만(`ADMIN_TOKEN_MIN_LENGTH`)이면 마찬가지로 활성화되지 않고, 「관리 패널이 활성화되지 않았습니다(게이트웨이 전달에는 영향이 없습니다)」라는 로그가 남습니다. 길이가 충분해도 `GATEWAY_TOKEN`과 **동일**하면 관리 API는 계속 503을 돌려줍니다(전달은 평소대로 동작합니다). `ADMIN_TOKEN`은 환경 변수에서만 읽고 저장소에서는 읽지 않으므로, 패널이 자기 열쇠를 스스로 교체할 수는 없습니다.

---

## 📝 최근 업데이트

| 날짜 | 변경 내용 |
|------|----------|
| 2026-08-31 | v0.1.0 - 🎉 **첫 릴리스**: 4개 프로토콜 게이트웨이, 레지스트라, 관리 패널이 한 번에 갖춰졌고 같은 코드가 Cloudflare Worker와 Node / Docker 두 런타임에서 함께 돕니다. 네 갈래 인바운드 프로토콜은 같은 업스트림 스케줄러, 같은 key 풀, 같은 실패 원인 판별을 공유합니다. 레지스트라의 임시 메일함 경로 두 개는 엄격하게 대등합니다. 패널은 여덟 개 섹션이며 빌드 단계가 필요 없습니다. 문서는 5개 언어로 각각 한 벌씩 있습니다 |

> 전체 변경 이력은 [CHANGELOG.md](../../CHANGELOG.md)에 있습니다.

---

## 🌟 핵심 기능

> 📖 자세한 사용 안내: [USAGE.md](USAGE.md)

### 🔌 네 갈래 프로토콜 입구, 하나의 업스트림

- 서비스 하나가 **OpenAI Chat**, **Anthropic Messages**, **OpenAI Responses**, **Gemini 네이티브**를 동시에 구사하며, 각 프로토콜의 공식 SDK는 베이스 URL만 바꾸면 그대로 붙습니다
- 네 갈래 인바운드 프로토콜은 같은 업스트림 스케줄러, 같은 key 풀, 같은 실패 원인 판별을 공유하고 스트리밍(SSE)은 네 갈래 모두에서 동작합니다
- 대화 외에 **이미지 생성**(`/v1/images/generations`)과 **동영상 생성**(`/v1/videos`로 작업을 만들고 `/v1/videos/{id}`로 폴링하는 2단계)도 전달합니다
- 경로는 **맨 앞 접두사** 한 갈래뿐입니다. OpenAI와 Anthropic은 `/v1` 아래, Gemini는 `/v1beta` 아래에 있습니다

### 🔐 하나로 모은 인증 게이트

- 네 가지 자격 증명 경로를 똑같이 받아들입니다: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, 쿼리 파라미터 `?key=` —— 각 프로토콜의 공식 SDK가 기본으로 보내는 바로 그 방식입니다
- 게이트웨이 토큰 `GATEWAY_TOKEN`은 **필수**이며 없으면 프로세스가 뜨지 않습니다. 관리 토큰 `ADMIN_TOKEN`은 **다른 열쇠**이고, 둘을 같은 값으로 두면 관리 API가 멈춥니다
- `/health` 생존 확인 엔드포인트는 인증이 필요 없고, 나머지는 모두 인증 게이트를 지납니다

### 🔄 key 풀 자가 회복과 자동 보충

> 📖 자세한 레지스트라 안내: [REGISTRAR.md](REGISTRAR.md)

- 업스트림의 `429`/`402`는 해당 키를 단계별 쿨다운에 넣고, `401`/`403`은 영구히 제거하며, 일시적 실패가 연달아 `MAX_STRIKES`에 닿으면 긴 쿨다운(기본 30분, 만료되면 자동 복귀)에 넣습니다
- 쓸 수 있는 키가 하나도 없으면 정직하게 `503`을 돌려주고 구분 가능한 `reason`(아직 넣지 않음 / 전부 쿨다운 중 / 전부 중지됨 / 전부 제거됨 / 업스트림이 계속 실패)을 함께 줍니다. 쿨다운인 경우에는 `Retry-After`도 붙습니다
- **자동 보충은 기본적으로 꺼져 있습니다**. `REGISTRAR_ENABLED`를 켜면 쓸 수 있는 키가 `TARGET_KEYS` 아래로 내려갔을 때 Agnes 계정을 등록해 풀을 다시 채웁니다
- 레지스트라의 임시 메일함 경로 두 개(`yyds` / `moemail`)는 **엄격하게 대등**합니다. 어느 쪽을 주로 쓸지는 이용자가 정하며, 권장값을 미리 박아두지 않았습니다

### 🔀 두 런타임, 하나의 전달 커널

- 같은 TypeScript 코드가 **Cloudflare Worker**(key 풀은 KV)에서도 **Node / Docker**(key 풀은 단일 JSON 파일)에서도 돌고, 요청 처리 로직은 글자 하나까지 같습니다
- 저장소 접근은 트래픽과 떼어놓았습니다. key 풀은 isolate/프로세스 단위로 캐시되고 텔레메트리 필드만 바뀌는 갱신은 통째로 버려지므로, 정상 상태에서는 저장소 읽기도 쓰기도 요청량을 따라 늘지 않습니다
- Worker에서는 보충 일정을 Cron 트리거가, Node에서는 프로세스 안의 타이머가 돌립니다. 보충의 의미는 양쪽이 같습니다

### 🖥 웹 관리 패널

> 📖 자세한 패널 안내: [ADMIN.md](ADMIN.md)

- **기본값은 꺼짐**입니다. `ADMIN_TOKEN`을 설정하지 않으면 `/admin` 트리 자체가 등록되지 않아 접근하면 404가 돌아옵니다. 인증 없는 패널이 드러나는 일은 없습니다
- 여덟 개 섹션: 개요, key 풀, 레지스트라, 이벤트, 사용량, 모델, 플레이그라운드, 설정
- **빌드 단계가 없습니다**. `admin-ui/`를 그대로 `/admin/` 아래에 둔 것이 곧 디버깅 가능한 패널이고, 빌드 스크립트는 그것을 바이트 단위로 생성물에 구워 넣을 뿐입니다
- 토큰은 `x-admin-key` 요청 헤더로만 오갑니다. 쿠키에도 쿼리 문자열에도 실리지 않습니다

### ⚡ 고성능 아키텍처

- **TypeScript + Hono** 위에서 Worker 진입점과 Node 진입점이 같은 라우팅 트리를 공유합니다
- 업스트림 응답은 기본적으로 스트림 그대로 전달합니다. 비스트리밍 요청은 `stream:false` 그대로 업스트림에 보내고, 게이트웨이가 업스트림의 JSON을 파싱해 호출한 프로토콜의 모양으로 옮깁니다
- 포트 계층과 어댑터 계층이 분리되어 있고(저장소, 페치, 로그, 메일함 모두 갈아 끼울 수 있는 포트입니다), 계약 테스트는 두 런타임에서 각각 한 번씩 돕니다
- 멀티 스테이지 Docker 빌드, 비 root 실행, 멀티 아키텍처 이미지(amd64 / arm64), 헬스 체크

---

## 📋 시스템 요구사항

| 의존 | 버전 | 비고 |
|------|------|------|
| Node.js | 22.13+ | 소스에서 빌드하거나 Node로 직접 돌릴 때만 필요합니다. Docker 배포라면 로컬 설치가 필요 없습니다 |
| Docker | 20.10+ | 권장하는 배포 방식이며 공식 이미지는 멀티 아키텍처입니다 |
| Agnes 계정 | — | 유효한 Agnes API key가 최소 한 개 필요합니다(레지스트라에게 보충을 맡길 수도 있습니다) |
| Cloudflare 계정 | wrangler 4+ | Cloudflare Worker 형태에서만 필요합니다. KV 네임스페이스 하나를 만들고 한 번 배포하면 됩니다 |

> [!TIP]
> Docker로 배포하면 로컬에 Node.js를 설치할 필요가 없고 Docker와 유효한 Agnes API key만 있으면 충분합니다. Cloudflare Worker에 배포한다면 서버조차 필요 없고 Cloudflare 계정과 wrangler 명령줄만 있으면 됩니다.

---

## ⚡ 빠른 배포

> 📖 자세한 배포 안내: [DEPLOY.md](DEPLOY.md)

> **사전 조건**: 유효한 Agnes API key가 최소 한 개, 그리고 Cloudflare 계정(Worker 형태)이나 Docker를 돌릴 수 있는 머신 중 하나가 필요합니다.

### 1. 업스트림 key 준비하기

Agnes AI 플랫폼에서 API key를 하나 만들어 두세요. 손으로 준비하기 싫다면 게이트웨이를 먼저 띄운 뒤 레지스트라를 켜서 풀을 채우게 해도 됩니다 —— 두 갈래 모두 배포 안내에 전부 적혀 있습니다.

### 2. 배포하기

#### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

원클릭 배포는 로컬 클론 단계를 생략해 주지만 대신해 주지 못하는 것이 두 가지 있습니다: `wrangler.toml`의 KV 네임스페이스 id(저장소에 있는 값은 항상 자리표시자입니다)와 `GATEWAY_TOKEN` secret——둘 중 하나라도 빠지면 게이트웨이가 기동되지 않습니다. 전 과정을 직접 진행하거나 배포 후에 이 두 가지를 채우려면 아래 명령을 사용하세요:

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install

# KV 네임스페이스를 만들고 돌려받은 id를 wrangler.toml에 적는다
npx wrangler kv namespace create POOL

# 게이트웨이 토큰은 필수 비밀값이다. secret으로 주입하고 저장소에는 넣지 않는다
npx wrangler secret put GATEWAY_TOKEN

npx wrangler deploy
```

#### Docker

```bash
# 저장소를 복제한다
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api

# 환경 변수 파일을 만든다
cp .env.example .env
```

`.env`를 편집해 최소한 게이트웨이 토큰을 채웁니다:

```env
GATEWAY_TOKEN=당신의-게이트웨이-토큰
# 관리 패널 토큰. 비워 두면 /admin 트리가 등록되지 않습니다.
# 설정한다면 GATEWAY_TOKEN과 다른 값이어야 하고 24자 이상이어야 합니다.
ADMIN_TOKEN=
```

서비스를 띄웁니다:

```bash
mkdir -p data
docker compose up -d
```

로그를 보고 기동을 확인합니다:

```bash
docker compose logs -f
# 수신 포트가 보이면 기동에 성공한 것입니다
```

> **첫 이미지가 배포되기 전**(또는 fork 이후)에는 `docker compose up -d` 가
> 로컬 빌드로 폴백합니다 —— `docker-compose.yml` 의 `build:` 블록이 그 역할을 합니다.

### 3. 확인하기

```bash
# 헬스 체크(인증 없음). Worker에서는 자신의 https://<name>.<sub>.workers.dev로 바꾼다
curl http://localhost:8080/health
# {"status":"ok","version":"0.1.0"}

# 쓸 수 있는 모델을 확인한다
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"

# 테스트 요청을 보낸다
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"안녕하세요"}]}'
```

AI가 보낸 문장이 돌아오면 배포가 성공한 것입니다. 401이 돌아온다면 API 키를 확인해 보세요.

---

## 🧪 통합 예제

> [!NOTE]
> 모든 요청에는 게이트웨이 토큰을 실어야 합니다. 인증 게이트는 아래 네 가지 자격 증명 경로를 똑같이 다루므로 특정 SDK를 위해 따로 설정할 것이 없습니다:
> - `Authorization: Bearer <token>`(OpenAI SDK가 기본으로 보내는 방식)
> - `x-api-key: <token>`(Anthropic SDK가 기본으로 보내는 방식)
> - `x-goog-api-key: <token>`(Google GenAI SDK가 기본으로 보내는 방식)
> - 쿼리 파라미터 `?key=<token>`(수동 호출과 브라우저 환경)
>
> 아래의 `http://localhost:8080`은 실제로 배포한 주소(Worker의 `*.workers.dev` 도메인, 사용자 도메인, 또는 Docker 배포의 로컬 주소)로, `your-gateway-token`은 진짜 게이트웨이 토큰으로 바꿔 주세요.

<details>
<summary><b>OpenAI SDK(Python)</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "안녕하세요"}],
)
print(resp.choices[0].message.content)
```

스트리밍은 OpenAI에 직접 붙였을 때와 똑같습니다 —— `stream=True`를 넘기고 돌려받은 제너레이터를 돌리면 됩니다.

</details>

<details>
<summary><b>Anthropic SDK(Python)</b></summary>

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "안녕하세요"}],
)
print(msg.content[0].text)
```

SDK의 `base_url`에는 `/v1`을 **붙이지 않는다**는 점에 유의하세요 —— SDK가 알아서 `/v1/messages`를 이어 붙입니다.

</details>

<details>
<summary><b>Gemini SDK(Python)</b></summary>

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="안녕하세요",
)
print(resp.text)
```

여기서도 SDK의 `base_url`에 `/v1beta`는 **붙이지 않습니다** —— SDK가 알아서 `/v1beta/models/...`를 이어 붙입니다.

</details>

<details>
<summary><b>OpenAI-Responses(cURL)</b></summary>

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","input":"안녕하세요"}'
```

이 프로토콜은 아직 널리 쓰이는 전용 SDK가 없어서 맨 HTTP 호출이 가장 분명한 예시입니다. 응답 구조와 스트리밍 이벤트 순서는 각 언어의 API 레퍼런스에 있습니다.

</details>

<details>
<summary><b>이미지 생성</b></summary>

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"a cat"}'
```

동기 전달입니다. 요청 본문도 응답 본문도 업스트림에서 그대로 통과하며 게이트웨이가 구조를 고쳐 쓰지 않습니다. 스트리밍의 첫 바이트 예산이 아니라 동기 타임아웃 예산으로 움직입니다.

</details>

<details>
<summary><b>동영상 생성(2단계)</b></summary>

```bash
# ① 작업을 만든다. 곧바로 돌아온다
curl -X POST http://localhost:8080/v1/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-video-v2.0","prompt":"a cat running"}'

# ② 앞 단계에서 받은 id로 폴링한다
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

작업은 업스트림에서 비동기로 돌아갑니다. 게이트웨이는 전달과 폴링만 맡고 두 응답 모두 그대로 통과합니다.

</details>

---

## 📡 API 엔드포인트

> 📖 자세한 API 레퍼런스: [API.md](API.md)

### OpenAI 호환(`/v1`)

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| GET | `/v1/models` | 모델 목록 |
| POST | `/v1/chat/completions` | 대화 완성(스트리밍 지원) |

### OpenAI Responses(`/v1`)

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| POST | `/v1/responses` | Responses API(스트리밍 지원) |

### Anthropic 호환(`/v1`)

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| POST | `/v1/messages` | Messages(스트리밍 지원) |

### Gemini 네이티브(`/v1beta`)

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| GET | `/v1beta/models` | 모델 목록 |
| POST | `/v1beta/models/{model}:generateContent` | 콘텐츠 생성(비스트리밍) |
| POST | `/v1beta/models/{model}:streamGenerateContent` | 스트리밍 생성 |

### 이미지와 동영상

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| POST | `/v1/images/generations` | 이미지 생성(동기 전달) |
| POST | `/v1/videos` | 동영상 작업 생성 |
| GET | `/v1/videos/{id}` | 동영상 작업 폴링 |

### 관리 API

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| GET | `/admin` | 관리 패널 본체(**`ADMIN_TOKEN`을 설정하지 않으면 트리째 등록되지 않아 접근하면 404입니다**) |
| GET · POST · PUT · DELETE | `/admin/api/*` | 관리 API: key 풀 / 레지스트라 / 이벤트 / 사용량 / 모델 / 설정(`x-admin-key`로 인증) |

### 시스템

| 메서드 | 엔드포인트 | 기능 |
|------|----------|------|
| GET | `/health` | 생존 확인(인증 없음. 버전과 저장소 건강 상태를 돌려줍니다) |

> URL 안의 `localhost:8080`은 예시일 뿐입니다. Node에서는 포트를 `PORT`가 정하고, Worker에서는 자신의 `*.workers.dev`나 사용자 도메인이 됩니다. 배포한 곳으로 바꿔 주세요.
>
> 인증 게이트는 네 가지 자격 증명 경로를 받아들입니다: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, 쿼리 파라미터 `?key=`. 각 벤더 고유의 헤더와 파라미터도 **똑같이 받아들이므로** 공식 SDK는 베이스 URL만 바꾸면 그대로 붙습니다. 바꿔야 하는 것은 **값**입니다 —— 어느 경로로 실려 오든 진짜 벤더 키가 아니라 **이 게이트웨이**의 토큰이어야 합니다.

---

## ⚙ 설정

우선순위는 **환경 변수 > 저장소 안의 설정 > 내장 기본값**입니다. 아래 표에는 자주 쓰는 것만 담았습니다. 변수 전체와 값의 범위, 기본값이 어떻게 정해지는지는 `.env.example`과 각 언어의 배포 안내에 있습니다.

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `GATEWAY_TOKEN` | ✅ | — | 게이트웨이 토큰. 클라이언트는 이것으로 이 게이트웨이를 호출합니다. 값이 없으면 게이트웨이는 기동을 거부합니다 |
| `ADMIN_TOKEN` | ❌ | — | 관리 패널 토큰. 설정하지 않으면 `/admin` 트리가 등록되지 않고, 설정한다면 게이트웨이 토큰과 다른 값에 24자 이상이어야 합니다 |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com/v1` | Agnes 업스트림 베이스 URL |
| `PORT` | ❌ | `8080` | Node에서의 수신 포트(Worker에서는 쓰지 않습니다) |
| `DATA_DIR` | ❌ | `/app/data` | 파일 저장소가 기록하는 디렉터리(Worker에서는 쓰지 않습니다) |
| `UPSTREAM_TIMEOUT_MS` | ❌ | `8000` | 스트리밍 응답과 동영상 폴링에서 업스트림 첫 바이트 예산(밀리초) |
| `UPSTREAM_SYNC_TIMEOUT_MS` | ❌ | `120000` | 동기 엔드포인트 전체의 타임아웃 예산(밀리초) |
| `MAX_STRIKES` | ❌ | `3` | 일시적 실패의 상한. 닿으면 그 키는 긴 쿨다운에 들어갑니다 |
| `POOL_CACHE_TTL_MS` | ❌ | `60000` | key 풀 스냅샷이 isolate/프로세스 하나 안에서 살아 있는 시간(밀리초) |
| `REGISTRAR_ENABLED` | ❌ | `false` | 레지스트라 마스터 스위치. 켜면 쓸 수 있는 키가 목표 아래로 내려갈 때 자동으로 보충합니다 |
| `TRUST_PROXY` | ❌ | — | 1로 두면 전달 헤더를 신뢰합니다. Cloudflare 뒤에서 돌린다면 설정해 두세요 |
| `USAGE_STATS_ENABLED` | ❌ | `false` | 패널 「사용량」 섹션을 위한 시계열. 기본값은 꺼짐이며 꺼져 있는 동안에는 비용이 들지 않습니다 |

**Cloudflare Worker 쪽 설정은 `.env`를 지나지 않습니다**. 민감하지 않은 항목은 `wrangler.toml`의 `[vars]` 블록에 적고 민감한 값은 secret으로 주입합니다. KV 네임스페이스와 보충 Cron도 같은 파일에서 선언합니다.

```bash
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

---

## ⚠ 주의사항

1. **외부에 공개하는 배포에서는 `GATEWAY_TOKEN`을 반드시 설정하고, 패널을 쓸 생각이라면 `ADMIN_TOKEN`도 설정하세요**: 앞의 것이 없으면 게이트웨이는 **애초에 뜨지 않으므로** 설정하지 않은 채로 돌아가는 상태라는 것이 존재하지 않습니다. 뒤의 것을 설정하지 않으면 `/admin` 트리는 **등록되지 않습니다**(404). 설정한다면 게이트웨이 토큰과 다른 값에 24자 이상이어야 하며, 그렇지 않으면 패널은 활성화되지 않습니다(게이트웨이 전달에는 영향이 없습니다).

2. **스트리밍**: 네 프로토콜 모두 스트리밍을 지원합니다. `stream:false`일 때는 게이트웨이도 `stream:false`로 업스트림에 요청하고, 받은 JSON을 호출한 프로토콜의 모양으로 옮겨 한 번에 돌려줍니다(`200`인데 본문이 JSON이 아니면 `502`). 업스트림 오류는 그대로 통과시키되, key 조각을 되비출 수 있는 `401`/`403` 본문만 예외입니다. **스트림이 도중에 끊겨도 게이트웨이는 오류 이벤트를 끼워 넣지 않으므로** 클라이언트에게는 정상으로 끝난 스트림이 갑니다. 잘렸는지는 업스트림의 `finish_reason`으로 판단하세요.

3. **key 풀 자가 회복**: 업스트림의 `429`/`402`는 키를 쿨다운시키고, 일시적 실패가 연달아 `MAX_STRIKES`에 닿으면 긴 쿨다운(`COOLDOWN_STRIKE_MS`, 기본 30분)에 들어가 만료되면 자동으로 돌아옵니다. **영구 제거는 업스트림 `401`/`403`에서만 일어납니다.** 쓸 수 있는 키가 하나도 남지 않으면 구분 가능한 이유를 붙여 `503`을 돌려줍니다. 동기 경로에서는 예산을 다 쓰도록 한 개도 응답하지 않은 경우에 `504`를 돌려줍니다.

4. **Cloudflare 무료 등급의 KV 할당량**: 하루 읽기 횟수는 갱신 주기와 살아 있는 isolate 수에만 좌우되고 요청량과는 무관합니다. 다만 권장 설정 그대로도 기본값은 이미 그 선에 가깝습니다. 공개하기 전에 배포 안내의 「할당량 계산」을 한 번 짚어 보고, 필요하면 `POOL_CACHE_TTL_MS`를 키우세요.

5. **네트워크 환경**: 배포 쪽에서 Agnes 업스트림(`AGNES_BASE_URL`)에 닿을 수 있어야 합니다. 레지스트라를 켠다면 고른 임시 메일함 서비스와 Agnes 플랫폼 백엔드에도 닿을 수 있어야 합니다.

---

## 🗺 로드맵

- [x] 네 갈래 프로토콜 입구(OpenAI / Anthropic / OpenAI-Responses / Gemini)
- [x] 하나로 모은 전달 커널과 네 가지 자격 증명 경로를 덮는 인증 게이트
- [x] 스트리밍(SSE)과 비스트리밍이 네 프로토콜에서 같은 모습으로 동작
- [x] 이미지 생성 전달과 2단계 동영상 생성 전달
- [x] key 풀: 꺼내기, 단계별 쿨다운, 영구 제거, 구분 가능한 고갈 이유
- [x] 두 런타임: Cloudflare Worker(KV)와 Node / Docker(파일 저장소)를 같은 코드로
- [x] 레지스트라: 임시 메일함 경로 두 개가 대등하고, 코드 수신부터 풀 투입까지 전자동
- [x] 여덟 개 섹션의 웹 관리 패널(빌드 불필요, 기본값은 꺼짐)
- [x] 관리 API 인증: fail-closed, 토큰은 요청 헤더로만
- [x] 5개 언어 문서와 5개 언어 패널
- [x] CI 13개 게이트와 두 런타임에서의 계약 테스트
- [ ] 실제 업스트림 샘플로 프로토콜 목록 대조하기(오늘의 업스트림 사실 표는 모든 줄에 assumed라고 적혀 있습니다)
- [ ] 첫 공개 컨테이너 이미지 배포하기

---

## ☕ 후원 & 기여

> 전체 내용은 [SPONSORS.md](SPONSORS.md)에 있습니다

도움이 되었다면 프로젝트에 Star를 눌러 주세요. 오픈소스 관리자에게 가장 곧바로 닿는 응원입니다.

agnes2api는 사실상 한 사람이 관리하고 있습니다. 코드, 문서, 수정, PR 어떤 형태의 참여든 환영합니다.

**기여 절차:**

1. 본 프로젝트를 Fork 한다
2. 브랜치를 만든다 `git checkout -b feature/your-feature`
3. 변경을 커밋한다 `git commit -m "feat: add something"`
4. push 하고 Pull Request를 연다

코드를 보내기 전에 [CONTRIBUTING.md](../../CONTRIBUTING.md)를 읽어 주세요. 보안 문제는 공개 issue를 열지 말고 [SECURITY.md](../../SECURITY.md)의 절차에 따라 비공개로 알려 주세요.

---

## 🙏 감사의 말

시간을 내어 시험해 주시는 모든 분께 감사드립니다. 버그 재현 절차, 로그, 호환성 보고, 기능 제안은 [Issues](https://github.com/xwteam/agnes2api/issues)로 보내 주세요 —— 이번이 첫 릴리스이고 key 풀, 레지스트라, 두 런타임, 멀티 프로토콜 호환, 웹 패널 모두 현실의 상황에 다듬어지기를 아직 기다리고 있습니다.

---

## 📄 라이선스

본 프로젝트는 [MIT 라이선스](../../LICENSE)로 공개합니다:

- **주는 것**: 본 소프트웨어를 사용, 복제, 수정, 병합, 게시, 배포, 서브라이선스, 판매할 권리
- **요구하는 것**: 저작권 고지와 라이선스 고지를 남길 것

본 프로젝트는 Agnes AI와 관련이 없습니다. 어떠한 보증도 지원 약속도 없으므로 위험은 본인이 부담하고 해당 이용약관을 지켜 주세요.

---

<div align="center">
  <sub>Built with TypeScript + Hono + Cloudflare Workers | Powered by Agnes AI</sub>
</div>
