#!/usr/bin/env node
/* AIプレイの操作画面：ブラウザで開く「連続プレイと録画」のコントロールパネル
 *
 * ai-player.mjs を1試行（1ゲーム）ずつ子プロセスで起動し、指定した回数だけ続けて遊ばせる。
 * 試行ごとに新しいゲームになり、反省メモ（notes/<名前>.md）は毎回読み直すので、前の試行の反省が次に効く。
 * 録画をオンにすると、server.mjs の --record で試行ごとに1本の動画（recordings/*.webm）を残す。
 *
 *   「操作盤を開く.cmd」をダブルクリック … 初回の準備（launch.mjs）をしてから、窓なしでこれを起動する
 *   node control.mjs              … http://127.0.0.1:3940 を開く（既定のブラウザが自動で開く）
 *   node control.mjs --port 3941  … ポートを変える
 *   node control.mjs --no-open    … ブラウザを自動で開かない
 *   node control.mjs --stay       … タブを全部閉じても終わらない（既定は、閉じてプレイもしていなければ90秒で終わる）
 *
 * 画面はこのPCからだけ開ける（127.0.0.1 で待ち受け、Host ヘッダーも確かめる）。
 */
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadNotes, safeName } from "./notes.mjs";
import { sweep } from "./mux-audio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1] || 0) || 3940;
const OPEN = !argv.includes("--no-open");
const IS_WIN = process.platform === "win32";
const NOTES_DIR = path.join(HERE, "notes");
const SETTINGS_FILE = path.join(NOTES_DIR, ".control-settings.json");
const HISTORY_FILE = path.join(NOTES_DIR, ".control-history.json");

/* ---------- 設定 ---------- */
const DEFAULTS = {
  baseUrl: "http://127.0.0.1:11434/v1", model: "", name: "のあ", think: "none",
  trials: 3, turns: "", record: true, recordDir: "recordings", headless: false,
  notesMode: "grow", maxSteps: 40, reflectEvery: 10, temperature: 0.6, pace: 300, size: "1280x720", persona: "",
};
async function readJson(file, def) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return def; } }
async function writeJson(file, v) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(v, null, 1) + "\n"); }
let settings = { ...DEFAULTS, ...(await readJson(SETTINGS_FILE, {})) };
if (!settings.v) { if (settings.pace === 700) settings.pace = 300; settings.v = 2; } // 演出の間の既定を 700→300 に変えたので、前の既定のままなら合わせる
let history = await readJson(HISTORY_FILE, []); // 試行の記録（新しい順、最大300件）

function clean(input) {
  const s = { ...settings, ...input };
  const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  s.baseUrl = String(s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/$/, "");
  s.model = String(s.model || "").trim();
  s.name = String(s.name || "").trim() || "のあ";
  s.think = ["none", "low", "medium", "high"].includes(s.think) ? s.think : "";
  s.trials = int(s.trials, 1, 999, 3);
  s.turns = s.turns === "" || s.turns == null ? "" : int(s.turns, 1, 999, "");
  s.record = !!s.record; s.headless = !!s.headless;
  s.recordDir = String(s.recordDir || "").trim() || "recordings";
  s.notesMode = ["grow", "readonly", "off"].includes(s.notesMode) ? s.notesMode : "grow";
  s.maxSteps = int(s.maxSteps, 5, 200, 40);
  s.reflectEvery = int(s.reflectEvery, 0, 999, 10);
  s.temperature = Number.isFinite(Number(s.temperature)) ? Math.min(2, Math.max(0, Number(s.temperature))) : 0.6;
  s.pace = int(s.pace, 0, 5000, 300);
  s.size = /^\d{3,4}x\d{3,4}$/.test(s.size) ? s.size : "1280x720";
  s.persona = String(s.persona || "").trim();
  return s;
}
const recordDir = () => path.resolve(HERE, settings.recordDir);

/* ---------- ログ（画面へは Server-Sent Events で流す） ---------- */
const logs = [];
const clients = new Set();
function push(ev) { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(data); }
function addLog(line, kind = "") {
  const item = { t: new Date().toLocaleTimeString("ja-JP"), line, kind };
  logs.push(item); if (logs.length > 800) logs.shift();
  push({ type: "log", ...item });
}
const sys = (line) => { addLog(line, "sys"); console.log(line); };

