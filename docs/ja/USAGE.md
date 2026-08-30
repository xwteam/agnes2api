# 使い方ガイド

本ページが扱うのは**クライアント側**です。すでに動いているゲートウェイに各プロトコル公式 SDK の向き先を合わせ、最初のリクエストを送り、ストリーミングを有効にし、拒否されたときどこから見るか——エンドポイントごとのリクエスト / レスポンス契約は [API.md](API.md)、ゲートウェイを立ち上げる二つの道は [DEPLOY.md](DEPLOY.md) にあります。

> [!TIP]
> agnes2api はプロトコル層で四つのプロトコルを実装しているため、**専用クライアントは要りません**。各プロトコル公式 SDK のベース URL を本ゲートウェイに向け、`GATEWAY_TOKEN` を API キーとして渡すだけです。

## 始める前に

### 必要なものは三つ

| もの | どこから来るか |
|------|----------------|
| ゲートウェイのアドレス | Worker の `*.workers.dev` ドメイン、独自ドメイン、または Docker のときの `http://localhost:8080` |
| ゲートウェイのトークン | デプロイ時に設定した `GATEWAY_TOKEN`。[デプロイガイド](DEPLOY.md#環境変数)を参照 |
| 使える上流キーが最低一本 | 管理パネルからプールに取り込みます。[管理パネル](ADMIN.md)を参照 |

### 例で使うプレースホルダ

以下の例はすべてこの二つのプレースホルダを使います。写し取る前に置き換えてください：

| プレースホルダ | 何に置き換えるか |
|----------------|------------------|
| `http://localhost:8080` | 実際にデプロイしたゲートウェイのアドレス |
| `your-gateway-token` | あなたの本物の `GATEWAY_TOKEN` |

> [!NOTE]
> ゲートウェイ自身は内容を生成しません。リクエストを上流の Agnes へ転送し、レスポンスをあなたが話したプロトコルへ翻訳し直すだけです。プールに使えるキーが一本もないとき、どのプロトコルエンドポイントもその場で `503` を返します。その一族の `reason` は本ページ最後の節にあります。

## 認証情報の渡し方

### 等価な四つの書き方

SDK はそれぞれ自分の既定のリクエストヘッダーを送ります。ゲートウェイは以下の四つを区別なく受け付けます——特定の SDK のために追加設定は要りません：

| 方式 | 誰が送るか |
|------|------------|
| `Authorization: Bearer <token>` | OpenAI SDK |
| `x-api-key: <token>` | Anthropic SDK |
| `x-goog-api-key: <token>` | Google GenAI SDK |
| `?key=<token>` クエリパラメータ | 手動呼び出し/ブラウザ用途 |

`/v1/*` と `/v1beta/*` 配下のすべてのルートにこの認証情報が要ります。`/health` には要りません。

### ゲートウェイのトークンは上流キーではない

`GATEWAY_TOKEN` は**下流の利用者**に配るトークンで、プールの上流キーとはまったく別物です——プールのキーは一本もゲートウェイの外へ出ません。

> [!IMPORTANT]
> 管理 API `/admin/api/*` は上の四つの書き方を**受け付けません**。読むのは `x-admin-key` ヘッダーだけ、通るのは `ADMIN_TOKEN` だけです。二つの鍵は厳格に分離されています：中継トークンをパネルのパスワードに使い回すのは、プール全体を下流の利用者全員に渡すのと同じです。

## 対応モデル

### 四つのモデルそれぞれの落とし所

| モデル | 用途 |
|--------|------|
| `agnes-2.0-flash` | 対話 / テキスト系エンドポイント |
| `agnes-image-2.1-flash` | `/v1/images/generations` |
| `agnes-image-2.0-flash` | `/v1/images/generations` |
| `agnes-video-v2.0` | `/v1/videos` |

### モデル名はボディか、それともパスか

OpenAI、OpenAI-Responses、Anthropic の三つはモデル名をリクエストボディの `model` フィールドに入れます。Gemini の二本のエンドポイントは**パスに書きます**。パスは最後のコロンで分割するので、モデル名自体にコロンが含まれていても正しく扱えます。

`GET /v1/models` は OpenAI 形状のモデル一覧を、`GET /v1beta/models` は同じモデル群を Gemini 形状で返します——一つのパスが二つの形式を同時に返すことはできないので、使う SDK に合う方を選んでください。

> [!NOTE]
> この二つの一覧はどちらも**固定表**で、四つのモデルが過不足なく並びます。プールに今この瞬間使えるキーがあるかどうかは反映しません。それを知るには管理パネルを見るか、単にリクエストを一回投げて `503` が返るかどうかを見てください。

## OpenAI SDK

### 非ストリーミング呼び出し

`base_url` をゲートウェイに向け、あとは普段どおり `chat.completions.create` を呼ぶだけです。他の引数は OpenAI 本家と同じです：

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

### ストリーミング呼び出し

`stream=True` を渡し、返ってくるジェネレータを回すだけです。OpenAI 本家に直接つなぐのとまったく同じです：

```python
stream = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "こんにちは"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

このプロトコルのストリーミングバイト列を、ゲートウェイは**そのまま素通し**します。解析も書き換えもしません：`Content-Type: text/event-stream`、標準的な OpenAI 形式の `data: {...}` チャンク、終端は `data: [DONE]` です。

### base_url には `/v1` を付ける

> [!IMPORTANT]
> これは下の二つの SDK とは**逆**です：`openai` SDK の `base_url` には `/v1` を**付けます**。その後ろに `/chat/completions` をそのまま連結するからです。`/v1` を落とすと SDK は `/chat/completions` を叩きにいきますが、ゲートウェイにそのパスは無く、返るのは何の役にも立たない `404` です。

## Anthropic SDK

### 非ストリーミング呼び出し

認証情報は `api_key` として渡します。SDK がそれを `x-api-key` ヘッダーに入れてくれるので、手で足すものはありません：

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

### ストリーミング呼び出し

```python
with client.messages.stream(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "こんにちは"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

ストリーミングレスポンスは標準的な Anthropic のイベント列です：`message_start`、`content_block_start`、一つ以上の `content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。

### base_url に `/v1` は付けない

> [!IMPORTANT]
> この SDK の `base_url` に `/v1` は**付けません**——SDK が自分で `/v1/messages` を連結します。`http://localhost:8080/v1` と書くと `/v1/v1/messages` を叩きにいきます。

> [!WARNING]
> `content`（または `system`）配列に `text` 以外のブロックが一つでもあると——`image`、`tool_use`、`tool_result` はいずれも該当します——ゲートウェイは上流へ転送する**前に** `400` を返します。そのブロックを黙って捨てることはしません。マルチモーダル入力はこのプロトコルでは今日通りません。画像を出したいときは `/v1/images/generations` を使ってください。

## Google GenAI SDK

### 非ストリーミング呼び出し

この SDK でベース URL を差し替える入口は `http_options` で、コンストラクタの位置引数ではありません：

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

### ストリーミング呼び出し

```python
for chunk in client.models.generate_content_stream(
    model="agnes-2.0-flash",
    contents="こんにちは",
):
    print(chunk.text or "", end="")
```

ストリーミングレスポンスの各イベントは `event:` フィールドを持たない `data:` 行で、**`[DONE]` の終端マーカーはありません**——ストリームは終わるとそのまま閉じます。このプロトコル向けに自分でパーサーを書くなら、永遠に来ない終端フレームを待たないでください。

### base_url に `/v1beta` は付けない

> [!IMPORTANT]
> この SDK の `base_url` にも `/v1beta` は**付けません**——SDK が自分で `/v1beta/models/...` を連結します。カスタムのベース URL を設定すると、この SDK は既定で `x-goog-api-key` ヘッダーを送ります。ゲートウェイはそれをそのまま受けるので、追加の設定は要りません。

## OpenAI Responses プロトコル

OpenAI-Responses プロトコルには広く使われている専用 SDK がまだ無いため、この節は素の HTTP 呼び出しで示します。

### 非ストリーミング呼び出し

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "instructions": "あなたは親切なアシスタントです。",
    "input": "こんにちは"
  }'
```

`instructions` は system メッセージ一件に変換され、配列形式の `input` は上流へ転送する前に messages へ変換されます。レスポンスは `output[]` 構造へ戻されます。

### ストリーミング呼び出し

`stream` フィールドを一つ足し、curl には `-N` を渡してバッファリングを切ります。切らないと最後にまとめて出力が届きます：

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.0-flash",
    "input": "こんにちは",
    "stream": true
  }'
```

### ストリーミングのイベント列

| イベント | いつ現れるか |
|----------|--------------|
| `response.created` | ストリームの最初のフレーム |
| `response.output_text.delta` | 一つ以上。本文の増分はすべてここに来ます |
| `response.completed` | ストリームの最後のフレーム |

## 画像と動画

### 画像を一枚生成する

同期エンドポイントです。上流が画像を出し終えるまで返さないので、この呼び出しは下のトラブルシューティングにある同期タイムアウト予算の上で動きます。

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-image-2.1-flash", "prompt": "一匹の猫" }'
```

### 動画ジョブを作る

ジョブ作成は即座に返り、動画自体は上流で非同期に走り切るので、結果は次の節のポーリングで拾います：

```bash
curl -X POST http://localhost:8080/v1/videos \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{ "model": "agnes-video-v2.0", "prompt": "走っている一匹の猫" }'
```

### ジョブの状態を問い合わせる

```bash
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

> [!IMPORTANT]
> ゲートウェイは転送する前にタスク識別子の形を検証し、**`A-Za-z0-9_- (1-128)` だけを受け付けます**：前半が許される文字集合、括弧の中が長さの下限と上限です。合わないものは一律 `400` で、しかも**上流リクエストは一度も出ません**——そのとき上流のパラメータをいじっても意味がありません。`400` の本文にはこの形が一字一句そのまま入っているので、それに合わせて識別子を貼り直してください。

## 汎用の OpenAI 互換クライアント

### どの欄を埋めるか

多くのサードパーティ製クライアントは入力欄を三つか四つしか用意しません。対応はこうです：

| クライアント側の欄 | 何を入れるか |
|--------------------|--------------|
| API のベース URL | `http://localhost:8080/v1` |
| API キー | あなたの `GATEWAY_TOKEN` |
| モデル名 | `agnes-2.0-flash` |
| 組織 / プロジェクト ID | 空のまま。ゲートウェイはこの二つを読みません |

### クライアントがモデルリストを取れないとき

起動時に `GET /v1/models` を一回叩き、それが通るまでメッセージを送らせないクライアントがあります。まず上の四つの書き方のどれかで認証情報がそもそも出ているかを確かめてください。出ているのにリストだけ失敗するなら、ほぼ確実にクライアント側が `/v1` を二重に連結しています——アドレス欄の `/v1` を外してもう一度試してください。

## 会話のコンテキスト

### ゲートウェイは履歴を持たない

ゲートウェイは**会話の状態を一切保持しません**。リクエストは毎回独立した転送で、プールが渡す上流キーも毎回変わり得ます。複数ターンの対話をするなら、履歴はクライアントが持ち、毎ターン丸ごと送り直します——各プロトコル公式 SDK が既定でやっているのはまさにそれです。

### 各プロトコルは履歴をどこに置くか

| プロトコル | 履歴の置き場所 | システムプロンプトの置き場所 |
|------------|----------------|------------------------------|
| OpenAI | `messages` 配列 | `messages` の中で `role` が system のもの |
| OpenAI-Responses | `input` 配列 | `instructions` フィールド |
| Anthropic | `messages` 配列 | `system` フィールド |
| Gemini | `contents` 配列 | `systemInstruction` フィールド |

## トラブルシューティング

### `401` —— 認証情報が届いていない

ゲートウェイの認証情報が無いか誤っています。まず送っているのが上流キーではなく `GATEWAY_TOKEN` であることを確かめ、次に SDK が上の四つの書き方のどれかを本当に送っているかを確かめてください。上流自身の `401` のレスポンスボディは**決して**転送されません——そこは上流 API がキーの断片を最も返しやすい場所だからです。

### `404` —— パスが違う

十中八九 `base_url` の接頭辞が一つ多いか一つ足りません。規則は SDK ごとに違います。上の三つの節にそれぞれ「base_url」の小節があります。

### `503` —— プールに使えるキーが無い

ゲートウェイは上流リクエストを出す**前に**これを返し、ボディの最上位に機械可読な `reason` を載せます：

| `reason` | 自然に治るか | 何をすべきか |
|----------|--------------|--------------|
| `pool_empty` | – | まだ一本も取り込んでいません。管理パネルから入れてください。 |
| `all_cooling` | **治る** | 全キーがクールダウン中。レスポンスヘッダー `Retry-After` が最も早い復帰時刻を示します。待ってください。 |
| `all_disabled` | **治らない** | 全キーが管理者の手で無効化されています。パネルで有効に戻してください——**認証情報自体に問題は無いので、キーを替えないこと**。 |
| `all_evicted` | **治らない** | 認証情報が失効して全キーが恒久的に排除されました。キーを入れ替えてください。 |
| `upstream_error` | **治る** | キーは使えるのに上流が毎回失敗しています。少し待って見直してください。 |

### `504` —— 同期エンドポイントが予算を使い切った

画像生成、動画ジョブ作成、そして**すべての非ストリーミング対話**は同期タイムアウト予算 `UPSTREAM_SYNC_TIMEOUT_MS`（既定 120000 ミリ秒）で動きます。この総予算がクライアントの最悪待ち時間そのもので、プールの大きさとは関係ありません。`504` のときゲートウェイはどのキーも**罰しません**。予算を上げるか、ストリーミングに切り替えてください。

### `400` —— ボディがゲートウェイを通らなかった

原因は四種類：Anthropic プロトコルでの `text` 以外の内容ブロック、動画タスク識別子の形が不正、管理 API のリクエストボディに知らないフィールド、管理 API の必須項目欠け。前の二つは上の対応する節にそれぞれ説明があります。

### `502` —— 上流が 200 を返したが JSON ではない

形式変換をするルートでだけ起きます。ゲートウェイは JSON でないボディをあなたの求めるプロトコル形状へ翻訳できないので、空のレスポンスを捏造せずありのままに報告します。この種類は一度やり直せば通ることが多いです。

## 次のステップ

- 二つのデプロイ形態とすべての環境変数：[DEPLOY.md](DEPLOY.md)
- Web 管理パネル：[ADMIN.md](ADMIN.md)
- レジストラー（自動プール補充）：[REGISTRAR.md](REGISTRAR.md)
- 四つのプロトコルのエンドポイントとリクエスト / レスポンスの形：[API.md](API.md)
- プロジェクトの概要とクイックスタート：[README.md](../../README.md)
- 不具合の報告と質問：[GitHub Issues](https://github.com/xwteam/agnes2api/issues)
