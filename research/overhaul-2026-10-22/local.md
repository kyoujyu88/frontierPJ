# ローカル版（frontier-war/ ・ frontier-war-local.zip）点検報告

対象：SNAP/local/build_local.py ＋ SNAP/game から作るローカル版。比べた完成品は /mnt/project-files/local/frontier-war/ と frontier-war-local.zip（読んだだけ）。
作業フォルダ：`/tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/local/`（以下 WORK）
使ったテスト：WORK/t1-load.mjs（読み込み・フォント・BGM）、t2-quirks.mjs（quirks／standards 比較）、t3-charset.mjs、t4-glyphs.mjs ＋ glyphcheck.py（サブセット外の文字）、t5-alone.mjs（zip から単体で開いた状態）、t6-warn.mjs、t7-music.mjs。
改善案のビルドスクリプト（試験済み）：**WORK/prop/local/build_local.py**

## 結論

ローカル版は Chromium の file:// で**問題なく遊べる**。コンソールエラー・読み込み失敗はゼロ。3つの書体は読み込まれて実際に描画に使われており、BGM はクリック後に7曲とも ABUF にデコードされ、戦闘に入ると曲が切り替わる。数ターン遊んで出た文字は、すべてフォントのサブセットに入っていた。重大度「高」の指摘は無い。
直したほうがよいのは主に2点。
- **zip の中から直接開いたとき**（Windows ではよくある）に、何の案内も無いまま画像・音・フォントが全部欠けること。
- **build_local.py が取りこぼしても黙って成功扱いになる**こと、途中で失敗すると前回の出力を壊してしまうこと。

---

## 1. ビルドの再現（確認済み）

- WORK/game・WORK/local に SNAP をコピーして `python3 WORK/local/build_local.py` を実行した（約5.5秒）。
- `diff -rq` を取ると、**frontier-war/ は /mnt/project-files/local/frontier-war/ とバイト単位で同じ**だった（index.html、woff2 ×3、audio-data.js、art 42枚、txt、css のすべて）。build_local.py と _src も同じ。
- zip は中身が同じ（55件。名前・サイズ・圧縮後サイズまで一致）。違うのは各エントリの日時だけ（ビルドした時刻が入るため）。
- 出力の `audio: 7/8 files embedded` は、取りこぼしではない。分母の 8 に、コメント中の例 `"audio/se-beam.mp3"`（frontier-war.html 1282行）が数えられているだけ（→ L-4）。

## 2. file:// を Chromium で開いた結果（FAST なし。確認済み）

| 項目 | 結果 |
|---|---|
| 読み込み時間 | load まで 0.35〜0.9 秒（15MB の audio-data.js を含む） |
| コンソール／pageerror／requestfailed | 0件／0件／0件 |
| 画像 | `<img>` はすべて naturalWidth>0。プレイ中に読まれた art は22種類で、すべて成功 |
| document.fonts | `DotGothic16 400 loaded`、`BIZ UDPGothic 400 loaded`、`BIZ UDPGothic 700 loaded`。fonts.check も3つとも true |
| 実際に描画に使われた書体（CDP の CSS.getPlatformFontsForNode） | h1・通信の話者名・戦闘見出し・フェイズ表示 → DotGothic16(web)、本文・ボタン → BIZ UDPGothic(web) |
| BGM | クリック前は ctx 無し・ABUF 空。クリックから約1.5秒で ABUF に bgm:map/battle/xeno/hive、se:jingle/win/sad の7件が入る（長さ 165〜181秒、ジングル 5〜7秒）。SND.file=map |
| 曲の切り替え | 作戦卓 map → 惑星攻略戦で battle → 撤退して閉じると map に戻る。setMusic("xeno"/"hive") でも、それぞれのファイルが鳴る |
| localStorage | file:// でも使える（origin は "file://"）。保存するのは `fw-sound` だけ |
| 日本語と空白を含むパス（…/ダウンロード/frontier-war-local (1)/frontier-war/） | 上と同じく問題なし |

## 3. サブセットに無い文字が画面に出ていないか（確認済み）

- 方法：addInitScript で MutationObserver を仕掛けた。DOM に足された文字（HTML、SVG の text、ログ、ツールチップ、戦闘の数字・バナー、通信ウィンドウ）を、その要素の computed font-family と太さごとに集め、woff2 の cmap（fontTools）と照らし合わせた。
  - ゲームは game-api.js を注入して pace 20ms（FAST ではない）で進めた。8ターン、戦闘5回。
  - 毎ターン、改装・陣形・造船・施設建設の各ウィンドウを開き、全惑星の右パネルとツールチップを出し、戦闘中は全ユニットのツールチップと「敵の射程」を出した。
  - 「最初から」「遊び方」も開き、最後に勝利・敗北の画面（showEnd(true/false)）も出した。
