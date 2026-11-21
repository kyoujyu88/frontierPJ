#!/usr/bin/env node
/* logstats.mjs（プレイログの集計）のテスト。作ったログで数字を確かめる（ブラウザも LLM も要らない、1秒かからない）
 *   npm run test:stats
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statsOf, statsText, compareText, statsLine, failKind } from "./logstats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let ok = 0;
const test = (name, fn) => { fn(); ok++; console.log(`✓ ${name}`); };

/* 2ターンのログを作る。cache=false でキャッシュの量を返さないサーバー */
function makeLog({ cache = true } = {}) {
  const ev = []; let ms = 0;
  const w = (type, d = {}, dt = 0) => { ms += dt; ev.push({ t: new Date(1.79e12 + ms).toISOString(), ms, type, ...d }); };
  const usage = (prompt, cached, out) => ({ prompt_tokens: prompt, completion_tokens: out, ...(cache ? { prompt_tokens_details: { cached_tokens: cached } } : {}) });
  const llm = (sec, prompt, cached, out, calls, extra = {}) => w("llm", { kind: "play", sec, usage: usage(prompt, cached, out), finish: "tool_calls", calls, ...extra }, sec * 1000);
  w("start", { name: "テスト", model: "m:1", maxTokens: 512, think: "none", serverArgs: ["--battle-speed", "2", "--pace", "300"] });
  w("model", { quantization: "Q4_0", parameterSize: "8B" });
  // ターン1：読み直し（最初の返事は読み込みが入るので速さからは外れる）→ 内政2つ（1つ失敗・同じ手でもう1回失敗）→ 移動（戦闘20秒）→ end_turn
  w("turn", { turn: 1, funds: 100 }, 100);
  llm(30, 8000, 0, 40, [{ name: "say", arguments: "{}" }]);
  w("loaded", { ctx: 16384, gpuPct: 100 });
  llm(2, 8200, 8000, 40, [{ name: "build_facility", arguments: "{}" }]);
  w("tool", { by: "ai", name: "build_facility", args: { planet_id: 1, facility: "mine" }, ok: false, message: "資金不足：採掘所には 60 必要（現在 40）" }, 500);
  llm(2.4, 8500, 8200, 50, [{ name: "build_facility", arguments: "{}" }]);
  w("tool", { by: "ai", name: "build_facility", args: { planet_id: 1, facility: "mine" }, ok: false, message: "資金不足：採掘所には 60 必要（現在 40）" }, 500);
  llm(2.2, 8800, 8500, 30, [{ name: "move_fleet", arguments: "{}" }]);
  w("tool", { by: "ai", name: "move_fleet", args: { fleet_id: 1, to: 4 }, ok: true }, 20000);
  w("battle", { title: "オルド 攻略戦", result: "勝利" });
  w("empty", { n: 1, tokens: 30, finish: "stop" });
  llm(1, 9000, 8800, 10, [{ name: "end_turn", arguments: "{}" }]);
  w("tool", { by: "ai", name: "end_turn", args: {}, ok: true }, 3000);
  w("tool", { by: "ai", name: "get_next", args: {}, ok: null }, 0);
  // ターン2：会話を続ける → 読み直しなし → 研究（成功）→ 自軍の星への移動で失敗 → end_turn
  w("turn", { turn: 2, funds: 150 }, 100);
  w("context", { keep: true, turns: 2, est: 11000, reserve: 2000 });
  llm(2.6, 11000, 9000, 60, [{ name: "invest_research", arguments: "{}" }]);
  w("tool", { by: "ai", name: "invest_research", args: { amount: 90 }, ok: true }, 200);
  llm(1.8, 11300, 11000, 20, [{ name: "move_fleet", arguments: "{}" }]);
  w("tool", { by: "ai", name: "move_fleet", args: { fleet_id: 1, to: 4 }, ok: false, message: "第1艦隊 はいま オルド にいます（とどまるなら何もしなくてよい）" }, 300);
  llm(2.0, 11600, 11300, 25, [{ name: "say", arguments: "{}" }, { name: "end_turn", arguments: "{}" }]);
  w("tool", { by: "ai", name: "end_turn", args: {}, ok: true }, 4000);
  w("context", { keep: false, est: 15000, reserve: 2500 });
  w("over", { result: "win", turn: 2 }, 100);
  w("end", { outcome: "勝利", turn: 2 });
  return ev;
}

