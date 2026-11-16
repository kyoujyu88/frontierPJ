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
 *   --ctx <n>          LLM のコンテキスト長（トークン）。省くと Ollama に聞く（/api/ps）。分かれば、ターンをまたいで会話を続ける  LLM_CTX
 *   --gpu <名前>       Ollama が使う GPU の名前（ログに出すだけ。Ollama の API では機種名が分からないため。例 "RTX 4090 24GB"）  LLM_GPU
 *   --keep-turns <n>   会話を続ける最大のターン数（既定 4。ここで作り直す）                  NOA_KEEP_TURNS
 *   --no-keep-context  ターンごとに会話を作り直す（以前の動き。毎ターンの最初にプロンプト全体の読み直しが入る）
 *   --log-name <名前>  プレイログ（logs/<名前>.jsonl）の名前（既定 <名前>_<日時>）。セリフ・LLMの返事・操作・戦闘を時刻つきで残す（playlog.mjs）  NOA_LOG_NAME
 *   --log-dir <dir>    プレイログの置き場所（既定 logs）                             NOA_LOG_DIR
 *   --no-log           プレイログを残さない
 *   -- <server.mjs のオプション>   例: -- --pace 900 --size 1920x1080
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNotes, saveNotes, notesPrompt, Journal, reflect, recordLine, safeName } from "./notes.mjs";
import { PlayLog, LOG_DIR, subtitlesBeside } from "./playlog.mjs";
import { makeTalk, stripThink } from "./talk.mjs";
import { modelInfo, loadedInfo, localGpus, gpuText, isLocalHost, describeModel, describeLoaded, loadWarnings } from "./llm-info.mjs";

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
/* ターンをまたいで会話を続ける（B2）。ローカルLLM（Ollama の Gemma 系など）は、前に送ったプロンプトの「後ろに足した」ときだけ読み直しを省ける。
 * ターンごとに会話を作り直すと、毎ターン最初の返事でプロンプト全体（約7千トークン）を読み直して 約11秒かかっていた（2026-11-16 のログ、36ターン×11秒）。
 * 続けるとコンテキストが伸びるので、長さが分かるとき（--ctx か Ollama の /api/ps）だけ、収まる間だけ続ける */
let CTX = Number(opt("ctx", "LLM_CTX", 0)) || 0;
const KEEP = !argv.includes("--no-keep-context");
const GPU_LABEL = String(opt("gpu", "LLM_GPU", "") || "").trim() || null;
const KEEP_TURNS = Math.max(1, Number(opt("keep-turns", "NOA_KEEP_TURNS", 4)) || 4);
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

/* ---------- プレイログ（セリフ・LLMとのやり取り・操作・戦闘を時刻つきで残す。playlog.mjs） ---------- */
const LOG_FILE = argv.includes("--no-log") ? null : path.resolve(HERE, opt("log-dir", "NOA_LOG_DIR", LOG_DIR),
  safeName(opt("log-name", "NOA_LOG_NAME", null) || `${NAME}_${new Date().toLocaleString("sv-SE").replace(/[-:]/g, "").replace(" ", "-").slice(0, 13)}`) + ".jsonl");
const plog = new PlayLog(LOG_FILE);
let lastTurn = null;
// URL は「プロトコル・ホスト・パス」だけ残す（ユーザー名・パスワードやクエリに載せたキーをログと操作盤に出さないように）
const logUrl = (() => { try { const u = new URL(BASE); return u.origin + u.pathname; } catch { return "(URLを読めません)"; } })();
plog.write("start", { name: NAME, model: MODEL, baseUrl: logUrl, think: THINK, temperature: TEMP, maxSteps: MAX_STEPS, turns: Number.isFinite(TURNS) ? TURNS : null,
  notes: USE_NOTES ? (WRITE_NOTES ? "grow" : "readonly") : "off", serverArgs, pid: process.pid });
if (LOG_FILE) log(`プレイログ：${LOG_FILE}`);

/* ---------- 使っている LLM の詳細（llm-info.mjs）。Ollama なら系統・パラメータ数・量子化・コンテキスト長、
 * 最初の返事のあと（モデルが読み込まれてから）実際のコンテキスト長とメモリの載り方（GPU／メインメモリ）を出す ---------- */
