/* 録画の映像を実際の時刻どおりに並べる（Playwright の recordVideo の時間の伸びを直す）。
 *
 * Playwright の録画は、ブラウザから届いた画面（コマ）を 25fps の動画に詰める。届くコマの間隔はまちまちで
 * （動きがあると 1/60 秒ごと、静かなときは何秒も来ない）、Playwright は「前のコマからの時間 × 25 を四捨五入、
 * ただし最低1コマ」だけ前のコマを繰り返す。この丸めの誤差が積み重なり、動きの多い場面ほど映像が実際より長くなる。
 * テスト用ページで 60 秒録ると映像は 68 秒になり、時間どおりに録れている音が 1 分で 7.5 秒先に進んだ（rec-sync-test.mjs）。
 *
 * ここでは書き込みを差し替え、「動画の n コマ目＝時刻ゼロ + n/25 秒にいちばん近いコマ」になるよう、
 * 足りなければ繰り返し、進みすぎなら捨てる。コマの時刻はブラウザが画面を出した時刻（frameSwapWallTime、
 * Date.now() と同じ時計）なので、動画の時刻ゼロも実際の時刻で分かる。時刻ゼロは server.mjs が録音の開始時刻に
 * そろえる（setStart）。そろえる相手がないときは最初のコマを時刻ゼロにする。
 *
 * Playwright の中身（lib/server/chromium/videoRecorder.js）に手を入れるので、package.json で版を固定している
 * （1.56.1）。形が合わなければ（メソッドと、使う内部フィールドの両方を確かめる）何もせず false を返す。録画ごとにも
 * 起動後に形を確かめ、合わなければその録画は Playwright のままにする（どちらの場合も音は少しずつずれる）。 */
import { createRequire } from "node:module";
import path from "node:path";

const FPS = 25;
const WAIT_START_MS = 10000;    // 時刻ゼロの知らせがこれだけ来なければ、最初のコマを時刻ゼロにする
const recorders = new Map();    // 出力ファイル → 録画中の VideoRecorder
const pending = new Map();      // 録画が始まる前に届いた時刻ゼロ（出力ファイル → ミリ秒 | null）
const waiters = new Map();      // 出力ファイル → 時刻ゼロが決まるのを待つ関数の一覧
const starts = new Map();       // 出力ファイル → 決まった時刻ゼロ（ミリ秒）と数字（録画が終わってからも引けるように残す）
let installed = null;

const key = (f) => path.resolve(f);
function decided(rec) {
  starts.set(rec._fwFile, { ms: rec._fwStart * 1000, stats: rec._fwStats });
  for (const w of waiters.get(rec._fwFile) ?? []) w(rec._fwStart * 1000);
  waiters.delete(rec._fwFile);
}