- 結果：書体ごとに集まった文字は、BIZ UDPGothic 400 が410種類、700 が101種類、DotGothic16 が221種類。**どれもサブセットに無い文字は0件**。"undefined"・"NaN"・"[object" を含む表示も無かった。
- 静的にも確かめた：HTML 中の非ASCII文字606種類は、元の TTF 2書体にすべて入っている。JS の `\uXXXX` エスケープ、HTML の文字参照、fromCharCode・toLocaleString も使われていない。つまり実行時に組み立てる文字列は数字・ASCII と HTML 中の文字だけなので、今の `set(html)`＋ASCII＋かな＋全角 のやり方で漏れは出ない。
- 参考（ローカル版に限った話ではない）：DotGothic16 が太字指定で使われている箇所が8文字分ある。DotGothic16 は 400 しか無いので、Web版でもローカル版でも合成太字になる。どの要素かは特定していない（未確認）。

## 4. zip とテキストファイル（確認済み。Windows の実機では未確認）

- 展開すると `frontier-war/` 1つにまとまる（55件。フォルダ自体のエントリは無いが問題ない）。不要物（__MACOSX、.DS_Store、生成途中のファイルなど）は無い。
- `はじめにお読みください.txt` だけ flag_bits=0x0800（UTF-8 フラグ）が立っている。Python の zipfile が非ASCII名に自動で付けるもの。Windows 10/11 のエクスプローラー（11 の新しい展開処理も含む）はこのフラグを見るので、仕様上は文字化けしない（**実機未確認**）。
- サイズ：zip 13.5MB、展開後 17.6MB。大半は audio-data.js（15.2MB、base64 で約1.33倍）。
- テキストの文字コード：はじめに／CREDITS は **UTF-8（BOM無し）・改行 LF**。Windows 10 1903 以降のメモ帳なら正しく表示されるが、それより古いメモ帳では文字化けし、1行につながる（→ L-5）。OFL-DotGothic16.txt は CRLF、OFL-BIZUDPGothic.txt は LF（どちらも ASCII）。
- CREDITS と同梱物の照合：
  - フォント：3書体とも同梱されている。著作権表記はフォントの name ID 0 と一致し、OFL 全文も fonts/ にある。どちらの OFL にも Reserved Font Name が無いので、サブセット（改変版）を同じ名前のまま出しても問題ない。
  - 画像：art は42枚。コードの組み立て規則（SHIP_ART・FACE・TRAIT_ART・unitArt・showEnd・showComm）から数えた必要枚数とちょうど一致し、使われていない画像も足りない画像も無い。
  - 音：埋め込まれているのは AUDIO_FILES の7件と同じ。
  - 出どころの記載（Gemini／Lyria／SynthID）は、ファイルからは確かめられなかった（→ L-7）。

---

## 指摘一覧

### L-1【中】zip の中から index.html を直接開くと、画像・フォント・BGM が全部欠けるのに、何の案内も出ない（確認済み）
- 場所：配布物全体（はじめにお読みください.txt の「※ zip のまま開かず」だけで防いでいる）。
- 何が起きるか：Windows のエクスプローラーは zip をダブルクリックするとフォルダのように開き、その中の index.html をダブルクリックすると**そのファイルだけ**を一時フォルダに出して開く。このとき fonts.css・audio-data.js・art がすべて ERR_FILE_NOT_FOUND になる。ゲーム自体は動くが、次の状態になる。
  - 画像が全部壊れたアイコンになる
  - フォントが OS 標準に替わる
  - BGM は合成音で代用される
  - 説明は何も出ないので、「こういうゲームだ」と誤解されやすい
