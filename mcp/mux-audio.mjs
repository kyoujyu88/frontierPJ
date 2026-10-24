#!/usr/bin/env node
/* 録画（映像だけの .webm）に、別に録ったゲームの音を重ねて仕上げる。
 *
 * server.mjs は録画を始めるとき、録画フォルダに覚え書き .rec-*.json（映像・音のファイル名、音の開始の遅れ）を置く。
 *   node mux-audio.mjs <覚え書き.json>   … 1本を仕上げる（server.mjs が最後に切り離して起動する）
 *   node mux-audio.mjs --sweep <録画フォルダ> … 仕上がっていない録画を全部仕上げる
 * Windows では MCP クライアントの終了時にサーバーがその場で強制終了されることがあり、そのときは覚え書きが残る。
 * 操作盤（control.mjs）は試行のたびに、server.mjs は起動するたびに、残った覚え書きを仕上げる（sweep）。
 *
 * ストリームをコピーするだけなので、Playwright 付属の小さな ffmpeg でできる。失敗したら映像だけの動画を残す。
 * 失敗の理由は録画フォルダの .mux-audio.log に書く。 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const exists = (f) => fs.stat(f).then(() => true, () => false);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function log(dir, msg) {
  await fs.appendFile(path.join(dir, ".mux-audio.log"), `${new Date().toLocaleString("sv-SE")} ${msg}\n`).catch(() => {});
}
export async function ffmpegPath() {
  try { return (await import("playwright-core/lib/server/registry/index")).registry.findExecutable("ffmpeg").executablePath(); } catch { return null; }
}
// 書き込み中（大きさが変わっている）なら落ち着くまで待つ
async function settle(f) {
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const size = await fs.stat(f).then(s => s.size, () => -1);
    if (size === last) return;
    last = size; await sleep(500);
  }
}
async function retry(fn) {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 9) throw e; await sleep(1000); } }
}
const uniqueName = async (dir, base) => {
  let dst = path.join(dir, base + ".webm");
  for (let i = 2; await exists(dst); i++) dst = path.join(dir, `${base}-${i}.webm`);
  return dst;
};

/* 1本を仕上げる。覚え書きの名前を変えて「受け持ち」にするので、同時に動いても二重には処理しない。仕上げた動画のパスを返す */
export async function finishJob(job) {
  const dir = path.dirname(job), work = job + ".work";
  try { await fs.rename(job, work); } catch { return null; }
  let j;
  try { j = JSON.parse(await fs.readFile(work, "utf8")); } catch (e) { await log(dir, `覚え書きを読めません ${path.basename(job)}: ${e.message}`); await fs.rm(work, { force: true }); return null; }
  let video = j.dst;
  try {
    if (!video || !(await exists(video))) {
      // サーバーが名前を付け直す前に止まった：Playwright が付けた名前のまま残っている
      if (!(await exists(j.src))) { await log(dir, `動画が見つかりません ${j.src}`); return null; }
      await settle(j.src);
      video = await uniqueName(dir, j.base);
      await retry(() => fs.rename(j.src, video));
    }
    const size = j.audio ? await fs.stat(j.audio).then(s => s.size, () => 0) : 0;
    if (!size) { if (j.audio) await log(dir, `${path.basename(video)}：音のデータがありません（ゲームの音が一度も鳴らなかった）`); return video; }
    await settle(j.audio);
    const ff = await ffmpegPath();
    if (!ff) { await log(dir, "ffmpeg が見つかりません（npx playwright install chromium）。音なしで残します"); return video; }
    // 動画のコマは実際の画面より約0.2秒遅れて記録されるので、音もその分遅らせる（実測）
    const offset = (Math.max(0, (j.start ?? j.t0) - j.t0 + 200) / 1000).toFixed(3);
    const tmp = video.replace(/\.webm$/, "") + ".mux.webm";
    let errText = "";
    const code = await new Promise((ok) => {
      const p = spawn(ff, ["-y", "-loglevel", "error", "-i", video, "-itsoffset", offset, "-i", j.audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", tmp], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      p.stderr.on("data", d => { errText += d; });
      p.on("error", e => { errText += e.message; ok(-1); }); p.on("exit", ok);
    });
    if (code !== 0) { await log(dir, `${path.basename(video)}：音を重ねられませんでした（ffmpeg ${code}）${errText.trim().slice(0, 500)}`); await fs.rm(tmp, { force: true }).catch(() => {}); return video; }
    // 再生中などでつかまれていたら少し待ってやり直す
    try { await retry(() => fs.rename(tmp, video)); }
    catch (e) { await log(dir, `${path.basename(video)}：音つきの動画に置き換えられません（${e.message}）。${path.basename(tmp)} に残します`); return video; }
    return video;
  } catch (e) {
    await log(dir, `${path.basename(video || j.src)}：${e.message}`);
    return video ?? null;
  } finally {
    if (j.audio) await fs.rm(j.audio, { force: true }).catch(() => {});
    await fs.rm(work, { force: true }).catch(() => {});
  }
}

/* 録画したサーバーがもう動いていない覚え書きを全部仕上げる。waitMs のあいだは、まだ動いている（止められている途中の）ものを待つ */
export async function sweep(dir, waitMs = 0) {
  const done = [], until = Date.now() + waitMs;
  for (;;) {
    let files, waiting = 0;
    try { files = (await fs.readdir(dir)).filter(f => /^\.rec-.*\.json$/.test(f)).sort(); } catch { return done; }
    for (const f of files) {
      const job = path.join(dir, f);
      try {
        const j = JSON.parse(await fs.readFile(job, "utf8"));
        if (j.pid !== process.pid && alive(j.pid)) { waiting++; continue; }
      } catch { continue; }
      const v = await finishJob(job);
      if (v) done.push(v);
    }
    if (!waiting || Date.now() >= until) return done;
    await sleep(3000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [a, b] = process.argv.slice(2);
  if (a === "--sweep") { for (const v of await sweep(path.resolve(b), 60000)) console.log(v); }
  else if (a) await finishJob(path.resolve(a));
  else console.error(`使い方: node ${path.basename(fileURLToPath(import.meta.url))} <覚え書き.json> | --sweep <録画フォルダ>`);
}
