#!/usr/bin/env node
/* プレイログ：AIプレイの1試行ぶんの出来事を、時刻つきで1行1件の JSON（.jsonl）に残す
 *
 * ai-player.mjs が書き、操作盤（control.mjs）とこのファイルのコマンドで読む。動画編集で使うのが主な目的なので、
 * 録画しているときは各行に「録画の開始からの時間」（vms）を入れ、字幕ファイル（SRT/VTT）や台本に書き出せる。
 *
 * 残すもの（type）
 *   start  … 設定（名前・モデル・URL など）        video … 録画の開始時刻と動画の名前
 *   turn   … ターンの始まり（資金）                  talk  … 字幕に出したセリフ（表示秒数つき）
 *   send   … LLM に送った文（システム・状況・ツールの結果。同じものは1回だけ）
 *   llm    … LLM の返事の全文（考えた部分・ツール呼び出し・トークン数・かかった秒数）
 *   tool   … ゲームの操作と結果（AI が選んだものと、自動進行のもの）  refuse … 実行せずに断った呼び出し
 *   battle … 戦闘の結果                              auto  … 自動進行に切り替えたとき
 *   error  … エラー                                  reflect … 反省メモの振り返り（項目・感想・返事の全文）
 *   over   … 勝敗がついた                            end   … 試行の終わり（結果・ターン・動画）
 *
 * コマンド（mcp フォルダで）
 *   node playlog.mjs                         … ログの一覧（新しい順。番号つき）
 *   node playlog.mjs 1 --format srt          … 1番目（いちばん新しい）のセリフを SRT で表示
 *   node playlog.mjs <名前> --format txt --out 台本.txt   … 台本（時刻・ターン区切り・セリフ・操作・戦闘）をファイルへ
 *   形式：srt / vtt（セリフの字幕）・txt（台本）・chapters（ターンごとのチャプター）・jsonl（全部）
 *   --all  … 台本に LLM とのやり取りも入れる
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = path.join(HERE, "logs");
/* 時刻の補正（video-clock.mjs）がない録画での、動画のコマ遅れの目安。補正があれば server.mjs の recording_info が lag: 0 を返す */
export const VIDEO_LAG_MS = 200;

/* ---------- 書く ---------- */
export class PlayLog {
  /* file を null にすると何も書かない（--no-log） */
  constructor(file) {
    this.file = file; this.t0 = Date.now(); this.videoT0 = null; this.videoLag = VIDEO_LAG_MS; this.sentSystem = {}; this.sent = new WeakSet();
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  /* 録画の開始時刻（server.mjs の recording_info）。これ以降の行に vms が付く */
  setVideo(t0, extra = {}) { if (!t0) return; this.videoT0 = t0; if (Number.isFinite(extra.lag)) this.videoLag = extra.lag; this.write("video", { t0, ...extra }); }
  write(type, data = {}, now = Date.now()) {
    if (!this.file) return;
    const ev = { t: new Date(now).toISOString(), ms: now - this.t0, ...(this.videoT0 ? { vms: Math.max(0, now - this.videoT0 + this.videoLag) } : {}), type, ...data };
    // 強制終了されても書いたところまでは残るように、1件ずつ追記する（量は1試行で数MBまで）
    try { fs.appendFileSync(this.file, JSON.stringify(ev) + "\n"); } catch (e) { if (!this.warned) { this.warned = true; console.error(`プレイログを書けません：${e.message}`); } }
  }
  /* LLM に送るメッセージのうち、まだ残していないものを残す（システムプロンプトは変わったときだけ） */
  sentMessages(messages, kind = "play") {
    if (!this.file) return;
    for (const m of messages) {
      if (typeof m !== "object" || this.sent.has(m)) continue;
      this.sent.add(m);
      if (m.role === "assistant") continue; // 返事は llm で残している
      if (m.role === "system") { if (m.content === this.sentSystem[kind]) continue; this.sentSystem[kind] = m.content; } // プレイ用と振り返り用で別々に
      this.write("send", { kind, role: m.role, ...(m.name ? { name: m.name } : {}), content: m.content });
    }
  }
}

/* ---------- 読む ---------- */
export function parseLog(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
export async function readLog(file) { return parseLog(await fsp.readFile(file, "utf8")); }

/* ファイルの先頭と末尾だけ読んで、一覧用の要約を作る（大きなログでも速いように） */
async function headTail(file, n = 16384) {
  const fh = await fsp.open(file, "r");
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(n, size)); await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(n, size)); await fh.read(tail, 0, tail.length, size - tail.length);
    return { size, head: head.toString("utf8"), tail: tail.toString("utf8") };
  } finally { await fh.close(); }
}
const firstOf = (text, type) => text.split("\n").slice(0, -1).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.type === type);
const lastOf = (text, type) => text.split("\n").slice(1).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e && (!type || e.type === type));

