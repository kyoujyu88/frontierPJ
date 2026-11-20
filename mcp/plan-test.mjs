/* 作戦（plan.mjs と ai-player.mjs の set_plan）のテスト
 *   node plan-test.mjs        （npm run test:plan）
 * 前半は plan.mjs の関数だけ、後半はにせの LLM サーバーと本物のゲーム（ヘッドレス）で ai-player.mjs を動かす */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newPlan, applyPlan, checkPlan, planBlock, parseTargets, STALE_TURNS, PLAN_TOOL } from "./plan.mjs";
import { readLog, describe } from "./playlog.mjs";
import { statsOf, statsText } from "./logstats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (cond, what) => { console.log(`${cond ? "✓" : "✗"} ${what}`); if (cond) passed++; else failed++; };

/* ---------- plan.mjs ---------- */
const P = (id, name, owner, def = 20, maxDef = 40) => ({ id, name, owner, ownerLabel: { P: "自国", E: "ヴァルガ帝国", N: "中立", M: "異生体浸食" }[owner], def, maxDef });
const stOf = (owners, sit = {}) => ({ planets: [P(0, "リュネ", owners[0]), P(1, "カルセ", owners[1]), P(5, "ミラ", owners[2]), P(7, "ゼタ", owners[3])], situation: sit });

