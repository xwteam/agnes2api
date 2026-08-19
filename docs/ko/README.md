# agnes2api

[![version](https://img.shields.io/badge/version-v0.1.0-success)](../../CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

**언어:** [English](../en/README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | 한국어

agnes2api는 Agnes AI 서비스 앞단에 위치하는 경량 API 게이트웨이로, 이를 OpenAI,
Anthropic, Gemini, OpenAI-Responses라는 4가지 주요 LLM API 프로토콜로 다시
노출합니다. 여기에 더해 이미지 생성과 동영상 생성을 위한 패스스루 엔드포인트도
제공합니다. Cloudflare Worker와 Docker 컨테이너 두 가지 배포 형태를 모두
지원하며, 문제가 있는 업스트림 key를 자동으로 쿨다운시키거나 제거하는 자가
치유형 key 풀을 내장하고 있습니다.

> **상업적 이용에 관하여**
>
> 본 프로젝트는 MIT 라이선스를 채택하고 있어 **법적으로는 상업적 이용이
> 허용**됩니다. 다만 상업 서비스로 사용하는 것은 **권장하지 않습니다**.
>
> 1. 본 프로젝트는 제3자 서비스의 무료 할당량에 의존하며, 가용성·지연 시간·
>    할당량 정책이 언제든 변경될 수 있어 상업 서비스에 필요한 안정성을 보장하지
>    않습니다
> 2. 무료 할당량을 대량으로 확보하는 방식은 상위 서비스 약관과 상충될 수 있으며,
>    그 위험은 전적으로 이용자가 부담합니다
> 3. 본 프로젝트는 어떠한 가용성 보장이나 기술 지원도 제공하지 않습니다
>
> (위 내용은 어디까지나 권고 사항이며 법적 구속력이 없고 라이선스 조항의
> 일부도 아닙니다.)

## 특징

- **4가지 프로토콜, 하나의 업스트림** —— OpenAI, Anthropic, Gemini,
  OpenAI-Responses의 공식 클라이언트가 스트리밍을 포함해 이 게이트웨이에
  그대로 연결됩니다.
- **이미지·동영상 패스스루** —— 이미지 생성은 동기식으로 전달되며, 동영상
  생성은 작업 생성과 폴링으로 이루어진 2단계 흐름입니다.
- **하나의 코드베이스, 두 가지 배포 대상** —— Cloudflare Worker(KV 저장소) 또는
  Docker(파일 저장소) 모두 완전히 동일한 요청 처리 로직으로 동작합니다.
- **자가 치유형 key 풀** —— 업스트림 `429`/`402`는 해당 key를 쿨다운시키고,
  `401`/`403`은 영구적으로 제거합니다. 일시적 실패가 연속으로 임계값에
  도달해도 마찬가지로 제거됩니다.
- **저장소 접근이 트래픽과 분리됨** —— key 풀은 isolate/프로세스 단위로 캐시되고,
  텔레메트리 필드만 바뀌는 갱신은 통째로 버려집니다. 그래서 정상 상태에서는 저장소
  읽기도 쓰기도 요청량에 비례해 늘어나지 않습니다. Cloudflare 무료 등급 KV에서 여유가
  얼마나 남는지는 동시에 활성인 isolate 수에 달려 있습니다 —— 산식과 두 가지 조정
  항목은 [DEPLOY.md](DEPLOY.md)의 "할당량 계산" 절을 참고하세요.
- **4가지 인증 정보 전달 방식 수용** —— `Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`, 쿼리 파라미터 `?key=` 모두 수용됩니다. 각 프로토콜의
  공식 SDK가 기본으로 전송하는 형식과 정확히 일치합니다.
- **선택적 자동 키 풀 보충(기본값은 비활성화)** —— 레지스트라를 활성화하면 사용
  가능한 key가 목표치 아래로 떨어질 때 Agnes 계정을 자동으로 등록해 보충합니다.
  [REGISTRAR.md](REGISTRAR.md)를 참고하세요.

## 엔드포인트 한눈에 보기

| 메서드 | 경로 | 프로토콜 | 비고 |
|---|---|---|---|
| GET | `/health` | – | 인증 불필요 |
| GET | `/v1/models` | OpenAI | 모델 목록 |
| POST | `/v1/chat/completions` | OpenAI | 스트리밍 지원 |
| POST | `/v1/messages` | Anthropic | 스트리밍 지원 |
| POST | `/v1/responses` | OpenAI-Responses | 스트리밍 지원 |
| GET | `/v1beta/models` | Gemini | 모델 목록 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini | 비스트리밍 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini | 스트리밍 |
| POST | `/v1/images/generations` | – | 이미지 생성 |
| POST | `/v1/videos` | – | 동영상 작업 생성 |
| GET | `/v1/videos/{id}` | – | 동영상 작업 폴링 |

전체 요청/응답 예시: [API.md](API.md)

## 모델

| 모델 | 유형 |
|---|---|
| `agnes-2.0-flash` | 대화 |
| `agnes-image-2.1-flash` | 이미지 |
| `agnes-image-2.0-flash` | 이미지 |
| `agnes-video-v2.0` | 동영상 |

## 빠른 시작

### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
npx wrangler kv namespace create POOL   # 반환된 id를 wrangler.toml에 입력
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

### Docker

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env   # GATEWAY_TOKEN 설정
docker compose up -d
```

전체 배포 가이드, 환경 변수 설명, key 수동 임포트 방법: [DEPLOY.md](DEPLOY.md)

## 게이트웨이 사용하기

본 게이트웨이는 OpenAI SDK, Anthropic SDK, Google GenAI SDK의 base URL로
그대로 대체해 사용할 수 있습니다. 각 언어별 접속 예시는 [USAGE.md](USAGE.md)를
참고하세요.

## 라이선스

MIT —— [LICENSE](../../LICENSE) 참고.
