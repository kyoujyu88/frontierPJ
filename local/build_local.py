#!/usr/bin/env python3
"""辺境星系戦記のローカル版（ダブルクリックで遊べるフォルダ一式）を作る。

  python3 build_local.py            （Windows なら  py build_local.py）
  python3 build_local.py --allow-missing-audio   （game/audio に無い曲は合成音で代用）

../game/frontier-war.html と art/・audio/ を元に、ネット接続なしで動く
frontier-war/ フォルダと frontier-war-local.zip を作り直す。
ゲーム本体（game/）は書き換えない。必要なもの: fonttools, brotli（pip）。
フォントの元ファイル（_src/fonts/*.ttf）は _src/fonts/SOURCES.txt の場所から入手する。

file:// で開くと fetch() が使えないため、BGM は audio/audio-data.js に
data: URL として埋め込み、window.AUDIO_FILES で読み込み先を差し替える。
フォントは Google Fonts の代わりに、同梱のOFLフォントを使用文字だけに絞って入れる。

途中で失敗したときは、前回の frontier-war/ と zip をそのまま残す（一時フォルダで組み立ててから差し替える）。
"""
import base64, datetime, os, re, shutil, sys, tempfile, zipfile
from pathlib import Path
from fontTools import subset

HERE = Path(__file__).resolve().parent
GAME = HERE.parent / "game"
SRC = HERE / "_src"
SRC_FONTS = SRC / "fonts"
OUT = HERE / "frontier-war"
ZIP = HERE / "frontier-war-local.zip"
TOP = "frontier-war"                      # zip を展開したときのフォルダ名

# 同梱するフォント（Google Fonts の family/weight → _src/fonts の TTF 名）
FONTS = {("DotGothic16", 400): "DotGothic16-Regular",
         ("BIZ UDPGothic", 400): "BIZUDPGothic-Regular",
         ("BIZ UDPGothic", 700): "BIZUDPGothic-Bold"}
MIME = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav"}
ART_EXT = (".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg")
STORE = {".woff2", ".mp3", ".ogg", ".m4a"}  # deflate しても縮まない（woff2 はかえって増える）ので無圧縮で入れる


def die(msg):
    sys.exit(f"build_local.py: 中止しました（前回の出力はそのまま）: {msg}")


html = (GAME / "frontier-war.html").read_text(encoding="utf-8")

# ---------- 1. 検査（ここで止まれば何も消さない）
# 音: AUDIO_FILES の既定値のブロックだけを読む（コメント中の例は数えない）
m = re.search(r"const\s+AUDIO_FILES\s*=\s*Object\.assign\(\s*\{(.*?)\}\s*,", html, re.S)
if not m:
    die("const AUDIO_FILES=Object.assign({...}, ...) が見つからない")
pairs = re.findall(r"""["']((?:bgm|se):[\w-]+)["']\s*:\s*["'](audio/[^"']+)["']""", m.group(1))
if not pairs:
    die("AUDIO_FILES に音声ファイルの指定が無い")
bad = [p for _, p in pairs if Path(p).suffix.lower() not in MIME]
if bad:
    die(f"知らない音声形式: {bad}")
missing = [p for _, p in pairs if not (GAME / p).is_file()]
if missing and "--allow-missing-audio" not in sys.argv:
    die(f"game/ に無い音声ファイル: {missing}（合成音で代用してよければ --allow-missing-audio）")

# フォント: Google Fonts の指定と、同梱するフォントが一致しているか
gf = re.search(r'<link\b[^>]*\bhref="(https://fonts\.googleapis\.com/css2\?[^"]+)"[^>]*>', html)
if not gf:
    die("Google Fonts の <link> が見つからない")
want = set()
for fam in re.findall(r"family=([^&]+)", gf.group(1).replace("&amp;", "&")):
    name, _, axes = fam.partition(":")
    weights = re.findall(r"\d{3}", axes.split("@", 1)[1]) if "@" in axes else ["400"]
    want |= {(name.replace("+", " "), int(w)) for w in weights}
if want != set(FONTS):
    die(f"Google Fonts の指定 {sorted(want)} と同梱フォント {sorted(FONTS)} が合わない。FONTS と _src/fonts を更新する")
for name in FONTS.values():
    if not (SRC_FONTS / f"{name}.ttf").is_file():
        die(f"_src/fonts/{name}.ttf が無い（入手先は _src/fonts/SOURCES.txt）")

# 画像: HTML に直接書かれた art/ の参照がすべて実在するか（ART+変数で組み立てる分は game 側の一覧と照合できないので、
#       art/ の画像はまとめて同梱する）
for ref in sorted(set(re.findall(r"\bart/[\w.-]+\.(?:webp|png|jpe?g|gif|svg)\b", html))):
    if not (GAME / ref).is_file():
        die(f"HTML が参照している {ref} が game/ に無い")

# ---------- 2. HTML の変換
html = re.sub(r'<link\b[^>]*\brel="preconnect"[^>]*>\s*', "", html)
html = html.replace(gf.group(0), '<link rel="stylesheet" href="fonts/fonts.css">\n'
                                  '<script src="audio/audio-data.js"></script>', 1)
