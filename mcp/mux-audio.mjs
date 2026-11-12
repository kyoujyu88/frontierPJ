#!/usr/bin/env node
/* 録画の仕上げ：映像だけの動画と、別に録ったゲームの音を合成する（録画のしくみは recorder.mjs）。
 *
 * server.mjs は録画を始めるとき、録画フォルダに覚え書き .rec-*.json（映像・音のファイル名、音の開始の遅れ）を置く。
 *   node mux-audio.mjs <覚え書き.json>   … 1本を仕上げる（server.mjs が最後に切り離して起動する）
 *   node mux-audio.mjs --sweep <録画フォルダ> … 仕上がっていない録画を全部仕上げる
 * Windows では MCP クライアントの終了時にサーバーがその場で強制終了されることがあり、そのときは覚え書きが残る。
 * 操作盤（control.mjs）は試行のたびに、server.mjs は起動するたびに、残った覚え書きを仕上げる（sweep）。
 *
 * 出来上がるもの（音が無ければ <名前>.webm だけ）
 *   <名前>.webm        映像と音を合成したもの
 *   <名前>.video.webm  映像だけ
 *   <名前>.audio.webm  音だけ（Opus）
 * ストリームをコピーするだけなので、Playwright 付属の小さな ffmpeg でできる。合成に失敗したら映像だけを <名前>.webm にする。
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
/* 同じ名前の録画（合成・映像だけ・音だけのどれか）がもうあれば -2, -3 … を付けた名前にする（拡張子なしで返す） */
export async function freeStem(dir, base) {
  const taken = async (b) => (await Promise.all([".webm", ".video.webm", ".audio.webm", ".mux.webm"].map(x => exists(path.join(dir, b + x))))).some(Boolean);
  let stem = base;
  for (let i = 2; await taken(stem); i++) stem = `${base}-${i}`;
  return stem;
}
const uniqueName = async (dir, base) => path.join(dir, (await freeStem(dir, base)) + ".webm");

function ffmpegRun(ff, args) {
  return new Promise((ok) => {
    let errText = "";
    const p = spawn(ff, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    p.stderr.on("data", d => { errText += d; });
    p.on("error", e => { errText += e.message; ok({ code: -1, errText }); }); p.on("exit", code => ok({ code, errText }));
  });
}

/* 1本を仕上げる。覚え書きの名前を変えて「受け持ち」にするので、同時に動いても二重には処理しない。仕上げた動画のパスを返す */
export async function finishJob(job) {
  const dir = path.dirname(job), work = job + ".work";
  try { await fs.rename(job, work); } catch { return null; }
  let j;
  try { j = JSON.parse(await fs.readFile(work, "utf8")); } catch (e) { await log(dir, `覚え書きを読めません ${path.basename(job)}: ${e.message}`); await fs.rm(work, { force: true }); return null; }
  if (j.v === 2) return finishJob2(dir, work, j);
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

/* 覚え書き（新しい形、v: 2）：映像だけ（video）・音だけ（audio）・合成（dst）の3つに分けて残す。
 * offset は音の0秒が映像の何秒目にあたるか。録音の開始を動画の時刻ゼロにしているので、ふつうは 0 */
async function finishJob2(dir, work, j) {
  let video = j.video, dst = j.dst, done = null;
  try {
    if (!video || !(await exists(video))) {
      // サーバーが名前を付け直す前に止まった：Playwright が付けた名前のまま残っている
      if (!j.src || !(await exists(j.src))) { await log(dir, `動画が見つかりません ${j.src}`); return null; }
      await settle(j.src);
      const stem = await freeStem(dir, j.base);
      video = path.join(dir, stem + ".video.webm"); dst = path.join(dir, stem + ".webm");
      await retry(() => fs.rename(j.src, video));
    }
    const stem = dst.replace(/\.webm$/, "");
    const size = j.audio ? await fs.stat(j.audio).then(s => s.size, () => 0) : 0;
    if (!size) {
      if (j.audio) await log(dir, `${path.basename(dst)}：音のデータがありません。映像だけで残します`);
      await retry(() => fs.rename(video, dst)); return (done = dst);
    }
    await settle(j.audio);
    const audioOut = stem + ".audio.webm";
    await retry(() => fs.rename(j.audio, audioOut));
    const ff = await ffmpegPath();
    if (!ff) { await log(dir, "ffmpeg が見つかりません（npx playwright install chromium）。合成せず、映像と音を別々に残します"); await fs.copyFile(video, dst); return (done = dst); }
    const offset = Number.isFinite(j.offset) ? j.offset : Math.max(0, (j.start ?? j.t0) - j.t0 + 200) / 1000;
    const tmp = stem + ".mux.webm";
    const a = ["-i", video, ...(offset > 0.0005 ? ["-itsoffset", offset.toFixed(3)] : []), "-i", audioOut, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", tmp];
    const { code, errText } = await ffmpegRun(ff, a);
    if (code !== 0) {
      await log(dir, `${path.basename(dst)}：合成できませんでした（ffmpeg ${code}）${errText.trim().slice(0, 500)}。映像だけを ${path.basename(dst)} にします`);
      await fs.rm(tmp, { force: true }).catch(() => {});
      await fs.copyFile(video, dst); return (done = dst);
    }
    try { await retry(() => fs.rename(tmp, dst)); }
    catch (e) { await log(dir, `${path.basename(dst)}：合成した動画の名前を付けられません（${e.message}）。${path.basename(tmp)} に残します`); return (done = video); }
    return (done = dst);
  } catch (e) {
    await log(dir, `${path.basename(dst || video || j.src || "")}：${e.message}`);
    return done ?? video ?? null;
  } finally {
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
