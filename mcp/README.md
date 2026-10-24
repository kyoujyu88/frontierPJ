# 辺境星系戦記 MCPサーバー（のあ配信用）

AIエージェント（のあ）が MCP ツールで「辺境星系戦記」を遊び、その画面をそのまま配信するための一式です。

```
のあ（MCPクライアント）
   │  stdio または Streamable HTTP
   ▼
server.mjs（MCPサーバー）──Playwright──▶ Chromium の窓（ゲーム画面）──▶ OBS でウィンドウキャプチャ
                                          └ game-api.js を注入（window.gameAPI）
```

- ゲーム本体（`../game/frontier-war.html`）は**書き換えずに**使います。`game-api.js` をページに後から差し込み、画面のボタンと同じ関数を同じ条件で呼びます。
- のあの操作は画面上でも見えます。移動先のハイライト、改装画面や造船所の表示が出ます。右上には「のあ：〇〇」と行動内容が出ます。
- **戦術戦闘はオート**です。艦隊を攻め込ませたり敵に襲われたりすると、ゲーム本体のオート戦闘で艦が自動で動き、決着して作戦卓に戻ってから結果が返ります。のあは戦闘を1隻ずつ操作しないので、戦闘に時間がかかりません（1戦あたり演出込みで1分ほど）。勝敗を分けるのは、戦う相手の選び方・修理・改装・陣形・旗艦の選び方といった事前の準備です。オートは陣形（方陣なら護衛が旗艦の隣に残る、鶴翼なら回り込みを重く見る）と艦の配分（ミサイル寄りは距離を保つ、旗艦と傷ついた艦は控える）に合わせて動くので、準備がそのまま戦い方になります。状況テキストの移動先と迎撃欄には、相手のドクトリン・戦力比・陣形の目安（オートでの勝率から）が付きます。1隻ずつ操作させたいときは `server.mjs` に `--manual-battle` を付けます（下の「オプション」）。
- `say` ツールでのあのセリフを画面下に字幕表示できます。

## ファイル

| ファイル | 中身 |
|---|---|
| `server.mjs` | MCPサーバー本体。ブラウザ起動、ゲームの配信、ツール定義 |
| `game-api.js` | ゲーム側フック。`window.gameAPI` を定義する（状態の取得・行動・字幕） |
| `ai-player.mjs` | ローカルLLM（OpenAI互換API）にゲームを遊ばせるプレイヤー。名前と人格を替えればどのAIでも使える |
| `noa-player.mjs` | 旧名。互換のため残してあり、中身は `ai-player.mjs` を読み込むだけ |
| `notes.mjs` | 反省メモ（プレイを振り返って書き、次のプレイで読む）の仕組み |
| `notes/<名前>.md` | 反省メモ本体。プレイすると自動でできる |
| `selftest.mjs` | 簡単なボットで数十ターン通しプレイする動作確認。想定外の拒否や、建設・移動が状態に反映されないと失敗（終了コード1） |
| `regress.mjs` | ゲーム本体の回帰テスト：スマホ幅の表示、主星に居座った異生体、戦闘中のキーボード操作（`npm run test:regress`） |
| `操作盤を開く.cmd` `launch.mjs` | ダブルクリックで操作盤を開く（初回は部品も入れる） |
| `control.mjs` `control.html` | 操作盤。ブラウザの画面から、試行回数を決めた連続プレイ・録画・停止・戦績の確認ができる（`npm run ui`） |
| `mux-audio.mjs` | 録画の映像に、別に録ったゲームの音を重ねる（server.mjs が試行の終わりに起動する） |
| `recordings/*.webm` | 録画した動画。録画をオンにするとできる |
| `notes-test.mjs` | にせのLLMで反省メモの保存と読み込み、負けたときにそこで止まるか、LLM のエラーで止めるか続けるかを確かめる（`npm run test:notes`） |
| `package.json` | 依存パッケージ（MCP SDK・Playwright・zod） |