# claude.ai では外側に <!doctype>・<meta charset>・viewport が付くが、ローカルでは自分で付ける
# （quirks モード・日本語版 Windows での文字化け・スマホでPC表示が縮小される のを防ぐ）
if not re.match(r"\s*<!doctype", html, re.I):
    html = ('<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + html)
# 失敗したときの案内（古いブラウザで本体スクリプトが動かない／zip の中から直接開いて audio-data.js 等が無い）。
# ふだんは hidden なので一瞬も出ない。案内の判定は ES5 だけで書く（古いブラウザでも動くように）
WARN = ('<div id="fw-warn" hidden style="position:fixed;left:0;right:0;top:0;z-index:9999;padding:12px 16px;'
        'background:#7a1f1f;color:#fff;font:15px/1.6 Meiryo,sans-serif">'
        'このブラウザではゲームを動かせませんでした。Microsoft Edge か Google Chrome（最新版）で index.html を開いてください。</div>\n')
CHECK = ('<script>(function(){var w=document.getElementById("fw-warn");if(!w)return;'
         'if(!window.AUDIO_FILES){w.textContent="zip の中から直接開いているため、画像・音・文字が読み込めません。'
         'zip を右クリック →「すべて展開」してから、展開したフォルダの index.html を開いてください。";w.hidden=false}'
         'else if(typeof S==="undefined"||!S)w.hidden=false;else w.parentNode.removeChild(w)})();</script>\n')
if html.count("<script>") != 1:
    die(f"本体の <script> が {html.count('<script>')} か所（1か所のはず）。game 側の HTML が変わっていないか確認")
html = html.rstrip() + "\n" + WARN + CHECK
ext = list(re.findall(r"""(?:src|href)\s*=\s*["']?((?:https?:)?//[^"'\s>]+)""", html))
ext += re.findall(r"url\(\s*['\"]?((?:https?:)?//[^)'\"]+)", html)
if ext:
    die(f"外部URLが残っている: {ext}")

# ---------- 3. 一時フォルダで組み立てる
tmp = Path(tempfile.mkdtemp(prefix=".build-", dir=HERE))
try:
    out = tmp / TOP
    (out / "audio").mkdir(parents=True)
    (out / "fonts").mkdir()
    shutil.copytree(GAME / "art", out / "art",
                    ignore=lambda d, names: [n for n in names if not n.lower().endswith(ART_EXT)])

    audio = {}
    for key, p in pairs:
        f = GAME / p
        if f.is_file():
            audio[key] = f"data:{MIME[f.suffix.lower()]};base64," + base64.b64encode(f.read_bytes()).decode()
    js = "/* build_local.py が生成。手で編集しない */\nwindow.AUDIO_FILES=Object.assign(window.AUDIO_FILES||{},{\n"
    js += ",\n".join(f'"{k}":"{v}"' for k, v in audio.items()) + "\n});\n"
    (out / "audio" / "audio-data.js").write_text(js, encoding="utf-8", newline="\n")

    chars = set(html)
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    chars |= {chr(c) for c in range(0x3000, 0x3100)}   # 記号・ひらがな・カタカナ
    chars |= {chr(c) for c in range(0xFF00, 0xFFF0)}   # 全角英数・半角カナ
    text = "".join(sorted(chars))
    css = []
    for (family, weight), name in FONTS.items():
        opts = subset.Options(); opts.flavor = "woff2"; opts.layout_features = ["*"]
        opts.name_IDs = ["*"]                            # 著作権・ライセンス表記をフォント内にも残す
        font = subset.load_font(str(SRC_FONTS / f"{name}.ttf"), opts)
        s = subset.Subsetter(opts); s.populate(text=text); s.subset(font)
        subset.save_font(font, str(out / "fonts" / f"{name}.woff2"), opts)
        css.append(f'@font-face{{font-family:"{family}";font-weight:{weight};font-display:swap;src:url({name}.woff2) format("woff2")}}')
    (out / "fonts" / "fonts.css").write_text("\n".join(css) + "\n", encoding="utf-8", newline="\n")
    for lic in SRC_FONTS.glob("OFL-*.txt"):
        shutil.copy(lic, out / "fonts" / lic.name)

    (out / "index.html").write_text(html, encoding="utf-8", newline="\n")
    # 説明書きはメモ帳向けに UTF-8（BOM付き）・CRLF にそろえる
    for name in ("はじめにお読みください.txt", "CREDITS.txt"):
        t = (SRC / name).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        (out / name).write_bytes(("﻿" + t).replace("\n", "\r\n").encode("utf-8"))

    # zip：展開すると frontier-war/ になる。日時は日本時間・ゲーム本体の更新時刻に固定（同じ入力なら同じ zip）
    mt = max(p.stat().st_mtime for p in [GAME / "frontier-war.html", *SRC.glob("*.txt")])
    stamp = datetime.datetime.fromtimestamp(mt, datetime.timezone(datetime.timedelta(hours=9))).timetuple()[:6]
    tzip = tmp / ZIP.name
    with zipfile.ZipFile(tzip, "w") as z:
        for p in sorted(out.rglob("*")):
            arc = p.relative_to(tmp).as_posix()
            if p.is_dir():
                zi = zipfile.ZipInfo(arc + "/", stamp); zi.external_attr = (0o40755 << 16) | 0x10
                z.writestr(zi, b"")
                continue
            zi = zipfile.ZipInfo(arc, stamp); zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_STORED if p.suffix.lower() in STORE else zipfile.ZIP_DEFLATED
            z.writestr(zi, p.read_bytes(), compresslevel=9)
    with zipfile.ZipFile(tzip) as z:                        # 自己点検
        names = z.namelist()
        assert all(n.startswith(TOP + "/") for n in names)
        assert f"{TOP}/index.html" in names and f"{TOP}/audio/audio-data.js" in names
        assert all(i.flag_bits & 0x800 for i in z.infolist() if not i.filename.isascii())

    # ---------- 4. 差し替え
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.move(str(out), str(OUT))
    os.replace(tzip, ZIP)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
print(f"audio: {len(audio)}/{len(pairs)} embedded ({', '.join(audio)})" + (f"  ※無し: {missing}" if missing else ""))
print(f"folder: {OUT} ({size/1e6:.1f} MB)  zip: {ZIP} ({ZIP.stat().st_size/1e6:.1f} MB)")