/* ---------- 連続プレイ ---------- */
const run = { running: false, stopAfter: false, trial: 0, total: 0, startedAt: null, child: null, current: null, check: false };
const status = () => ({ running: run.running, stopAfter: run.stopAfter, trial: run.trial, total: run.total, startedAt: run.startedAt, current: run.current, check: run.check });
const pushState = () => push({ type: "state", status: status() });

function playerArgs(s, n) {
  const a = [path.join(HERE, "ai-player.mjs"), "--base-url", s.baseUrl, "--model", s.model, "--name", s.name,
    "--max-steps", String(s.maxSteps), "--reflect-every", String(s.reflectEvery), "--temperature", String(s.temperature)];
  if (s.think) a.push("--think", s.think);
  if (s.turns) a.push("--turns", String(s.turns));
  if (s.persona) a.push("--persona", path.resolve(HERE, s.persona));
  if (s.notesMode === "readonly") a.push("--notes-readonly");
  if (s.notesMode === "off") a.push("--no-notes");
  a.push("--", "--pace", String(s.pace), "--size", s.size);
  if (s.headless) a.push("--headless");
  if (s.record) {
    const stamp = new Date().toLocaleString("sv-SE").replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
    a.push("--record", recordDir(), "--record-name", `${safeName(s.name)}_${stamp}_${n}of${run.total}`);
  }
  return a;
}

function runTrial(s, n) {
  return new Promise((resolve) => {
    const rec = { id: `${Date.now()}`, n, of: run.total, name: s.name, model: s.model, startedAt: new Date().toISOString(), endedAt: null,
      outcome: "プレイ中", turn: 0, funds: null, autoTurns: 0, failures: 0, video: null, note: "" };
    run.current = rec; pushState();
    const child = spawn(process.execPath, playerArgs(s, n), { cwd: HERE, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
    run.child = child; run.childStopping = false;
    let llmDown = false, llmWhy = "", over = null, stopped = false;
    const onLine = (line, err) => {
      if (!line.trim()) return;
      let m;
      if ((m = line.match(/=== ターン(\d+) 資金(-?\d+)/))) { rec.turn = Number(m[1]); rec.funds = Number(m[2]); pushState(); }
      else if ((m = line.match(/ゲーム終了：(win|lose)/))) over = m[1];
      else if (/自動進行に切り替えます/.test(line)) rec.autoTurns++;
      else if (/^\S*\s*✗ /.test(line.replace(/^[\d:]+\s+/, ""))) rec.failures++;
      else if ((m = line.match(/ローカルLLMに接続できないため止めます|LLMのエラーで止めます/))) { llmDown = true; llmWhy = m[0].startsWith("ローカル") ? "LLM接続エラー" : "LLMエラー"; }
      else if (/止めます。反省メモを書いてから/.test(line)) stopped = run.childStopping = true;
      else if ((m = line.match(/\[frontier-war-mcp\] recorded: (.+)$/))) { rec.video = path.basename(m[1].trim()); push({ type: "videos" }); }
      addLog(line, err ? "err" : /^[\d:]+\s+(→|  )/.test(line) ? "op" : "");
    };
    const lines = (stream, err) => { let buf = ""; stream.setEncoding("utf8"); stream.on("data", d => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(l => onLine(l, err)); }); stream.on("end", () => buf && onLine(buf, err)); };
    lines(child.stdout, false); lines(child.stderr, true);
    child.on("error", e => sys(`起動できませんでした：${e.message}`));
    // ゲームの窓（server.mjs）は ai-player より少し遅れて閉じ、そのとき録画が確定する。
    // server.mjs も同じ出力につながっているので、出力が全部閉じた（close）ところで締める。close が来なければ時間で打ち切る
    let done = false;
    const finish = async (code) => {
      if (done) return;
      done = true;
      rec.endedAt = new Date().toISOString();
      rec.outcome = over === "win" ? "勝利" : over === "lose" ? "敗北" : llmDown ? llmWhy : stopped || run.killed ? "停止" : code ? `エラー終了(${code})` : s.turns && rec.turn >= s.turns ? "ターン上限" : "途中終了";
      if (s.record) {
        // サーバーが仕上げる前に止められた録画（Windows で起きる）は、ここで名前を付け直して音を重ねる
        const fixed = await sweep(recordDir()).catch(() => []);
        if (fixed.length) sys(`録画を仕上げました：${fixed.map(f => path.basename(f)).join("、")}`);
        if (!rec.video) rec.video = fixed.length ? path.basename(fixed.at(-1)) : await latestVideo(Date.parse(rec.startedAt));
      }
      history.unshift(rec); history = history.slice(0, 300);
      await writeJson(HISTORY_FILE, history).catch(() => {});
      run.current = null;
      sys(`── 試行 ${n}/${run.total} 終了：${rec.outcome}（ターン${rec.turn}）${rec.video ? ` 録画 ${rec.video}` : ""}`);
      push({ type: "history" }); push({ type: "videos" });
      resolve({ llmDown, llmWhy, code });
    };
    child.on("exit", (code) => {
      run.child = null;
      setTimeout(() => finish(code), s.record ? 30000 : 5000);
    });
    child.on("close", (code) => finish(code));
  });
}

async function latestVideo(since) {
  try {
    const files = await fs.readdir(recordDir());
    let best = null;
    for (const f of files.filter(f => f.endsWith(".webm") && !f.startsWith(".") && !f.endsWith(".mux.webm"))) {
      const st = await fs.stat(path.join(recordDir(), f));
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs };
    }
    return best?.f ?? null;
  } catch { return null; }
}