export function installVideoClock() {
  if (installed !== null) return installed;
  installed = false;
  let VideoRecorder;
  try {
    const require = createRequire(import.meta.url);
    const core = path.dirname(require.resolve("playwright-core/package.json"));
    ({ VideoRecorder } = require(path.join(core, "lib", "server", "chromium", "videoRecorder.js")));
  } catch { return false; }
  const P = VideoRecorder?.prototype;
  if (!P || ["_launch", "writeFrame", "stop", "_sendFrames"].some(m => typeof P[m] !== "function")) return false;
  // 差し替えたあとで触る内部のフィールドも、クラスの中身にあるか確かめる（版が変わって中身が違えば差し替えない）
  const FIELDS = ["_frameQueue", "_lastWritePromise", "_lastFrameBuffer", "_lastFrameTimestamp", "_isStopped", "_process", "_gracefullyClose"];
  let src = "";
  try { src = Function.prototype.toString.call(VideoRecorder); } catch {}
  if (FIELDS.some(f => !src.includes(f))) return false;
  const launch = P._launch, origWrite = P.writeFrame, origStop = P.stop;
  // 録画ごとにも、起動したあとで実際の形を確かめる。合わなければその録画は Playwright のまま（以前のやり方）にする
  const shapeOk = (r) => Array.isArray(r._frameQueue) && typeof r._lastWritePromise?.then === "function" && typeof r._gracefullyClose === "function" && !!r._process && typeof r._isStopped === "boolean";

  P._launch = async function (options) {
    this._fwFile = key(options.outputFile);
    this._fwStart = undefined;   // 時刻ゼロ（秒、Date.now()/1000 と同じ時計）。null＝最初のコマに合わせる
    this._fwCount = 0;           // ffmpeg に送ったコマ数
    this._fwFirst = undefined;   // 最初に届いたコマの時刻
    this._fwStats = { frames: 0, dup: 0, drop: 0 };
    recorders.set(this._fwFile, this);
    if (pending.has(this._fwFile)) { setStartOn(this, pending.get(this._fwFile)); pending.delete(this._fwFile); }
    const r = await launch.call(this, options);
    if (!shapeOk(this)) { this._fwOff = true; recorders.delete(this._fwFile); this._fwStats = null; }
    return r;
  };

  P.writeFrame = function (frame, timestamp) {
    if (this._fwOff || !this._fwStats) return origWrite.call(this, frame, timestamp);
    if (this._isStopped || !this._process) return;
    if (!Number.isFinite(timestamp)) timestamp = Date.now() / 1000;
    this._fwStats.frames++;
    this._fwFirst ??= timestamp;
    if (this._fwStart === undefined && (timestamp - this._fwFirst) * 1000 >= WAIT_START_MS) setStartOn(this, null);
    if (this._fwStart === undefined || this._fwStart === null) {
      // 時刻ゼロ待ち：いちばん新しいコマだけ持っておく
      if (this._fwStart === null) { this._fwStart = this._fwFirst; decided(this); }
      else { this._lastFrameBuffer = frame; this._lastFrameTimestamp = timestamp; return; }
    }
    // このコマが始まるべきコマ番号まで、手持ちのコマで埋める
    const target = Math.round((timestamp - this._fwStart) * FPS);
    let n = target - this._fwCount;
    const fill = this._lastFrameBuffer ?? frame; // 時刻ゼロより後に最初のコマが来たら、それで頭を埋める
    if (n > 0 && fill.length) {
      if (n > 1) this._fwStats.dup += n - 1;
      for (let i = 0; i < n; i++) this._frameQueue.push(fill);
      this._fwCount += n;
      this._lastWritePromise = this._lastWritePromise.then(() => this._sendFrames());
    } else if (this._lastFrameBuffer) this._fwStats.drop++; // 同じコマ番号に2枚目が来た：前のを捨てる
    this._lastFrameBuffer = frame;
    this._lastFrameTimestamp = timestamp;
  };

  P.stop = async function () {
    if (this._fwOff || !this._fwStats) return origStop.call(this);
    if (this._isStopped) return;
    if (this._fwStart === undefined) setStartOn(this, null);
    if (this._fwStart === null && this._fwFirst !== undefined) { this._fwStart = this._fwFirst; decided(this); }
    // 止めた時刻まで最後のコマを伸ばす（空のコマは書かれない）
    if (this._fwStart != null) this.writeFrame(Buffer.alloc(0), Date.now() / 1000);
    this._isStopped = true;
    recorders.delete(this._fwFile);
    await this._lastWritePromise;
    await this._gracefullyClose();
  };

  installed = true;
  return true;
}

function setStartOn(rec, ms) {
  if (rec._fwStart !== undefined && rec._fwStart !== null) return; // 一度決めたら変えない
  rec._fwStart = ms == null ? null : ms / 1000;
  if (rec._fwStart !== null) decided(rec);
}

/* 動画の時刻ゼロを決める。ms＝Date.now() の時刻、null＝最初のコマに合わせる。録画が始まる前に呼んでもよい */
export function setStart(file, ms) {
  const rec = recorders.get(key(file));
  if (rec) setStartOn(rec, ms);
  else if (!pending.has(key(file))) pending.set(key(file), ms);
}

/* 動画の時刻ゼロ（Date.now() のミリ秒）。決まるまで待つ（timeoutMs を過ぎたら null） */
export function videoStart(file, timeoutMs = 15000) {
  const done = starts.get(key(file));
  if (done) return Promise.resolve(done.ms);
  return new Promise((ok) => {
    const k = key(file), list = waiters.get(k) ?? [];
    const t = setTimeout(() => ok(null), timeoutMs);
    list.push((ms) => { clearTimeout(t); ok(ms); });
    waiters.set(k, list);
  });
}

/* 録画の数字（届いたコマ・繰り返したコマ・捨てたコマ）。確かめるためのもの */
export function videoStats(file) { return recorders.get(key(file))?._fwStats ?? starts.get(key(file))?.stats ?? null; }
