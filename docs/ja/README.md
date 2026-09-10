<div align="center">

<img src="../logo.png" width="128" height="128" alt="agnes2api">

<h1>agnes2api</h1>
<h3>マルチプロトコル AI 中継 · Agnes バックエンド</h3>
<p>ひとつのコードベースで OpenAI / Anthropic / OpenAI-Responses / Gemini という 4 大 AI SDK の方言をすべて話し、Agnes AI をバックエンドに対話と画像・動画の生成をまとめて供給します。Docker ならコマンド 1 つでデプロイできます。</p>

<p>
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Docker-20.10+-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-4285F4?style=flat-square&logo=linux&logoColor=white" alt="Arch">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/version-v0.4.0-success?style=flat-square" alt="Version">
</p>

<p>
  <a href="#-最近の更新">最近の更新</a> &bull;
  <a href="#-主な機能">主な機能</a> &bull;
  <a href="#-システム要件">システム要件</a> &bull;
  <a href="#-クイックデプロイ">クイックデプロイ</a> &bull;
  <a href="#-統合例">統合例</a> &bull;
  <a href="#-api-エンドポイント">API エンドポイント</a> &bull;
  <a href="#-設定">設定</a> &bull;
  <a href="#-重要な注意事項">重要な注意事項</a> &bull;
  <a href="#-ロードマップ">ロードマップ</a>
</p>

<p>
  📖 ドキュメントの言語：<a href="../zh-CN/README.md">简体中文</a> | <a href="../zh-TW/README.md">繁體中文</a> | <a href="../en/README.md">English</a> | 日本語 | <a href="../ko/README.md">한국어</a>
</p>

<br>

<a href="https://github.com/xwteam/agnes2api/issues"><img src="https://img.shields.io/github/issues/xwteam/agnes2api?style=flat-square" alt="Issues"></a>
<a href="https://github.com/xwteam/agnes2api/stargazers"><img src="https://img.shields.io/github/stars/xwteam/agnes2api?style=flat-square" alt="Stars"></a>

</div>

---

> [!NOTE]
> 本プロジェクトは研究と学習のみを目的としています。良識のある範囲でご利用ください。商用はお勧めしません。

> [!WARNING]
> 本プロジェクトは Agnes AI との関連も、Agnes AI による承認もありません。Agnes AI のサービスをマルチプロトコル互換 API として包み直すものであり、この使い方は上流の利用規約に適合しない可能性があります。無料枠をまとめて取得する行為も上流の規約と緊張関係にあります。利用は自己責任でお願いします。アカウントへの処分やデータの消失について作者は責任を負いません。

> [!TIP]
> 上流は Agnes API key のプールが供給します。対話は `agnes-2.0-flash` ほか 6 つ、画像は `agnes-image-2.1-flash` ほか 3 つ、動画は `agnes-video-v2.0` ほか 3 つ（タスク作成 + ポーリングの 2 段階）を使います。全一覧は [API.md](API.md) にあります。key プールは自己修復します —— 上流の `429`/`402` はそのキーをクールダウンさせ、`401`/`403` は永久に排除し、一時的な失敗が連続して `MAX_STRIKES` に達した場合は排除ではなく長いクールダウン（`COOLDOWN_STRIKE_MS`、既定 30 分）に入れます。期限切れとともに自動で戻る種類のものに人手の介入は要りません。

