/* 反省メモの動作確認：にせのLLM（OpenAI互換API）を立てて ai-player.mjs を走らせ、
 * 1回目に書いた反省メモが2回目の最初のプロンプトに入るかを確かめる。本物のLLMは要らない。
 * プレイログ（playlog.mjs）が残るか、録画に合わせた字幕（.srt）が書き出されるかも確かめる。
 *   node notes-test.mjs
 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadNotes } from "./notes.mjs";
import { readLog, toSrt, toChapters, listLogs } from "./playlog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LESSON = "爆装を2以上積んだ艦隊で惑星を攻める";
let prompts = [], reflections = 0;
// LLM のふるまい：normal／empty（黙った返事を返す）／flaky（2ターン目の最初だけ 400）／notools（ツール非対応の 400）／always400（毎回 400）
// ／play（ひとこと付きの操作・記号つきの名前・無い名前・名前で書いたIDを混ぜて呼ぶ）
let mode = "normal", emptySent = false;
// 会話の書き換えの見張り：同じターンの中で、前に送ったメッセージが次の問い合わせで変わっていたら数える（変わるとローカルLLMがプロンプト全体を読み直す）
let lastMsgs = null, rewrites = 0, toolSeen = [], firstUser = [];
const callOf = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

const reply = (message) => ({ choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }] });
const llm = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const b = JSON.parse(body);
  const fail = (message) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } })); };
  // Ollama と同じく、content が文字列でも配列でもないメッセージ（ツール呼び出しなし）は断る
  if (b.messages.some(m => typeof m.content !== "string" && !Array.isArray(m.content) && !m.tool_calls)) return fail("invalid message content type: <nil>");
  if (b.messages.some(m => m.role === "assistant" && m.content === "" && !m.tool_calls)) emptySent = true;
  if (b.tools && mode === "notools") return fail("registry.ollama.ai/library/gemma3:latest does not support tools");
  if (b.tools && mode === "always400") return fail("the request exceeds the available context size");
  // flaky：2ターン目の最初の問い合わせだけ断る（prompts には1ターン目の分だけが入っている）
  if (b.tools && mode === "flaky" && String(b.messages.at(-1).content).includes("今の状況です") && prompts.length === 1) { prompts.push("(400)"); return fail("the request exceeds the available context size"); }
  let out;
  if (!b.tools) {
    // 振り返り：考える部分つき・余計な前置きつきで返して、箇条書きだけ拾えるか見る
    reflections++;
    if (process.env.SHOW_REFLECT) console.log(b.messages.at(-1).content);
    out = reply({ content: `<think>うーん</think>\n反省します！\n- ${LESSON}\n- 状況テキストのIDだけを使う\n1. 研究に早めに投資する\n感想：次こそ勝つよ！` });
  } else {
    const last = b.messages.at(-1);
    const starts = last.role === "user" && last.content.includes("今の状況です");
    if (!starts && lastMsgs && JSON.stringify(b.messages.slice(0, lastMsgs.length)) !== JSON.stringify(lastMsgs)) rewrites++;
    lastMsgs = b.messages;
    if (starts) firstUser.push(last.content); else toolSeen.push(...b.messages.filter(m => m.role === "tool"));
    if (starts) {
      prompts.push(b.messages[0].content);
      out = mode === "empty" ? reply({ content: "" }) // 黙った返事（話さず、ツールも呼ばない）
        : mode === "play" ? reply({ content: "", tool_calls: [
          callOf("p1", "invest_research", { amount: 100, say: "研究を進めるよ！" }),           // 30刻みでない額・ひとこと付き
          callOf("p2", ":build_facility", { planet_id: "1", facility: "採掘所" }),               // 記号つきの名前・文字列の数字・日本語の施設名
          callOf("p3", "move_fleet", { fleet_id: "第2艦隊", to: 5 }),                           // 艦隊を名前で書く（ID は 6。名前の番号 2 をIDとしては読まない）。中立の星へ入って攻略戦になる
          callOf("p4", "replace_ship", { fleet_id: 1, class_index: 0 })] })                     // 無い名前（build_ship の replace=true に読み替える。置換する艦が無いので断られる）
        : mode === "say"
        // say を地の文に書く（gemma4 で実際に出た形）＋ say ツールの直呼び
        ? reply({ content: "say{text:「研究に投資するよ！」} say{text:「カルセは要塞だし、守りを固めよう。」}", tool_calls: [
          { id: `s${prompts.length}`, type: "function", function: { name: "say", arguments: JSON.stringify({ text: "「第1艦隊、進軍！」" }) } },
          { id: `c${prompts.length}`, type: "function", function: { name: "end_turn", arguments: "{}" } }] })
        // ツール名だけを地の文に書く（2026-11 の録画で字幕に「end_turn」と出た形）。ツール呼び出しは付けない
        : mode === "bare" ? reply({ content: "内政はおしまい！\nend_turn" })
        : reply({ content: "ターンを終えるよ！", tool_calls: [{ id: `c${prompts.length}`, type: "function", function: { name: "end_turn", arguments: "{}" } }] });
    } else out = mode === "empty" || mode === "play" ? reply({ content: "", tool_calls: [callOf(`e${toolSeen.length}`, "end_turn", {})] }) : reply({ content: "様子を見るね" });
  }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
});
await new Promise(r => llm.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${llm.address().port}/v1`;
const notesFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "notes-")), "テスト.md");
const logDir = path.join(path.dirname(notesFile), "logs"); // テストのログは mcp/logs に混ぜない
let logNo = 0;

function run(turns, extra = [], serverExtra = []) {
  return new Promise((ok, ng) => {
    const p = spawn(process.execPath, [path.join(HERE, "ai-player.mjs"), "--model", "mock", "--base-url", BASE, "--name", "テスト",
      "--notes", notesFile, "--turns", String(turns), "--max-steps", "4", "--log-dir", logDir, "--log-name", `run${++logNo}`, ...extra, "--", "--headless", "--pace", "0", ...serverExtra], { stdio: ["ignore", "pipe", "inherit"] });
    let log = ""; p.stdout.on("data", d => { log += d; });
    p.on("exit", code => code === 0 ? ok(log) : ng(new Error(`exit ${code}\n${log}`)));
  });
}
let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "✓" : "✗"} ${what}`); if (!cond) failed++; };

// 1回目：4ターン。2ターンごとに振り返る
await run(4, ["--reflect-every", "2"]);
let n = await loadNotes(notesFile);
check(n.lessons.includes(LESSON), "1回目の反省メモが保存された");
check(n.lessons.length === 3 && !n.lessons.some(l => l.includes("感想")), "箇条書きだけを拾い、感想は入れない");
check(n.records.length === 1 && n.records[0].includes("途中終了") && n.records[0].includes("mock"), "戦績が1件残った");
check(reflections >= 2, `途中と終了時に振り返った（${reflections}回）`);
check(!prompts[0].includes(LESSON) && prompts.slice(2).some(p => p.includes(LESSON)), "途中の振り返りから、同じゲームの次のターンに反映された");
// プレイログ：1回目の記録が時刻つきで残っている
{
  const ev = await readLog(path.join(logDir, "run1.jsonl"));
  const count = (t) => ev.filter(e => e.type === t).length;
  check(ev[0]?.type === "start" && ev[0].name === "テスト" && ev[0].model === "mock" && ev.every(e => e.t && Number.isFinite(e.ms)), "プレイログ：最初に設定、各行に時刻");
  check(count("turn") === 4 && count("talk") >= 4 && ev.some(e => e.type === "talk" && e.text === "ターンを終えるよ！" && e.durMs > 0), `プレイログ：ターン区切りとセリフ（表示秒数つき）（ターン${count("turn")}・セリフ${count("talk")}）`);
  check(ev.some(e => e.type === "llm" && e.calls?.[0]?.name === "end_turn") && ev.some(e => e.type === "llm" && e.kind === "reflect" && e.content.includes("<think>")), "プレイログ：LLM の返事を加工前の全文で残す");
  const sys = ev.filter(e => e.type === "send" && e.role === "system" && e.kind === "play");
  check(sys.length === 2 && ev.some(e => e.type === "send" && e.role === "user" && e.content.includes("今の状況です")), `プレイログ：送った文（システムプロンプトは反省メモで変わったときだけ：${sys.length}回）`);
  check(ev.some(e => e.type === "tool" && e.name === "end_turn" && e.by === "ai" && e.ok === true), "プレイログ：操作と結果");
  check(count("reflect") >= 2 && ev.at(-1).type === "end" && ev.at(-1).outcome === "ターン上限", `プレイログ：振り返りと試行の終わり（${ev.at(-1).outcome}）`);
  const srt = toSrt(ev);
  check(/^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\nターンを終えるよ！\n/.test(srt), "プレイログ：SRT に書き出せる");
  check(/^0:00 .+\n(\d+:\d\d .+\n)*$/.test(toChapters(ev)) && toChapters(ev).includes("ターン"), "プレイログ：チャプターに書き出せる");
}

// 2回目：別のゲーム。最初のターンからメモが入っている
prompts = []; reflections = 0;
await run(2);
check(prompts[0].includes("前回までの反省メモ") && prompts[0].includes(LESSON), "次のゲームの最初のプロンプトに反省メモが入った");
check(prompts[0].includes("これまでの戦績：1回"), "戦績もプロンプトに入った");
n = await loadNotes(notesFile);
check(n.records.length === 2, "戦績が2件になった");

// 3回目：--notes-readonly は読むが書かない
const before = await fs.readFile(notesFile, "utf8");
prompts = []; reflections = 0;
await run(2, ["--notes-readonly"]);
check(prompts[0].includes(LESSON) && reflections === 0 && before === await fs.readFile(notesFile, "utf8"), "--notes-readonly はメモを読むだけ");

// 4回目：--no-notes は使わない
prompts = [];
await run(1, ["--no-notes"]);
check(!prompts[0].includes("反省メモ"), "--no-notes ではプロンプトに入らない");

// 5回目：ゲームが終わったら気づいて止まる（結果の画面を閉じても、新しいゲームを勝手に始めない）
// 主星以外をヴァルガ領にした練習用のゲームで、数ターンで負けさせる
const loseGame = path.join(path.dirname(notesFile), "lose-fast.html");
const html = await fs.readFile(path.join(HERE, "../game/frontier-war.html"), "utf8");
const i = html.lastIndexOf("</body>");
await fs.writeFile(loseGame, html.slice(0, i) + `<script>(()=>{const weak=()=>{for(const p of S.planets)if(p.id!==HOME&&p.id!==HIVE)p.owner="E";planet(HOME).def=planet(HOME).maxDef=1;S.fleets=S.fleets.filter(f=>f.side!=="P");render()};const ng=newGame;newGame=function(){ng();weak()};weak()})();</script>` + html.slice(i));
const log = await run(30, ["--reflect-every", "0"], ["--game", loseGame]);
n = await loadNotes(notesFile);
check(/ゲーム終了：lose/.test(log) && n.records[0]?.includes("敗北"), "負けたら「ゲーム終了」を出し、戦績に敗北が残る");
check((log.match(/=== ターン1 /g) || []).length === 1, "負けたあと新しいゲームを勝手に始めない");

// 録画つき：プレイログの時刻が録画の開始からの時間になり、動画の隣に同じ名前の字幕ができる
{
  const recDir = path.join(path.dirname(notesFile), "rec");
  await run(2, ["--no-notes"], ["--record", recDir, "--record-name", "録画テスト", "--no-record-audio"]);
  const ev = await readLog(path.join(logDir, `run${logNo}.jsonl`));
  const end = ev.at(-1), video = ev.find(e => e.type === "video");
  check(video?.t0 > 0 && ev.filter(e => e.type === "talk").every(e => e.vms >= 0), "録画つき：セリフに録画の開始からの時間が付く");
  check(end.type === "end" && end.video === "録画テスト.webm", `録画つき：試行の終わりに動画の名前（${end.video}）`);
  const srt = await fs.readFile(path.join(recDir, "録画テスト.srt"), "utf8").catch(() => "");
  check(srt.startsWith("\uFEFF1\n") && srt.includes("ターンを終えるよ！"), "録画つき：動画の隣に字幕（.srt）ができた");
  // コマンドでの取り出し
  const out = await new Promise((ok) => { const p = spawn(process.execPath, [path.join(HERE, "playlog.mjs"), "1", "--format", "vtt", "--dir", logDir], { stdio: ["ignore", "pipe", "inherit"] }); let o = ""; p.stdout.on("data", d => { o += d; }); p.on("exit", () => ok(o)); });
  check(out.startsWith("WEBVTT") && out.includes("<v テスト>ターンを終えるよ！"), "コマンド：node playlog.mjs 1 --format vtt");
  check((await listLogs(logDir))[0]?.video === "録画テスト.webm", "一覧：録画の名前が出る");
}

// 地の文に書かれた say{text:「…」} は1件ずつ字幕にし、生の記法は出さない。say ツールの直呼びもセリフに残る
{
  mode = "say";
  await run(1, ["--no-notes"]);
  const ev = await readLog(path.join(logDir, `run${logNo}.jsonl`));
  const talks = ev.filter(e => e.type === "talk").slice(0, 3); // end_turn のあとの「様子を見るね」は見ない
  check(!ev.some(e => e.type === "talk" && /say|[{}]/.test(e.text)) && JSON.stringify(talks.map(e => e.text)) === JSON.stringify(["研究に投資するよ！", "カルセは要塞だし、守りを固めよう。", "第1艦隊、進軍！"]),
    `say{text:…} を1件ずつ字幕にし、say ツールの直呼びもセリフに残る（${talks.map(e => e.text).join(" / ")}）`);
  check(talks[1].ms - talks[0].ms >= 1500 && talks[2].ms - talks[1].ms >= 1500, `続けて話すときは前のセリフを読める長さだけ待つ（${talks.slice(1).map((e, k) => e.ms - talks[k].ms).join("ms・")}ms）`);
  // 修正前のログ（記法つきのまま1件で残ったセリフ）も、字幕に書き出すときに分ける
  const old = toSrt([{ type: "talk", ms: 0, who: "のあ", durMs: 9000, text: "say{text:「研究にガッツリ投資！」} say{text:「守りを固めよう。」}" }]);
  check(!old.includes("say{") && /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n研究にガッツリ投資！\n\n2\n.+ --> 00:00:09,000\n守りを固めよう。\n$/.test(old), "修正前のログも SRT では1件ずつに分ける");
  mode = "normal";
}

// 括弧の付かないツール名だけの行（end_turn）は字幕に出さず、その操作を実行する
{
  mode = "bare";
  await run(1, ["--no-notes"]);
  const ev = await readLog(path.join(logDir, `run${logNo}.jsonl`));
  const talks = ev.filter(e => e.type === "talk").map(e => e.text);
  const ended = ev.find(e => e.type === "tool" && e.name === "end_turn");
  check(talks[0] === "内政はおしまい！" && !talks.some(t => /end_turn/.test(t)) && ended && ended.by !== "auto",
    `ツール名だけの行は字幕に出さずに実行する（セリフ：${talks.join(" / ")}・end_turn：${ended ? ended.by ?? "AI" : "なし"}）`);
  const old = toSrt([{ type: "talk", ms: 0, who: "のあ", durMs: 2000, text: "end_turn" }, { type: "talk", ms: 3000, who: "のあ", durMs: 2000, text: "これで end_turn するね" }]);
  check(/^1\n00:00:03,000 --> 00:00:05,000\nこれでターン終了するね\n$/.test(old), "修正前のログも SRT では操作名だけのセリフを外し、文の中の名前は置き換える");
  mode = "normal";
}

// 操作ミスを減らす仕組み：ひとこと付きの操作・寛容な引数・名前のゆれ・通信の自動クローズ・「のこりの手」。会話は後ろに足すだけ（書き換えない）
{
  mode = "play"; rewrites = 0; toolSeen = []; firstUser = [];
  await run(2, ["--no-notes"]);
  const ev = await readLog(path.join(logDir, `run${logNo}.jsonl`));
  const tools = ev.filter(e => e.type === "tool" && e.by === "ai"), t = (name) => tools.find(e => e.name === name);
  check(ev.some(e => e.type === "talk" && e.text === "研究を進めるよ！") && t("invest_research")?.ok && !("say" in t("invest_research").args), "操作ツールの say 引数は字幕とプレイログのセリフになり、操作には渡さない");
  check(/^90 投資/.test(t("invest_research")?.message ?? ""), `研究投資は30刻みに丸めて実行する（${t("invest_research")?.message}）`);
  check(t("build_facility")?.ok === true && !tools.some(e => e.name.startsWith(":")), "記号の付いたツール名（:build_facility）・文字列の数字・日本語の施設名でも通る");
  check(t("move_fleet")?.ok === true && /^第2艦隊 を /.test(t("move_fleet").message), `艦隊を名前で書いても、その名前の艦隊が動く（${t("move_fleet")?.message}）`);
  check(t("build_ship")?.ok === false && /旧式の艦がいません/.test(t("build_ship").message) && !ev.some(e => e.type === "refuse"), "無い名前 replace_ship は build_ship の置換に読み替える（断らない）");
  check(!tools.some(e => e.name === "dismiss_dialog") && /通信が届いています/.test(firstUser[0]) && !/通信が届いています/.test(firstUser[1] ?? "通信が届いています"), "最初の通信は dismiss_dialog なしで、次の操作のときに閉じる");
  const moved = toolSeen.find(m => m.name === "move_fleet")?.content ?? "";
  check(/のこりの手：資金\d+/.test(moved) && /自軍艦隊：/.test(moved) && /戦闘「/.test(moved) && !moved.includes("■惑星"), "戦闘のあとの返り値は、状況テキスト全体ではなく「のこりの手」と艦隊の残りを付ける");
  check(/払える内政：/.test(toolSeen.find(m => m.name === "build_ship")?.content ?? ""), "断られたときも「のこりの手」が付く");
  check(rewrites === 0 && toolSeen.length >= 5, `同じターンの中で、前に送ったメッセージを書き換えない（書き換え ${rewrites} 回）`);
  mode = "normal";
}

// 6回目以降：LLM のエラーの扱い（反省メモは使わない）
const stopLine = /LLMのエラーで止めます|接続できないため止めます/;
const turns = (log) => (log.match(/=== ターン\d+ /g) || []).length;
mode = "empty"; prompts = [];
let l = await run(3, ["--no-notes"]);
check(emptySent && !stopLine.test(l) && turns(l) === 3, "黙った返事のあとも 400 にならずに続く");
mode = "flaky"; prompts = [];
l = await run(3, ["--no-notes"]);
check(/エラー：LLM API 400/.test(l) && /このターンは自動で進めます/.test(l) && !stopLine.test(l) && turns(l) === 3, "その場かぎりの 400 はそのターンだけ自動で進めて続ける");
mode = "notools"; prompts = [];
l = await run(3, ["--no-notes"]);
check(/LLMのエラーで止めます/.test(l) && turns(l) === 1, "ツール非対応の 400 はすぐ止める");
mode = "always400"; prompts = [];
l = await run(6, ["--no-notes"]);
check(/3ターン続けて失敗/.test(l) && turns(l) === 3, "400 が3ターン続いたら止める");

console.log("\n" + (await fs.readFile(notesFile, "utf8")));
llm.close();
process.exit(failed ? 1 : 0);