const llm = { info: null, loaded: null, gpu: GPU_LABEL, gpuFrom: GPU_LABEL ? "--gpu" : null, loadedAsked: false };
llm.info = await modelInfo(BASE, MODEL).catch(() => null);
if (!llm.gpu && isLocalHost(BASE)) { const g = gpuText(await localGpus().catch(() => null)); if (g) { llm.gpu = g; llm.gpuFrom = "nvidia-smi"; } }
log(`LLM：${describeModel(MODEL, llm.info) ?? `${MODEL}（Ollama ではないので、モデルの詳細は分かりません）`}`);
if (llm.gpu) log(`  GPU：${llm.gpu}（${llm.gpuFrom === "--gpu" ? "--gpu の指定" : "この PC の nvidia-smi"}）`);
plog.write("model", { model: MODEL, ...(llm.info ?? { ollama: false }), gpu: llm.gpu, gpuFrom: llm.gpuFrom });
/* 読み込まれたあとの状態。最初の返事のあとに1回だけ聞く（モデルはその返事で読み込まれる） */
async function checkLoaded() {
  if (llm.loadedAsked) return llm.loaded;
  llm.loadedAsked = true;
  llm.loaded = await loadedInfo(BASE, MODEL).catch(() => null);
  if (!llm.loaded) { if (llm.info) log("読み込み状態：Ollama の /api/ps にこのモデルが見つかりませんでした"); return null; }
  log(`読み込み状態：${describeLoaded(llm.loaded, { gpu: llm.gpu })}`);
  for (const w of loadWarnings(llm.loaded, llm.info)) log(`  ⚠ ${w}`);
  plog.write("loaded", { ...llm.loaded, gpu: llm.gpu, warnings: loadWarnings(llm.loaded, llm.info) });
  return llm.loaded;
}

/* ---------- MCPサーバーにつなぐ ---------- */
const mcp = new Client({ name: "ai-player", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "server.mjs"), ...serverArgs],
  env: process.env, stderr: "inherit",
}));
let journal = new Journal();
// プレイログに操作として残さない、読むだけ・配信用のツール
const QUIET = new Set(["get_state", "get_summary", "get_rules", "say", "finish_recording", "recording_info"]);
let autoBy = false; // 自動進行中の操作は by:"auto" で残す
async function tool(name, args = {}) {
  // オート戦闘は演出つきで数分かかることがあるので、MCP の既定（60秒）より長く待つ
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60 * 1000 });
  const text = r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  let out;
  try { out = { text, json: JSON.parse(text) }; } catch { out = { text, json: null }; }
  // 引数の形が合わずに MCP サーバーが断ったもの（「MCP error -32602: … Invalid arguments for tool x: 〜を指定してください at to」）も、ふつうの失敗として扱う。
  // この文言は MCP SDK（@modelcontextprotocol/sdk 1.x）のもの。SDK を上げて文言が変わると拾えなくなるが、そのときも本文はそのまま LLM に返る（selftest の「引数が足りないとき」の確認が先に落ちる）
  const bad = !out.json && text.match(/^MCP error -?\d+:[\s\S]*?Invalid arguments for tool [^:]+:\s*([\s\S]*)$/);
  if (bad) out.json = { ok: false, message: `引数が正しくありません：${bad[1].replace(/ at (\w+)$/gm, "（$1）").replace(/\n/g, "、")}` };
  journal.onTool(name, out);
  if (!QUIET.has(name)) capHold = 0; // ゲームを操作したら、次のセリフは待たずに出す
  const j = out.json;
  if (!QUIET.has(name)) plog.write("tool", { by: autoBy ? "auto" : "ai", name, args, ok: j?.ok ?? null, message: j?.message ?? (j ? undefined : text.slice(0, 300)),
    ...(j?.events?.length ? { events: j.events } : {}), ...(j?.funds != null ? { funds: j.funds } : {}), ...(j?.mode ? { mode: j.mode } : {}) });
  for (const b of Array.isArray(j?.battles) ? j.battles : []) plog.write("battle", { title: b.title, result: b.result });
  if (j?.ok && name === "battle_close") plog.write("battle", { title: journal.battleTitle ?? "", result: /勝利/.test(j.message) ? "勝利" : /敗北/.test(j.message) ? "敗北" : "撤退" });
  return out;
}
const summary = async () => (await tool("get_summary")).text;
// 字幕は次のセリフですぐ置き換わる。1つの返事に say が並んだときなどに前のセリフが読めるよう、
// ゲームの操作をはさまずに続けて話すときは、前のセリフを読める長さ（最大6秒）だけ待ってから出す
let capHold = 0;
async function say(text, extra = {}) {
  const t = cleanTalk(text);
  if (!t) return null;
  const wait = capHold - Date.now();
  if (wait > 0 && !stopping) await new Promise(r => setTimeout(r, wait));
  const at = Date.now();
  const r = await tool("say", { ...extra, text: t }).catch(() => null);
  const durMs = r?.json?.durationMs ?? null;
  capHold = at + Math.min(durMs ?? Infinity, 1500 + t.length * 100, 6000); // 表示秒数が返らないときは文字数の目安で
  plog.write("talk", { who: NAME, text: t, durMs }, at); // 時刻は字幕を出し始めたとき
  return r;
}