export async function logSummary(file) {
  const st = await fsp.stat(file);
  const { size, head, tail } = await headTail(file);
  const whole = size <= 16384 ? head : null;
  const start = whole ? parseLog(whole).find(e => e.type === "start") : firstOf(head, "start");
  const evs = whole ? parseLog(whole) : null;
  const end = evs ? evs.findLast(e => e.type === "end") : lastOf(tail, "end");
  const turn = evs ? evs.findLast(e => e.type === "turn") : lastOf(tail, "turn");
  const last = evs ? evs.at(-1) : lastOf(tail);
  const video = end?.video ?? (evs ? evs.find(e => e.type === "video") : firstOf(head, "video"))?.name ?? null;
  return {
    name: path.basename(file, ".jsonl"), size, mtime: st.mtimeMs,
    player: start?.name ?? "", model: start?.model ?? "", startedAt: start?.t ?? new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
    outcome: end?.outcome ?? (Date.now() - st.mtimeMs < 5 * 60 * 1000 ? "プレイ中" : "途中で終了"),
    turn: end?.turn ?? turn?.turn ?? null, video: end?.video ?? video, lengthMs: last?.ms ?? 0,
  };
}
export async function listLogs(dir = LOG_DIR) {
  let files;
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith(".jsonl") && !f.startsWith(".")); } catch { return []; }
  const out = [];
  for (const f of files) { try { out.push(await logSummary(path.join(dir, f))); } catch {} }
  return out.sort((a, b) => b.mtime - a.mtime);
}
/* 一覧の名前（拡張子なし）からファイルへ。フォルダの外は指せない */
export function logPath(name, dir = LOG_DIR) {
  const base = path.basename(String(name)).replace(/\.jsonl$/, "");
  if (!base || base.startsWith(".")) return null;
  return path.join(dir, base + ".jsonl");
}
/* 試行の終わりが書かれていなければ（強制終了など）書き足す */
export async function ensureEnd(file, data) {
  try {
    const { tail } = await headTail(file, 4096);
    if (lastOf(tail, "end")) return false;
    const last = lastOf(tail), now = Date.now();
    const ev = { t: new Date(now).toISOString(), ms: (last?.ms ?? 0) + (last ? now - Date.parse(last.t) : 0), type: "end", by: "control", ...data };
    await fsp.appendFile(file, JSON.stringify(ev) + "\n");
    return true;
  } catch { return false; }
}

