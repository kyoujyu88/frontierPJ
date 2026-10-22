/* 反省メモの動作確認：にせのLLM（OpenAI互換API）を立てて ai-player.mjs を走らせ、
 * 1回目に書いた反省メモが2回目の最初のプロンプトに入るかを確かめる。本物のLLMは要らない。
 *   node notes-test.mjs
 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadNotes } from "./notes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LESSON = "爆装を2以上積んだ艦隊で惑星を攻める";
let prompts = [], reflections = 0;

const reply = (message) => ({ choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }] });
const llm = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const b = JSON.parse(body);
  let out;
  if (!b.tools) {
    // 振り返り：考える部分つき・余計な前置きつきで返して、箇条書きだけ拾えるか見る
    reflections++;
    if (process.env.SHOW_REFLECT) console.log(b.messages.at(-1).content);
    out = reply({ content: `<think>うーん</think>\n反省します！\n- ${LESSON}\n- 状況テキストのIDだけを使う\n1. 研究に早めに投資する\n感想：次こそ勝つよ！` });
  } else {
    const last = b.messages.at(-1);
    if (last.role === "user" && last.content.includes("今の状況です")) {
      prompts.push(b.messages[0].content);
      out = reply({ content: "ターンを終えるよ！", tool_calls: [{ id: `c${prompts.length}`, type: "function", function: { name: "end_turn", arguments: "{}" } }] });
    } else out = reply({ content: "様子を見るね" });
  }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
});
await new Promise(r => llm.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${llm.address().port}/v1`;
const notesFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "notes-")), "テスト.md");

function run(turns, extra = [], serverExtra = []) {
  return new Promise((ok, ng) => {
    const p = spawn(process.execPath, [path.join(HERE, "ai-player.mjs"), "--model", "mock", "--base-url", BASE, "--name", "テスト",
      "--notes", notesFile, "--turns", String(turns), "--max-steps", "4", ...extra, "--", "--headless", "--pace", "0", ...serverExtra], { stdio: ["ignore", "pipe", "inherit"] });
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

console.log("\n" + (await fs.readFile(notesFile, "utf8")));
llm.close();
process.exit(failed ? 1 : 0);