> [!IMPORTANT]
> **本ゲートウェイは fail-closed です。トークンが未設定のままトラフィックを捌く動作モードは存在しません。** `GATEWAY_TOKEN` は必須項目で、欠けているとゲートウェイは**起動そのものを拒否**します（`src/core/config.ts` が「缺少 GATEWAY_TOKEN，网关无法启动」を送出します）。ただしこの起動経路は**存在だけを見て長さを見ません**。短いトークンでもゲートウェイは立ち上がるので、強度の担保は利用者側の責任です。管理パネルは既定では**存在しません**。`ADMIN_TOKEN` が未設定なら `/admin` のツリーはそもそも登録されず、アクセスすると 404 になります。設定しても 24 文字未満（`ADMIN_TOKEN_MIN_LENGTH`）なら同じく有効化されず、「管理パネルは有効化されていません（ゲートウェイの転送に影響はありません）」というログが残ります。十分な長さでも `GATEWAY_TOKEN` と**同一**なら管理 API は 503 を返し続けます（転送は平常どおりです）。`ADMIN_TOKEN` は環境変数からのみ読み、ストレージからは読みません。パネルが自分の鍵を自力で交換することはできません。

---

## 📝 最近の更新

> 直近 5 版のみ。**全履歴は [CHANGELOG](../../CHANGELOG.md)** —— この表はリリースごとに 1 行増えるため上限を設けています。

| 日付 | 更新内容 |
|------|----------|
| 2026-09-10 | v0.4.0 - ✂️ **Cloudflare Worker 形態を削除**（破壊的変更）：Docker のみ。Worker ではレジストラーが key を発行できず（上流の制限は IP 単位）、`waitUntil` は長いラウンドを無言で打ち切ります。ほか、パネルが失効上限を 1 分多く表示（6 → 5 分） |
| 2026-09-10 | v0.3.1 - 🔍 **監査の締め**：36 件の指摘を対抗的レビューで 20 件確認し、本版で全て修正。critical 2 件 —— SECURITY.md が v0.3.0 で失われた保証をそのまま記載、`/v1/responses` のストリーミングが公式 SDK 内部でクラッシュ |
| 2026-09-10 | v0.3.0 - 🚀 **利用者向けの大改修**（破壊的変更あり）：モデル目録 4 → 12、パネルにブレークポイントを追加、認証情報の平文表示とコピー、モデル別の疎通テスト。ほか実測不具合を一括修正 |
| 2026-09-09 | v0.2.2 - 🐛 **「今すぐ補充」を修正**（破壊的変更あり）：202 を返した後にラウンド全体が Cloudflare に無言で打ち切られ、ロックが 15 分漏れて定時ラウンドまで塞いでいました。今は完了を待って 200 と実際の結果を返します |
| 2026-09-09 | v0.2.1 - 🧾 **リリース後の後始末**：v0.2.0 の監査結果はタグの後に直したため誰も受け取れませんでした。本版で実際に出します —— LICENSE を純粋な MIT に戻し、README のセクション数を訂正し、実装より多くを主張していた文言を一式直しました |

> 変更履歴の全文は [CHANGELOG.md](../../CHANGELOG.md) にあります。

---

## 🌟 主な機能

> 📖 詳しい使い方ガイド：[USAGE.md](USAGE.md)

### 🔌 4 つのプロトコル入口、1 つの上流

- ひとつのサービスが **OpenAI Chat**、**Anthropic Messages**、**OpenAI Responses**、**Gemini ネイティブ** を同時に話します。各プロトコルの公式 SDK はベース URL を差し替えるだけで直結できます
- 4 本の受信プロトコルは同じ上流スケジューラ、同じ key プール、同じ失敗の切り分けを共有し、ストリーミング（SSE）は 4 本すべてで動きます
- 対話のほかに**画像生成**（`/v1/images/generations`）と**動画生成**（`/v1/videos` でタスク作成 + `/v1/videos/{id}` でポーリングの 2 段階）も転送します
- パスは**素のプレフィックス**の 1 系統だけです。OpenAI と Anthropic は `/v1` の下、Gemini は `/v1beta` の下にあります

### 🔐 統一された認証ゲート