/* ---------- 書き出し ---------- */
const at = (e) => e.vms ?? e.ms ?? 0;
const pad = (n, w = 2) => String(n).padStart(w, "0");
function stamp(ms, sep) { ms = Math.max(0, Math.round(ms)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`; }
export function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; }

/* セリフの表示区間：表示秒数か、次のセリフが出るまで（字幕は次のセリフで置き換わる） */
export function cues(events) {
  const talks = events.filter(e => e.type === "talk" && e.text);
  return talks.map((e, i) => {
    const start = at(e), next = talks[i + 1] ? at(talks[i + 1]) : Infinity;
    const end = Math.max(start + 100, Math.min(start + (e.durMs ?? 2500 + e.text.length * 120), next));
    return { start, end, who: e.who ?? "", text: e.text };
  });
}
export function toSrt(events) {
  return cues(events).map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
}
export function toVtt(events) {
  return "WEBVTT\n\n" + cues(events).map(c => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.who ? `<v ${c.who.replace(/[<>&]/g, "")}>` : ""}${c.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n`).join("\n");
}
/* YouTube の概要欄にそのまま貼れるチャプター（最初は 0:00 から） */
export function toChapters(events) {
  const L = [];
  for (const e of events) {
    if (e.type === "turn") L.push([at(e), `ターン${e.turn}`]);
    else if (e.type === "over") L.push([at(e), e.result === "win" ? "勝利" : e.result === "lose" ? "敗北" : `決着（${e.result}）`]);
    else if (e.type === "reflect") L.push([at(e), "振り返り"]);
  }
  if (!L.length || L[0][0] >= 1000) L.unshift([0, "はじまり"]); else L[0][0] = 0;
  // 同じ秒に重なったものは後ろを残す
  const out = [];
  for (const [ms, t] of L) { if (out.length && Math.floor(out.at(-1)[0] / 1000) === Math.floor(ms / 1000)) out.pop(); out.push([ms, t]); }
  return out.map(([ms, t]) => `${clock(ms)} ${t}`).join("\n") + "\n";
}
/* 1件を人が読む1行にする（台本・操作盤の表示で共通）。LLM とのやり取りは all のときだけ */
export function describe(e, { all = false } = {}) {
  const j = (v) => JSON.stringify(v ?? {});
  switch (e.type) {
    case "start": return { kind: "sys", text: `${e.name}（${e.model} @ ${e.baseUrl}）がプレイを始めます${e.think ? `　考える量 ${e.think}` : ""}　temperature ${e.temperature}` };
    case "video": return { kind: "sys", text: `録画を始めました${e.name ? `：${e.name}` : ""}` };
    case "turn": return { kind: "turn", text: `── ターン${e.turn}　資金${e.funds} ──` };
    case "talk": return { kind: "talk", text: `${e.who ?? ""}「${e.text}」` };
    case "tool": return { kind: "op", text: `${e.by === "auto" ? "（自動）" : "→ "}${e.name} ${j(e.args)}${e.message ? `　${e.ok === false ? "✗" : "○"} ${e.message}` : ""}${e.events?.length ? `\n    ${e.events.join("\n    ")}` : ""}` };
    case "refuse": return { kind: "op", text: `✗ ${e.name} ${j(e.args)}　${e.reason}` };
    case "battle": return { kind: "battle", text: `戦闘「${e.title}」${e.result}` };
    case "auto": return { kind: "sys", text: `自動進行：${e.reason}` };
    case "stop": return { kind: "sys", text: "停止の合図を受けました" };
    case "newgame": return { kind: "sys", text: "新しいゲームを始めます" };
    case "error": return { kind: "err", text: `エラー：${e.message}` };
    case "over": return { kind: "sys", text: `ゲーム終了：${e.result === "win" ? "勝利" : e.result === "lose" ? "敗北" : e.result}` };
    case "reflect": return { kind: "sys", text: `反省メモ${e.lessons ? `\n  - ${e.lessons.join("\n  - ")}` : "：うまく書けなかったので前のメモを残しました"}${e.comment ? `\n  感想：${e.comment}` : ""}` };
    case "end": return { kind: "sys", text: `試行の終わり：${e.outcome ?? ""}${e.turn ? `（ターン${e.turn}）` : ""}${e.video ? `　録画 ${e.video}` : ""}` };
    case "send": return all ? { kind: "llm", text: `［LLMへ・${e.role}${e.name ? ` ${e.name}` : ""}］\n${e.content}` } : null;
    case "llm": return all ? { kind: "llm", text: `［LLMの返事・${e.sec}秒${e.usage?.total_tokens ? `・${e.usage.total_tokens}トークン` : ""}］${e.reasoning ? `\n（考えた部分）${e.reasoning}` : ""}${e.content ? `\n${e.content}` : ""}${e.calls?.length ? `\n${e.calls.map(c => `${c.name} ${c.arguments}`).join("\n")}` : ""}` } : null;
    default: return null;
  }
}
export function toText(events, { all = false, name = "" } = {}) {
  const s = events.find(e => e.type === "start"), v = events.find(e => e.type === "video"), end = events.findLast(e => e.type === "end");
  const L = [`# プレイログ ${name}`,
    s ? `${s.name}（${s.model}）　開始 ${new Date(s.t).toLocaleString("ja-JP")}` : "",
    v || end?.video ? `時刻は録画の開始からの経過時間です${end?.video ? `（${end.video}）` : ""}` : "時刻はプレイの開始からの経過時間です（録画なし）",
    ""];
  for (const e of events) {
    const d = describe(e, { all });
    if (!d) continue;
    if (d.kind === "turn") L.push("");
    L.push(`[${clock(at(e))}] ${d.text}`);
  }
  return L.filter((l, i) => l !== "" || i > 2).join("\n") + "\n";
}
export const FORMATS = { srt: [toSrt, "application/x-subrip"], vtt: [toVtt, "text/vtt"], txt: [toText, "text/plain"], chapters: [toChapters, "text/plain"] };
export function exportLog(events, format, opts = {}) {
  if (format === "jsonl") return events.map(e => JSON.stringify(e)).join("\n") + "\n";
  const f = FORMATS[format]; if (!f) throw new Error(`形式は ${[...Object.keys(FORMATS), "jsonl"].join(" / ")} のどれかです`);
  return f[0](events, opts);
}
/* 出力ファイル名の後ろ（chapters だけ .chapters.txt にして、台本の .txt と分ける） */
export const extOf = (format) => format === "chapters" ? ".chapters.txt" : `.${format}`;