test("ターン数・1ターンの秒数・内訳", () => {
  const s = statsOf(makeLog());
  assert.equal(s.turns, 2);
  assert.equal(s.outcome, "勝利");
  const play = (s.playSec);
  assert.ok(play > 70 && play < 80, `playSec ${play}`);
  assert.ok(Math.abs(s.secPerTurn - play / 2) < 0.6, `secPerTurn ${s.secPerTurn}`);
  // LLM：30+2+2.4+2.2+1+2.6+1.8+2.0 = 44.0 → 22.0/ターン
  assert.equal(s.time.llmPerTurn, 22);
  // 移動と戦闘：move_fleet 20 + 0.3、end_turn 3 + 4 = 27.3 → 13.7/ターン（四捨五入）
  assert.equal(s.time.battlePerTurn, 13.7);
  assert.equal(s.settings.battleSpeed, "2");
  assert.equal(s.settings.skipBattle, false);
  assert.equal(s.settings.ctx, 16384);
});

test("読み直し・読み込みの速さ・会話の継続", () => {
  const s = statsOf(makeLog());
  assert.equal(s.llm.cacheKnown, true);
  assert.equal(s.llm.reread, 1);           // cached_tokens=0 は最初の返事だけ
  assert.equal(s.llm.turnFirstReread, 1);  // ターン2は会話を続けたので読み直しなし
  assert.equal(s.llm.rereadAvgSec, 30);
  assert.equal(s.llm.promptTps, null);     // 最初の返事は読み込みが入るので速さには使わない
  assert.ok(s.llm.genTps == null || s.llm.genTps > 0);
  assert.deepEqual(s.context, { keep: 1, rebuild: 1, compact: 0 });
  assert.equal(s.llm.sayOnly, 1);           // say と end_turn を一緒に呼んだ返事は数えない
  assert.equal(s.llm.sayWith, 1);           // その say と end_turn を一緒に呼んだ返事
  assert.equal(s.empty, 1);
});

test("失敗率・理由・同じ失敗の繰り返し", () => {
  const s = statsOf(makeLog());
  assert.equal(s.ops.total, 7);             // get_next（ok:null）は数えない
  assert.equal(s.ops.fails, 3);
  assert.equal(s.ops.failRate, 42.9);
  assert.deepEqual(s.ops.failKinds, { "資金不足": 2, "いまいる星への移動": 1 });
  assert.equal(s.ops.repeatFails, 1);
  assert.equal(failKind("第3艦隊 はこのターン行動済みです"), "行動済みの艦隊");
  assert.equal(failKind("引数が正しくありません：to（行き先の惑星ID）を指定してください"), "引数の形");
  assert.equal(failKind("なにか知らない断り"), "そのほか");
});

test("成功のまま同じ手を続けた回数・陣形の「変更なし」", () => {
  const ev = makeLog(), at = ev.findIndex(e => e.type === "tool" && e.name === "move_fleet");
  const t = ev[at].ms, form = (ok, message) => ({ t: ev[at].t, ms: t, type: "tool", by: "ai", name: "set_formation", args: { fleet_id: 1, formation: "line" }, ok, ...(message ? { message } : {}) });
  ev.splice(at, 0, form(true), form(true), form(true), form(false, "変更なし：第1艦隊 はすでに横陣です。陣形はこのままで、移動など次の手に進んでください"));
  const s = statsOf(ev);
  assert.equal(s.ops.repeatOks, 2);         // 1回目の成功のあとの2回
  assert.equal(s.ops.failKinds["変更なし（すでにその陣形）"], 1);
  assert.equal(statsOf(makeLog()).ops.repeatOks, 0);
  // 研究の投資を30ずつ続ける・ターンをまたいだ同じ手は数えない。say とキーの順は見ない
  const ev2 = makeLog(), at2 = ev2.findIndex(e => e.type === "tool" && e.name === "move_fleet"), t2 = ev2[at2], tool = (name, args) => ({ t: t2.t, ms: t2.ms, type: "tool", by: "ai", name, args, ok: true });
  ev2.splice(at2, 0, tool("invest_research", { amount: 30 }), tool("invest_research", { amount: 30 }), tool("set_formation", { formation: "line", fleet_id: 1, say: "横陣で！" }), tool("set_formation", { fleet_id: 1, formation: "line" }));
  const last = ev2.findLastIndex(e => e.type === "tool" && e.name === "end_turn");
  ev2.splice(last, 0, tool("set_formation", { fleet_id: 1, formation: "square" }));
  ev2.splice(ev2.findIndex(e => e.type === "turn" && e.turn === 2) + 1, 0, tool("set_formation", { fleet_id: 1, formation: "square" }));
  assert.equal(statsOf(ev2).ops.repeatOks, 1); // set_formation の say 違い・キーの順違いの1回だけ
  assert.match(statsText(s), /成功のまま同じ手\s+2/);
});