- 4 種類の認証情報の経路を同等に受け付けます：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、クエリパラメータ `?key=` —— 各プロトコルの公式 SDK が既定で送るものにちょうど対応します
- ゲートウェイのトークン `GATEWAY_TOKEN` は**必須**で、無ければプロセスは起動しません。管理トークン `ADMIN_TOKEN` は**別の鍵**であり、両者を同じ値にすると管理 API は停止します
- `/health` の死活確認エンドポイントは認証不要で、それ以外はすべて認証ゲートを通ります

### 🔄 key プールの自己修復と自動補充

> 📖 詳しいレジストラーのガイド：[REGISTRAR.md](REGISTRAR.md)

- 上流の `429`/`402` はそのキーを段階的なクールダウンに入れ、`401`/`403` は永久に排除し、一時的な失敗が連続して `MAX_STRIKES` に達した場合は長いクールダウン（既定 30 分、期限切れで自動復帰）に入れます
- 使えるキーが 1 本も無いときは正直に `503` を返し、区別できる `reason`（未投入 / 全部クールダウン中 / 全部停止中 / 全部排除済み / 上流が失敗し続けている）を添えます。クールダウンの場合は `Retry-After` も付きます
- **自動補充は既定では無効**です。`REGISTRAR_ENABLED` を有効にすると、使えるキーが `TARGET_KEYS` を下回ったときに Agnes アカウントを登録してプールを埋め直します
- レジストラーの 2 本の一時メールボックス経路（`yyds` / `moemail`）は**厳密に対等**です。いずれか一方を選ぶ方式で、どちらにするかは利用者が決めるもの。推奨値は組み込まれていません

### 🔀 ストレージとトラフィックの分離

- 状態はすべて単一ファイルの JSON（`store.json`）に落ちます: key プール、パネルの設定、対外キー表、イベントリングはどれも同じマウントボリューム上にあります
- ストレージへのアクセスはトラフィックから切り離されています。key プールはプロセス単位でキャッシュされ、テレメトリ用のフィールドしか変わらない更新はまるごと捨てられるので、定常状態ではストレージの読みも書きもリクエスト量とともに増えません
- 補充と `pool:index` の照合は同じプロセス内タイマー（`TEND_INTERVAL_MS`）で回ります。レジストラーがオフでも照合は走り続けます

### 🖥 Web 管理パネル

> 📖 詳しいパネルのガイド：[ADMIN.md](ADMIN.md)

- **既定では無効**です。`ADMIN_TOKEN` が未設定なら `/admin` のツリーはそもそも登録されず、アクセスすると 404 になります。認証なしのパネルが露出することはありません
- 9 つのセクション：概要、key プール、レジストラー、イベント、使用量、モデル、プレイグラウンド、API キー、設定
- **ビルド手順は不要**です。`admin-ui/` をそのまま `/admin/` の下に置いたものがそのままデバッグできるパネルで、ビルドスクリプトはそれを 1 バイトずつ生成物へ焼き込むだけです
- トークンは `x-admin-key` リクエストヘッダーだけを通ります。Cookie にもクエリ文字列にも載りません

### ⚡ 高性能アーキテクチャ

- **TypeScript + Hono** を土台に、1 本のルーティングツリーが 4 つのプロトコル・メディア転送・`/admin` サブツリーを担います
- 上流のレスポンスは既定でストリームのまま転送します。非ストリーミングのリクエストは `stream:false` のまま上流へ送り、ゲートウェイが上流の JSON を解析して、呼び出したプロトコルの形に翻訳します
- ポート層とアダプター層は分かれており（ストレージ、フェッチ、ログ、メールボックスはいずれも差し替え可能なポート）、契約テストは実際に組み立てたルーティングツリーを直接叩きます
- マルチステージの Docker ビルド、非 root 実行、マルチアーキテクチャのイメージ（amd64 / arm64）、ヘルスチェック

---

## 📋 システム要件

