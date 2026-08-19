# デプロイガイド

**Language:** [English](../en/DEPLOY.md) | [简体中文](../zh-CN/DEPLOY.md) | [繁體中文](../zh-TW/DEPLOY.md) | 日本語 | [한국어](../ko/DEPLOY.md)

agnes2api は同一のコードベースとリクエスト処理ロジックから構築された 2 つの
デプロイ先を提供します。あなたのインフラに合わせてどちらかを選んでください。
両者の違いはストレージバックエンドのみです。Worker は Cloudflare KV
ネームスペースを、Docker はマウントされたボリューム上の JSON ファイルを使います。

## 環境変数

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `GATEWAY_TOKEN` | **はい** | – | クライアントが本ゲートウェイを呼び出す際に提示しなければならないトークン。 |
| `AGNES_BASE_URL` | いいえ | `https://apihub.agnes-ai.com/v1` | 上流 Agnes API のベース URL。 |
| `UPSTREAM_TIMEOUT_MS` | いいえ | `8000` | **ストリーミング**応答と動画ポーリングの最初のバイトのタイムアウト。この時間（ミリ秒）以内に上流の最初のバイトが届かない場合、呼び出しを中断する。 |
| `UPSTREAM_SYNC_TIMEOUT_MS` | いいえ | `120000` | **同期**エンドポイントの全体タイムアウト予算。「最初のバイトが、上流が結果全体を計算し終えてから届く」種類のリクエストにのみ適用される: 画像生成、動画ジョブ作成、そしてすべての**非ストリーミング**対話。詳細は下記。 |
| `MAX_STRIKES` | いいえ | `3` | 連続する一時的な失敗（タイムアウト、ネットワークエラー、上流 `5xx`）がこの閾値に達すると key を長いクールダウンに入れる。 |
| `COOLDOWN_RATE_LIMIT_MS` | いいえ | `60000` | 上流が `429` を返した後、その key に適用されるクールダウン時間。 |
| `COOLDOWN_PAYMENT_MS` | いいえ | `3600000` | 上流が `402` を返した後、その key に適用されるクールダウン時間。 |
| `COOLDOWN_STRIKE_MS` | いいえ | `1800000` | key の一時的な失敗が `MAX_STRIKES` に達した後のクールダウン時間。満了時に自動で復帰する。 |
| `POOL_CACHE_TTL_MS` | いいえ | `60000` | 各 isolate／プロセスが key プールのスナップショットをメモリ上に保持する時間。`0` でキャッシュ無効。**1 日あたりの KV 読み取り回数 = アクティブな isolate 数 × (86400 ÷ 本値の秒数) × (1 + プール内の key 数) であり、リクエスト数とは無関係。** 代償: 他の isolate が判定したクールダウン／除外が、この isolate に見えるまで最大でこの時間かかる。 |
| `POOL_TOUCH_INTERVAL_MS` | いいえ | `21600000` | key の「最終使用時刻」を書き込む最大間隔。`0` で成功リクエストごとに書き込む。これは表示専用のフィールドでスケジューリングは一切読まず、リクエストごとに書くと無料枠の 1,000 回/日の書き込み枠を使い切り、クールダウンや除外すら書けなくなる。代償: 「最終使用」の精度はこの間隔まで粗くなる。 |
| `PORT` | いいえ（Node/Docker のみ） | `8080` | Node ランタイムのリッスンポート。Worker では使用されません。 |
| `DATA_DIR` | いいえ（Node/Docker のみ） | `/app/data` | ファイルストレージが `store.json` を書き込むディレクトリ。Worker では使用されません。 |

`COOLDOWN_RATE_LIMIT_MS` と `COOLDOWN_PAYMENT_MS` は `.env.example` に既定では
記載されていませんが、どちらのデプロイ先でも環境変数として読み込まれ、必要に
応じて設定できます。上記の数値型の変数はすべて整数である必要があります。
`POOL_CACHE_TTL_MS` と `POOL_TOUCH_INTERVAL_MS` は下限が `0`（`0` は「無効」の意）で、
それ以外はすべて `0` より大きい必要があり、そうでない場合ゲートウェイは起動を拒否します。