/* 録画の隣に同じ名前の字幕（.srt）を置く（VLC などの再生ソフトや編集ソフトが自動で読む） */
export async function subtitlesBeside(logFile, videoFile) {
  const events = await readLog(logFile);
  if (!events.some(e => e.type === "talk")) return null;
  const out = videoFile.replace(/\.webm$/i, "") + ".srt";
  await fsp.writeFile(out, "﻿" + toSrt(events)); // BOM 付き：Windows の編集ソフトで文字化けしないように
  return out;
}

/* ---------- コマンド ---------- */
async function cli(args) {
  const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const dir = path.resolve(val("dir") ?? LOG_DIR);
  const pos = args.filter((a, i) => !a.startsWith("--") && !["--format", "--out", "--dir"].includes(args[i - 1]));
  const logs = await listLogs(dir);
  if (!pos.length) {
    if (!logs.length) { console.log(`ログはまだありません（${dir}）`); return; }
    console.log(`ログ（${dir}、新しい順）`);
    logs.forEach((l, i) => console.log(`${String(i + 1).padStart(3)}. ${l.name}　${l.player} ${l.model}　${l.outcome}${l.turn ? ` ターン${l.turn}` : ""}　${clock(l.lengthMs)}${l.video ? "　録画あり" : ""}`));
    console.log("\n取り出し：node playlog.mjs <番号か名前> --format srt|vtt|txt|chapters|jsonl [--out ファイル] [--all]");
    return;
  }
  const key = pos[0];
  const hit = /^\d+$/.test(key) && logs[Number(key) - 1] ? logs[Number(key) - 1] : logs.find(l => l.name === key.replace(/\.jsonl$/, "")) ?? logs.find(l => l.name.includes(key));
  if (!hit) { console.error(`見つかりません：${key}（node playlog.mjs で一覧）`); process.exit(1); }
  const format = val("format") ?? "txt";
  const text = exportLog(await readLog(path.join(dir, hit.name + ".jsonl")), format, { all: args.includes("--all"), name: hit.name });
  const out = val("out");
  if (out) { await fsp.writeFile(out, (format === "srt" ? "﻿" : "") + text); console.error(`書き出しました：${path.resolve(out)}`); }
  else process.stdout.write(text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