| 依存 | バージョン | 備考 |
|------|----------|------|
| Node.js | 22.13+ | ソースからビルドする場合や Node で直接動かす場合にだけ必要です。Docker でのデプロイならローカルへの導入は要りません |
| Docker | 20.10+ | 推奨のデプロイ方法です。公式イメージはマルチアーキテクチャです |
| Agnes アカウント | — | 有効な Agnes API key が最低 1 本必要です（レジストラーに補充させることもできます） |
| マウントボリューム | — | コンテナが `./data` を `/app/data` にマウントします。状態はすべてそこに落ちるので、アップグレード前にバックアップを |

> [!TIP]
> Docker でデプロイするならローカルに Node.js を入れる必要はなく、Docker と有効な Agnes API key があれば足ります。

---

## ⚡ クイックデプロイ

> 📖 詳しいデプロイのガイド：[DEPLOY.md](DEPLOY.md)

> **前提条件**：有効な Agnes API key が最低 1 本と、Docker を動かせるマシンが必要です。

### 1. 上流の key を用意する

Agnes AI のプラットフォームで API key を 1 本作って手元に置きます。手作業で用意したくなければ、先にゲートウェイを立ち上げてからレジストラーを有効にして補充させることもできます —— どちらの道もデプロイのガイドに全部書いてあります。

### 2. デプロイする

```bash
# リポジトリをクローンする
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api

# 環境変数ファイルを作る
cp .env.example .env
```

`.env` を編集して、少なくともゲートウェイのトークンを入れます：

```env
GATEWAY_TOKEN=あなたのゲートウェイトークン
# 管理パネルのトークン。空のままなら /admin のツリーは登録されません。
# 設定する場合は GATEWAY_TOKEN と別の値で、24 文字以上にしてください。
ADMIN_TOKEN=
```

サービスを起動します：

```bash
mkdir -p data
docker compose up -d
```

ログを見て起動を確認します：

```bash
docker compose logs -f
# 待ち受けポートが見えたら起動成功です
```

> **最初のイメージが公開される前**（または fork 後）は、`docker compose up -d` は
> ローカルビルドにフォールバックします —— `docker-compose.yml` の `build:` ブロックが
> そのためのものです。

### 3. 動作を確かめる

```bash
# ヘルスチェック（認証不要）。前段にドメインを置いたなら自分のアドレスに置き換える
curl http://localhost:8080/health
# {"status":"ok","version": "0.4.0"}

# 使えるモデルを確かめる
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"

# テストのリクエストを送る
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"こんにちは"}]}'
```

AI からの文章が返ってくればデプロイは成功です。401 が返る場合は API キーを確かめてください。

---

## 🧪 統合例

> [!NOTE]
> どのリクエストにもゲートウェイのトークンを載せます。認証ゲートは次の 4 種類の認証情報の経路を同じように扱うので、特定の SDK のために追加の設定をする必要はありません：
> - `Authorization: Bearer <token>`（OpenAI SDK が既定で送るもの）
> - `x-api-key: <token>`（Anthropic SDK が既定で送るもの）
> - `x-goog-api-key: <token>`（Google GenAI SDK が既定で送るもの）
> - クエリパラメータ `?key=<token>`（手動での呼び出しやブラウザからの利用）
>
> 以下の `http://localhost:8080` は実際にデプロイした先（ローカルアドレス、または前段に置いたドメイン）に、`your-gateway-token` は本物のゲートウェイのトークンに置き換えてください。

<details>
<summary><b>OpenAI SDK（Python）</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "こんにちは"}],
)
print(resp.choices[0].message.content)
```

ストリーミングは OpenAI に直接つないだときとまったく同じです —— `stream=True` を渡して、返ってきたジェネレーターを回すだけです。

</details>

<details>
<summary><b>Anthropic SDK（Python）</b></summary>

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "こんにちは"}],
)
print(msg.content[0].text)
```

SDK の `base_url` に `/v1` を**付けない**点に注意してください —— SDK が自分で `/v1/messages` を継ぎ足します。

</details>