## セットアップ（配信するPCで）

Node.js 20 以上が必要です。

```sh
cd mcp
npm install
npx playwright install chromium
npm test            # 動作確認（ウィンドウなしで30ターン）
npm run test:regress   # ゲーム本体の回帰テスト（数秒）
node selftest.mjs --show   # 窓を出して演出つきで眺める
MANUAL=1 npm test   # 戦闘を battle_* で1隻ずつ操作する版（--manual-battle）の動作確認
```

`mcp/` と `game/` は同じ親フォルダに置いてください（ゲームの場所は `--game` で変えられます）。

## 家のローカルLLMで遊ばせる（ai-player.mjs）

Ollama・LM Studio・llama.cpp server などの **OpenAI互換API** に直接つなぐプレイヤーです。MCPクライアントを別に用意しなくても、これ1本で「のあが考える → ツールで操作 → 画面に字幕」が回ります。

```sh
# Ollama（既定 http://127.0.0.1:11434/v1）
node ai-player.mjs --model qwen3:14b

# LM Studio
node ai-player.mjs --base-url http://127.0.0.1:1234/v1 --model <モデル名>

# のあの人格ファイルと、ゲーム側のオプション（-- の後ろは server.mjs に渡る）
node ai-player.mjs --model qwen3:14b --persona noa.txt -- --pace 900 --size 1920x1080
```

- のあが返した地の文は、そのまま画面下に字幕で出ます（`<think>…</think>` は消します）。
- ターンごとに会話をリセットし、状況は短い日本語のテキスト（`get_summary`）で渡すので、長時間遊んでも文脈が溢れません。前のターンの発言だけは引き継ぎます。ターンの中でも、状況テキストは最新の1つだけを全文で送り、古いものは1行に縮めます。
- 戦闘はオートで決着するので、のあには「出来事」として結果（例：`戦闘「ミラ 攻略戦」：勝利（9ラウンド・自軍の損失1/4隻・敵の撃破3/3）`）と、戦闘後の状況が届きます。反省メモの戦績にも数えます。
- のあが考える回数が `--max-steps`（既定40）を超えたり、黙り込んだりしたら、残りを自動で片付けて先へ進めます。作戦卓では1ターンごとに数えます（`-- --manual-battle` で戦闘を操作させるときは、戦闘は1戦ごとに数え、上限を超えたらその戦闘だけ自動で片付けます）。配信が止まらないための保険です。
- LLMにつながらないとき（モデル名の違い・ツール非対応も）は、自動で遊び続けずに止まります。`LLM API 400` などその場かぎりのエラーは、そのターンだけ自動で進めて続けます（3ターン続いたら止まります）。
- プレイを振り返って**反省メモ**を書き、次のプレイに活かします（下の「遊ぶほど上手になる」）。

**モデルについて**：ツール呼び出し（function calling）に対応したモデルが必要です（Ollama なら `ollama show <モデル>` の Capabilities に `tools` があるもの。`gemma3` などは非対応で `LLM API 400: … does not support tools` になります）。システムプロンプトとルールで約3千字、状況テキストで2〜4千字になるので、**コンテキストは16k以上**にしてください（Ollama なら `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`）。戦術戦闘はオートなので、座標を扱う操作はありません（`--manual-battle` で操作させると、小さすぎるモデルでは失敗が増えます）。失敗しても理由が返るので、次の手で取り返せます。

