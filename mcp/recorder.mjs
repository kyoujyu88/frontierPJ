/* 録画（server.mjs が使う。rec-sync-test.mjs も同じものを使って音と映像のずれを測る）
 *
 * 映像：Playwright の recordVideo（WebM VP8・25fps・音なし）。コマの並べ方は video-clock.mjs で実際の時刻どおりに直す。
 * 音  ：ゲームの音はすべて1つの AudioContext から出力（destination）へつながる。ページができた直後に録音用の
 *       AudioContext を作っておき、ゲームが最初に new AudioContext() したときにそれを渡す。destination への connect を
 *       横取りして MediaStreamDestination にも流し、ページ内の MediaRecorder（Opus）で録って exposeBinding で受け取る。
 *       ゲームが音を出す前（タイトル画面）から録り始めるので、音のファイルは映像とほぼ同じ時刻から始まる。
 * 時刻：録音が始まった時刻を動画の時刻ゼロにする（video-clock.mjs の setStart）。音の0秒＝映像の0秒になり、
 *       合成するときに音をずらす必要がない。
 *
 * 仕上げ（名前の付け直しと合成）は mux-audio.mjs に切り離して任せる。録画フォルダの覚え書き .rec-*.json に必要なことを
 * 書いておくので、途中でサーバーが強制終了されても（Windows では MCP クライアントの終了から2秒で止められる）、
 * 操作盤か次に起動したサーバーが仕上げる。出来上がるのは次の3つ（音が一度も鳴らなければ <名前>.webm だけ）。
 *   <名前>.webm        映像と音を合成したもの（ふだん見るのはこれ）
 *   <名前>.video.webm  映像だけ
 *   <名前>.audio.webm  音だけ（Opus）。0秒が映像の0秒と同じ時刻 */
import fs from "node:fs/promises";
import path from "node:path";
import { installVideoClock, setStart, videoStart, videoStats } from "./video-clock.mjs";
import { freeStem } from "./mux-audio.mjs";

export const CLOCK_OK = installVideoClock();
export const OLD_LAG_MS = 200; // 時刻の補正がないときの、映像のコマ遅れの目安（以前の実測）

export const AUDIO_TAP = `(() => {
  if (window.top !== window || window.__fwTapped || !/^(https?|file):$/.test(location.protocol)) return;
  const AC = window.AudioContext;
  if (!AC || !window.MediaRecorder || !window.__fwAudio) return;
  window.__fwTapped = true;
  let ctx0;
  try { ctx0 = new AC(); } catch (e) { return; }
  const dest0 = ctx0.createMediaStreamDestination();
  // 何も鳴っていないあいだ録音が途切れて時刻が飛ぶ（再生ソフトによっては詰めてしまい、ずれる）のを防ぐ、聞こえない音
  try { const k = ctx0.createConstantSource(); k.offset.value = 1e-6; k.connect(dest0); k.start(); } catch (e) {}
  let given = false;
  window.AudioContext = new Proxy(AC, { construct(t, args, nt) {
    if (!given && !(args[0] && args[0].sampleRate) && ctx0.state !== "closed") { given = true; return ctx0; }
    return Reflect.construct(t, args, nt);
  } });
  if (window.webkitAudioContext === AC) window.webkitAudioContext = window.AudioContext;
  const orig = AudioNode.prototype.connect;
  let rec = null, queue = Promise.resolve(), stopped = false;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    if (!stopped && dest instanceof AudioDestinationNode && dest.context === ctx0) { try { orig.call(this, dest0); } catch (e) {} }
    return r;
  };
  const send = (b) => { const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return window.__fwAudio("data", btoa(s)); };
  // 録るのは1ページにつき最初の文書だけ（読み込み直しで2本目が同じファイルに混ざらないように、サーバーに聞く）
  Promise.resolve(window.__fwAudio("hello", location.href)).then((ok) => {
    if (!ok || stopped) return;
    rec = new MediaRecorder(dest0.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
    // 録音の0秒は start() を呼んだ時刻（onstart が届くのはそれより約50ミリ秒あと。実測）
    let t1 = 0;
    rec.onstart = () => { window.__fwAudio("start", String(t1)); };
    rec.ondataavailable = (e) => { if (e.data.size) queue = queue.then(() => e.data.arrayBuffer()).then(send).catch(() => {}); };
    t1 = Date.now(); rec.start(1000);
  }).catch(() => {});
  window.__fwRecStop = () => new Promise((res) => {
    stopped = true;
    if (!rec || rec.state === "inactive") return queue.then(res);
    rec.onstop = () => setTimeout(() => queue.then(res), 50);
    rec.stop();
  });
})();`;