<details>
<summary><b>Gemini SDK（Python）</b></summary>

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="こんにちは",
)
print(resp.text)
```

ここでも SDK の `base_url` に `/v1beta` は**付けません** —— SDK が自分で `/v1beta/models/...` を継ぎ足します。

</details>

<details>
<summary><b>OpenAI-Responses（cURL）</b></summary>

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","input":"こんにちは"}'
```

このプロトコルには広く使われている専用 SDK がまだ無いので、素の HTTP 呼び出しが一番はっきりした例になります。レスポンスの構造とストリーミングのイベント列は各言語の API リファレンスにあります。

</details>

<details>
<summary><b>画像生成</b></summary>

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"a cat"}'
```

同期転送です。リクエストボディもレスポンスボディも上流からそのまま通り抜け、ゲートウェイが構造を書き換えることはありません。ストリーミングの初回バイトの予算ではなく、同期のタイムアウト予算で動きます。

</details>

<details>
<summary><b>動画生成（2 段階）</b></summary>

```bash
# ① タスクを作る。すぐ返る
curl -X POST http://localhost:8080/v1/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-video-v2.0","prompt":"a cat running"}'

# ② 前の手順で得た id でポーリングする
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

タスクは上流で非同期に走ります。ゲートウェイは転送とポーリングを担うだけで、どちらのレスポンスもそのまま通り抜けます。

</details>

---

## 📡 API エンドポイント

> 📖 詳しい API リファレンス：[API.md](API.md)

### OpenAI 互換（`/v1`）

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| GET | `/v1/models` | モデルの一覧 |
| POST | `/v1/chat/completions` | 対話補完（ストリーミング対応） |

### OpenAI Responses（`/v1`）

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| POST | `/v1/responses` | Responses API（ストリーミング対応） |

### Anthropic 互換（`/v1`）

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| POST | `/v1/messages` | Messages（ストリーミング対応） |

### Gemini ネイティブ（`/v1beta`）

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| GET | `/v1beta/models` | モデルの一覧 |
| POST | `/v1beta/models/{model}:generateContent` | コンテンツ生成（非ストリーミング） |
| POST | `/v1beta/models/{model}:streamGenerateContent` | ストリーミング生成 |

### 画像と動画

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| POST | `/v1/images/generations` | 画像生成（同期転送） |
| POST | `/v1/videos` | 動画タスクの作成 |
| GET | `/v1/videos/{id}` | 動画タスクのポーリング |

### 管理 API

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| GET | `/admin` | 管理パネル本体（**`ADMIN_TOKEN` が未設定ならツリーごと登録されず、アクセスすると 404 です**） |
| GET · POST · PUT · DELETE | `/admin/api/*` | 管理 API：key プール / レジストラー / イベント / 使用量 / モデル / 設定（`x-admin-key` で認証） |

### システム

| メソッド | エンドポイント | 機能 |
|--------|--------------|------|
| GET | `/health` | 死活確認（認証不要。バージョンとストレージの健全性を返します） |

> URL の `localhost:8080` はあくまで例です。ポートは `PORT` が決め、前段にリバースプロキシやドメインを置けばホストはそちらになります。デプロイした先に置き換えてください。
>
> 認証ゲートは 4 種類の認証情報の経路を受け付けます：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、クエリパラメータ `?key=`。各ベンダー固有のヘッダーやパラメータも**同じように受け付ける**ので、公式 SDK はベース URL を差し替えるだけで直結できます。差し替えるのは**値**のほうです —— どの経路で運ばれるものも、本物のベンダーのキーではなく**このゲートウェイ**のトークンでなければなりません。

---

## ⚙ 設定

優先順位は **環境変数 > ストレージ内の設定 > 組み込みの既定値** です。下の表はよく使うものだけを並べています。変数の全体像と取りうる値、既定値の導き方は `.env.example` と各言語のデプロイのガイドにあります。