- 再現：WORK/t5-alone.mjs。`Temp1_frontier-war-local.zip/frontier-war/index.html` だけを置いて開いた。スクリーンショットは WORK/shot-alone.png。
- 直し方：ビルド時に、ふだんは hidden の警告帯と、ES5 だけで書いた判定スクリプトを index.html の末尾に足す。改善案の build_local.py に入れてあり、試験済み：
  - 正常に開いたとき → 警告帯は消え、一瞬も出ない
  - zip から単体で開いたとき → 「zip を右クリック →『すべて展開』…」と出る（WORK/warn-alone.png）
  - 本体スクリプトが構文エラーのとき（古いブラウザ相当）→ 「Edge か Chrome の最新版で…」と出る

  ```python
  WARN = ('<div id="fw-warn" hidden style="position:fixed;left:0;right:0;top:0;z-index:9999;padding:12px 16px;'
          'background:#7a1f1f;color:#fff;font:15px/1.6 Meiryo,sans-serif">'
          'このブラウザではゲームを動かせませんでした。Microsoft Edge か Google Chrome（最新版）で index.html を開いてください。</div>\n')
  CHECK = ('<script>(function(){var w=document.getElementById("fw-warn");if(!w)return;'
           'if(!window.AUDIO_FILES){w.textContent="zip の中から直接開いているため、画像・音・文字が読み込めません。'
           'zip を右クリック →「すべて展開」してから、展開したフォルダの index.html を開いてください。";w.hidden=false}'
           'else if(typeof S==="undefined"||!S)w.hidden=false;else w.parentNode.removeChild(w)})();</script>\n')
  html = html.rstrip() + "\n" + WARN + CHECK
  ```
  （`typeof S` は、本体の `let S` が宣言されていれば見える。本体が構文エラーなら宣言されないので "undefined" になる。）

### L-2【中】build_local.py が取りこぼしても成功扱いになる。途中で失敗すると前回の出力を壊す（確認済み）
- 場所：build_local.py 33〜35行（音の正規表現）、64〜68行（HTML の置き換え）、26〜30行（最初に rmtree）。
- 何が起きるか：WORK/mut に game のコピーを作り、HTML を少しずつ変えてビルドした。

  | game 側の変更 | 今のスクリプトの結果 |
  |---|---|
  | 本体の `<script>` → `<script defer>` | **終了コード0**。index.html に audio-data.js が入らず、BGM は全部合成音になる。出力はなお「7/8 embedded」 |
  | `"bgm:map": "audio/bgm-map.mp3"`（コロンの後に空白） | **終了コード0**。bgm:map が黙って抜ける（6/8） |
  | 音を .ogg に変更 | **終了コード0**。その音が黙って抜ける |
  | Google Fonts に `&family=Noto+Sans+JP` を追加 | **終了コード0**。新しい書体は同梱されず、黙って OS フォントになる |
  | `<link href=… rel="stylesheet">`（属性の順番を変える） | assert で止まる。ただし**その時点で frontier-war/ はもう消えて作りかけ（index.html が無い）になり、古い zip だけが残る** |

  ほかにも次の問題がある。
  - 68行の `html.replace("<script>", …, 1)` は件数を確かめていない。
  - 69行の外部 URL 検査は https:// しか見ていない。しかも http の SVG 名前空間を消してから https を探しており、意味の無い処理になっている。
  - 30行の `copytree(art)` は、Thumbs.db・desktop.ini・元の PNG なども全部入れてしまう。
- 直し方：WORK/prop/local/build_local.py（全文、試験済み）。要点は次のとおり。
  1. **検査を先に済ませ、一時フォルダ（HERE/.build-*）で組み立ててから差し替える**。失敗したら前回の frontier-war/ と zip はそのまま残る。上の表の5件で確かめた。止まるべき4件は終了コード1で止まり、index.html は残り、一時フォルダのごみも残らない。空白と属性順の2件は、正しく成功する。
  2. 音は `const AUDIO_FILES=Object.assign({…},` の中だけを、空白・引用符の違いに強い正規表現で読む：
     `r"""["']((?:bgm|se):[\w-]+)["']\s*:\s*["'](audio/[^"']+)["']"""`。拡張子から MIME を決め（mp3/ogg/m4a/wav）、ファイルが無ければ止める（`--allow-missing-audio` を付けたときだけ続行）。
  3. Google Fonts の URL の `family=…:wght@…` を分解し、同梱する `FONTS` 表（family と weight）と食い違えば止める。
  4. audio-data.js は本体の `<script>` の前ではなく、**Google Fonts の `<link>` を置き換えたところ（head）に入れる**。本体の script タグが変わっても影響を受けない。そのうえで素の `<script>` がちょうど1つであることを確かめる（defer や module にされると、末尾の判定スクリプトより後に動いてしまうため）。
  5. HTML に直接書かれた `art/….webp` が実在するか調べる。art は画像の拡張子だけをコピーする。
  6. 外部 URL の検査は src・href・url() の http/https/`//` を対象にする。
  7. 最後に zip を開き直して自己点検する（全エントリが `frontier-war/` の下にあるか、index.html と audio-data.js があるか、非ASCII名に 0x800 が立っているか）。
