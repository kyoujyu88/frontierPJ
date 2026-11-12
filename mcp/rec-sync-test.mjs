#!/usr/bin/env node
/* 録画の音と映像のずれを測る（npm run test:recsync）
 *
 * テスト用のページ（2秒ごとに左上が白く光り、同時に「ピッ」と鳴る。ほかに帯がずっと動いている）を
 * server.mjs と同じしくみ（recorder.mjs・video-clock.mjs・mux-audio.mjs）で録画し、出来た3つのファイルで
 *   ・合成した動画：光った時刻と鳴った時刻の差（最初から最後まで、どれだけ変わるか）
 *   ・映像だけ／音だけ：同じ差を、別々のファイルから
 *   ・プレイログの時刻：ページで鳴らした実際の時刻 − 動画の時刻ゼロ と、動画で光った時刻の差
 * を出す。音と映像を読むのに ffmpeg / ffprobe（ふつうの版）が要る。Playwright 付属の ffmpeg では読めない。
 *
 *   node rec-sync-test.mjs [秒数=60] [--headed] [--still] [--keep <フォルダ>] [--allow-skip]
 *     --still  帯を動かさない（画面がほとんど変わらないとき）
 *     --keep   録画をそのフォルダに残す（既定は終わったら消す）
 *     --allow-skip  ffmpeg / ffprobe が無いとき、測らずに終了コード 0 で終える（既定は 2） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { prepareAudio, trackRecording, stopRecording, CLOCK_OK } from "./recorder.mjs";
import { finishJob } from "./mux-audio.mjs";

const argv = process.argv.slice(2);
const SECS = Number(argv.find(a => /^\d+$/.test(a)) ?? 60);
const HEADED = argv.includes("--headed"), STILL = argv.includes("--still");
const KEEP = argv.includes("--keep") ? path.resolve(argv[argv.indexOf("--keep") + 1]) : null;
const LIMIT_MS = 80;  // 光と音の差がこれを超えたら失敗
const DRIFT_MS = 60;  // 最初と最後で差がこれ以上変わったら失敗

const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#000">
<canvas id=c width=1280 height=720></canvas>
<script>
const anim = ${!STILL}, c = document.getElementById("c"), g = c.getContext("2d");
let flashUntil = 0, ac = null; window.beeps = [];
function frame(t) {
  g.fillStyle = "#000"; g.fillRect(0, 0, 1280, 720);
  if (anim) { g.fillStyle = "#468"; for (let i = 0; i < 12; i++) g.fillRect((t / 3 + i * 110) % 1280, 300 + i * 20, 80, 15); }
  if (performance.now() < flashUntil) { g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 200); }
  if (anim || performance.now() < flashUntil + 100) requestAnimationFrame(frame);
}
function beep() {
  if (!ac) ac = new AudioContext(); // ゲームと同じく1つの AudioContext → destination
  const o = ac.createOscillator(), gn = ac.createGain(); o.frequency.value = 1000; gn.gain.value = 0.5;
  o.connect(gn); gn.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.1);
  flashUntil = performance.now() + 200; requestAnimationFrame(frame); window.beeps.push(Date.now());
}
setTimeout(() => { beep(); setInterval(beep, 2000); }, 3000);
requestAnimationFrame(frame);
</script>`;

const have = (cmd) => { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } };
// 測れないときは成功にしない（終了コード 2）。測れなくてよい環境では --allow-skip で 0 にする
if (!have("ffmpeg") || !have("ffprobe")) { console.log("スキップ：ffmpeg / ffprobe が見つからないので測っていません（PATH に入れてください）"); process.exit(argv.includes("--allow-skip") ? 0 : 2); }

function flashes(file) {
  const esc = file.replace(/\\/g, "/").replace(/[:']/g, "\\$&");
  const rows = execFileSync("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `movie=${esc},crop=200:200:0:0,signalstats`, "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"], { maxBuffer: 1 << 28 })
    .toString().trim().split("\n").map(l => l.split(",").map(Number));
  const out = []; let prev = false;
  for (const [t, y] of rows) { const on = y > 128; if (on && !prev && t > 1) out.push(t); prev = on; }
  return out;
}
function beeps(file) {
  // 時刻の飛び（無音で録音が途切れたところ）は aresample で無音を詰めて、ファイルの時刻どおりに並べる
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const s = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), out = [], win = 40;
  let on = false;
  for (let i = 0; i + win < s.length; i += win) {
    let e = 0; for (let k = 0; k < win; k++) e += s[i + k] * s[i + k];
    const loud = Math.sqrt(e / win) > 0.05;
    if (loud && !on) { let k = i; while (k < i + win && Math.abs(s[k]) < 0.05) k++; out.push(k / 8000); }
    on = loud;
  }
  return out;
}
const gaps = (file) => {
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]).toString().trim().split("\n").map(Number);
  let n = 0; for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 0.1) n++;
  return n;
};
const duration = (file, sel) => Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", sel, "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", file]).toString().trim().split("\n").map(l => l.split(",").map(Number)).reduce((m, [p, d]) => Math.max(m, p + (d || 0)), 0).toFixed(2));
function compare(label, a, b, unit = "音−映像") {
  const n = Math.min(a.length, b.length), d = [];
  for (let i = 0; i < n; i++) d.push(Math.round((b[i] - a[i]) * 1000));
  if (!n) { console.log(`${label}：比べられるものがありません（光 ${a.length}・音 ${b.length}）`); return { ok: false }; }
  const drift = d.at(-1) - d[0], worst = Math.max(...d.map(Math.abs));
  const ok = a.length === b.length && worst <= LIMIT_MS && Math.abs(drift) <= DRIFT_MS;
  console.log(`${ok ? "OK " : "NG "} ${label}：${n}回　${unit} 最初 ${d[0]}ms・最後 ${d.at(-1)}ms・最大 ${worst}ms・最初→最後 ${drift >= 0 ? "+" : ""}${drift}ms`);
  return { ok };
}

const dir = KEEP ?? await fs.mkdtemp(path.join(os.tmpdir(), "recsync-"));
await fs.mkdir(dir, { recursive: true });
const srv = http.createServer((_q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(PAGE); });
await new Promise(r => srv.listen(0, "127.0.0.1", r));
console.log(`録画 ${SECS} 秒（${HEADED ? "画面あり" : "headless"}・${STILL ? "静止" : "動きあり"}）… 時刻の補正 ${CLOCK_OK ? "あり" : "なし（Playwright の版が想定と違う）"}`);
const browser = await chromium.launch({ headless: !HEADED, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
const audio = await prepareAudio(ctx, dir);
const page = await ctx.newPage();
let jobFile = null;
const r = trackRecording(page, audio, { dir, base: "recsync", log: (...a) => console.log(" ", ...a), onDone: (job) => { jobFile = job; } });
await page.goto(`http://127.0.0.1:${srv.address().port}/`);
await page.waitForTimeout(SECS * 1000);
const wall = await page.evaluate(() => window.beeps);
const vstart = await r.start();
await stopRecording(page);
await r.done;
const merged = await finishJob(jobFile);
await browser.close(); srv.close();

const base = merged.replace(/\.webm$/, "");
const files = { merged, video: base + ".video.webm", audio: base + ".audio.webm" };
for (const [k, f] of Object.entries(files)) console.log(`  ${k.padEnd(6)} ${path.basename(f)}  ${await fs.stat(f).then(s => `${(s.size / 1048576).toFixed(1)}MB`, () => "（ありません）")}`);
console.log(`  長さ：映像 ${duration(files.video, "v:0")}秒・音 ${duration(files.audio, "a:0")}秒（録った時間 ${SECS}秒）　音の途切れ ${gaps(files.audio)}か所`);
const results = [
  compare("合成した動画", flashes(merged), beeps(merged)),
  compare("映像だけ＋音だけ", flashes(files.video), beeps(files.audio)),
];
if (vstart) results.push(compare("プレイログの時刻", wall.map(t => (t - vstart) / 1000), flashes(files.video), "映像−ログ"));
else console.log("（動画の時刻ゼロが分からないので、プレイログの時刻は測りません）");
if (!KEEP) await fs.rm(dir, { recursive: true, force: true });
else console.log(`録画：${dir}`);
const ok = results.every(x => x.ok);
console.log(ok ? "合格" : "不合格");
process.exit(ok ? 0 : 1);