| オプション | 環境変数 | 既定 |
|---|---|---|
| `--base-url` | `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `--model` | `LLM_MODEL` | （必須） |
| `--api-key` | `LLM_API_KEY` | なし |
| `--name <名前>` | `PLAYER_NAME` | 省くと起動時に聞く（Enter で前回の名前、初回は `のあ`）。字幕の名前と反省メモのファイル名 |
| `--persona <file>` | `NOA_PERSONA` | 内蔵の短い設定 |
| `--max-steps` | `NOA_MAX_STEPS` | `40` |
| `--turns` | `NOA_TURNS` | 無制限 |
| `--temperature` | `LLM_TEMPERATURE` | `0.6` |
| `--think <none\|low\|medium\|high>` | `LLM_THINK` | 送らない（モデル任せ）。`reasoning_effort` として送る。`none` で考えずに即答（Ollama の thinking 対応モデルの待ち時間を短くする） |
| `--loop` | | ゲーム終了後に新しいゲームを始める |
| `--notes <file>` | `NOA_NOTES` | `notes/<名前>.md` |
| `--notes-chars` | `NOA_NOTES_CHARS` | `1200`（プロンプトに入れる反省メモの上限文字数） |
| `--reflect-every` | `NOA_REFLECT_EVERY` | `10`（ゲームの途中でも何ターンごとに振り返るか。0で終了時だけ） |
| `--notes-readonly` | | 反省メモを読むだけで書き換えない |
| `--no-notes` | | 反省メモを使わない（毎回はじめて遊ぶ状態） |

### 遊ぶほど上手になる（反省メモ）

ローカルLLMはプレイ中に学習しないので、そのままだと毎回はじめて遊ぶ状態になります。そこで、プレイの記録を本人に読ませて「次に活かすこと」を書かせ、次のプレイの最初に読ませます。

1. プレイ中、ターンごとの要点を記録します（資金・惑星の獲得と喪失・戦闘の勝敗・失敗した操作・そのターンの発言）。
2. ゲームが終わったとき、`--reflect-every` ターンごと、`--turns` で止まったとき、Ctrl+C で止めたときに、LLMが記録を読んで反省メモを書き直します。役に立つ項目は残し、間違っていた項目は消すので、増え続けません。
3. 反省メモは次のターンから、毎ターンのシステムプロンプトに入ります。つまり同じゲームの後半にも、次のゲームにも効きます。のあは「前回の反省を活かして」と配信で言うことがあります。
4. 書き終えたら、視聴者へのひとこと（感想）を字幕に出します。

反省メモは `notes/<名前>.md` に、こんな形で残ります。手で読んだり、直したり、項目を消したりできます。

```markdown
## 反省メモ（大事な順）
- 爆装を2以上積んだ艦隊で惑星を攻める
- 通信ウィンドウが出たら先に dismiss_dialog してから end_turn
## 戦績（新しい順）
- 2026-10-21 qwen3:14b 敗北 ターン23 最大5星 戦闘9回（勝6） 操作失敗4回
```

**ほかのローカルLLMでも同じです。** 振り返りはツールを使わない普通のチャットで、返事の中の「- 」で始まる行だけを拾います（`<think>` や前置きは無視）。うまく書けなかったときは前のメモを残します。メモは名前ごとに分かれるので、モデルを比べたいときは名前を変えます。

```sh
node ai-player.mjs --model qwen3:14b                     # notes/のあ.md を育てる
node ai-player.mjs --model gpt-oss:20b --name ジーピー     # notes/ジーピー.md（字幕の名前もジーピー）
node ai-player.mjs --model gpt-oss:20b --notes notes/のあ.md # のあのメモを別のモデルに引き継ぐ
```

戦績にはモデル名も残るので、同じ名前で途中からモデルを替えても、どのモデルで遊んだかがわかります。反省メモは最大1200字（`--notes-chars`）なので、コンテキストが小さいモデルでも溢れません。

配信で「上達したところ」を見せたいときは、育てたメモを `--notes-readonly` で固定する、または `--no-notes` と見比べると違いがわかりやすくなります。

LM Studio は自身もMCPクライアントになれるので、`server.mjs` を LM Studio の `mcp.json` に登録して、そのチャット画面から遊ばせることもできます（下の stdio 設定と同じ書き方）。

## 連続プレイと録画（操作盤 control.mjs）

ブラウザで開く操作盤から、AIに**決めた回数だけ続けて**遊ばせ、試行ごとに**自動で録画**します。OBS は要りません。コマンドを打たずに使えます。

- **Windows**：`mcp\操作盤を開く.cmd` をダブルクリック。はじめての1回は `npm install` と Chromium（録画用の ffmpeg 込み）を自動で入れます。操作盤は窓なしで裏で動き、既定のブラウザで `http://127.0.0.1:3940/` が開きます。もう動いていれば開くだけです。終えるときは画面右上の「終了」。タブを全部閉じたときも、プレイ中でなければ90秒ほどで自動で終わります（プレイ中なら、終わってから90秒後）。
- 画面右上：「動作確認」（LLMなしで selftest を10ターン）・「反省メモを開く」（メモ帳）・「録画フォルダ」・「デスクトップに置く」（ショートカット作成）・「終了」。
- コマンドで動かすなら `npm run ui`（= `node control.mjs`）。起動係は `launch.mjs`、操作盤の出力は `notes/.control.log` に残ります。