- 改善案で作った出力でも、t1（読み込み・フォント・BGM・戦闘で曲切り替え）と t6 を流して問題なかった。compatMode は CSS1Compat になる。

### L-3【低】index.html に `<!doctype html>` も `<meta charset>` も無いため、quirks モードで動いている（確認済み）
- 場所：frontier-war.html 1行目が `<title>` から始まる（claude.ai では外側にひな形が付くので問題にならない）。build_local.py は何も足していない。
- 何が起きるか：ローカルでは `document.compatMode === "BackCompat"`（quirks モード）になる。
  - 見た目：doctype を足した版と 1366×768／1920×1080／1280×720 の作戦卓・戦闘画面で比べたが、主要要素の位置と大きさは同じで、ピクセル差もほぼ0だった（今は実害なし）。今後 CSS を変えたときに Web 版とずれる種になる。
  - 文字コード：Chromium は内容から UTF-8 と判定した。ただし既定の文字コードを Shift_JIS に変える設定が効かなかったので、日本語版 Windows の Chrome／Edge と同じ条件で確かめられてはいない（未確認）。Firefox も未確認。
- 直し方：ビルドで先頭に足す（改善案に入れてある）。
  `html = '<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n' + html`

### L-4【低】ビルドの出力「audio: 7/8」がまぎらわしい（確認済み）
- 場所：build_local.py 33行の `refs`。frontier-war.html 1282行のコメント中の例 `audio/se-beam.mp3` まで数えている。
- 直し方：分母を AUDIO_FILES のブロックから読んだ件数にする（改善案では `7/7`、無いファイルがあれば名前も出す）。

### L-5【低】説明書きのテキストが UTF-8（BOM無し）・LF なので、古いメモ帳では読めない（確認済み。実機未確認）
- 場所：_src/はじめにお読みください.txt、_src/CREDITS.txt を shutil.copy でそのまま入れている。
- 何が起きるか：Windows 10 1903 以降のメモ帳なら問題ない。それより古いメモ帳や、ほかのビューアでは、Shift_JIS と判定されて文字化けしたり、1行につながったりする恐れがある。
- 直し方：ビルドで BOM付き UTF-8・CRLF に変換する（改善案に入れてある）。
  ```python
  t = (SRC / name).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
  (out / name).write_bytes(("﻿" + t).replace("\n", "\r\n").encode("utf-8"))
  ```

### L-6【低】はじめにお読みください.txt の中身の改善
- 「Chrome / Edge / Firefox / Safari で動作」とあるが、確かめたのは Chromium だけ。持ち主は Windows なので Safari は不要。Firefox の file:// でのフォント読み込みは未確認（後の「未確認」参照）。
- Windows の既定では拡張子が表示されないので、index.html は「index」と見える。
- 再読み込み（F5）でも最初からになることが書かれていない。
- BGM がどこにあるか（audio/ に mp3 が無く、audio-data.js に入っていること）も書かれていない。
- 案（そのまま差し替えられる文面）：
  ```
  辺境星系戦記（ローカル版）

  ■ 遊び方
    1. zip を右クリック →「すべて展開」で展開します。
       （zip の中から直接開くと、画像・音・文字が読み込めません）
    2. 展開してできた frontier-war フォルダの index.html
       （拡張子が表示されていなければ「index」）をダブルクリックします。
       Microsoft Edge か Google Chrome で開いてください。インターネット接続は不要です。
    3. BGM はブラウザの仕様で、画面を一度クリックしてから鳴り始めます。
       右上の「音 ON／音 OFF」で切り替えられます。F11 キーで全画面になります。

  ■ セーブ
    セーブ機能はありません。ページを閉じたり再読み込み（F5）したりすると最初からになります。

  ■ うまく動かないとき
    ・画面の上に赤い帯が出たら、帯の案内に従ってください。
    ・古いブラウザや別のアプリで開いてしまうときは、index.html を右クリック →
      「プログラムから開く」→「Microsoft Edge」を選んでください。

  ■ フォルダの中身
    index.html  ゲーム本体
    art\        画像
    audio\      音楽（audio-data.js に埋め込み済み）
    fonts\      フォントとそのライセンス（SIL Open Font License）

  ■ 取り扱い
    個人で遊ぶため・配信のための私的なコピーです。
    ファイルの再配布やWebへのアップロードはしないでください。
    クレジットは CREDITS.txt を参照してください。
  ```