{
  const st = stOf(["P", "P", "N", "E"]);
  check(JSON.stringify(parseTargets([5, 7], st).ids) === "[5,7]" && JSON.stringify(parseTargets("5, 7", st).ids) === "[5,7]" && JSON.stringify(parseTargets("5ミラ→7", st).ids) === "[5,7]"
    && JSON.stringify(parseTargets(["5", "ゼタ"], st).ids) === "[5,7]" && JSON.stringify(parseTargets(7, st).ids) === "[7]" && JSON.stringify(parseTargets("[5,7]", st).ids) === "[5,7]",
    "攻める星：配列・カンマ区切り・矢印・名前・数1つ・角括弧つきの文字を読む");
  const u = parseTargets("5,99,なぞ", st);
  check(JSON.stringify(u.ids) === "[5]" && u.unknown.join() === "99,なぞ", "攻める星：無い星のIDや読めない名前は外して知らせる");
  check(parseTargets("0,1,5,7", st).ids.length === 3, "攻める星は3つまで");
}
{
  const plan = newPlan();
  const st = stOf(["P", "P", "N", "E"]);
  check(!applyPlan(plan, {}, { turn: 1, st }).ok && !applyPlan(plan, { long: "  " }, { turn: 1, st }).ok && plan.sets === 0, "set_plan：何も書いていなければ断り、数えない");
  const r = applyPlan(plan, { long: "北から攻める", short: "第1艦隊でミラ", targets: "0,5,7" }, { turn: 1, st });
  check(r.ok && plan.long === "北から攻める" && plan.short === "第1艦隊でミラ" && plan.targets.join() === "5,7" && plan.longTurn === 1 && plan.shortTurn === 1
    && /0リュネはもう自国の星なので外しました/.test(r.content) && /攻める順：5ミラ → 7ゼタ/.test(r.content) && r.changed.join() === "long,short,targets",
    "set_plan：長期・短期・攻める星を覚え、自国の星は外して知らせる");
  check(r.entry.targets[0].name === "ミラ" && r.entry.long === "北から攻める" && r.entry.turn === 1, "プレイログ用の形：星は名前つき");
  const r2 = applyPlan(plan, { short: "第1艦隊でミラ" }, { turn: 1, st });
  check(r2.ok && r2.changed.length === 0 && /前と同じ/.test(r2.content), "同じ文なら「前と同じ」（見直したことにはなる）");
  const r3 = applyPlan(plan, { short: "x" }, { turn: 1, st });
  check(!r3.ok && r3.refused && plan.short === "第1艦隊でミラ", `1ターンに書き直せるのは2回まで（3回目は断る）`);
  check(applyPlan(plan, { short: "y".repeat(300) }, { turn: 2, st }).ok && plan.short.length <= 101 && plan.shortTurn === 2 && plan.longTurn === 1, "次のターンにはまた書ける・長すぎる文は切る・変えない欄のターンはそのまま");
}
{
  // レビューの指摘：攻める星が1つも残らない targets・状態が取れないときは、前の攻める順を消さない
  const plan = newPlan();
  const st = stOf(["P", "P", "N", "E"]);
  applyPlan(plan, { targets: "5,7" }, { turn: 1, st });
  let r = applyPlan(plan, { targets: "99,なぞ" }, { turn: 1, st });
  check(r.ok && plan.targets.join() === "5,7" && !r.changed.includes("targets") && /攻める順は前のまま（5ミラ → 7ゼタ）/.test(r.content), "読めない星だけの targets では、前の攻める順を残す");
  r = applyPlan(plan, { targets: "0,1" }, { turn: 2, st });
  check(r.ok && plan.targets.join() === "5,7" && /もう自国の星なので外しました/.test(r.content) && /前のまま/.test(r.content), "自国の星だけの targets でも、前の攻める順を残す");
  r = applyPlan(plan, { targets: "3", short: "S" }, { turn: 2, st: null });
  check(r.ok && plan.targets.join() === "5,7" && plan.short === "S" && /いまは星を確かめられないので、攻める順は前のまま/.test(r.content), "状態が取れないときは targets を変えない（ほかの欄は覚える）");
  plan.targets.push(42);
  checkPlan(plan, st, 3);
  check(plan.targets.join() === "5,7", "盤面に無い星は、ターンの始まりに攻める順から外す");
  const lo = newPlan();
  applyPlan(lo, { long: "L" }, { turn: 1, st });
  const k = [2, 3, 4, 5].map(t => checkPlan(lo, st, t).cues.map(x => x.kind).join());
  check(k.join("|") === "stale|||stale" && /短期の作戦（このターンから2〜3ターンの手）がまだありません/.test(checkPlan(lo, st, 8).cues[0]?.text ?? ""), `長期だけの作戦なら、短期を書くよう${STALE_TURNS}ターンごとに促す（${k.join("|")}）`);
  const sk = newPlan();
  applyPlan(sk, { long: "L", short: "S" }, { turn: 1, st });
  const k2 = [2, 5, 6, 7, 8].map(t => checkPlan(sk, st, t).cues.map(x => x.kind).join());
  check(k2.join("|") === "|stale|||stale", `突き合わせを飛ばしたターン（3・4）があっても、短期の古さの合図は取りこぼさない（${k2.join("|")}）`);
}
{
  const plan = newPlan();
  let st = stOf(["P", "P", "N", "E"]);
  let c = checkPlan(plan, st, 1);
  check(c.cues.map(x => x.kind).join() === "none" && /まだありません。最初の手と同じ返事で set_plan/.test(planBlock(plan, st, c.cues)), "作戦がないときは書くよう頼む");
  applyPlan(plan, { long: "L", short: "S", targets: "5,7" }, { turn: 1, st });
  c = checkPlan(plan, st, 2);
  let b = planBlock(plan, st, c.cues);
  check(!c.cues.length && /^■今の作戦\n長期（ターン1から）：L\n短期（ターン1から）：S\n攻める順：5ミラ（中立・防衛20\/40） → 7ゼタ（ヴァルガ帝国・防衛20\/40）\n作戦どおりなら、そのまま手を打ってください/.test(b), `合図がなければ作戦だけ見せる\n${b}`);
  st = stOf(["P", "M", "P", "E"], { xenoAppeared: true });
  c = checkPlan(plan, st, 3);
  b = planBlock(plan, st, c.cues);
  check(c.hits.length === 1 && c.hits[0].id === 5 && plan.targets.join() === "7" && c.cues.map(x => x.kind).join() === "hit,lost,event"
    && /落とした：5ミラ（ターン3）/.test(b) && /見直しの合図：攻める星だった5ミラを落としました。1カルセ（いま異生体浸食・防衛20\/40）を失いました。異生体が現れました。作戦を見直して/.test(b),
    `攻める星を落とした・星を失った・異生体の出現を合図にする\n${b}`);
  st = stOf(["P", "M", "P", "P"], { xenoAppeared: true });
  c = checkPlan(plan, st, 4);
  check(c.cues.map(x => x.kind).join() === "hit,empty,stale" && /攻める順：なし/.test(planBlock(plan, st, c.cues)), "攻める星がなくなったら合図する（短期の作戦も3ターンたった）");
  c = checkPlan(plan, st, 5);
  check(!c.cues.length, "同じ合図（攻める星なし）は続けて出さない");
  c = checkPlan(plan, st, 1 + STALE_TURNS * 2);
  check(c.cues.map(x => x.kind).join() === "stale" && /短期の作戦はターン1に立てたものです/.test(c.cues[0].text), `短期の作戦が${STALE_TURNS}ターンごとに古くなったら合図する`);
  c = checkPlan(plan, { ...st, situation: { xenoAppeared: true, truceWithVarga: true } }, 8);
  check(c.cues.some(x => x.kind === "event" && /休戦しました/.test(x.text)), "休戦も合図にする");
  check(!planBlock(plan, st).includes("見直しの合図") && !planBlock(plan, st).includes("作戦どおり"), "合図なし（null）なら作戦だけ（ターンの途中で作り直すとき）");
}
check(PLAN_TOOL.function.name === "set_plan" && ["long", "short", "targets", "say"].every(k => PLAN_TOOL.function.parameters.properties[k]), "set_plan の定義（long・short・targets・say）");
{
  const t = describe({ type: "plan", turn: 3, changed: ["short"], long: "L", short: "S", targets: [{ id: 5, name: "ミラ" }] })?.text ?? "";
  check(/^作戦（ターン3・短期を変更）\n  長期：L\n  短期：S\n  攻める順：5ミラ$/.test(t) && describe({ type: "plan_turn", cues: ["none"] }) === null
    && /見直しの合図：攻める星を落とした・短期の作戦が古い/.test(describe({ type: "plan_turn", cues: ["hit", "stale"] }).text) && /5ミラ を落としました/.test(describe({ type: "plan_hit", id: 5, name: "ミラ" }).text),
    "台本：作戦・見直しの合図・落とした星を1行にする");
}
{
  const ev = [{ type: "start", plan: "on", ms: 0 }, { type: "turn", turn: 1, ms: 1 }, { type: "plan_turn", turn: 1, has: false, cues: ["none"], targets: [], ms: 2 },
    { type: "plan", turn: 1, changed: ["long", "short", "targets"], targets: [{ id: 5 }], ms: 3 },
    { type: "tool", by: "ai", name: "move_fleet", args: { fleet_id: 6, to: 5 }, ok: true, ms: 4 }, { type: "tool", by: "ai", name: "move_fleet", args: { fleet_id: 1, to: 2 }, ok: true, ms: 5 },
    { type: "turn", turn: 2, ms: 6 }, { type: "plan_hit", turn: 2, id: 5, ms: 7 }, { type: "plan_turn", turn: 2, has: true, cues: ["hit", "empty"], targets: [], ms: 8 },
    { type: "turn", turn: 3, ms: 9 }, { type: "plan_turn", turn: 3, has: true, cues: [], targets: [], ms: 10 }, { type: "plan", turn: 3, changed: ["short"], targets: [{ id: 7 }], ms: 11 },
    { type: "end", outcome: "ターン上限", ms: 12 }];
  const s = statsOf(ev).plan;
  check(s.sets === 2 && s.long === 1 && s.short === 2 && s.turnsWithPlan === 2 && s.turns === 3 && s.hits === 1 && s.cueTurns === 2 && s.cueFollowed === 1 && s.moves === 2 && s.toTarget === 1 && s.firstTurn === 1,
    `集計：書いた回数・作戦ありのターン・落とした星・合図に応えた数・攻める星への出撃（${JSON.stringify(s)}）`);
  check(/作戦 +書いた 2回（長期を変えた 1・短期を変えた 2・最初はターン1）・作戦ありのターン 2\/3・落とした攻める星 1・攻める星への出撃 1\/2・見直しの合図 2ターン→書き直した 1/.test(statsText(statsOf(ev))), "集計の表に「作戦」の行");
  check(/作戦 +使わない/.test(statsText(statsOf([{ type: "start", plan: "off" }]))) && /作戦の仕組みが入る前/.test(statsText(statsOf([{ type: "start" }]))), "作戦を使わない試合・古いログ");
}