- 画面で LLM の URL・モデル（「一覧」で LLM から読み込める）・名前・考える量・**試行回数**・1回の上限ターン・反省メモの使い方・録画のオンオフを決めて「連続プレイを開始」。設定は次回も残ります。
- 1試行＝1ゲーム。試行ごとに `ai-player.mjs` を起動し直すので、毎回新しいゲームになり、**前の試行で書いた反省メモが次の試行の最初から効きます**。
- 「この試行で終わる」（今のゲームは最後まで）・「いま止める」（反省メモを書いてから止める）・「強制終了」（すぐ止める）で止められます。LLM につながらなくなったら、残りの試行はやめます。
- 「戦績」タブに試行ごとの結果（勝利・敗北・ターン上限・停止）、到達ターン、自動進行と操作失敗の回数、録画が並びます。到達ターンの棒グラフで、上達しているかが見えます。「反省メモ」タブは今のメモ、「録画」タブはその場で再生・保存。
- 「ゲームの窓を出さない」にすると裏で回せます（録画はできます）。演出の間（pace）を 0 にすると最速ですが、録画は見づらくなります。
- 操作盤はこのPCからだけ開けます（127.0.0.1 で待ち受け、Host ヘッダーを確かめる）。`npm run ui` で起動したときは、その窓を閉じるとプレイも止まります。ポートを変えるなら `node control.mjs --port 3941`、ブラウザを自動で開かないなら `--no-open`。
- 戦績の一覧は `notes/.control-history.json`、操作盤の設定は `notes/.control-settings.json` に残ります。

**録画について**：映像は Playwright の動画録画（`server.mjs --record`）、音はページの中で録ります（ゲームの音はすべて1つの AudioContext から出るので、出力へのつなぎ込みを横取りして MediaRecorder で Opus に録る）。試行が終わると `mux-audio.mjs` が、`npx playwright install chromium` で入る ffmpeg で両方を1本に重ねます（ストリームのコピーだけなので数秒）。追加のソフトは要りません。

- 形式は WebM（VP8・25fps・約1Mbps＋Opus 128kbps）で、**BGM と効果音が入ります**。1時間で約500MBです。字幕と行動表示は画面の中に描いているので映ります。映像のコマは実際の画面より約0.2秒遅れて記録されるので、音も同じだけ遅らせて合わせています。
- 音を重ねるのは試行が終わった直後です。数秒のあいだは音なしのファイルが見えます。重ねるのに失敗したときは音なしの動画が残ります。音を入れたくないときは `--no-record-audio`。
- ファイル名は `recordings/<名前>_<日時>_<n>of<回数>.webm`。YouTube にはそのまま上げられます。MP4 が要るときは変換してください。
- もっと高画質で残したいときは、これまでどおり OBS で録画します（下の「配信のしかた」）。

`ai-player.mjs` を直接動かすときも、`--` の後ろに付ければ録画できます。

```sh
node ai-player.mjs --model noa-game -- --record recordings
```

## MCPクライアントからつなぐ

### stdio（Claude Desktop など一般的なMCPクライアント）