// AIに渡すツール。重い get_state、画像の get_screenshot、やり直しの new_game は外す（say は地の文で代用）。
// ルールはシステムプロンプトに入れてあるので get_rules も外す（小さなモデルが読み直しを繰り返すため）
const HIDDEN = new Set(["get_state", "get_screenshot", "new_game", "battle_state", "get_rules", "finish_recording", "recording_info"]);
const mcpTools = (await mcp.listTools()).tools;
const tools = mcpTools.filter(t => !HIDDEN.has(t.name)).map(t => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: { type: "object", properties: {}, ...t.inputSchema } },
}));

const TOOL_NAMES = new Set(tools.map(t => t.function.name));
// 録画しているなら、その開始時刻をプレイログに入れる（以降の行に「録画の開始からの時間」が付き、字幕を動画に合わせられる）
{ const ri = (await tool("recording_info").catch(() => null))?.json; if (ri?.recording) plog.setVideo(ri.t0, { name: ri.name, lag: ri.lag ?? 200 }); }
// 既定のオート戦闘では battle_* ツールが無い（サーバーを -- --manual-battle で起動したときだけ1隻ずつ操作する）
const MANUAL_BATTLE = TOOL_NAMES.has("battle_attack");
// 文字で書かれたツール呼び出し（dismiss_dialog()・call:name{…}・say{text:「…」} など）を拾い、字幕からは記法を外す（talk.mjs）
// 渡していないツール（get_state など）も拾って字幕から外す。実行はせずに断る
const { cleanTalk, splitReply } = makeTalk({ toolNames: mcpTools.map(t => t.name), name: NAME });

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
- 操作と一緒に話すときは、その操作ツールの say 引数にセリフを書く（say だけを先に呼ぶと、そのぶん1手遅くなる）。
- 操作の返り値の「のこりの手」に、いまの資金で払える内政と、まだ動かしていない艦隊が出る。資金を使ったあと・艦隊を動かしたあとの次の手は、そこから選ぶ（最初の状況テキストは古くなっている）。「打てる手はもうありません」と出たら end_turn。
- 通信が届いたら内容をひとことで紹介する。通信は次の操作で自動的に閉じるので、dismiss_dialog は呼ばなくてよい。
${MANUAL_BATTLE ? `- 戦闘中は、攻撃候補（予測ダメージつき）と移動先から1隻ずつ battle_attack / battle_move を選ぶ。動かしたくない艦（傷ついていて前に出したくない・射程外で近づくと不利など）は battle_wait で待機させる。全艦が動く（待機も含む）と自動で敵の番になるので、「敵の動きを見る」ために battle_end_phase を使わない。終わったら battle_close。
- 惑星の攻略戦では、中枢と防衛衛星はその場から動かない。待っていても撃たれるだけなので、毎ターン近づいて攻撃する。中枢は爆装（射程1）でしか壊せないので、爆装を持つ艦を中枢の隣まで進める（深淵の巣の中枢はセラフ級の爆装でしか壊せない）。` : `- 戦闘はオートで進む。攻め込む（move_fleet）か襲われると、戦闘は自動で決着して「出来事」に結果が出る。結果をひとこと実況する。
- あなたの仕事は戦う前の準備：勝てる相手を選ぶ、傷ついた艦隊は修理してから出す、惑星の攻略には爆装を持つ艦を入れる（中枢は爆装でしか壊せない。深淵の巣の中枢はセラフ級の爆装でしか壊せない）、相手に合わせて陣形を選ぶ（移動先の「陣形の目安」）、旗艦は打たれ強い艦にする。オートの戦い方はルールの「オートの戦い方」のとおりで、改装の配分がそのまま戦い方になる。`}
- IDは状況テキストに書かれた数字だけを使う（艦隊は「ID」の後ろの数字、星は名前の前の数字）。断られたときは、理由と一緒に出る「選べるもの」から選び直す。同じ操作を繰り返さない。