async function startSeries(input) {
  if (run.running) throw new Error("いま実行中です");
  const s = clean(input);
  if (!s.model) throw new Error("モデルを指定してください");
  settings = s; await writeJson(SETTINGS_FILE, settings);
  Object.assign(run, { running: true, stopAfter: false, killed: false, trial: 0, total: s.trials, startedAt: new Date().toISOString() });
  sys(`連続プレイを始めます：${s.name}（${s.model}）× ${s.trials}回${s.turns ? `・1回${s.turns}ターンまで` : ""}${s.record ? "・録画あり" : ""}`);
  pushState();
  (async () => {
    for (let n = 1; n <= s.trials; n++) {
      run.trial = n; pushState();
      sys(`── 試行 ${n}/${s.trials} を始めます`);
      const r = await runTrial(s, n);
      if (r.llmDown) { sys(r.llmWhy === "LLM接続エラー" ? "ローカルLLMにつながらないので、連続プレイを止めました（URLとモデル名を確認してください）" : "LLMがエラーを返すので、連続プレイを止めました（ログの「エラー：」の行を確かめてください）"); break; }
      if (run.stopAfter || run.killed) break;
      if (n < s.trials) await new Promise(r => setTimeout(r, 2000));
    }
    sys(run.killed || run.stopAfter ? "連続プレイを止めました" : "連続プレイが終わりました");
    Object.assign(run, { running: false, stopAfter: false, child: null, current: null });
    pushState();
  })();
}

/* 停止：反省メモを書いてから止める（Windows ではシグナルを送れないので ai-player に IPC で伝える） */
function stopNow() {
  if (!run.running) return;
  run.stopAfter = true; run.killed = true;
  const c = run.child;
  if (!c) return pushState();
  sys("止めています。反省メモを書いてから終わります（1分ほどかかることがあります）");
  try { c.send({ type: "stop" }); } catch {}
  setTimeout(() => { if (run.child === c) { sys("止まらないので強制終了します"); c.kill(); } }, 3 * 60 * 1000).unref();
  pushState();
}
function kill() { if (run.child) { run.stopAfter = true; run.killed = true; sys("強制終了します（この試行の反省メモは書きません）"); run.child.kill(); pushState(); } }

/* ---------- 動作確認（LLMなし）：selftest.mjs を窓なし・演出なしで10ターン回す ---------- */
function runCheck() {
  if (run.running) throw new Error("いま実行中です");
  Object.assign(run, { running: true, check: true, stopAfter: false, killed: false, trial: 0, total: 0, startedAt: new Date().toISOString(), current: null });
  sys("動作確認を始めます（LLMは使いません。ゲームを窓なしで10ターン自動で遊びます。1〜2分）");
  pushState();
  const child = spawn(process.execPath, [path.join(HERE, "selftest.mjs")], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, TURNS: "10" } });
  run.child = child;
  for (const [stream, err] of [[child.stdout, false], [child.stderr, true]]) {
    let buf = ""; stream.setEncoding("utf8");
    stream.on("data", d => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.filter(l => l.trim()).forEach(l => addLog(l, err ? "err" : "op")); });
  }
  child.on("error", e => sys(`起動できませんでした：${e.message}`));
  child.on("exit", (code) => {
    sys(run.killed ? "動作確認を止めました" : code === 0 ? "動作確認：成功しました。ゲームとMCPサーバーは正しく動いています" : `動作確認：失敗しました（終了コード ${code}）。ログの赤字を確かめてください`);
    Object.assign(run, { running: false, check: false, child: null });
    pushState();
  });
}