### L-7【低】CREDITS と実際の同梱物
- フォントの項は正しい（上記）。
- 画像・音の出どころ（Gemini／Lyria／SynthID）は、**ファイルからは確かめられない**（確認済み）。
  - 51ファイル（webp 42、mp3 9）すべてに入っている C2PA マニフェストは Anthropic のものだけ（`claim_generator_info: Anthropic Files`、"Claude provided this file at the request of a user and may have created or modified the file contents"）。Google の来歴情報は残っていない。
  - mp3 は ffmpeg（Lavf60.16.100）で再エンコードされている（128kbps・44.1kHz）。
  - SynthID は音声そのものに埋め込まれる透かしなので、メタデータからは判断できない。
  - 記載が正しいかは持ち主の記憶で確かめてもらうしかない。
- 足すとよい2行：「BGM・ジングルは audio/audio-data.js に埋め込み」「画像・音声の形式変換（webp／mp3 化）：Claude」。後者は C2PA の記載と合わせるため。
- 細かい点：OFL-BIZUDPGothic.txt 1行目の URL が `morisawa-biz-ud-mincho` になっている（フォント内の表記は `…-gothic`）。上流の配布ファイルどおりと思われる（未確認）ので、ライセンス文書は手を加えずそのままでよい。

### L-8【低】zip の細部（確認済み）
- woff2 は deflate するとかえって大きくなる（209588→209619 など）。改善案では woff2・mp3 を STORED（無圧縮）にした。webp は deflate で 10〜40% 縮むので deflate のまま。
- 日時は、ビルドしたコンテナのローカル時刻（UTC）がそのまま入る。エクスプローラーでは9時間ずれて見え、毎回 zip のバイト列が変わる。改善案では「ゲーム本体と説明書きの更新時刻を日本時間にしたもの」で固定している（同じ入力なら同じ zip になる）。
- エクスプローラーの「すべて展開」は zip 名のフォルダを作るので、展開先は `frontier-war-local\frontier-war\index.html` と2重になる。害は無く、説明書きで「frontier-war フォルダの index.html」と書けば足りる（L-6 の案に反映）。

### L-9【低】サブセットしたフォントから name ID 13/14（ライセンス表記）が落ちている（確認済み）
- fontTools の既定では name ID 0〜6 しか残らない。OFL の条件は fonts/OFL-*.txt で満たしているので必須ではない。フォント単体で持ち出されたときのため、`opts.name_IDs = ["*"]` で残すのが無難（増えるのは数百バイト）。改善案に入れてある。

### L-10【低・参考】game/audio に使われていない曲がある（確認済み）
- `bgm-title.mp3`（1.9MB）と `bgm-crisis.mp3`（2.8MB）は、どこからも参照されていない（AUDIO_FILES に無い）。ローカル版が入れていないのは正しい動き。タイトル曲・危機曲として使う予定が無いなら、game 側（Web 版）でも配る必要は無い。

### L-11【要判断・情報】リポジトリ kyoujyu88/frontierPJ は public（確認済み）
- `gh api repos/kyoujyu88/frontierPJ` の結果：`"private":false,"visibility":"public"`。
- game/art・game/audio（約18MB）は、すでに GitHub で誰でも見られる状態になっている。持ち主が「Web 公開しない」つもりなら、方針と食い違っている可能性がある。説明書きの「再配布しないでください」とも合わない。
- private にするかは持ち主の判断。少なくとも、生成物の zip や同梱フォントを public リポジトリに足すのは避けたほうがよい（次節）。

---

## 5. ローカル版ならではの点（6 への回答）