`POOL_CACHE_TTL_MS` と `POOL_TOUCH_INTERVAL_MS` は **app の構築時に一度だけ**読まれます。
変更を反映するにはコンテナの再起動、または isolate の再生成を待つ必要があり、
他の設定項目のようにリクエストごとには反映されません。

### レジストラー関連の変数（オプション、デフォルトで無効）

レジストラーはオプションの自動プール補充コンポーネントで、デフォルトでは無効になって
おり、ゲートウェイの中核である転送機能には影響しません。ここでは変数の早見表のみを
示します。動作原理、2 つのメールボックスチャネルの選び方、Cloudflare Cron の壁時計
上限などの詳細は [REGISTRAR.md](REGISTRAR.md) を参照してください。

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | いいえ | `false` | マスタースイッチ。`true` にしないとレジストラーは有効になりません。 |
| `REGISTRAR_PRIMARY` | 有効化時は必須 | なし | 主チャネル、`yyds` または `moemail`。両者は対等でデフォルト値なし。 |
| `REGISTRAR_FALLBACK` | いいえ | 空（フォールバックなし） | 副チャネル、`yyds` または `moemail`。 |
| `TARGET_KEYS` | いいえ | `20` | 目標とする利用可能 key 数。 |
| `MINT_BATCH` | いいえ | `5` | 1 ラウンドで発行する key の最大数。 |
| `TEND_INTERVAL_MS` | いいえ（Node/Docker のみ） | `1800000` | Node 側の補充間隔。Worker 側は `wrangler.toml` の Cron が代わりに決める。 |
| `CODE_TIMEOUT_MS` | いいえ | `120000` | 認証コードを待つタイムアウト。 |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | いいえ | `2000` / `5000` | 発行試行の間に入れるランダム待機時間。 |
| `MAX_DOMAIN_ATTEMPTS` | いいえ | `8` | 1 回の発行試行で試すドメインの最大数。 |
| `REGISTRAR_TOKEN_NAME` | いいえ | `auto` | 発行された key が Agnes 管理画面に表示される名前。 |
| `AGNES_PLATFORM_URL` | いいえ | `https://platform-backend.agnes-ai.com` | 登録に使う Agnes プラットフォームのバックエンド。 |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | いいえ / チャネルが yyds の場合は必須 | `https://maliapi.215.im` / 空 | YYDS Mail チャネルの認証情報。 |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | チャネルが moemail の場合は必須 | 空 / 空 | MoeMail チャネルの認証情報（自己ホスト、デフォルトアドレスなし）。 |

### 2 つのタイムアウト予算の使い分け

判断基準は「上流の最初のバイトがいつ届き得るか」であり、エンドポイントの名前では
ありません:

| 予算 | 対象エンドポイント | 変数 |
|---|---|---|
| 最初のバイト | **ストリーミング**対話（`stream: true`）、動画ポーリング `GET /v1/videos/{id}` | `UPSTREAM_TIMEOUT_MS` |
| 同期 | 画像生成、動画ジョブ作成、**すべての非ストリーミング対話**（4 プロトコルとも） | `UPSTREAM_SYNC_TIMEOUT_MS` |

非ストリーミングのリクエストは、上流が回答全体を生成し終えてからでないと応答ヘッダを
返しません。画像生成とまったく同じ遅延の性質であり、8 秒の最初のバイト予算で切ると
正常なリクエストが大量に失敗し、key プールまで巻き添えになります。

`UPSTREAM_SYNC_TIMEOUT_MS` は**1 リクエストの総予算**、つまりクライアントの最悪待ち時間
です——「プールの大きさ × 予算」ではありません。ゲートウェイはこの予算のうち単一の key に
最大でも半分しか使わず、残りは別の key での再試行に取っておきます。こうすることで、
プール内にハングした key（接続はできるが決して応答しない）があってもリクエストを丸ごと
食い潰されません。したがって**単一呼び出しの最悪所要時間の 2 倍以上**に設定してください。

同期予算でのタイムアウトは、その場では key を罰しません。同一リクエスト内で切り替えた
別の key が実際に成功した場合にのみ、先にタイムアウトした key に計上します
（`MAX_STRIKES` に達するとクールダウン）。そのリクエストで全部の key がタイムアウトした
場合は 1 つも罰しません——予算が小さすぎるか上流全体が遅い可能性の方が高いためです。

