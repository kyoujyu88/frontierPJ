#!/usr/bin/env node
/* ローカルLLM（のあ など）に「辺境星系戦記」を遊ばせるプレイヤー
 *（旧名 noa-player.mjs。noa-player.mjs は互換のためこのファイルを読み込むだけ）
 *
 * ローカルLLMの OpenAI互換API（Ollama / LM Studio / llama.cpp server / vLLM など）と
 * このフォルダの MCPサーバー（server.mjs）をつなぎ、ツール呼び出しでゲームを進める。
 * AIが返した地の文（ツール以外の発言）は、そのまま画面に字幕表示する。名前と人格は --name / --persona で替える。
 * ゲームの終わりと数ターンごとに、プレイを振り返って「反省メモ」（notes/<名前>.md）を書き直し、
 * 次のターン・次のゲームのシステムプロンプトに入れる（notes.mjs）。どのモデルでも同じ仕組みで動く。
 *
 *   node ai-player.mjs --model qwen3:14b
 *   node ai-player.mjs --base-url http://127.0.0.1:1234/v1 --model <LM Studioのモデル名>
 *
 * オプション（環境変数でも可）
 *   --base-url <url>   OpenAI互換APIのURL（既定 Ollama: http://127.0.0.1:11434/v1）  LLM_BASE_URL
 *   --model <名前>     モデル名（必須）                                              LLM_MODEL
 *   --api-key <key>    APIキー（ローカルなら不要）                                  LLM_API_KEY
 *   --name <名前>      プレイヤーの名前。字幕の名前と反省メモのファイル名になる。省くと起動時に聞く（Enter で前回の名前、初回は のあ）  PLAYER_NAME
 *   --persona <file>   のあの人格・口調を書いたテキスト（システムプロンプトの先頭に入る） NOA_PERSONA
 *   --max-steps <n>    のあが考える回数の上限。作戦卓では1ターンごと、戦闘では1戦ごとに数える（既定 40。超えたら自動で進める） NOA_MAX_STEPS
 *   --turns <n>        何ターン遊んだら止めるか（既定 無制限）                        NOA_TURNS
 *   --temperature <t>  （既定 0.6）                                                   LLM_TEMPERATURE
 *   --think <none|low|medium|high>  考える量（reasoning_effort）。none で考えずに即答（Ollama の thinking 対応モデル向け）  LLM_THINK
 *   --loop             ゲームが終わったら新しいゲームを始める
 *   --notes <file>     反省メモのファイル（既定 notes/<名前>.md）                    NOA_NOTES
 *   --notes-chars <n>  プロンプトに入れる反省メモの上限文字数（既定 1200）           NOA_NOTES_CHARS
 *   --reflect-every <n> 何ターンごとにゲームの途中でも振り返るか（既定 10、0で終了時だけ） NOA_REFLECT_EVERY
 *   --notes-readonly   反省メモを読むだけで書き換えない（腕前を固定して見せたいとき）
 *   --no-notes         反省メモを使わない（毎回はじめて遊ぶ状態）
 *   -- <server.mjs のオプション>   例: -- --pace 900 --size 1920x1080
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNotes, saveNotes, notesPrompt, Journal, reflect, recordLine, safeName } from "./notes.mjs";

const sep = process.argv.indexOf("--");
const argv = sep >= 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const serverArgs = sep >= 0 ? process.argv.slice(sep + 1) : [];
const opt = (name, env, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : (process.env[env] ?? def); };
const BASE = opt("base-url", "LLM_BASE_URL", "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const MODEL = opt("model", "LLM_MODEL", null);
const KEY = opt("api-key", "LLM_API_KEY", "local");
const PERSONA_FILE = opt("persona", "NOA_PERSONA", null);
const MAX_STEPS = Number(opt("max-steps", "NOA_MAX_STEPS", 40));
const TURNS = Number(opt("turns", "NOA_TURNS", Infinity));
const TEMP = Number(opt("temperature", "LLM_TEMPERATURE", 0.6));
const THINK = opt("think", "LLM_THINK", null);
const LOOP = argv.includes("--loop");
const HERE = path.dirname(fileURLToPath(import.meta.url));
/* プレイヤー名：--name がなければ起動時に聞く（Enter で前回の名前。初回は のあ）。ここで選んだ名前は次回の既定になる */
const LAST_FILE = path.join(HERE, "notes", ".last-player.json");
async function pickName() {
  const given = opt("name", "PLAYER_NAME", null);
  let last = "のあ";
  try { last = JSON.parse(await fs.readFile(LAST_FILE, "utf8")).name || last; } catch {}
  let name = given;
  if (!name && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    name = (await rl.question(`プレイヤーの名前（字幕と反省メモに使います。Enter で「${last}」）: `)).trim() || last;
    rl.close();
    try { await fs.mkdir(path.dirname(LAST_FILE), { recursive: true }); await fs.writeFile(LAST_FILE, JSON.stringify({ name }) + "\n"); } catch {}
  }
  return name || last;
}
if (!opt("model", "LLM_MODEL", null)) { console.error("--model を指定してください（例: --model qwen3:14b）"); process.exit(1); }
const NAME = await pickName();
const USE_NOTES = !argv.includes("--no-notes");
const WRITE_NOTES = USE_NOTES && !argv.includes("--notes-readonly");
const NOTES_FILE = path.resolve(opt("notes", "NOA_NOTES", path.join(HERE, "notes", `${safeName(NAME)}.md`)));
const NOTES_CHARS = Number(opt("notes-chars", "NOA_NOTES_CHARS", 1200));
const REFLECT_EVERY = Number(opt("reflect-every", "NOA_REFLECT_EVERY", 10));
// 字幕の名前をプレイヤー名にそろえる（-- の後ろで --speaker を指定したらそちらが優先）
if (!serverArgs.includes("--speaker") && !process.env.GAME_SPEAKER) serverArgs.push("--speaker", NAME);
if (!MODEL) { console.error("--model を指定してください（例: --model qwen3:14b）"); process.exit(1); }