```json
{
  "mcpServers": {
    "frontier-war": {
      "command": "node",
      "args": ["/絶対パス/mcp/server.mjs"]
    }
  }
}
```

### HTTP（自作のAIキャラ基盤などから）

```sh
node server.mjs --http 3939      # → http://127.0.0.1:3939/mcp （Streamable HTTP）
```

### オプション

| オプション | 環境変数 | 既定 | 内容 |
|---|---|---|---|
| `--game <path>` | `GAME_PATH` | `../game/frontier-war.html` | ゲームのHTML |
| `--pace <ms>` | `GAME_PACE` | `300` | 行動ごとの演出の間（視聴者が追える速さ）。0で即時（移動・攻撃アニメーションも省く） |
| `--speaker <名前>` | `GAME_SPEAKER` | `のあ` | 字幕と行動表示の名前 |
| `--size 1280x720` | `GAME_SIZE` | `1280x720` | 画面の大きさ（OBSの解像度に合わせる） |
| `--cdp <url>` | `GAME_CDP` | なし | 起動済みのChromeに接続する（`chrome --remote-debugging-port=9222`） |
| `--headless` | `GAME_HEADLESS=1` | なし | 窓を出さない（テスト用） |
| `--http <port>` | `GAME_HTTP` | なし | stdio の代わりに HTTP で待ち受け |
| `--record <dir>` | `GAME_RECORD` | なし | ゲーム画面を dir に動画（.webm、BGM・効果音つき）で録画する。ゲームを閉じたときに書き終わる |
| `--no-record-audio` | | | 録画に音を入れない |
| `--record-name <名前>` | `GAME_RECORD_NAME` | 日時 | 録画ファイルの名前（.webm は自動で付く） |
| `--manual-battle` | `GAME_MANUAL_BATTLE=1` | なし（オート） | 戦術戦闘を `battle_*` ツールで1隻ずつ操作する。付けなければ戦闘はオートで決着し、`battle_*` ツールは出さない |

## 配信のしかた

1. MCPクライアント（のあ）を起動すると、サーバーが Chromium の窓でゲームを開きます。
2. OBS で「ウィンドウキャプチャ」にその窓を指定します。音はブラウザから鳴るので「アプリケーション音声キャプチャ」で拾います。
3. 字幕（`say`）と行動表示はゲーム画面の中に重ねて描くため、OBS 側の設定は要りません。

窓を閉じても、次のツール呼び出しで開き直します。ただし戦況は最初からになります。

## ツール一覧

| 種類 | ツール | 内容 |
|---|---|---|
| 情報 | `get_rules` | ルール要約（計算式つき）。最初に一度読む |
| | `get_summary` | 状況を短い日本語テキストで（小さなモデル向け） |
| | `get_state` | 全状況。自軍艦隊ごとの移動先候補（何が起きるか付き）、通信ウィンドウ、戦闘盤面も含む |
| | `get_screenshot` | 画面の画像（画像を読めるモデル向け） |
| 演出 | `say` | セリフを字幕表示 |
| 共通 | `dismiss_dialog` | 通信ウィンドウを閉じる（下の行の「了解」「閉じる」などを押す。勝敗の結果画面では閉じるだけで、次のゲームは `new_game`） |
| 作戦卓 | `move_fleet` `intercept` | 移動（戦闘に入ることもある）・迎撃 |
| | `invest_research` | 研究投資 30/60/120 |
| | `refit_ship` `set_flagship` | 改装（sh/ca/mi/bo/sp の配分。書かない項目は今の値のまま）・旗艦指定 |
| | `set_formation` | 陣形（line 横陣／wedge 楔形／square 方陣／crane 鶴翼／rear 後衛陣）。いつでも変更でき、行動は消費しない |
| | `build_ship` `repair_fleet` `new_fleet` | 造船（追加か置換）・修理・新艦隊 |
| | `build_facility` `demolish_facility` | 施設の建設・撤去 |
| | `survey` `fortify` | 小惑星探査・防衛修復 |
| | `end_turn` `new_game` | ターン終了・やり直し |