${rules}
${USE_NOTES ? `\n${notesPrompt(notes, NOTES_CHARS)}` : ""}`.trimEnd();

/* ---------- 会話の長さの見積もり（ターンをまたいで続けるか、作り直すかを決める） ----------
 * 最後の返事の usage（prompt_tokens + completion_tokens）に、そのあと足したメッセージの字数×（トークン/字）を足す。
 * トークン/字は、送った字数（ツールの定義も含む）と prompt_tokens から測り、少し多めに見る。usage が無いサーバーでは 1字=1トークンで数える */
const TOOLS_CHARS = JSON.stringify(tools).length;
const charsOf = (ms) => ms.reduce((t, m) => t + (typeof m.content === "string" ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
const sizeOf = {
  last: null, perChar: null, // perChar：トークン/字（まだ測っていなければ null で、1字=1トークンとして数える）
  seen(messages, usage) {
    if (!usage?.prompt_tokens) { this.last = null; return; }
    this.last = { messages, count: messages.length, tokens: usage.prompt_tokens + (usage.completion_tokens ?? 0) };
    const r = usage.prompt_tokens / (charsOf(messages) + TOOLS_CHARS);
    if (r > 0.2 && r < 3) this.perChar = Math.max(this.perChar ?? 0, r * 1.1);
  },
  // messages を送ったときのトークン数の見積もり
  of(messages) {
    const l = this.last;
    if (l && messages.length >= l.count && l.messages.every((m, i) => messages[i] === m)) return l.tokens + Math.ceil(charsOf(messages.slice(l.count)) * (this.perChar ?? 1));
    return Math.ceil((charsOf(messages) + TOOLS_CHARS) * (this.perChar ?? 1));
  },
};
/* コンテキスト長：--ctx がなければ Ollama に聞く（読み込み中のモデルの context_length。古い Ollama ならモデルの num_ctx）。分からなければ 0 */
let ctxAsked = false;
async function detectCtx() {
  if (ctxAsked || !KEEP || MANUAL_BATTLE) return;
  ctxAsked = true;
  if (CTX) {
    log(`コンテキスト長 ${CTX}（--ctx）：収まる間はターンをまたいで会話を続けます`);
    const real = llm.loaded?.ctx;
    if (real && real < CTX) log(`  ⚠ Ollama が実際に確保したコンテキスト長は ${real} で、--ctx ${CTX} より短いので、あふれた分は古い会話から切り捨てられます`);
    plog.write("ctx", { ctx: CTX, ...(real ? { loaded: real } : {}) }); return;
  }
  // 読み込み中のモデルの実際の長さ（/api/ps）。古い Ollama で分からなければ Modelfile の num_ctx（/api/show）
  CTX = (await checkLoaded())?.ctx || llm.info?.numCtx || 0;
  log(CTX ? `コンテキスト長 ${CTX}：収まる間はターンをまたいで会話を続けます` : "コンテキスト長が分からないので、毎ターン会話を作り直します（--ctx <トークン数> で指定すると続けられます）");
  plog.write("ctx", { ctx: CTX || null });
}

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
  if (withTools) sizeOf.seen(messages, data.usage);
  msg.usage = data.usage ?? null;
  // content を配列で返すサーバーもある
  if (Array.isArray(msg.content)) msg.content = msg.content.map(c => c.text ?? "").join("");
  // 返事は加工する前の全文を残す（考えた部分を別の欄で返すサーバーもある）
  plog.write("llm", { kind: withTools ? "play" : "reflect", sec: Math.round(sec * 10) / 10, content: msg.content ?? "",
    ...(msg.reasoning_content || msg.reasoning ? { reasoning: msg.reasoning_content || msg.reasoning } : {}),
    ...(msg.tool_calls?.length ? { calls: msg.tool_calls.map(c => ({ name: c.function?.name, arguments: c.function?.arguments })) } : {}),
    ...(data.usage ? { usage: data.usage } : {}), finish: data.choices[0].finish_reason ?? null });
  return msg;
}
const llmError = (message, fatal) => Object.assign(new Error(message), { fatal });

/* ツール結果をのあ向けに短くする。
 * 作戦卓では、状況テキストを付け直さずに「のこりの手」（いま払える内政・未行動の艦隊。game-api.js の next）だけを付ける。
 * 以前は戦闘や通信のたびに状況テキスト全体を付け直し、古いものを縮めていたが、会話の前のほうを書き換えると
 * ローカルLLMがプロンプト全体を読み直す（実測で1回 約10秒。読み直しがなければ 約1.4秒）ので、会話は後ろに足すだけにする。
 * 手動戦闘（--manual-battle）では盤面が要るので、これまでどおり盤面のテキストに置き換え、古くなったとき用の縮めた版（short）も返す */
const DIALOG_MAX = 700;
async function digest(name, r) {
  const j = r.json;
  if (!j || typeof j !== "object" || !("ok" in j)) return { content: r.text.slice(0, 6000), short: null };
  const lines = [`${j.ok ? "成功" : "失敗"}：${j.message}`];
  if (j.events?.length) lines.push("出来事：\n " + j.events.slice(-12).join("\n "));
  for (const d of j.dialogs ?? []) lines.push(`届いていた通信（閉じました）：\n${d.slice(0, DIALOG_MAX)}`);
  // 戦闘中（手動戦闘）と、戦闘を閉じて作戦卓に戻ったときは、最新の状況テキストをつける
  if (j.ok && (j.mode === "battle" || j.mode === "battle_ended" || (name === "battle_close" && j.mode === "map"))) {
    const short = [lines[0], ...(j.events?.length ? ["出来事：\n " + j.events.slice(-4).join("\n ")] : []), OLD_NOTE].join("\n");
    return { content: [...lines, await summary()].join("\n"), short };
  }
  if (j.dialog) lines.push(`通信が届きました（次の操作で自動的に閉じます。dismiss_dialog は不要）：\n${j.dialog.text.slice(0, DIALOG_MAX)}`);
  if (j.next) lines.push(j.next);
  else if (j.ok && j.funds != null) lines.push(`資金${j.funds}`);
  return { content: lines.join("\n"), short: null };
}
/* 手動戦闘では盤面のテキストが貯まっていくので、最新の1つだけ全文で送り、古いものは縮める（オート戦闘では縮めるものがなく、会話は後ろに足すだけ）。
 * 前のターンから続けている会話（keepFrom より前）は縮めない：送るプロンプトの先頭が変わると、Ollama が全部を読み直すため */
const OLD_NOTE = "（このときの状況テキストは省略。最新の状況は後ろのメッセージにあります）";
const shortOf = new WeakMap();
let keepFrom = 0;
function slim(messages) {
  let last = -1;
  messages.forEach((m, i) => { if (shortOf.has(m)) last = i; });
  return messages.map((m, i) => i >= keepFrom && i < last && shortOf.has(m) ? { ...m, content: shortOf.get(m) } : m);
}

/* ---------- 自動進行（のあが詰まったときの保険） ---------- */
async function autopilot(reason = "") {
  log("自動進行に切り替えます");
  plog.write("auto", { reason });
  autoBy = true;
  try { return await autopilotSteps(); } finally { autoBy = false; }
}
async function autopilotSteps() {
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

/* ---------- ツール名のゆれ ---------- */
// 「:build_ship」のように記号が付いた名前は記号を外す。実際に出た無い名前（replace_ship）は、同じ意味の呼び出しに読み替える
const fixName = (n) => String(n ?? "").replace(/^[^A-Za-z_]+|[^A-Za-z0-9_]+$/g, "");
const ALIAS = { replace_ship: ["build_ship", { replace: true }] };

/* ---------- 前のターンにしたこと ----------
 * 次のターンの最初に「前のターンにしたこと」を渡す（会話を作り直すとき）。以前は前のターンの最初のセリフを渡していたが、
 * 小さなモデルはそれをそのまま繰り返し、採掘所のある星に3ターン続けて採掘所を建てようとした（2026-11-16 のログ）。
 * 意図ではなく、実際に成功した操作と戦闘の結果だけを書く */
let recap = "", done = [];
function noteDone(name, args, j) {
  if (!j?.ok || QUIET.has(name)) return;
  const bs = (j.battles ?? []).map(b => `${b.title}：${b.result}`);
  if (name === "end_turn") { if (bs.length) done.push(`ターン終了後の戦闘（${bs.join("、")}）`); return; }
  const m = String(j.message ?? "").split(/[。：（]/)[0].trim();
  if (m) done.push(`${name === "invest_research" ? "研究に" : ""}${m}${bs.length ? `（${bs.join("、")}）` : ""}`);
}
function takeRecap(turn, auto) {
  const t = done.length ? done.join("、") : "なし";
  done = [];
  const s = `前のターン（ターン${turn}）にしたこと：${t.length > 400 ? t.slice(0, 400) + "…" : t}${auto ? "（途中から自動で進めました）" : ""}`;
  return s;
}

/* ---------- 会話（ターンをまたいで続ける） ---------- */
let convo = null, convoTurns = 0;
const RESERVE = 3000; // 1ターンのあいだに会話が伸びる分（2026-11-16 のログで最大 約2,500トークン）
const START = "今の状況です。操作を始めてください。";
function freshTurn(text) {
  const first = { role: "user", content: text };
  shortOf.set(first, `${text.split(START)[0]}${START}\n${OLD_NOTE}`);
  convoTurns = 1; keepFrom = 0;
  return [{ role: "system", content: SYSTEM() }, first];
}
async function startTurn(turn) {
  const sum = await summary();
  // 続ける：前のターンの会話の後ろに、新しい状況を足すだけ（前のメッセージは書き換えない）
  if (KEEP && CTX && convo && !MANUAL_BATTLE && convoTurns < KEEP_TURNS && convo[0].content === SYSTEM()) {
    const add = { role: "user", content: `【ターン${turn}】前のターンが終わりました。ここまでの状況テキストと「のこりの手」は古くなっています（資金・艦隊・星が変わっています）。下の新しい状況を見てください。\n${START}\n\n${sum}` };
    const est = sizeOf.of([...convo, add]);
    if (est + RESERVE <= CTX * 0.9) {
      keepFrom = convo.length; convo.push(add); convoTurns++;
      plog.write("context", { keep: true, turns: convoTurns, est });
      return convo;
    }
    plog.write("context", { keep: false, est, ctx: CTX });
  }
  return freshTurn(`${recap ? `${recap}\n\n` : ""}${START}\n\n${sum}`);
}
/* ターンの途中でコンテキストがあふれそうになったら、いまの状況で作り直す（会話を続けると長くなるので、その保険） */
async function compactIfLong(messages) {
  if (!CTX || sizeOf.of(messages) <= CTX * 0.9) return messages;
  log("会話が長くなったので、いまの状況で作り直します");
  plog.write("context", { compact: true, est: sizeOf.of(messages), ctx: CTX });
  const head = done.length ? `このターンにしたこと：${done.join("、")}\n\n` : "";
  return freshTurn(`${head}（会話が長くなったので、まとめ直しました。このターンの続きです）\n${START}\n\n${await summary()}`);
}

/* ---------- 1ターン ---------- */
let turnTalk = "";
async function playTurn(turn) {
  turnTalk = "";
  let messages = await startTurn(turn);
  convo = null; // 最後まで普通に終わったターンだけ、次のターンに続ける
  let ended = false, over = false, idle = 0, empty = 0, wasted = 0, lastName = "", auto = false;
  // 考える回数は、作戦卓ではこのターンの合計、戦闘では1戦ごとに数える（攻める戦闘と防衛戦が重なっても途中で自動進行にならないように）
  let step = 0, mapSteps = 0, battleSteps = 0, inBattle = false;
  while (mapSteps < MAX_STEPS && wasted < 6) {
    if (inBattle && battleSteps >= MAX_STEPS) {
      // この戦闘だけ自動で片付けて、作戦卓の続きは本人に戻す
      log(`この戦闘で ${MAX_STEPS} 回考えたので、残りの戦闘を自動で片付けます`);
      const s = await autopilot(`この戦闘で ${MAX_STEPS} 回考えた`); auto = true; inBattle = false;
      if (s.over || ended) return { st: s, auto };
      const back = { role: "user", content: `残りの戦闘は自動で片付けました。作戦卓の操作を続けてください。\n\n${await summary()}` };
      shortOf.set(back, `残りの戦闘は自動で片付けました。\n${OLD_NOTE}`);
      messages.push(back);
      continue;
    }
    if (inBattle) battleSteps++; else mapSteps++;
    step++;
    messages = await compactIfLong(messages);
    plog.sentMessages(messages);
    const msg = await chat(slim(messages));
    if (step === 1) { await checkLoaded().catch(() => {}); await detectCtx().catch(() => {}); } // 最初の返事でモデルが読み込まれてから聞く
    // 地の文は1行、文字で書かれた say{text:「…」}・say "…" は1件ずつ字幕にする（生の記法や、end_turn だけの行のようなツール名は出さない）
    const { lines, calls: written } = splitReply(stripThink(msg.content));
    const talk = lines.join("\n");
    if (talk && !turnTalk) turnTalk = talk.slice(0, 200);
    for (const line of lines) { log(`${NAME}：` + line); await say(line.slice(0, 160)); }
    let calls = msg.tool_calls ?? [];
    if (!calls.length && (calls = written).length) log(`  （文字で書かれたツール呼び出しを実行します：${calls.map(c => c.function.name).join(", ")}）`);
    if (!calls.length && !talk) {
      /* 中身が空の返事（話さず、ツールも呼ばない）。2026-11-16 のログでは 約50トークン出したのに中身が空、が4回続いてターンが自動で終わった。
       * 空の返事は会話に積まない（積むと、空の返事を続けやすくなる）。1回目はそのまま聞き直し（会話が同じなので読み直しはない）、
       * 2回目は「のこりの手」を見せて手を選ばせ、3回目で自動進行に切り替える */
      empty++;
      plog.write("empty", { n: empty, tokens: msg.usage?.completion_tokens ?? null });
      if (empty >= 3) break;
      if (empty === 2) {
        const nx = (await tool("get_next").catch(() => null))?.text || "";
        messages.push({ role: "user", content: `返事が空でした。次の手をツールで1つ呼んでください（セリフはそのツールの say 引数に）。打てる手がなければ end_turn。${nx ? `\n${nx}` : ""}` });
      } else log("  （空の返事だったので、もう一度聞きます）");
      continue;
    }
    empty = 0; // 「空の返事が3回続いたら」なので、話した返事でも数え直す
    // content は必ず文字列にする（null だと Ollama が「invalid message content type: <nil>」の 400 で断る）
    messages.push({ role: "assistant", content: talk, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      if (++idle >= 3) break;
      const nx = ended ? "" : (await tool("get_next").catch(() => null))?.text || "";
      messages.push({ role: "user", content: ended ? "状況を見て、残りの戦闘や通信を片付けてください。" : `ツールで操作を続けてください。やることが終わったら end_turn。${nx ? `\n${nx}` : ""}` });
      continue;
    }
    idle = 0;
    for (const c of calls) {
      c.id ||= `call_${step}_${Math.random().toString(36).slice(2, 8)}`;
      let args = c.function.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { args = {}; } }
      if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
      if (!TOOL_NAMES.has(c.function.name)) {
        let n = fixName(c.function.name);
        if (ALIAS[n]) { args = { ...args, ...ALIAS[n][1] }; n = ALIAS[n][0]; }
        if (TOOL_NAMES.has(n)) c.function.name = n; // 会話に残る名前も直す（次の返事でまた同じ名前を書かないように）
      }
      log(`→ ${c.function.name} ${JSON.stringify(args)}`);
      // 渡していないツールや、同じ情報の取り直しは実行せずに次の手を促す（読み直しのループを防ぐ）
      const refuse = !TOOL_NAMES.has(c.function.name)
        ? `失敗：${c.function.name} は使えません。ルールはシステムプロンプトに、今の状況は最初のメッセージに書いてあります。使えるツール：${[...TOOL_NAMES].join("、")}`
        : c.function.name === "get_summary" && lastName === "get_summary" ? "状況はさっきと同じです。操作のツールを選んでください。" : null;
      lastName = c.function.name;
      if (refuse) { wasted++; log("  ✗ " + refuse.split("。")[0]); plog.write("refuse", { name: c.function.name, args, reason: refuse.split("。")[0] }); messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: refuse }); continue; }
      if (c.function.name !== "get_summary") wasted = 0;
      if (c.function.name === "say") {
        // say ツールを直接呼んだとき：地の文と同じく整えて字幕に出し、プレイログのセリフにも残す
        const r = args?.text ? await say(args.text, args.seconds ? { seconds: args.seconds } : {}) : null;
        if (r && !turnTalk) turnTalk = cleanTalk(args.text).slice(0, 200);
        // 結果には、次は操作と一緒に話すよう添える（say だけの返事が1ゲーム41回・LLM の時間の2割あった。2026-11-16 のログ）
        messages.push({ role: "tool", tool_call_id: c.id, name: "say", content: r ? "表示しました。続けて操作のツールを呼んでください（話しながら操作するときは、その操作の say 引数にセリフを書くと1回で済みます）" : "失敗：text が空です。" });
        continue;
      }
      // 操作ツールの say 引数（ひとこと）：地の文と同じく整えて字幕に出し、プレイログのセリフにも残す。サーバーには渡さない（二重に出さない）
      if (typeof args.say === "string") {
        const line = args.say; delete args.say;
        if (await say(line.slice(0, 160)) && !turnTalk) turnTalk = cleanTalk(line).slice(0, 200);
      } else delete args.say;
      if (c.function.name === "battle_end_phase") {
        const stop = await checkEndPhase();
        if (stop) { log("  ✗ まだ動ける艦があるので、フェイズ終了を止めました"); plog.write("refuse", { name: c.function.name, args, reason: "まだ動ける艦があるので、フェイズ終了を止めました" }); messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: stop }); continue; }
      } else if (c.function.name.startsWith("battle_")) endPhaseNagged = false;
      const r = await tool(c.function.name, args);
      noteDone(c.function.name, args, r.json);
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
      // 通信が開いていても次のターンへ進む（次のターンの状況テキストに出て、最初の操作で自動的に閉じる）
      const s = (await tool("get_state")).json;
      if (!s.battle) { if (!auto) convo = messages; return { st: s, auto }; }
    }
  }
  // 上限まで来た・黙った：残りを自動で片付けてターンを終える
  let s = await autopilot(mapSteps >= MAX_STEPS ? `このターンで ${MAX_STEPS} 回考えた` : wasted >= 6 ? "使えない操作や読み直しが続いた" : empty >= 3 ? "空の返事が続いた" : "操作をしなくなった");
  if (!ended && !s.over) { autoBy = true; await tool("end_turn").then(r => noteDone("end_turn", {}, r.json)).finally(() => { autoBy = false; }); s = await autopilot("ターン終了のあとの戦闘や通信"); }
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
        chat: async (m) => { plog.sentMessages(m, "reflect"); return (await chat(m, { withTools: false })).content ?? ""; },
        name: NAME, persona, notes, journal, outcome, maxChars: NOTES_CHARS, stripThink,
      });
      if (r.lessons) { notes.lessons = r.lessons; log("反省メモ：\n  - " + r.lessons.join("\n  - ")); }
      else log("反省メモをうまく書けなかったので、前のメモを残します");
      plog.write("reflect", { outcome, lessons: r.lessons, comment: r.comment || null });
      if (r.comment && !stopping) await say(r.comment);
    } catch (e) { log("振り返りに失敗：" + e.message); plog.write("error", { message: "振り返りに失敗：" + e.message }); }
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
  plog.write("stop", {});
  await writeNotes("プレイを途中でやめたところ", "途中終了").catch(e => log(e.message));
  plog.write("end", { outcome: "停止", turn: lastTurn });
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
    plog.write("over", { result: st.over, turn: st.turn });
    if (reflectedAt !== -1) await writeNotes(`ゲームが${outcomeText(st.over)}で終わったところ`, outcomeText(st.over));
    reflectedAt = -1;
    if (!LOOP) break;
    await tool("new_game", { confirm: true }); recap = ""; done = []; convo = null;
    journal = new Journal(); reflectedAt = 0;
    st = (await tool("get_state")).json; journal.begin(st);
    plog.write("newgame", {});
  }
  if (stopping) await new Promise(() => {});
  const turn = st.turn;
  log(`=== ターン${turn} 資金${st.funds} ===`);
  plog.write("turn", { turn, funds: st.funds }); lastTurn = turn;
  let auto = false;
  try { ({ st, auto } = await playTurn(turn)); llmErrors = 0; }
  catch (e) {
    if (stopping) await new Promise(() => {});
    log("エラー：" + e.message);
    plog.write("error", { message: e.message, ...(e.fatal ? { fatal: true } : {}) });
    if (/^LLM API/.test(e.message)) {
      if (/^LLM API に接続できません/.test(e.message)) { log("ローカルLLMに接続できないため止めます（--base-url と --model を確認）"); llmDown = true; break; }
      if (e.fatal) { log("LLMのエラーで止めます：モデル名と、ツール呼び出しに対応したモデルかを確認してください"); llmDown = true; break; }
      if (++llmErrors >= 3) { log("LLMのエラーで止めます：3ターン続けて失敗しました（モデルとコンテキストの長さを確認）"); llmDown = true; break; }
      log("その場かぎりのエラーとみなして、このターンは自動で進めます");
    }
    convo = null; // 途中で止まった会話は続けない
    st = await autopilot("エラーのあと"); if (!st.over) { autoBy = true; await tool("end_turn").then(r => noteDone("end_turn", {}, r.json)).finally(() => { autoBy = false; }); st = await autopilot("ターン終了のあとの戦闘や通信"); }
    auto = true;
  }
  recap = takeRecap(turn, auto);
  journal.endTurn(turn, st, { talk: turnTalk, auto });
  if (!st.over && REFLECT_EVERY > 0 && journal.turns.length - reflectedAt >= REFLECT_EVERY)
    await writeNotes(`ゲームの途中（ターン${turn}まで）`, null);
}
if (st.over && reflectedAt !== -1) { log(`ゲーム終了：${st.over}`); plog.write("over", { result: st.over, turn: st.turn }); await writeNotes(`ゲームが${outcomeText(st.over)}で終わったところ`, outcomeText(st.over)); }
else if (!st.over && !llmDown) await writeNotes(`プレイを途中でやめたところ（ターン${st.turn - 1}まで）`, "途中終了");
else if (!st.over && llmDown && WRITE_NOTES && journal.turns.length) {
  notes.records.unshift(recordLine({ date: new Date().toLocaleDateString("sv-SE"), model: MODEL, outcome: "途中終了", journal }));
  await saveNotes(NOTES_FILE, NAME, notes);
}
// 録画を仕上げてから閉じる（MCP の close はサーバーを2秒で止め、Windows ではその場で強制終了になるため）
const videos = (await tool("finish_recording").catch(() => null))?.json?.videos ?? [];
plog.write("end", { outcome: st.over === "win" ? "勝利" : st.over === "lose" ? "敗北" : llmDown ? "LLMエラー" : Number.isFinite(TURNS) && journal.turns.length >= TURNS ? "ターン上限" : "途中終了",
  turn: lastTurn ?? st.turn ?? null, ...(videos.length ? { video: path.basename(videos.at(-1)) } : {}) });
// 録画の隣に同じ名前の字幕（.srt）を置く
if (LOG_FILE) for (const v of videos) { const f = await subtitlesBeside(LOG_FILE, v).catch(() => null); if (f) log(`字幕を書き出しました：${f}`); }
await mcp.close();
process.exit(0);