const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

/* ---------- MCPサーバーにつなぐ ---------- */
const mcp = new Client({ name: "ai-player", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "server.mjs"), ...serverArgs],
  env: process.env, stderr: "inherit",
}));
let journal = new Journal();
async function tool(name, args = {}) {
  // オート戦闘は演出つきで数分かかることがあるので、MCP の既定（60秒）より長く待つ
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60 * 1000 });
  const text = r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  let out;
  try { out = { text, json: JSON.parse(text) }; } catch { out = { text, json: null }; }
  journal.onTool(name, out);
  return out;
}
const summary = async () => (await tool("get_summary")).text;
const say = (text) => tool("say", { text: cleanTalk(text) }).catch(() => {});

// AIに渡すツール。重い get_state、画像の get_screenshot、やり直しの new_game は外す（say は地の文で代用）。
// ルールはシステムプロンプトに入れてあるので get_rules も外す（小さなモデルが読み直しを繰り返すため）
const HIDDEN = new Set(["get_state", "get_screenshot", "new_game", "battle_state", "get_rules"]);
const tools = (await mcp.listTools()).tools.filter(t => !HIDDEN.has(t.name)).map(t => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: { type: "object", properties: {}, ...t.inputSchema } },
}));

const TOOL_NAMES = new Set(tools.map(t => t.function.name));
// 既定のオート戦闘では battle_* ツールが無い（サーバーを -- --manual-battle で起動したときだけ1隻ずつ操作する）
const MANUAL_BATTLE = TOOL_NAMES.has("battle_attack");
const TEXT_CALL = new RegExp(`\\b(${[...TOOL_NAMES].join("|")})\\s*\\(([^()]*)\\)`, "g");
// Gemma 系がサーバー側で解釈されずに地の文へ漏らす書式：<|tool_call>call:battle_move{unit_id:30,x:3,y:2}<tool_call|>
const TOKEN_CALL = new RegExp(`call:(${[...TOOL_NAMES].join("|")})\\{([^{}]*)\\}?`, "g");
/* ツール呼び出しを地の文に書いてしまうモデル向け：dismiss_dialog() や move_fleet(fleet_id=1, to=2)、call:name{...} を拾う */
function textCalls(s) {
  const out = [];
  const src = (s || "").replace(/<\|"\|>/g, '"');
  const found = [...src.matchAll(TOKEN_CALL)].map(m => [m[1], m[2]]);
  if (!found.length) for (const m of src.matchAll(TEXT_CALL)) found.push([m[1], m[2]]);
  for (const [name, body] of found) {
    const raw = body.trim();
    let args = {};
    if (raw.startsWith("{")) { try { args = JSON.parse(raw); } catch { continue; } }
    else for (const kv of raw.split(",").map(x => x.trim()).filter(Boolean)) {
      const mm = kv.match(/^(\w+)\s*[=:]\s*(.+)$/); if (!mm) continue;
      const v = mm[2].trim().replace(/^["'](.*)["']$/, "$1");
      args[mm[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    }
    out.push({ id: `text_${out.length}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  }
  return out.slice(0, 4);
}

/* ---------- プロンプト ---------- */
const persona = PERSONA_FILE ? (await fs.readFile(PERSONA_FILE, "utf8")).trim()
  : `あなたは「${NAME}」。SF戦略シミュレーション「辺境星系戦記」を実況プレイ配信している。明るく、視聴者に話しかけるように短く喋る。`;
const rules = (await tool("get_rules")).text;
const notes = USE_NOTES ? await loadNotes(NOTES_FILE) : { lessons: [], records: [] };
const SYSTEM = () => `${persona}

# 配信のしかた
- ツールを使ってゲームを操作する。ツール以外の地の文は、そのまま配信画面に字幕で出る。1回に1〜2文、60字以内で、視聴者に向けて話す。
- 大事な判断（攻める先、研究、改装）の前に理由をひとこと話す。長い計画は話さない。
- 1ターンの流れ：状況を見る → 内政（研究・建設・探査・造船・改装）→ 戦いに行く艦隊は相手に合わせて陣形（set_formation）→ 艦隊の移動 → end_turn。
- 内政は「■内政の候補」に打てる手が呼び出しの形で並んでいる。毎ターン艦隊を動かす前に、資金の使い道を決めて1つ以上実行する（収入が増えると強い艦を作れる。◎は星の特性に合う施設）。修理のために少し残すのはよいが、使わずに貯めすぎない。
- 通信ウィンドウが出たら内容をひとことで紹介してから dismiss_dialog。
${MANUAL_BATTLE ? `- 戦闘中は、攻撃候補（予測ダメージつき）と移動先から1隻ずつ battle_attack / battle_move を選ぶ。動かしたくない艦（傷ついていて前に出したくない・射程外で近づくと不利など）は battle_wait で待機させる。全艦が動く（待機も含む）と自動で敵の番になるので、「敵の動きを見る」ために battle_end_phase を使わない。終わったら battle_close。
- 惑星の攻略戦では、中枢と防衛衛星はその場から動かない。待っていても撃たれるだけなので、毎ターン近づいて攻撃する。中枢は爆装（射程1）でしか壊せないので、爆装を持つ艦を中枢の隣まで進める（深淵の巣の中枢はセラフ級の爆装でしか壊せない）。` : `- 戦闘はオートで進む。攻め込む（move_fleet）か襲われると、戦闘は自動で決着して「出来事」に結果が出る。結果をひとこと実況する。
- あなたの仕事は戦う前の準備：勝てる相手を選ぶ、傷ついた艦隊は修理してから出す、惑星の攻略には爆装を持つ艦を入れる（中枢は爆装でしか壊せない。深淵の巣の中枢はセラフ級の爆装でしか壊せない）、相手に合わせて陣形を選ぶ（移動先の「陣形の目安」）、旗艦は打たれ強い艦にする。オートの戦い方はルールの「オートの戦い方」のとおりで、改装の配分がそのまま戦い方になる。`}
- IDは状況テキストに書かれた数字だけを使う。失敗したら理由を読んで別の手を選ぶ。

${rules}
${USE_NOTES ? `\n${notesPrompt(notes, NOTES_CHARS)}` : ""}`.trimEnd();

/* ---------- LLM 呼び出し ---------- */
async function chat(messages, { withTools = true } = {}) {
  const body = { model: MODEL, messages, temperature: TEMP };
  if (THINK) body.reasoning_effort = THINK;
  if (withTools) Object.assign(body, { tools, tool_choice: "auto" });
  else body.temperature = Math.min(TEMP, 0.4);
  const t0 = Date.now();
  // LLM まわりの失敗は「LLM API」で始まるエラーにそろえる。何度やっても同じになる失敗（つながらない・モデルがない・ツール非対応）には fatal をつける。
  // メインループは fatal ならすぐ止め、それ以外（400 などその場かぎりのもの）はそのターンだけ自動で進める
  let res;
  for (let retry = 0; ; retry++) {
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      break;
    } catch (e) {
      if (e.name === "TimeoutError") throw llmError("LLM API の返事が10分来ません", false);
      if (retry >= 1) throw llmError(`LLM API に接続できません：${e.cause?.code || e.message}`, true);
      await new Promise(r => setTimeout(r, 5000)); // Ollama の再起動などに備えて、一度だけやり直す
    }
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw llmError(`LLM API ${res.status}: ${text}`, [401, 403, 404].includes(res.status) || /does not support tools|model\b.*\bnot found/i.test(text));
  }
  const sec = (Date.now() - t0) / 1000;
  if (sec >= 20) log(`（返事まで ${sec.toFixed(0)}秒）`);
  const data = await res.json().catch(e => ({ error: e.message }));
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw llmError(`LLM API の返事が読めません：${JSON.stringify(data).slice(0, 200)}`, false);
  // content を配列で返すサーバーもある
  if (Array.isArray(msg.content)) msg.content = msg.content.map(c => c.text ?? "").join("");
  return msg;
}
const llmError = (message, fatal) => Object.assign(new Error(message), { fatal });
const stripThink = s => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "")
  .replace(/<\|channel\|?>\s*thought[\s\S]*?(<channel\|>|(?=<\|tool_call)|$)/g, "") // Gemma 系の考える部分
  .trim();
/* 字幕向けに整える：紛れ込んだHTMLタグ・名前の前置き・強調記号・セリフを囲む引用符や、片方だけ残った引用符を外す */
const QUOTES = [['"', '"'], ["＂", "＂"], ["“", "”"], ["〝", "〟"], ["「", "」"], ["『", "』"], ["'", "'"], ["‘", "’"]];
function cleanTalk(s) {
  let t = (s || "").replace(/<\|tool_call\|?>[\s\S]*?(<tool_call\|>|$)/g, " ") // Gemma 系のツール呼び出し書式
    .replace(/call:\w+\{[^{}]*\}?/g, " ")
    .replace(/<\|[^<>]{0,40}>|<[^<>]{0,40}\|>/g, " ") // <|channel> <channel|> などの特殊トークン
    .replace(/```[\s\S]*?(```|$)/g, " ") // コードブロック（ツール呼び出しを文字で書いたもの）
    .replace(TEXT_CALL, " ")
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, " ") // </td> や <dialog> など、紛れ込んだタグ
    .replace(/\*\*|__/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, "\n").trim()
    .replace(/(^|\n)thought$/i, "").trim(); // 考える部分の見出しだけが最後に残ったもの（Gemma 系）
  t = t.replace(new RegExp(`^${NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[：:]\\s*`), "");
  for (let changed = true; changed && t.length > 1;) {
    changed = false;
    for (const [a, b] of QUOTES) {
      const n = t.split(a).length - 1 + (a === b ? 0 : t.split(b).length - 1);
      if (n === 2 && t.length > 2 && t.startsWith(a) && t.endsWith(b)) { t = t.slice(1, -1).trim(); changed = true; }
    }
  }
  const count = (c) => t.split(c).length - 1;
  for (const [a, b] of QUOTES) {
    if (a === b) { if (count(a) % 2) t = t.startsWith(a) ? t.slice(1) : t.endsWith(a) ? t.slice(0, -1) : t; }
    else if (count(a) !== count(b)) { if (t.startsWith(a) && !count(b)) t = t.slice(1); else if (t.endsWith(b) && !count(a)) t = t.slice(0, -1); }
    t = t.trim();
  }
  return t;
}

/* ツール結果をのあ向けに短くする（戦闘中は盤面のテキストに置き換える）。
 * 状況テキストをつけたときは、あとで古くなったとき用の縮めた版（short）も返す */
async function digest(name, r) {
  const j = r.json;
  if (!j || typeof j !== "object" || !("ok" in j)) return { content: r.text.slice(0, 6000), short: null };
  const lines = [`${j.ok ? "成功" : "失敗"}：${j.message}`];
  if (j.events?.length) lines.push("出来事：\n " + j.events.slice(-12).join("\n "));
  // 戦闘中・通信・戦闘を閉じて作戦卓に戻ったときは、最新の状況テキストをつける
  if (j.ok && (j.mode === "battle" || j.mode === "battle_ended" || j.dialog || ((name === "battle_close" || j.battles?.length) && j.mode === "map"))) {
    const short = [lines[0], ...(j.events?.length ? ["出来事：\n " + j.events.slice(-4).join("\n ")] : []), OLD_NOTE].join("\n");
    return { content: [...lines, await summary()].join("\n"), short };
  }
  if (j.ok) lines.push(`資金${j.funds}`);
  return { content: lines.join("\n"), short: null };
}
/* 1ターンの会話は貯まっていくので、状況テキスト（戦闘の盤面など）は最新の1つだけ全文で送り、古いものは縮める */
const OLD_NOTE = "（このときの状況テキストは省略。最新の状況は後ろのメッセージにあります）";
const shortOf = new WeakMap();
function slim(messages) {
  let last = -1;
  messages.forEach((m, i) => { if (shortOf.has(m)) last = i; });
  return messages.map((m, i) => i < last && shortOf.has(m) ? { ...m, content: shortOf.get(m) } : m);
}

/* ---------- 自動進行（のあが詰まったときの保険） ---------- */
async function autopilot() {
  log("自動進行に切り替えます");
  for (let i = 0; i < 200; i++) {
    const s = (await tool("get_state")).json;
    if (s.dialog) { await tool("dismiss_dialog"); continue; }
    const b = s.battle;
    if (!b) return s;
    if (b.ended) { await tool("battle_close"); continue; }
    const u = b.units.find(v => v.side === "自軍" && !v.acted);
    if (!u) { await tool("battle_end_phase"); continue; }
    if (u.attacks?.length) { const a = u.attacks.sort((x, y) => y.damage - x.damage)[0]; await tool("battle_attack", { unit_id: u.id, target_id: a.target }); continue; }
    const foes = b.units.filter(v => v.side === "敵"), goal = foes.find(v => v.flagship) ?? foes[0];
    const d = (p) => Math.abs(Math.abs(p[0] - goal.x) + Math.abs(p[1] - goal.y) - 1);
    const best = (u.moves ?? []).sort((p, q) => d(p) - d(q))[0];
    if (best && d(best) < d([u.x, u.y])) await tool("battle_move", { unit_id: u.id, x: best[0], y: best[1] });
    else await tool("battle_wait", { unit_id: u.id });
  }
  // ここまで来るのは膠着したときだけ（ゲーム側にもラウンド上限がある）。撤退して作戦卓へ戻る
  let s = (await tool("get_state")).json;
  if (s.battle && !s.battle.ended) { await tool("battle_retreat"); s = (await tool("get_state")).json; }
  if (s.battle?.ended) { await tool("battle_close"); s = (await tool("get_state")).json; }
  return s;
}

/* ---------- 戦闘で何もせずにフェイズを終えようとしたら、一度だけ止めて具体的な手を示す ---------- */
let endPhaseNagged = false;
async function checkEndPhase() {
  const b = (await tool("get_state")).json?.battle;
  if (!b || b.ended || b.phase !== "自軍フェイズ") return null;
  if (endPhaseNagged) { endPhaseNagged = false; return null; } // 2回続けたら本人の判断に任せる
  const idle = b.units.filter(u => u.side === "自軍" && !u.acted);
  if (!idle.length) return null;
  endPhaseNagged = true;
  const foes = b.units.filter(u => u.side === "敵");
  const core = foes.find(u => u.kind?.startsWith("中枢"));
  const tips = idle.map(u => {
    if (u.attacks?.length) {
      const a = [...u.attacks].sort((x, y) => (y.target === core?.id) - (x.target === core?.id) || y.damage - x.damage)[0];
      return `${u.label} ID${u.id} ${u.name}：battle_attack で ID${a.target}${a.targetName}へ${a.weapon}${a.damage}`;
    }
    const goal = (core && u.weapons?.some(w => w.coreOnly) ? core : null) ?? foes.find(v => v.flagship) ?? foes[0];
    if (!goal) return null;
    const d = (p) => Math.abs(Math.abs(p[0] - goal.x) + Math.abs(p[1] - goal.y) - 1);
    const best = [...(u.moves ?? [])].sort((p, q) => d(p) - d(q))[0];
    return best && d(best) < d([u.x, u.y]) ? `${u.label} ID${u.id} ${u.name}：battle_move で (${best[0]},${best[1]}) へ（ID${goal.id}${goal.name}に近づく）` : `${u.label} ID${u.id} ${u.name}：近づける場所がないので battle_wait で待機`;
  }).filter(Boolean);
  return `失敗：まだ行動していない艦がいます。敵の番は全艦が動けば自動で来るので、先に次の手を打ってください。${core ? "惑星の中枢と防衛衛星は動かないので、待っても有利になりません。" : ""}\n ${tips.join("\n ")}\n動かしたくない艦は battle_wait（unit_id を指定）で待機させれば、全艦が終わった時点で敵の番になります。（それでも今すぐ終えたいときは、もう一度 battle_end_phase）`;
}

/* ---------- 1ターン ---------- */
let memo = "", turnTalk = "";
async function playTurn() {
  turnTalk = "";
  const intro = `${memo ? `前のターンのあなたの発言：${memo}\n\n` : ""}今の状況です。操作を始めてください。`;
  const first = { role: "user", content: `${intro}\n\n${await summary()}` };
  shortOf.set(first, `${intro}\n${OLD_NOTE}`);
  const messages = [{ role: "system", content: SYSTEM() }, first];
  let ended = false, over = false, idle = 0, wasted = 0, lastName = "", auto = false;
  // 考える回数は、作戦卓ではこのターンの合計、戦闘では1戦ごとに数える（攻める戦闘と防衛戦が重なっても途中で自動進行にならないように）
  let step = 0, mapSteps = 0, battleSteps = 0, inBattle = false;
  while (mapSteps < MAX_STEPS && wasted < 6) {
    if (inBattle && battleSteps >= MAX_STEPS) {
      // この戦闘だけ自動で片付けて、作戦卓の続きは本人に戻す
      log(`この戦闘で ${MAX_STEPS} 回考えたので、残りの戦闘を自動で片付けます`);
      const s = await autopilot(); auto = true; inBattle = false;
      if (s.over || ended) return { st: s, auto };
      const back = { role: "user", content: `残りの戦闘は自動で片付けました。作戦卓の操作を続けてください。\n\n${await summary()}` };
      shortOf.set(back, `残りの戦闘は自動で片付けました。\n${OLD_NOTE}`);
      messages.push(back);
      continue;
    }
    if (inBattle) battleSteps++; else mapSteps++;
    step++;
    const msg = await chat(slim(messages));
    const talk = cleanTalk(stripThink(msg.content));
    if (talk) { log(`${NAME}：` + talk); memo = turnTalk = talk.slice(0, 200); await say(talk.slice(0, 160)); }
    let calls = msg.tool_calls ?? [];
    if (!calls.length && (calls = textCalls(stripThink(msg.content))).length) log(`  （文字で書かれたツール呼び出しを実行します：${calls.map(c => c.function.name).join(", ")}）`);
    // content は必ず文字列にする（null だと Ollama が「invalid message content type: <nil>」の 400 で断る）
    messages.push({ role: "assistant", content: talk, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      if (++idle >= 3) break;
      messages.push({ role: "user", content: ended ? "状況を見て、残りの戦闘や通信を片付けてください。" : "ツールで操作を続けてください。やることが終わったら end_turn。" });
      continue;
    }
    idle = 0;
    for (const c of calls) {
      c.id ||= `call_${step}_${Math.random().toString(36).slice(2, 8)}`;
      let args = c.function.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { args = {}; } }
      if (c.function.name === "say" && args?.text) args.text = cleanTalk(args.text); // say ツールを直接呼んだときも整える
      log(`→ ${c.function.name} ${JSON.stringify(args)}`);
      // 渡していないツールや、同じ情報の取り直しは実行せずに次の手を促す（読み直しのループを防ぐ）
      const refuse = !TOOL_NAMES.has(c.function.name)
        ? `失敗：${c.function.name} は使えません。ルールはシステムプロンプトに、今の状況は最初のメッセージに書いてあります。操作のツールを選んでください。`
        : c.function.name === "get_summary" && lastName === "get_summary" ? "状況はさっきと同じです。操作のツールを選んでください。" : null;
      lastName = c.function.name;
      if (refuse) { wasted++; log("  ✗ " + refuse.split("。")[0]); messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: refuse }); continue; }
      if (c.function.name !== "get_summary") wasted = 0;
      if (c.function.name === "battle_end_phase") {
        const stop = await checkEndPhase();
        if (stop) { log("  ✗ まだ動ける艦があるので、フェイズ終了を止めました"); messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: stop }); continue; }
      } else if (c.function.name.startsWith("battle_")) endPhaseNagged = false;
      const r = await tool(c.function.name, args ?? {});
      if (c.function.name === "end_turn" && r.json?.ok) ended = true;
      if (r.json?.mode === "over") { over = true; break; } // 勝敗がついた（結果の画面は配信用に出したまま、振り返りへ）
      if (r.json?.mode) { const b = r.json.mode === "battle" || r.json.mode === "battle_ended"; if (b && !inBattle) battleSteps = 0; inBattle = b; }
      const { content, short } = await digest(c.function.name, r);
      if (r.json && r.json.ok === false) log("  ✗ " + r.json.message);
      const m = { role: "tool", tool_call_id: c.id, name: c.function.name, content };
      if (short) shortOf.set(m, short);
      messages.push(m);
    }
    if (over) return { st: (await tool("get_state")).json, auto };
    if (ended) {
      const s = (await tool("get_state")).json;
      if (!s.battle && !s.dialog) return { st: s, auto };
    }
  }
  // 上限まで来た・黙った：残りを自動で片付けてターンを終える
  let s = await autopilot();
  if (!ended && !s.over) { await tool("end_turn"); s = await autopilot(); }
  return { st: s, auto: true };
}

/* ---------- 反省メモ ---------- */
let reflectedAt = 0;
async function writeNotes(outcome, final) {
  if (!WRITE_NOTES || !journal.turns.length) return;
  if (final) notes.records.unshift(recordLine({ date: new Date().toLocaleDateString("sv-SE"), model: MODEL, outcome: final, journal }));
  if (journal.turns.length >= 2 && journal.turns.length > reflectedAt) {
    log(`${NAME}が反省メモを書いています…`);
    try {
      const r = await reflect({
        chat: async (m) => (await chat(m, { withTools: false })).content ?? "",
        name: NAME, persona, notes, journal, outcome, maxChars: NOTES_CHARS, stripThink,
      });
      if (r.lessons) { notes.lessons = r.lessons; log("反省メモ：\n  - " + r.lessons.join("\n  - ")); }
      else log("反省メモをうまく書けなかったので、前のメモを残します");
      if (r.comment && !stopping) await say(r.comment);
    } catch (e) { log("振り返りに失敗：" + e.message); }
  }
  reflectedAt = journal.turns.length;
  await saveNotes(NOTES_FILE, NAME, notes);
  log(`反省メモを保存しました：${NOTES_FILE}`);
}
const outcomeText = (over) => over === "win" ? "勝利" : "敗北";

/* Ctrl+C：MCPサーバーも一緒に止まるので、ここまでの記録で反省メモを書いてから終わる */
let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) process.exit(130);
  stopping = true;
  log("止めます。反省メモを書いてから終了します（もう一度 Ctrl+C ですぐ終了）");
  await writeNotes("プレイを途中でやめたところ", "途中終了").catch(e => log(e.message));
  process.exit(0);
});
// control.mjs（連続プレイ）から子プロセスとして動かすとき：Windows では SIGINT を送れないので、停止の合図をメッセージで受ける
process.on("message", m => { if (m?.type === "stop") process.emit("SIGINT"); });

/* ---------- メインループ ---------- */
log(`${NAME}（${MODEL} @ ${BASE}）がプレイを始めます`);
if (USE_NOTES) log(notes.lessons.length ? `反省メモ ${notes.lessons.length}項目を読み込みました（${NOTES_FILE}）` : `反省メモはまだありません。プレイ後に ${NOTES_FILE} に書きます`);
let st = (await tool("get_state")).json;
journal.begin(st);
log("最初の返事を待っています（モデルの読み込みと長い指示の読み取りで、数分かかることがあります）");
let llmDown = false, llmErrors = 0;
for (let n = 0; n < TURNS; n++) {
  if (st.over) {
    log(`ゲーム終了：${st.over}`);
    if (reflectedAt !== -1) await writeNotes(`ゲームが${outcomeText(st.over)}で終わったところ`, outcomeText(st.over));
    reflectedAt = -1;
    if (!LOOP) break;
    await tool("new_game", { confirm: true }); memo = "";
    journal = new Journal(); reflectedAt = 0;
    st = (await tool("get_state")).json; journal.begin(st);
  }
  if (stopping) await new Promise(() => {});
  const turn = st.turn;
  log(`=== ターン${turn} 資金${st.funds} ===`);
  let auto = false;
  try { ({ st, auto } = await playTurn()); llmErrors = 0; }
  catch (e) {
    if (stopping) await new Promise(() => {});
    log("エラー：" + e.message);
    if (/^LLM API/.test(e.message)) {
      if (/^LLM API に接続できません/.test(e.message)) { log("ローカルLLMに接続できないため止めます（--base-url と --model を確認）"); llmDown = true; break; }
      if (e.fatal) { log("LLMのエラーで止めます：モデル名と、ツール呼び出しに対応したモデルかを確認してください"); llmDown = true; break; }
      if (++llmErrors >= 3) { log("LLMのエラーで止めます：3ターン続けて失敗しました（モデルとコンテキストの長さを確認）"); llmDown = true; break; }
      log("その場かぎりのエラーとみなして、このターンは自動で進めます");
    }
    st = await autopilot(); if (!st.over) { await tool("end_turn"); st = await autopilot(); }
    auto = true;
  }
  journal.endTurn(turn, st, { talk: turnTalk, auto });
  if (!st.over && REFLECT_EVERY > 0 && journal.turns.length - reflectedAt >= REFLECT_EVERY)
    await writeNotes(`ゲームの途中（ターン${turn}まで）`, null);
}
if (st.over && reflectedAt !== -1) { log(`ゲーム終了：${st.over}`); await writeNotes(`ゲームが${outcomeText(st.over)}で終わったところ`, outcomeText(st.over)); }
else if (!st.over && !llmDown) await writeNotes(`プレイを途中でやめたところ（ターン${st.turn - 1}まで）`, "途中終了");
else if (!st.over && llmDown && WRITE_NOTES && journal.turns.length) {
  notes.records.unshift(recordLine({ date: new Date().toLocaleDateString("sv-SE"), model: MODEL, outcome: "途中終了", journal }));
  await saveNotes(NOTES_FILE, NAME, notes);
}
await mcp.close();
process.exit(0);