| 変数 | 必須 | 既定値 | 説明 |
|------|------|--------|------|
| `GATEWAY_TOKEN` | ✅ | — | ゲートウェイのトークン。クライアントはこれでこのゲートウェイを呼びます。欠けているとゲートウェイは起動を拒否します |
| `ADMIN_TOKEN` | ❌ | — | 管理パネルのトークン。未設定なら `/admin` のツリーは登録されません。設定するならゲートウェイのトークンと別の値で 24 文字以上が必要です |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com/v1` | Agnes 上流のベース URL |
| `PORT` | ❌ | `8080` | コンテナ内の待ち受けポート。compose が同じ番号をホストにも公開します |
| `DATA_DIR` | ❌ | `/app/data` | ファイルストレージの書き込み先ディレクトリ。compose のボリュームマウントと結び付いています |
| `UPSTREAM_TIMEOUT_MS` | ❌ | `8000` | ストリーミング応答と動画ポーリングにおける上流の初回バイトの予算（ミリ秒） |
| `UPSTREAM_SYNC_TIMEOUT_MS` | ❌ | `120000` | 同期エンドポイント全体のタイムアウト予算（ミリ秒） |
| `MAX_STRIKES` | ❌ | `3` | 一時的な失敗の上限。到達するとそのキーは長いクールダウンに入ります |
| `POOL_CACHE_TTL_MS` | ❌ | `60000` | key プールのスナップショットが 1 つのプロセス内で生きる時間（ミリ秒） |
| `REGISTRAR_ENABLED` | ❌ | `false` | レジストラーの主スイッチ。有効にすると使えるキーが目標を下回ったときに自動で補充します |
| `TRUST_PROXY` | ❌ | — | 1 にすると転送ヘッダーを信頼します。プロキシや CDN の後ろに本当にいるときだけ設定してください |
| `USAGE_STATS_ENABLED` | ❌ | `false` | パネルの「使用量」セクション向けの時系列。既定では無効で、無効の間はコストがかかりません |

**`.env` を編集したら `docker compose restart` ではなく `docker compose up -d` を実行してください**。コンテナの環境は作成時に凍結されるので、同じコンテナを再起動しても何も読み直されません。

```bash
docker compose up -d      # コンテナを作り直して新しい設定を効かせる
docker compose logs -f    # 起動ログを見て反映を確認する
```

---

## ⚠ 重要な注意事項

1. **外部に公開するデプロイでは `GATEWAY_TOKEN` を必ず設定し、パネルを使うなら `ADMIN_TOKEN` も設定してください**：前者が欠けているとゲートウェイは**そもそも立ち上がらない**ので、未設定のまま動いている状態というものが存在しません。後者を設定しなければ `/admin` のツリーは**登録されません**（404）。設定するならゲートウェイのトークンと別の値で 24 文字以上にしてください。そうでなければパネルは有効化されません（ゲートウェイの転送に影響はありません）。

2. **ストリーミング**：4 つのプロトコルすべてがストリーミングに対応します。`stream:false` のときはゲートウェイも `stream:false` で上流に要求し、上流の JSON を呼び出したプロトコルの形に翻訳して一度に返します（上流が `200` を返しても本文が JSON でなければ `502` になります）。上流のエラーはそのまま透過します（key の断片を書き戻しうる `401`/`403` の本文だけは除きます）。**上流のストリームが途中で切れてもゲートウェイはエラーイベントを差し込みません。** クライアントには正常に終わったように見えるストリームが届くので、切断されたかどうかは上流自身の `finish_reason` で判断してください。

3. **key プールの自己修復**：上流の `429`/`402` はキーをクールダウンさせ、一時的な失敗が連続して `MAX_STRIKES` に達した場合は長いクールダウン（`COOLDOWN_STRIKE_MS`、既定 30 分）に入って期限切れで自動復帰します。**永久の排除は上流の `401`/`403` でだけ起きます。**使えるキーが 1 本も残っていないときは区別できる理由を添えて `503` を返します。同期の経路では、予算を使い切っても 1 本も応答しなかった場合に `504` を返します。

4. **データディレクトリが状態のすべてです**：key プール、パネルの設定、発行済みの対外キーはすべて `./data/store.json` にあり、コピーは 1 つだけで予備はなく、しかも**平文**です。アップグレード前に `cp -a ./data ./data.bak` を実行し、そのディレクトリは認証情報として扱ってください。

5. **ネットワーク環境**：デプロイ側から Agnes 上流（`AGNES_BASE_URL`）に到達できる必要があります。レジストラーを有効にする場合は、選んだ一時メールボックスのサービスと Agnes プラットフォームのバックエンドにも到達できる必要があります。

---

## 🗺 ロードマップ

- [x] 4 つのプロトコル入口（OpenAI / Anthropic / OpenAI-Responses / Gemini）
- [x] 統一された転送カーネルと 4 種類の認証情報の経路を覆う認証ゲート
- [x] ストリーミング（SSE）と非ストリーミングが 4 つのプロトコルで揃った振る舞いをすること
- [x] 画像生成の転送と 2 段階の動画生成の転送
- [x] key プール：取り出し、段階的なクールダウン、永久の排除、区別できる枯渇理由
- [x] 単一ファイル JSON ストレージ：key プール・設定・対外キー表・イベントリングが 1 つのマウントボリュームを共有
- [x] レジストラー：2 本の一時メールボックス経路が対等で、コードの受け取りからプール投入まで全自動
- [x] 9 セクションの Web 管理パネル（ビルド不要、既定では無効）
- [x] 管理 API の認証：fail-closed、トークンはリクエストヘッダーのみ
- [x] 5 言語のドキュメントと 5 言語のパネル
- [x] CI の 13 のゲートと契約テスト
- [ ] 実際の上流のサンプルでプロトコル目録を突き合わせる（今日の上流事実表はどの行にも assumed と書いてあります）
- [ ] 最初の公開コンテナイメージを出す

---

## ☕ サポート & 貢献

> 全文は [SPONSORS.md](SPONSORS.md) にあります

役に立ったと感じたら、プロジェクトに Star を付けてください。オープンソースの維持者にとって一番まっすぐ届く応援になります。

agnes2api はほぼ 1 人で維持しています。コード、ドキュメント、修正、PR、どの形の参加も歓迎します。

**貢献の手順：**

1. 本プロジェクトを Fork する
2. ブランチを作る `git checkout -b feature/your-feature`
3. 変更をコミットする `git commit -m "feat: add something"`
4. push して Pull Request を出す

コードを送る前に [CONTRIBUTING.md](../../CONTRIBUTING.md) を読んでください。セキュリティの問題は公開の issue を立てず、[SECURITY.md](../../SECURITY.md) の手順に沿って非公開で報告してください。

---

## 🙏 謝辞

時間を割いて試してくださるすべての方に感謝します。バグの再現手順、ログ、互換性の報告、機能の案は [Issues](https://github.com/xwteam/agnes2api/issues) へどうぞ —— これは最初のリリースで、key プール、レジストラー、マルチプロトコル互換、Web パネルはどれも現実の場面に磨かれるのをまだ待っています。

---

## 📄 ライセンス

本プロジェクトは [MIT ライセンス](../../LICENSE) で公開しています：

- **与えるもの**：本ソフトウェアを使用、複製、改変、結合、公開、頒布、サブライセンス、販売する権利
- **求めるもの**：著作権表示とライセンス表示を残すこと

本プロジェクトは Agnes AI とは関係がありません。保証もサポートの約束もありませんので、自己責任でご利用いただき、該当する利用規約を守ってください。

---

<div align="center">
  <sub>Built with TypeScript + Hono + Docker | Powered by Agnes AI</sub>
</div>