/* ---------- フォルダやファイルを開く・デスクトップのショートカット ---------- */
function openPath(p) {
  const [cmd, args] = IS_WIN ? ["explorer.exe", [p]] : process.platform === "darwin" ? ["open", [p]] : ["xdg-open", [p]];
  spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: false }).on("error", () => {}).unref();
}
async function openThing(what) {
  if (what === "recordings") { await fs.mkdir(recordDir(), { recursive: true }); return openPath(recordDir()); }
  if (what === "notes") {
    const file = path.join(NOTES_DIR, `${safeName(settings.name)}.md`);
    if (await fs.stat(file).then(() => true, () => false)) {
      if (IS_WIN) return spawn("notepad.exe", [file], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      return openPath(file);
    }
    await fs.mkdir(NOTES_DIR, { recursive: true }); return openPath(NOTES_DIR);
  }
  if (what === "folder") return openPath(HERE);
  throw new Error("開けません");
}
function makeShortcut() {
  if (!IS_WIN) throw new Error("ショートカットは Windows だけで作れます");
  const target = path.join(HERE, "操作盤を開く.cmd").replace(/'/g, "''");
  const dir = HERE.replace(/'/g, "''");
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\AIプレイ操作盤.lnk');$s.TargetPath='${target}';$s.WorkingDirectory='${dir}';$s.WindowStyle=7;$s.Save()`;
  return new Promise((ok, ng) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
    p.on("error", ng); p.on("exit", c => c === 0 ? ok() : ng(new Error(`作れませんでした（${c}）`)));
  });
}
function quit() {
  sys("操作盤を終了します");
  if (run.child) { run.killed = true; run.child.kill(); }
  setTimeout(() => process.exit(0), 1500);
}

/* ---------- HTTP ---------- */
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(v)); };
async function body(req) { let b = ""; for await (const c of req) { b += c; if (b.length > 1e5) throw new Error("too large"); } return b ? JSON.parse(b) : {}; }