「排除」と「クールダウン」は別物です。上記の設定にかかわらず、上流の `401`/`403`
はその key を**永久に**排除します——これらは「この key はもう有効ではない」状態
であり、再試行に意味がないためです。一時的な失敗が排除につながることはありません。
`MAX_STRIKES` に達しても `COOLDOWN_STRIKE_MS` のクールダウンに入るだけで自動的に
復帰するので、上流の一時的な不調がプールを恒久的に破壊することはありません。

どの key もリクエストを処理できない場合、ゲートウェイは `503` を返し、`error.reason`
に判別可能な理由を示します：`pool_empty`（key が未登録）、`all_cooling`（全 key が
クールダウン中。自動的に回復し、`Retry-After` ヘッダーが復帰時刻を示す）、
`all_evicted`（全 key が認証情報の失効により永久排除。**自動回復しない**ため key の
入れ替えが必要）、`upstream_error`（key 自体は有効だが、上流が毎回失敗した）。

## Cloudflare Worker

### 方法 A —— Deploy to Cloudflare ボタン

ルートの [README](../../README.md) にあるボタンをクリックし、Cloudflare を
認可すると、リポジトリを fork/clone してデプロイまで自動的に行われます。
その後も、下記の **secret** と **KV ネームスペース** の手順は自分で完了させる
必要があります——ボタンだけではこの 2 つは設定されません。

### 方法 B —— 手動デプロイ

1. リポジトリをクローンして依存関係をインストールします。

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   pnpm install
   ```

2. key プール用の KV ネームスペースを作成し、`POOL` としてバインドします。

   ```bash
   npx wrangler kv namespace create POOL
   ```

   返された namespace の `id` を `wrangler.toml` に貼り付け、
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` を置き換えます。

   ```toml
   [[kv_namespaces]]
   binding = "POOL"
   id = "your-namespace-id"
   ```

3. ゲートウェイトークンを Worker の secret として設定します（絶対に
   `wrangler.toml` にコミットしないでください）。

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

4. デプロイします。

   ```bash
   npx wrangler deploy
   ```

### タグ push による自動デプロイ

`.github/workflows/deploy-worker.yml` は `v*` タグが push されると自動的に
Worker をデプロイします。ただし、リポジトリの
**Settings → Secrets and variables → Actions** に `CLOUDFLARE_API_TOKEN`
が設定されている必要があります。設定されていない場合、ワークフローは警告を
出力してデプロイ手順をスキップし、実行自体は失敗しません。

### ローカル開発

```bash
npx wrangler dev
```

`GATEWAY_TOKEN` は `wrangler.toml` と同じディレクトリにあるローカルの
`.dev.vars` ファイル（すでに `.gitignore` 済み）に書いてください——
`wrangler.toml` に直接秘密情報を書かないでください。

## Docker