/* newPage の前に呼ぶ。録音を受け取る口とページに入れるスクリプトを用意する */
export async function prepareAudio(ctx, dir) {
  const a = { start: null, file: path.join(dir, `.audio-${process.pid}-${Date.now()}.webm`), out: null, bytes: 0, claimed: false, onStart: null, writing: Promise.resolve() };
  await ctx.exposeBinding("__fwAudio", async (_src, kind, data) => {
    if (kind === "hello") { if (a.claimed) return false; a.claimed = true; return true; }
    if (kind === "start") { a.start = Number(data); a.onStart?.(a.start); return; }
    const b = Buffer.from(data, "base64");
    a.writing = a.writing.then(async () => { a.out ??= await fs.open(a.file, "w"); await a.out.write(b); a.bytes += b.length; });
    await a.writing;
  });
  await ctx.addInitScript(AUDIO_TAP);
  a.t0 = Date.now(); // 時刻の補正がないとき用：動画はページを作ったときから始まる
  return a;
}

/* ページの録画を見張る。ページが閉じたら映像を <名前>.video.webm にして、仕上げ（mux-audio.mjs）を頼む。
 * 戻り値：{ job: 覚え書きのパス, done: 合成後の動画のパス（<名前>.webm）を返す Promise, start(): 動画の時刻ゼロ } */
export function trackRecording(pg, audio, { dir, base, index = 1, log = () => {}, onDone = () => {} }) {
  const v = pg.video();
  if (!v) return null;
  const job = path.join(dir, `.rec-${process.pid}-${index}.json`);
  const info = { v: 2, pid: process.pid, base, src: null, video: null, dst: null, audio: audio?.file ?? null, t0: audio?.t0 ?? Date.now(), start: null, vstart: null, offset: null };
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => fs.writeFile(job, JSON.stringify(info))).catch(e => log("録画の覚え書き：", e.message)));
  const offset = () => {
    if (info.start == null) return null;
    if (info.vstart != null) return Math.max(0, info.start - info.vstart) / 1000; // ふつうは 0（録音の開始を動画の時刻ゼロにした）
    return Math.max(0, info.start - info.t0 + OLD_LAG_MS) / 1000;                   // 補正がないとき（以前のやり方）
  };
  save();
  const srcP = v.path();
  srcP.then(p => {
    info.src = p; save();
    if (!CLOCK_OK) return;
    if (!audio) setStart(p, null);              // 音を録らないなら最初のコマが時刻ゼロ
    else if (info.start != null) setStart(p, info.start);
    videoStart(p).then(ms => { info.vstart = ms; info.offset = offset(); save(); });
  }, () => {});
  if (audio) audio.onStart = (t) => { info.start = t; info.offset = offset(); save(); if (info.src && CLOCK_OK) setStart(info.src, t); };
  const ctx = pg.context(), ctxClosed = new Promise(r => ctx.once("close", r));
  const done = new Promise(r => pg.once("close", r)).then(async () => {
    // コンテキストが閉じ終わると動画が書き終わる（閉じる途中で close() をもう一度呼んでもすぐ返るので、close イベントを待つ）
    ctx.close().catch(() => {});
    await ctxClosed;
    const src = await srcP;
    await audio?.writing; await audio?.out?.close().catch(() => {});
    const stem = await freeStem(dir, base);
    info.video = path.join(dir, stem + ".video.webm");
    info.dst = path.join(dir, stem + ".webm");
    await fs.rename(src, info.video);
    info.src = src; info.offset = offset();
    const st = CLOCK_OK && videoStats(src);
    if (st) log(`録画のコマ：届いた ${st.frames}・繰り返し ${st.dup}・捨てた ${st.drop}（時刻どおりに並べ直し済み）`);
    if (!CLOCK_OK) log("録画の時刻の補正が使えません（Playwright の版が想定と違う）。長い録画では音が少しずつずれます");
    await save();
    onDone(job, info);
    return info.dst;
  }).catch(e => { log("recording failed:", e.message); return null; });
  return { job, info, done, start: async () => { const p = await srcP.catch(() => null); return p && CLOCK_OK ? videoStart(p, 5000) : null; } };
}

/* 録音を止めて最後の音のかけらを受け取ってから、コンテキストを閉じる */
export async function stopRecording(page) {
  try { await Promise.race([page?.evaluate(() => window.__fwRecStop?.()), new Promise(r => setTimeout(r, 800))]); } catch {}
  try { await page?.context().close(); } catch {}
}