async function listPlayers() {
  try { return (await fs.readdir(NOTES_DIR)).filter(f => f.endsWith(".md")).map(f => f.slice(0, -3)); } catch { return []; }
}
async function listVideos() {
  try {
    const dir = recordDir(), out = [];
    for (const f of (await fs.readdir(dir)).filter(f => f.endsWith(".webm") && !f.startsWith(".") && !f.endsWith(".mux.webm"))) {
      const st = await fs.stat(path.join(dir, f)); out.push({ file: f, size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
async function sendVideo(req, res, file) {
  const p = path.join(recordDir(), path.basename(file));
  let st; try { st = await fs.stat(p); } catch { res.writeHead(404); return res.end(); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { "content-type": "video/webm", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(p, { start, end }).on("error", () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": st.size });
    createReadStream(p).on("error", () => res.destroy()).pipe(res);
  }
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = http.createServer(async (req, res) => {
  try {
    // 別のサイトからこの画面を操作されないように（DNSリバインディング・CSRF対策）
    if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end("forbidden"); }
    if (req.method === "POST" && !/^application\/json/.test(req.headers["content-type"] || "")) { res.writeHead(415); return res.end(); }
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    // 別のサイトのページからの読み込み（<img src="http://127.0.0.1:3940/api/models?…"> など）も断る。
    // この画面自身・アドレス欄・ほかのページのリンクから画面（/）を開くのは通す
    if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) && !(req.method === "GET" && p === "/" && req.headers["sec-fetch-mode"] === "navigate")) { res.writeHead(403); return res.end("forbidden"); }
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await fs.readFile(path.join(HERE, "control.html")));
    }
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", status: status(), logs: logs.slice(-300) })}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/state") return json(res, 200, { settings, status: status(), defaults: DEFAULTS, players: await listPlayers(), platform: process.platform, here: HERE });
    if (p === "/api/history") return json(res, 200, history);
    if (p === "/api/videos") return json(res, 200, { dir: recordDir(), videos: await listVideos() });
    if (p.startsWith("/videos/")) return sendVideo(req, res, decodeURIComponent(p.slice(8)));
    if (p === "/api/notes") {
      const name = url.searchParams.get("name") || settings.name;
      const file = path.join(NOTES_DIR, `${safeName(name)}.md`);
      return json(res, 200, { file, ...(await loadNotes(file)) });
    }
    if (p === "/api/models") {
      const base = String(url.searchParams.get("baseUrl") || settings.baseUrl).replace(/\/$/, "");
      if (!/^https?:\/\//.test(base)) return json(res, 400, { error: "URL は http:// か https:// で始めてください" });
      try {
        const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return json(res, 502, { error: `モデル一覧を取れませんでした（${r.status}）` });
        return json(res, 200, { models: ((await r.json()).data ?? []).map(m => m.id).sort() });
      } catch (e) { return json(res, 502, { error: `つながりません：${e.cause?.code || e.message}` }); }
    }
    if (req.method === "POST" && p === "/api/start") { await startSeries(await body(req)); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/settings") { settings = clean(await body(req)); await writeJson(SETTINGS_FILE, settings); return json(res, 200, { ok: true, settings }); }
    if (req.method === "POST" && p === "/api/stop-after") { if (run.running) { run.stopAfter = true; sys("この試行が終わったら止めます"); pushState(); } return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/stop") { if (run.check) kill(); else stopNow(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/kill") { kill(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/check") { runCheck(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/open") { await openThing((await body(req)).what); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/shortcut") { await makeShortcut(); sys("デスクトップに「AIプレイ操作盤」のショートカットを作りました"); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/quit") { json(res, 200, { ok: true }); return quit(); }
    if (req.method === "POST" && p === "/api/history/clear") { history = []; await writeJson(HISTORY_FILE, history); push({ type: "history" }); return json(res, 200, { ok: true }); }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 400, { error: e.message }); }
});
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20000).unref();

/* ブラウザのタブがすべて閉じられ、プレイも動作確認もしていない状態が続いたら自動で終わる
 *（裏で動き続けて mcp フォルダを掴んだままにならないように）。--stay で無効 */
const IDLE_MS = 90 * 1000;
let idleSince = Date.now();
if (!argv.includes("--stay")) setInterval(() => {
  if (clients.size || run.running) { idleSince = null; return; }
  idleSince ??= Date.now();
  if (Date.now() - idleSince >= IDLE_MS) { console.log("操作盤のタブが閉じられたので終了します"); process.exit(0); }
}, 5000).unref();

const URL_ = `http://127.0.0.1:${PORT}/`;
function openBrowser() {
  const [cmd, args] = IS_WIN ? ["cmd", ["/c", "start", "", URL_]] : process.platform === "darwin" ? ["open", [URL_]] : ["xdg-open", [URL_]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref(); } catch {}
}
server.on("error", async (e) => {
  if (e.code === "EADDRINUSE") {
    // もう操作盤が動いているなら、それを開くだけにする（ダブルクリックを2回しても大丈夫なように）
    const ours = await fetch(`${URL_}api/state`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
    if (ours) { console.log(`操作盤はもう動いています：${URL_}`); if (OPEN) openBrowser(); process.exit(0); }
    console.error(`ポート ${PORT} はほかのソフトが使っています。node control.mjs --port ${PORT + 1} で起動してください。`);
  } else console.error(e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`AIプレイの操作画面：${URL_}`);
  console.log("終了は画面右上の「終了」か、この窓で Ctrl+C。");
  if (OPEN) openBrowser();
});

/* Ctrl+C：プレイ中なら反省メモを書かせてから終わる。
 * Ctrl+C は同じ窓の ai-player にも届くので、まず向こうが止まり始めるのを待ち、届いていなければ合図を送る */
let quitting = false;
process.on("SIGINT", () => {
  if (quitting || !run.child) process.exit(0);
  quitting = true;
  console.log("プレイ中の試行を止めて、反省メモを書いてから終わります（もう一度 Ctrl+C ですぐ終了）");
  run.stopAfter = run.killed = true;
  setTimeout(() => { if (run.child && !run.childStopping) stopNow(); }, 3000);
  const t = setInterval(() => { if (!run.running) { clearInterval(t); process.exit(0); } }, 500);
});