/* ---------- ai-player.mjs（にせの LLM と本物のゲーム） ---------- */
let scenario = "plan", modelsCtx = 0, reqs = [];
const callOf = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (message, usage) => ({ choices: [{ index: 0, message: { role: "assistant", content: "", ...message }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
let turnNo = 0;
const llm = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.url === "/v1/models" && modelsCtx) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ object: "list", data: [{ id: "mock", max_model_len: modelsCtx }] })); }
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
  const b = JSON.parse(body);
  reqs.push(b);
  const last = b.messages.at(-1);
  const starts = last.role === "user" && String(last.content).includes("今の状況です");
  if (starts) turnNo++;
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(b.messages).length / 2), completion_tokens: 20 };
  let out;
  if (scenario === "text") {
    out = reply({ content: starts && turnNo === 1 ? '作戦を立てるね。\nset_plan(long="北から攻める", short="まずミラ", targets="5")\nend_turn()' : "end_turn()" });
  } else if (!starts) out = reply({ tool_calls: [callOf(`e${reqs.length}`, "end_turn", {})] }, usage);
  else if (turnNo === 1) out = reply({ tool_calls: [callOf("p1", "set_plan", { long: "北のミラから順に取る", short: "第2艦隊でミラを攻略", targets: "5,99", say: "作戦を立てたよ！" }),
    callOf("p2", "invest_research", { amount: 30 })] }, usage);
  else if (turnNo === 2) out = reply({ tool_calls: ["S2", "S3", "S4"].map((t, i) => callOf(`q${i}`, "set_plan", { short: t })) }, usage); // end_turn は次の返事で（結果が次の問い合わせに載るように）
  else out = reply({ tool_calls: [callOf(`z${reqs.length}`, "end_turn", {})] }, usage);
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
});
await new Promise(r => llm.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${llm.address().port}/v1`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-"));
let logNo = 0;
function run(turns, extra = []) {
  turnNo = 0; reqs = [];
  return new Promise((ok, ng) => {
    const p = spawn(process.execPath, [path.join(HERE, "ai-player.mjs"), "--model", "mock", "--base-url", BASE, "--name", "テスト", "--no-notes", "--turns", String(turns), "--max-steps", "6",
      "--log-dir", dir, "--log-name", `run${++logNo}`, ...extra, "--", "--headless", "--pace", "0", "--battle-speed", "4"], { stdio: ["ignore", "pipe", "inherit"] });
    let log = ""; p.stdout.on("data", d => { log += d; });
    p.on("exit", code => code === 0 ? ok(log) : ng(new Error(`exit ${code}\n${log}`)));
  });
}
const firstUserOf = (b) => b.messages.findLast(m => m.role === "user" && String(m.content).includes("今の状況です"))?.content ?? "";
const toolMsg = (b, id) => b.messages.find(m => m.role === "tool" && m.tool_call_id === id)?.content ?? "";

// 1) 会話を毎ターン作り直す（コンテキスト長が分からない）：作り直した最初のメッセージに作戦が入る
{
  await run(3);
  const turnStarts = reqs.filter(b => String(b.messages.at(-1).content).includes("今の状況です"));
  const sys = turnStarts.map(b => b.messages[0].content);
  const t = (b) => b.tools?.find(x => x.function.name === "set_plan");
  check(reqs.every(t) && t(reqs[0]).function.parameters.properties.targets, "set_plan をツールとして渡す");
  check(turnStarts.length === 3 && sys.every(s => s === sys[0]) && /set_plan で、長期の作戦/.test(sys[0]) && !sys[0].includes("北のミラ"), "システムプロンプトに作戦の使い方を書き、作戦の中身は入れない（3ターンとも同じ）");
  const u = turnStarts.map(firstUserOf);
  check(/■作戦：まだありません。最初の手と同じ返事で set_plan/.test(u[0]), "1ターン目：作戦を書くよう頼む");
  check(/■今の作戦\n長期（ターン1から）：北のミラから順に取る\n短期（ターン1から）：第2艦隊でミラを攻略\n攻める順：5\S+（中立/.test(u[1]) && /作戦どおりなら、そのまま手を打って/.test(u[1]) && u[1].indexOf("■今の作戦") < u[1].indexOf("今の状況です"),
    `2ターン目：作り直した会話の最初に、覚えた作戦を入れる\n${u[1].split("今の状況です")[0]}`);
  const after1 = reqs.find(b => b.messages.some(m => m.tool_call_id === "p1"));
  check(/作戦を覚えました/.test(toolMsg(after1, "p1")) && /星のIDとして読めないもの（99）は外しました/.test(toolMsg(after1, "p1")), "set_plan の結果：覚えたことと、外した星を返す");
  const after2 = reqs.find(b => b.messages.some(m => m.tool_call_id === "q2"));
  check(/作戦を覚えました/.test(toolMsg(after2, "q1")) && /このターンはもう2回作戦を書きました/.test(toolMsg(after2, "q2")), "1ターンに3回目の set_plan は断る");
  check(/短期（ターン2から）：S3/.test(u[2]) && /長期（ターン1から）：北のミラから順に取る/.test(u[2]), "3ターン目：変えた短期だけ新しくなり、長期は残る");
  const ev = await readLog(path.join(dir, `run${logNo}.jsonl`));
  const plans = ev.filter(e => e.type === "plan");
  check(ev[0].plan === "on" && plans.length === 3 && plans[0].turn === 1 && plans[0].targets[0]?.id === 5 && !!plans[0].targets[0]?.name && plans[2].short === "S3"
    && ev.filter(e => e.type === "plan_turn").length === 3 && ev.some(e => e.type === "refuse" && e.name === "set_plan"), `プレイログ：作戦を書くたび・ターンごとの突き合わせ・断った3回目（plan ${plans.length}件）`);
  check(!ev.some(e => e.type === "tool" && e.name === "set_plan") && ev.some(e => e.type === "talk" && e.text === "作戦を立てたよ！"), "set_plan はゲームの操作に数えない・say 引数は字幕に出す");
  const s = statsOf(ev).plan;
  check(s.sets === 3 && s.turnsWithPlan === 2 && s.turns === 3, `集計：作戦 ${JSON.stringify(s)}`);
}
// 2) ターンをまたいで会話を続ける：続けるターンの最初のメッセージ（後ろに足す）に作戦が入り、前のメッセージは書き換えない
{
  modelsCtx = 1000000;
  await run(2);
  const t2 = reqs.findLast(b => String(b.messages.at(-1).content).includes("【ターン2】"));
  const before = reqs.filter(b => b !== t2 && reqs.indexOf(b) < reqs.indexOf(t2)).at(-1);
  check(t2 && /^【ターン2】前のターンが終わりました[\s\S]*■今の作戦\n長期（ターン1から）：北のミラから順に取る/.test(t2.messages.at(-1).content)
    && JSON.stringify(t2.messages.slice(0, before.messages.length)) === JSON.stringify(before.messages), "会話を続けるターンは、足すメッセージに作戦を入れ、前の会話は書き換えない");
  modelsCtx = 0;
}
// 3) --no-plan：作戦を使わない（以前の動き）
{
  await run(1, ["--no-plan"]);
  const ev = await readLog(path.join(dir, `run${logNo}.jsonl`));
  check(reqs.every(b => !b.tools.some(x => x.function.name === "set_plan")) && !reqs[0].messages[0].content.includes("set_plan") && !/■(今の)?作戦/.test(firstUserOf(reqs[0]))
    && ev[0].plan === "off" && !ev.some(e => e.type === "plan_turn"), "--no-plan：set_plan を渡さず、作戦の文も入れない");
}
// 4) --tool-mode text：手を文字で書くときも set_plan を拾う
{
  scenario = "text";
  await run(1, ["--tool-mode", "text"]);
  const ev = await readLog(path.join(dir, `run${logNo}.jsonl`));
  const sys = reqs[0].messages[0].content;
  check(/^- set_plan\(long\?, short\?, targets\?, say\?\)：作戦を書く・直す/m.test(sys) && ev.some(e => e.type === "plan" && e.long === "北から攻める" && e.targets[0]?.id === 5)
    && !ev.some(e => e.type === "talk" && /set_plan/.test(e.text)), "--tool-mode text：手の一覧に set_plan が出て、文字で書いた set_plan も覚える（字幕には出さない）");
}

llm.close();
await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
console.log(`\n${failed ? `${failed} 件失敗` : `${passed} 件すべて通りました`}`);
process.exit(failed ? 1 : 0);
