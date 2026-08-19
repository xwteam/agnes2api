# agnes2api

[![version](https://img.shields.io/badge/version-v0.1.0-success)](../../CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

**Language:** [English](../en/README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | 日本語 | [한국어](../ko/README.md)

agnes2api は Agnes AI サービスの手前に立つ軽量な API ゲートウェイで、OpenAI、
Anthropic、Gemini、OpenAI-Responses という 4 つの主要な LLM API プロトコルとして
再公開します。あわせて画像生成・動画生成のパススルーエンドポイントも提供します。
Cloudflare Worker と Docker コンテナの両方の形態でデプロイでき、異常な上流 key を
自動でクールダウンまたは排除する自己修復型の key プールを内蔵しています。

> **商用利用について**
>
> 本プロジェクトは MIT ライセンスを採用しており、**法的には商用利用が可能**です。
> ただし、商用サービスでの利用は**推奨しません**。
>
> 1. 本プロジェクトはサードパーティサービスの無料枠に依存しており、その可用性・
>    遅延・割り当てポリシーは予告なく変更される可能性があり、商用サービスに必要な
>    安定性が保証されません
> 2. 無料枠を大量に取得する行為は上流サービスの利用規約と緊張関係にあり、その
>    リスクは利用者が全面的に負うことになります
> 3. 本プロジェクトは可用性の保証や技術サポートを一切提供しません
>
> （以上はあくまで助言であり、法的拘束力はなく、ライセンス条項の一部でもありません。）

## 特徴

- **4 つのプロトコル、1 つの上流** —— OpenAI、Anthropic、Gemini、
  OpenAI-Responses の公式クライアントがそのまま本ゲートウェイに接続でき、
  ストリーミングにも対応します。
- **画像・動画のパススルー** —— 画像生成の同期転送、および動画生成のタスク作成／
  ポーリングという 2 段階のフローです。
- **2 つのデプロイ先、1 つのコードベース** —— Cloudflare Worker（KV ストレージ）
  または Docker（ファイルストレージ）のどちらも、まったく同じリクエスト処理
  ロジックで動作します。
- **自己修復型の key プール** —— 上流の `429`/`402` はそのキーをクールダウンさせ、
  `401`/`403` は永久に排除します。一時的な失敗が連続して閾値に達した場合も同様に
  排除します。
- **ストレージアクセスがトラフィックから分離** —— key プールは isolate／プロセス単位で
  キャッシュされ、テレメトリ用フィールドしか変わらない更新は丸ごと破棄されます。その
  結果、定常状態ではストレージの読み取りも書き込みもリクエスト量に比例して増えません。
  Cloudflare の無料枠 KV でどれだけ余裕が残るかは同時にアクティブな isolate 数に依存
  します——算出式と 2 つの調整項目は [DEPLOY.md](DEPLOY.md) の「クォータの見積もり」を
  参照してください。
- **4 種類の認証情報を受け付け** —— `Authorization: Bearer`、`x-api-key`、
  `x-goog-api-key`、クエリパラメータ `?key=` のいずれも受け付けます。各プロトコル
  の公式 SDK が既定で送信する形式にちょうど対応しています。
- **オプションの自動プール補充（デフォルトで無効）** —— レジストラーを有効にすると、
  利用可能な key が目標値を下回った際に Agnes アカウントを自動登録して補充します。
  [REGISTRAR.md](REGISTRAR.md) を参照してください。

## エンドポイント一覧

| メソッド | パス | プロトコル | 備考 |
|---|---|---|---|
| GET | `/health` | – | 認証不要 |
| GET | `/v1/models` | OpenAI | モデル一覧 |
| POST | `/v1/chat/completions` | OpenAI | ストリーミング対応 |
| POST | `/v1/messages` | Anthropic | ストリーミング対応 |
| POST | `/v1/responses` | OpenAI-Responses | ストリーミング対応 |
| GET | `/v1beta/models` | Gemini | モデル一覧 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini | 非ストリーミング |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini | ストリーミング |
| POST | `/v1/images/generations` | – | 画像生成 |
| POST | `/v1/videos` | – | 動画タスクの作成 |
| GET | `/v1/videos/{id}` | – | 動画タスクのポーリング |

完全なリクエスト／レスポンス例は [API.md](API.md) を参照してください。

## モデル

| モデル | 種類 |
|---|---|
| `agnes-2.0-flash` | 会話 |
| `agnes-image-2.1-flash` | 画像 |
| `agnes-image-2.0-flash` | 画像 |
| `agnes-video-v2.0` | 動画 |

## クイックスタート

### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
npx wrangler kv namespace create POOL   # 返された id を wrangler.toml に記入
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

### Docker

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env   # GATEWAY_TOKEN を設定
docker compose up -d
```

デプロイの詳細、環境変数、key の手動インポート方法は [DEPLOY.md](DEPLOY.md) を
参照してください。

## ゲートウェイの利用

本ゲートウェイは OpenAI SDK、Anthropic SDK、Google GenAI SDK のベース URL として
そのまま差し替えて使えます。各言語の接続例は [USAGE.md](USAGE.md) を参照して
ください。

## ライセンス

MIT —— [LICENSE](../../LICENSE) を参照してください。
