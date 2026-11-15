/* 自動テスト：簡単なボットでMCPツールを通してゲームを数十ターン遊ばせ、操作が詰まらないか確かめる。
 * 想定外の拒否（ok:false）や、建設・移動などが状態に反映されていないときは失敗（終了コード1）にする。
 *   node selftest.mjs            … ウィンドウなし・演出なし
 *   node selftest.mjs --show     … ウィンドウを出して演出つきで見る
 *   MANUAL=1 node selftest.mjs   … 戦闘を battle_* で1隻ずつ操作する（サーバーの --manual-battle）。既定はオート戦闘
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const show = process.argv.includes("--show");
const MAX_TURNS = Number(process.env.TURNS ?? 30);
const MANUAL = process.env.MANUAL === "1";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), ...(show ? [] : ["--headless", "--pace", "0"]), ...(MANUAL ? ["--manual-battle"] : [])],
  env: process.env, stderr: "inherit",
});
const client = new Client({ name: "selftest", version: "1" });
await client.connect(transport);
let calls = 0, errors = 0, refused = 0, autoBattles = 0;
const fail = msg => { errors++; console.log(`  ✗ ${msg}`); };
// reject: わざと断られる操作を試す（断られなければ失敗）
async function call(name, args = {}, { reject = false } = {}) {
  calls++;
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60 * 1000 }); // オート戦闘は長いことがある
  const t = r.content[0].text;
  let v; try { v = JSON.parse(t); } catch { return t; }
  if (reject) { if (v.ok === false) refused++; else fail(`${name} が断られなかった`); }
  else if (v.ok === false) fail(`${name}: ${v.message}`);
  for (const b of v.battles ?? []) { autoBattles++; console.log(`  戦闘（オート）：${b.title} ${b.result}（${b.rounds}ラウンド・損失${b.lost}/${b.ships}・撃破${b.downed}/${b.foes}）`); }
  return v;
}
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

async function clearDialogs() {
  for (let i = 0; i < 5; i++) { const s = await call("get_state"); if (!s.dialog) return s; console.log("  [通信] " + s.dialog.text.split("\n").slice(1, 3).join(" / ")); await call("dismiss_dialog"); }
}
async function fight() {
  if (!MANUAL) return clearDialogs(); // オート戦闘では戦闘は返ってくる前に決着している
  for (let round = 0; round < 40; round++) {
    const now = await clearDialogs();
    if (now && !now.battle) return; // 通信だけで戦闘が無いとき（ターン終了後の知らせなど）は、盤面を聞かない
    const b = await call("battle_state");
    if (b.ok === false) return;
    if (b.ended) { const r = await call("battle_close"); console.log(`  戦闘終了：${r.message}`); await clearDialogs(); const s = await call("get_state"); if (!s.battle) return; continue; }
    const mine = b.units.filter(u => u.side === "自軍" && !u.acted);
    if (!mine.length) { await call("battle_end_phase"); continue; }
    const u = mine[0];
    if (u.attacks?.length) { const a = u.attacks.sort((x, y) => y.damage - x.damage)[0]; await call("battle_attack", { unit_id: u.id, target_id: a.target }); continue; }
    const foes = b.units.filter(v => v.side === "敵");
    const goal = foes.find(v => v.flagship) ?? foes[0];
    const best = (u.moves ?? []).map(([x, y]) => ({ x, y, d: Math.abs(dist({ x, y }, goal) - 1) })).sort((p, q) => p.d - q.d)[0];
    if (best && best.d < Math.abs(dist(u, goal) - 1)) await call("battle_move", { unit_id: u.id, x: best.x, y: best.y });
    else await call("battle_wait", { unit_id: u.id });
  }
}

const toolNames = (await client.listTools()).tools.map(t => t.name);
console.log(`${toolNames.length} tools（戦闘：${MANUAL ? "手動" : "オート"}）`);
if (!MANUAL && toolNames.some(n => n.startsWith("battle_"))) fail("オート戦闘なのに battle_* ツールが出ている");
if (MANUAL && !toolNames.includes("battle_state")) fail("手動戦闘なのに battle_* ツールが出ていない");
const rules = await call("get_rules"); console.log("rules:", rules.length, "chars");
// 通信が開いたままでも操作でき（自動で閉じる）、引数は寛容に読み、返り値に「のこりの手」が付く
{
  const before = await call("get_state");
  const r = await call("invest_research", { amount: "100" }); // 文字列の数字・30刻みでない額 → 90 を投資
  const after = await call("get_state");
  if (!before.dialog) fail("最初の通信が開いていない（テストの前提）");
  if (r.ok === false || after.funds !== before.funds - 90) fail(`invest_research 100 が 90 の投資にならなかった（${before.funds} → ${after.funds}）`);
  if (after.dialog) fail("開いていた通信が、操作のあとも閉じていない");
  if (!/のこりの手：資金\d+。払える内政：/.test(r.next ?? "") || !/未行動の艦隊：/.test(r.next ?? "")) fail("返り値に「のこりの手」が無い");
  const bad = await call("move_fleet", { fleet_id: 1 }); // 引数が足りない → 日本語で何を書くかを返す（JSON ではなく MCP のエラー文）
  if (typeof bad !== "string" || !/to（行き先の惑星ID）を指定してください/.test(bad)) fail(`引数が足りないときの案内が日本語で返らない：${JSON.stringify(bad).slice(0, 120)}`);
  const stay = await call("move_fleet", { fleet_id: "第1艦隊", to: before.myFleets[0].at }, { reject: true }); // いまいる星へは動けない。行ける先を返す
  if (!/行ける先：\d/.test(stay.message ?? "")) fail(`断るときに行ける先が付かない：${stay.message}`);
  const dup = await call("build_facility", { planet_id: 0, facility: "採掘所" }, { reject: true }); // 既にある施設。建てられるものを返す
  if (!/建てられるのは：/.test(dup.message ?? "")) fail(`断るときに建てられる施設が付かない：${dup.message}`);
}
await call("say", { text: "テストを始めるよ！" });
await call("build_facility", { planet_id: 6, facility: "mine" }, { reject: true }); // 敵の星には建てられない
await call("move_fleet", { fleet_id: 9999, to: 1 }, { reject: true }); // 無い艦隊は動かせない
for (let t = 0; t < MAX_TURNS; t++) {
  let s = await clearDialogs();
  if (s.over) { console.log("終了:", s.over); break; }
  console.log(`ターン${s.turn} 資金${s.funds} 研究${s.research.next ? s.research.next.progress + "/" + s.research.next.need : "-"} 自軍艦隊${s.myFleets.length}`);
  if (s.research.next && s.funds >= 120) { await call("invest_research", { amount: 60 }); s = await clearDialogs(); } // 開発完了の通信が出ることがある
  if (t === 1) {
    const r = await call("build_facility", { planet_id: 1, facility: "mine" });
    s = await clearDialogs();
    const has = s.planets.find(p => p.id === 1).facilities.some(f => f.key === "mine");
    if (r.ok !== false && !has) fail("build_facility が成功と答えたのに採掘所が建っていない");
  }
  if (t === 0) {
    const fid = s.myFleets[0].id, r = await call("set_formation", { fleet_id: fid, formation: "square" }); console.log("  陣形:", r.message);
    s = await clearDialogs();
    if (r.ok !== false && s.myFleets.find(f => f.id === fid)?.formation !== "square") fail("set_formation が状態に反映されていない");
  }
  if (t === 2) { await call("refit_ship", { fleet_id: s.myFleets[0].id, ship_index: 0, sh: 2, ca: 2, mi: 0, bo: 2, sp: 0 }); s = await clearDialogs(); }
  for (const { id } of s.myFleets) {
    s = await clearDialogs();
    if (s.over) break;
    const f = s.myFleets.find(x => x.id === id);
    if (!f) continue; // 前の戦闘で失った
    if (f.repairCost && s.funds >= f.repairCost) { await call("repair_fleet", { fleet_id: f.id }); s = await clearDialogs(); }
    const opt = f.moveOptions.find(o => o.kind.includes("攻略") || o.kind.includes("艦隊戦")) ?? f.moveOptions.find(o => o.kind === "移動" && o.to > f.at);
    if (opt && f.power >= 12) {
      console.log(`  ${f.name} → ${opt.name}（${opt.kind}）`);
      const r = await call("move_fleet", { fleet_id: f.id, to: opt.to });
      if (r.battle) await fight();
      else if (r.ok !== false && opt.kind === "移動") {
        const after = (await clearDialogs()).myFleets.find(x => x.id === id);
        if (after && after.at !== opt.to) fail(`move_fleet が成功と答えたのに ${f.name} が ${opt.name} にいない`);
      }
    }
  }
  s = await clearDialogs();
  if (s.over) { console.log("終了:", s.over); break; }
  const r = await call("end_turn");
  for (const e of r.events ?? []) if (!e.startsWith("［戦闘］") && !e.startsWith("戦闘「")) console.log("  · " + e);
  if (r.battle || r.dialog) { await fight(); }
  let st = await call("get_state");
  while (st.battle) { await fight(); st = await call("get_state"); }
}
const final = await call("get_state");
console.log(`\n最終：ターン${final.turn} 資金${final.funds} over=${final.over} 自国惑星${final.planets.filter(p => p.owner === "P").length} 異生体=${final.situation.xenoAppeared}`);
console.log(`ツール呼び出し ${calls} 回、想定外の失敗 ${errors} 回、わざと断らせた操作 ${refused} 回${MANUAL ? "" : `、オートで決着した戦闘 ${autoBattles} 回`}`);
if (!MANUAL && final.battle) fail("オート戦闘なのに戦闘が残っている");
if (errors) { console.log(`✗ テスト失敗（想定外の失敗 ${errors} 回）`); process.exitCode = 1; } else console.log("✓ テスト成功");
await client.close();
