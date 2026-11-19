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
 *   model  … 使っている LLM の詳細（系統・パラメータ数・量子化・最大コンテキスト長・num_ctx・Ollama の版・GPU の名前）
 *   loaded … 読み込まれたあとの状態（実際のコンテキスト長・メモリの量と GPU／メインメモリの割合）  ctx … 会話を続けるのに使う長さ
 *
 * コマンド（mcp フォルダで）
 *   node playlog.mjs                         … ログの一覧（新しい順。番号つき）
 *   node playlog.mjs 1 --format srt          … 1番目（いちばん新しい）のセリフを SRT で表示
 *   node playlog.mjs <名前> --format txt --out 台本.txt   … 台本（時刻・ターン区切り・セリフ・操作・戦闘）をファイルへ
 *   形式：srt / vtt（セリフの字幕）・txt（台本）・chapters（ターンごとのチャプター）・stats（集計）・jsonl（全部）
 *   node playlog.mjs --stats                 … いちばん新しいログの集計（1ターンの秒数と内訳・読み込みの速さ・失敗率など。logstats.mjs）
 *   node playlog.mjs --stats 3 2 1           … 何本かを横に並べて比べる（モデルや設定を替えたときに）
 *   --all  … 台本に LLM とのやり取りも入れる
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitRecordedTalk } from "./talk.mjs";
import { describeModel, describeLoaded } from "./llm-info.mjs";
import { statsOf, statsText, compareText } from "./logstats.mjs";

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
  return talks.flatMap((e, i) => {
    const start = at(e), next = talks[i + 1] ? at(talks[i + 1]) : Infinity;
    const end = Math.max(start + 100, Math.min(start + (e.durMs ?? 2500 + e.text.length * 120), next));
    // 修正前のログには say{text:「…」} が並んだまま1件で残っていることがある。1件ずつに分け、表示時間を文字数で割り振る。
    // 操作名だけのセリフ（end_turn など）は出さない
    const parts = splitRecordedTalk(e.text, e.who ?? "");
    if (!parts.length) return [];
    if (parts.length === 1) return [{ start, end, who: e.who ?? "", text: parts[0] }];
    const total = parts.reduce((n, p) => n + p.length, 0);
    let t = start;
    return parts.map((p, k) => {
      const s = t; t = k === parts.length - 1 ? end : Math.round(t + (end - start) * p.length / total);
      return { start: s, end: t, who: e.who ?? "", text: p };
    });
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
const PLAN_FIELD = { long: "長期", short: "短期", targets: "攻める順" };
export const PLAN_CUE = { none: "作戦なし", hit: "攻める星を落とした", lost: "星を失った", event: "情勢の変化", empty: "攻める星がなくなった", stale: "短期の作戦が古い" };
/* 1件を人が読む1行にする（台本・操作盤の表示で共通）。LLM とのやり取りは all のときだけ */
export function describe(e, { all = false } = {}) {
  const j = (v) => JSON.stringify(v ?? {});
  switch (e.type) {
    case "start": return { kind: "sys", text: `${e.name}（${e.model} @ ${e.baseUrl}）がプレイを始めます${e.think ? `　考える量 ${e.think}` : ""}　temperature ${e.temperature}${e.maxTokens ? `　返事の上限 ${e.maxTokens}` : ""}` };
    case "model": return { kind: "sys", text: `LLM：${e.ollama === false ? `${e.model}（Ollama ではないので詳細は分かりません）` : describeModel(e.model, e)}${e.gpu ? `\n  GPU：${e.gpu}${e.gpuFrom ? `（${e.gpuFrom === "--gpu" ? "--gpu の指定" : e.gpuFrom === "nvidia-smi" ? "この PC の nvidia-smi" : e.gpuFrom}）` : ""}` : ""}` };
    case "loaded": return e.found === false ? { kind: "sys", text: "読み込み状態：Ollama の /api/ps にこのモデルが見つかりませんでした" } : { kind: "sys", text: `読み込み状態：${describeLoaded(e, { gpu: e.gpu })}${e.warnings?.length ? `\n  ⚠ ${e.warnings.join("\n  ⚠ ")}` : ""}` };
    case "ctx": return { kind: "sys", text: e.ctx ? `コンテキスト長 ${e.ctx}：収まる間はターンをまたいで会話を続けます` : "コンテキスト長が分からないので、毎ターン会話を作り直します" };
    case "video": return { kind: "sys", text: `録画を始めました${e.name ? `：${e.name}` : ""}` };
    case "turn": return { kind: "turn", text: `── ターン${e.turn}　資金${e.funds} ──` };
    case "talk": {
      const parts = splitRecordedTalk(e.text, e.who ?? "");
      return parts.length ? { kind: "talk", text: parts.map(t => `${e.who ?? ""}「${t}」`).join("\n") } : { kind: "sys", text: `（操作名だけのセリフ「${e.text}」は字幕から外しました）` };
    }
    case "tool": return { kind: "op", text: `${e.by === "auto" ? "（自動）" : "→ "}${e.name} ${j(e.args)}${e.message ? `　${e.ok === false ? "✗" : "○"} ${e.message}` : ""}${e.events?.length ? `\n    ${e.events.join("\n    ")}` : ""}` };
    case "refuse": return { kind: "op", text: `✗ ${e.name} ${j(e.args)}　${e.reason}` };
    case "battle": return { kind: "battle", text: `戦闘「${e.title}」${e.result}` };
    case "auto": return { kind: "sys", text: `自動進行：${e.reason}` };
    case "cut": return { kind: "sys", text: `返事が上限で切れたので、途中で終わった呼び出しは実行しませんでした：${(e.names ?? []).join(", ")}` };
    case "stop": return { kind: "sys", text: "停止の合図を受けました" };
    case "newgame": return { kind: "sys", text: "新しいゲームを始めます" };
    case "error": return { kind: "err", text: `エラー：${e.message}` };
    case "over": return { kind: "sys", text: `ゲーム終了：${e.result === "win" ? "勝利" : e.result === "lose" ? "敗北" : e.result}` };
    case "reflect": return { kind: "sys", text: `反省メモ${e.lessons ? `\n  - ${e.lessons.join("\n  - ")}` : "：うまく書けなかったので前のメモを残しました"}${e.comment ? `\n  感想：${e.comment}` : ""}` };
    case "plan": return { kind: "sys", text: `作戦${e.turn != null ? `（ターン${e.turn}` : "（"}${e.changed?.length ? `・${e.changed.map(k => PLAN_FIELD[k] ?? k).join("・")}を変更）` : "・変更なし）"}`
      + `${e.long ? `\n  長期：${e.long}` : ""}${e.short ? `\n  短期：${e.short}` : ""}\n  攻める順：${e.targets?.length ? e.targets.map(t => `${t.id}${t.name ?? ""}`).join(" → ") : "なし"}` };
    case "plan_hit": return { kind: "sys", text: `作戦の攻める星 ${e.id}${e.name ?? ""} を落としました` };
    case "plan_turn": { const c = (e.cues ?? []).filter(k => k !== "none"); return c.length ? { kind: "sys", text: `作戦の見直しの合図：${c.map(k => PLAN_CUE[k] ?? k).join("・")}` } : null; }
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
const toStats = (events, { name = "" } = {}) => statsText(statsOf(events), { name });
export const FORMATS = { srt: [toSrt, "application/x-subrip"], vtt: [toVtt, "text/vtt"], txt: [toText, "text/plain"], chapters: [toChapters, "text/plain"], stats: [toStats, "text/plain"] };
export function exportLog(events, format, opts = {}) {
  if (format === "jsonl") return events.map(e => JSON.stringify(e)).join("\n") + "\n";
  const f = FORMATS[format]; if (!f) throw new Error(`形式は ${[...Object.keys(FORMATS), "jsonl"].join(" / ")} のどれかです`);
  return f[0](events, opts);
}
/* 出力ファイル名の後ろ（chapters・stats は .chapters.txt・.stats.txt にして、台本の .txt と分ける） */
export const extOf = (format) => format === "chapters" ? ".chapters.txt" : format === "stats" ? ".stats.txt" : `.${format}`;

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
  const find = (key) => /^\d+$/.test(key) && logs[Number(key) - 1] ? logs[Number(key) - 1] : logs.find(l => l.name === key.replace(/\.jsonl$/, "")) ?? logs.find(l => l.name.includes(key));
  if (args.includes("--stats")) {
    // 集計：指定がなければいちばん新しいもの。2本以上は横に並べる（書いた順に左から）
    const hits = (pos.length ? pos : ["1"]).map(k => find(k) ?? (() => { throw new Error(`見つかりません：${k}（node playlog.mjs で一覧）`); })());
    const list = await Promise.all(hits.map(async h => ({ name: h.name, stats: statsOf(await readLog(path.join(dir, h.name + ".jsonl"))) })));
    process.stdout.write(list.length === 1 ? statsText(list[0].stats, { name: list[0].name }) : compareText(list));
    return;
  }
  if (!pos.length) {
    if (!logs.length) { console.log(`ログはまだありません（${dir}）`); return; }
    console.log(`ログ（${dir}、新しい順）`);
    logs.forEach((l, i) => console.log(`${String(i + 1).padStart(3)}. ${l.name}　${l.player} ${l.model}　${l.outcome}${l.turn ? ` ターン${l.turn}` : ""}　${clock(l.lengthMs)}${l.video ? "　録画あり" : ""}`));
    console.log("\n取り出し：node playlog.mjs <番号か名前> --format srt|vtt|txt|chapters|stats|jsonl [--out ファイル] [--all]");
    console.log("集計：node playlog.mjs --stats [番号か名前 …]（2本以上で並べて比べる）");
    return;
  }
  const key = pos[0];
  const hit = find(key);
  if (!hit) { console.error(`見つかりません：${key}（node playlog.mjs で一覧）`); process.exit(1); }
  const format = val("format") ?? "txt";
  const text = exportLog(await readLog(path.join(dir, hit.name + ".jsonl")), format, { all: args.includes("--all"), name: hit.name });
  const out = val("out");
  if (out) { await fsp.writeFile(out, (format === "srt" ? "﻿" : "") + text); console.error(`書き出しました：${path.resolve(out)}`); }
  else process.stdout.write(text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