戦術戦闘はオートで、`move_fleet` `intercept` `end_turn` は戦闘が決着して作戦卓に戻ってから返ります。返り値の `events` に結果の1行、`battles` に `{ title, result, rounds, lost, ships, downed, foes }` が入ります。`--manual-battle` のときだけ、次のツールが増えます。

| 種類 | ツール | 内容 |
|---|---|---|
| 戦術戦闘 | `battle_state` | 盤面（文字の盤面図、ユニット、各艦の移動先と攻撃候補・予測ダメージ） |
| | `battle_attack` `battle_move` `battle_wait` | 1隻ずつ行動 |
| | `battle_end_phase` `battle_retreat` `battle_close` | 敵フェイズへ・撤退・戦闘を閉じる |

行動系ツールはすべて同じ形で返ります。

```json
{ "ok": true, "message": "…", "events": ["この行動で起きたログ"], "funds": 120, "turn": 3,
  "mode": "map | battle | battle_ended | over", "dialog": {…}, "battle": {…}, "battles": [{…}] }
```

画面のボタンで押せない操作（資金不足、射程外など）は `ok:false` と理由が返ります。ゲームは進みません。

## のあ向けの指示（システムプロンプト例）

```
あなたは「辺境星系戦記」を実況プレイ配信しているのあです。
- 最初に get_rules を読み、各ターンの始めに get_state で状況を見る。
- 通信ウィンドウ（dialog）が出たら、内容を視聴者向けに要約して say してから dismiss_dialog。
- 大きな判断（研究、攻める先、改装）の前に、理由を一言 say する。長考は避け、1ターンの操作は数回にまとめる。
- 戦闘はオートで決着し、結果が events に出る。結果をひとこと実況する。
  勝てる相手を選び、傷ついた艦隊は修理してから出し、相手に合わせて陣形を選ぶ。
- 惑星や巣の中枢は爆装でしか壊せない（巣の中枢はセラフ級の爆装だけ）。攻略に出す艦隊には爆装を積む。
```

## ゲーム本体への組み込み案（任意）

いまは Playwright が `game-api.js` を後から差し込むので、本体の変更は不要です。本体に同梱する場合は、本体の `<script>…</script>` の直後に次の1行を足すだけです。

```html
<script src="game-api.js"></script>
```

`game-api.js` は本体の以下の名前に依存しています。改名や仕様変更をする場合は、こちらも合わせて直す必要があります。

- 状態：`S`, `B`, `CLASSES`, `STATS`, `FAC`, `OWNER_LABEL`, `HIVE`, `BW`, `BH`
- 関数：`log`, `bmsg`（記録のため差し替える）, `render`, `renderBattle`, `planet`, `neighbors`, `fleetsAt`, `intruder`, `fleetPower`, `planetIncome`, `income`, `labRate`, `capOf`, `bcost`, `hasF`, `researchOpen`, `shipStats`, `makeShip`, `reach`, `bestAttack`, `unitAt`, `dist`, `isRock`・`docOf`・`FORM`・`FORM_KEYS`・`formKey`・`formOf`・`openFormation`（あれば使う）
- 行動：`orderMove`（演出つきの async。await して待つ）, `intercept`, `invest`, `openRefit`, `openYard`, `openBuild`, `closeModal`, `repair`, `newFleet`, `buildFac`, `demolish`, `survey`, `fortify`, `endTurn`, `newGame`, `doAttack`, `doMove`, `afterPlayerAct`, `enemyPhase`, `finishBattle`, `closeBattle`
- 要素：`#modal`, `#modalCard`（通信ウィンドウの検出と「了解」ボタン）
- 演出：`window.FAST`（`setPace(0)` で true にして、移動・攻撃・フェイズの演出を省く）。待機判定は `B.busy`／`B.phase` と `endTurn()` の完了で行う