- **file:// の localStorage**：Chromium で使える（確認済み）。Chrome／Edge では、すべてのローカル HTML が "file://" という1つの保存先を共有するが、このゲームが保存するのは `fw-sound` だけなので害は無い。ブラウザがストレージを禁止していても try/catch で包まれている（1302・1318行）。
- **Edge／Chrome**：どちらも Chromium なので、上の確認がそのまま当てはまる。自動再生は「最初のクリックで AudioContext を起こす」作りで対応済み（1416行）。
- **既定ブラウザが IE や古いもの**：Windows 10/11 では IE11 が無効になっており、.html は Edge で開くので、まず起きない。それでも古い Chromium／Firefox で `?.` などが構文エラーになると真っ黒な画面になるので、L-1 の判定スクリプトで「Edge か Chrome の最新版で」と出すようにした（構文エラー版で確認済み）。
- **Firefox**（未確認）：file:// の @font-face は同一フォルダ以下なら読めるはずだが、実機では試していない。読めなくても Meiryo になるだけで、遊べなくなるわけではない。確実にしたければ、fonts.css の src を `url(data:font/woff2;base64,…)` にして埋め込めばブラウザによる差がなくなる（増えるのは約0.16MB）。fetch("data:…") による BGM は Firefox でも動くはず（未確認）。
- **ダウンロードした zip の Mark of the Web**：Chromium 系は MOTW で file:// の動きを変えないので、影響は無いと考える（未確認）。
- **メモリ**：BGM 4曲（各約170秒・44.1kHz・ステレオ）をデコードすると、合計で約240MB になる。Web 版と同じで、ローカル版だけの問題ではない。

## 6. リポジトリに local/ を入れるか（意見）

**入れるべき。ただし入れるのは「作り方」だけで、「作ったもの」と大きな原本は入れない。**

入れるもの：
- `local/build_local.py`（改善案の版がよい）
- `local/_src/はじめにお読みください.txt`、`local/_src/CREDITS.txt`
- `local/_src/fonts/OFL-DotGothic16.txt`、`local/_src/fonts/OFL-BIZUDPGothic.txt`
- `local/_src/fonts/SOURCES.txt`（新規。TTF の入手先と sha256。下の案）
- ルートの README.md の表に `local/` の行を1つ足す（「`python3 local/build_local.py` で frontier-war/ と zip を作る。要 fonttools・brotli」）

.gitignore に足すもの：
```gitignore
# ローカル版の生成物（local/build_local.py で作り直せる）
local/frontier-war/
local/frontier-war-local.zip
local/.build-*/
# フォント原本（約11MB。入手先と sha256 は local/_src/fonts/SOURCES.txt）
local/_src/fonts/*.ttf
```

理由：
- 生成物は入れない。zip（13.5MB）と frontier-war/（17.6MB）は、game を変えるたびに作り直すので、入れるたびに履歴が十数MBずつ膨らむ。リポジトリが public なので、zip を入れるとそれ自体が「再配布」になる。
- TTF は大きく（3つで約11MB）、上流からいつでも同じものを入手できる。今の Claude のセッションには /mnt/project-files/local/_src/fonts にあるので、ビルドは困らない。
  - 持ち主の PC でも必ず作れるようにしたいなら、TTF もコミットする手はある。OFL なので再配布は問題なく、11MB を1度足すだけ。ただ、上の理由で .gitignore を勧める。

SOURCES.txt の案（sha256 は今の _src の実物から計算。URL は Google Fonts の配布場所として書いたもので、ネットに出られないため**未確認**）：
```
DotGothic16-Regular.ttf   https://github.com/google/fonts/tree/main/ofl/dotgothic16   (Version 1.100)
  sha256 3ad9af88726d42b40f7f365f0dcac785af73cf20ea6f1d5b44e57cc21150b8f1
BIZUDPGothic-Regular.ttf  https://github.com/google/fonts/tree/main/ofl/bizudpgothic  (Version 1.051)
  sha256 258d7156c165f2ff774b6efee637c22c3b950de0d8a10e501137061bc8085d01
BIZUDPGothic-Bold.ttf     https://github.com/google/fonts/tree/main/ofl/bizudpgothic  (Version 1.051)
  sha256 30eba52fc837e8b62c97d4b82e6706583149fb7294e3712dd71a655eaea80a90
```
（版が変わっても困らないので、build_local.py で sha256 を照合するのは任意。照合するなら、違ったときは止めずに警告を出す程度でよい。）

---

## 未確認のまとめ
- Windows の実機での確認はしていない：エクスプローラーでの日本語ファイル名（UTF-8 フラグは立っている）、メモ帳での表示、MOTW、既定ブラウザまわり。
- Firefox：file:// での @font-face、fetch("data:") による BGM、文字コードの判定。
- 日本語版 Windows の Chrome／Edge（既定の文字コードが Shift_JIS）で、宣言なしの index.html が UTF-8 と判定されるか。Linux の Chromium では内容から UTF-8 と判定された。既定値を変える設定が効かなかったので、Shift_JIS 既定の条件は再現できていない。L-3 で `<meta charset>` を足せば、この問題自体がなくなる。
- CREDITS にある画像・音の生成元（Gemini／Lyria）。
- SOURCES.txt の URL。