test("キャッシュの量を返さないサーバーでは読み直しを数えない", () => {
  const s = statsOf(makeLog({ cache: false }));
  assert.equal(s.llm.cacheKnown, false);
  assert.equal(s.llm.reread, null);
  assert.match(statsText(s), /サーバーがキャッシュの量を返さない/);
});

test("読み込みの速さは読み直しの返事の 送ったトークン÷秒（2回目以降）", () => {
  const ev = makeLog();
  // ターン2の最初を読み直しにする（12000 トークンを 10 秒 → 1200）
  const i = ev.findIndex(e => e.type === "llm" && e.usage.prompt_tokens === 11000);
  ev[i] = { ...ev[i], sec: 10, usage: { prompt_tokens: 12000, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 0 } } };
  const s = statsOf(ev);
  assert.equal(s.llm.reread, 2);
  assert.equal(s.llm.promptTps, 1200);
});

test("文字にする（1本・並べる・1行）", () => {
  const s = statsOf(makeLog());
  const t = statsText(s, { name: "x" });
  for (const h of ["1ターン", "移動・戦闘の演出", "読み直し", "失敗率", "空の返事", "会話の継続"]) assert.match(t, new RegExp(h));
  const c = compareText([{ name: "a", stats: s }, { name: "b", stats: statsOf(makeLog({ cache: false })) }]);
  assert.match(c, /\[1\] a/); assert.match(c, /│/);
  assert.match(statsLine(s), /^1ターン[\d.]+秒/);
});

test("空のログ・途中のログでも落ちない", () => {
  const s = statsOf([]);
  assert.equal(s.turns, 0); assert.equal(s.secPerTurn, null);
  statsText(s);
  const part = makeLog().filter(e => !["over", "end"].includes(e.type));
  assert.equal(statsOf(part).outcome, "途中");
  // end がなく over だけのとき（落ちた途中のログ）、負けは「敗北」にする
  const lost = makeLog().filter(e => e.type !== "end").map(e => e.type === "over" ? { ...e, result: "lose" } : e);
  assert.equal(statsOf(lost).outcome, "敗北");
  // 振り返りの返事はターン最初の読み直しに数えない
  const ev = makeLog(); const i = ev.findIndex(e => e.type === "turn" && e.turn === 2);
  ev.splice(i + 1, 0, { t: ev[i].t, ms: ev[i].ms, type: "llm", kind: "reflect", sec: 5, usage: { prompt_tokens: 3000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 0 } } });
  assert.equal(statsOf(ev).llm.turnFirstReread, 1);
});

// コマンド：node playlog.mjs --stats（1本・並べる）と --format stats
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logstats-"));
  try {
    const log = makeLog().map(e => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(path.join(dir, "a.jsonl"), log);
    await fs.writeFile(path.join(dir, "b.jsonl"), log);
    const one = execFileSync(process.execPath, [path.join(HERE, "playlog.mjs"), "--dir", dir, "--stats", "a"], { encoding: "utf8" });
    assert.match(one, /# 集計 a/); assert.match(one, /失敗率 +42\.9%/);
    const two = execFileSync(process.execPath, [path.join(HERE, "playlog.mjs"), "--dir", dir, "--stats", "a", "b"], { encoding: "utf8" });
    assert.match(two, /\[2\] b/);
    const fmt = execFileSync(process.execPath, [path.join(HERE, "playlog.mjs"), "--dir", dir, "a", "--format", "stats"], { encoding: "utf8" });
    assert.match(fmt, /1ターン/);
    ok++; console.log("✓ コマンドの出力");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
console.log(`\n${ok} 件すべて通りました`);