1. リポジトリをクローンし、環境変数ファイルを準備します。

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   cp .env.example .env
   ```

2. `.env` を編集し、少なくとも `GATEWAY_TOKEN` を設定します。それ以外の
   変数は上記の [環境変数](#環境変数) 表を参照してください。

3. コンテナを起動します。

   ```bash
   docker compose up -d
   ```

   `docker-compose.yml` は既定でポート `8080` を公開し（`.env` の `PORT` で
   上書き可能）、`./data` をコンテナ内の `/app/data` にマウントします——
   `store.json`（key プールと永続化された設定）はここに保存されます。
   再起動やアップグレードをまたいでこのディレクトリを必ず保持してください。
   インポート済みの key プールの唯一のコピーです。

4. コンテナが健全に起動しているか確認します。

   ```bash
   curl http://localhost:8080/health
   ```

   イメージには `HEALTHCHECK` が組み込まれており、Docker はこれをもとに
   コンテナの健全性を報告します。データディレクトリが書き込めない場合、`/health` は
   `status` が `degraded` の `503` を返し、コンテナは unhealthy と表示されます。
   具体的な原因はコンテナログを参照してください。

### コンテナは `./data` の所有者を書き換えます（事前にご確認ください）

コンテナは **root で entrypoint に入り**、次の 2 つを行ってから権限を落とします:

- `DATA_DIR`（既定 `/app/data`）の所有者がコンテナ内の実行ユーザー `app`
  （**uid 100 / gid 101**）と異なる場合のみ、そのディレクトリを再帰的に `chown` します。
  所有者が既に一致していれば何も書き換えません。
- その後 `su-exec` で権限を落とすため、**メインプロセス（PID 1）は root ではなく app**
  として動きます。

実行時に行う必要がある理由は、バインドマウントではホスト側ディレクトリの所有者が
イメージのビルド時 `chown` を上書きしてしまい、コンテナ内の app が `store.json` に
書き込めなくなるからです。しかもこの失敗は静か（すべての API が `pool_empty` を返す）です。

**副作用**: バインドマウントで書き換わるのは**ホスト**上のファイルです。
`docker compose up -d` の後、あなたの `./data` とその中のファイルの所有者は自分の uid から
`100:101` に変わり、以後ホスト側で読み書きやバックアップをするには `sudo` が必要に
なります。それを避けたい場合は `--user`（または compose の `user:`）で非 root 実行を
指定してください。その場合 entrypoint は chown を一切行わず、データディレクトリの所有者と
書き込み可否はあなたが用意します。

同じ理由でイメージには **`USER app` を入れていません**。既定ユーザーは root です
（`docker inspect --format '{{.Config.User}}' <image>` は空を出力）。これは Kubernetes に
影響します: `runAsNonRoot: true` を設定しつつ `runAsUser` を明示しない場合、kubelet は
コンテナの起動を拒否します。そうしたデプロイでは `runAsUser: 100`、`runAsGroup: 101`
（または任意の uid）を明示し、ボリュームの所有者は自分で用意してください——非 root 起動時、
entrypoint は「chown せずそのまま実行する」分岐を通ります。

安全境界: `DATA_DIR` が `/` やトップレベルのシステムディレクトリ（`/etc`、`/usr` など）に
設定された場合、entrypoint はその上での再帰的 chown を拒否します（警告を出すだけで起動は
継続）。コンテナのファイルシステム全体が app から書き込み可能になるのを防ぐためです。

## 上流 Agnes key のインポート

現バージョンのゲートウェイには key をプールへ追加するための HTTP
エンドポイントはありません。ストレージバックエンドへ直接書き込む必要が
あります。各エントリは `key:<id>` というキーを持つ JSON オブジェクトで、
`<id>` はプール内で一意な任意の文字列で構いません（ゲートウェイ自身が
レコードを作成する際は key のハッシュ値から導出しますが、読み込み時には
その値は検証されないため、手動インポートでは任意の一意な識別子で問題
ありません）。

```json
{
  "id": "1a2b3c4d5e6f7a8b",
  "key": "実際の-agnes-api-key",
  "addedAt": 1735689600000,
  "lastUsedAt": null,
  "cooldownUntil": 0,
  "strikes": 0,
  "evicted": false,
  "evictedReason": null
}
```

### Docker

実行中のプロセスとの書き込み競合を避けるため、まずコンテナを停止し、
ホスト上で `./data/store.json` を編集して、キー
`"key:1a2b3c4d5e6f7a8b"` の下に上記のようなレコードを追加してから、
コンテナを再度起動します。

```bash
docker compose stop
# ./data/store.json を編集
docker compose start
```

`./data/store.json` がまだ存在しない場合は、`key:<id>` という形式の
キーを持つ単一の JSON オブジェクトとして新規作成してください。

### Cloudflare Worker

wrangler を使ってレコードを `POOL` KV ネームスペースへ直接書き込みます。

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"実際の-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

`--remote` を省略すると、本番ではなく `wrangler dev` が使用するローカルの
ネームスペースに書き込まれます。

この方法でインポートした key は次のリクエストからすぐ有効になります。ゲートウェイは
プール内の id 一覧を `pool:index` というキーに保持しており（転送のたびに KV の `list`
を消費しないため。無料枠の list は 1 日 1,000 回しかありません）、索引が知らない手動
インポートのレコードは自動的に検出されて索引に追加されます。

レジストラを使わない場合でも `wrangler.toml` の `[triggers]` を削除しないでください。
この cron は `pool:index` と実際の `key:` レコードを突き合わせて修復する唯一の経路であり、
`REGISTRAR_ENABLED` の値とは無関係に実行されます。
