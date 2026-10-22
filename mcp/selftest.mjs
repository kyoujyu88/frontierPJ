/* 自動テスト：簡単なボットでMCPツールを通してゲームを数十ターン遊ばせ、操作が詰まらないか確かめる。
 *   node selftest.mjs            … ウィンドウなし・演出なし
 *   node selftest.mjs --show     … ウィンドウを出して演出つきで見る
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const show = process.argv.includes("--show");
const MAX_TURNS = Number(process.env.TURNS ?? 30);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), ...(show ? [] : ["--headless", "--pace", "0"])],
  env: process.env, stderr: "inherit",
});
const client = new Client({ name: "selftest", version: "1" });
await client.connect(transport);
let calls = 0, errors = 0;
async function call(name, args = {}) {
  calls++;
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  let v; try { v = JSON.parse(t); } catch { return t; }
  if (v.ok === false) { errors++; console.log(`  ✗ ${name}: ${v.message}`); }
  return v;
}
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

async function clearDialogs() {
  for (let i = 0; i < 5; i++) { const s = await call("get_state"); if (!s.dialog) return s; console.log("  [通信] " + s.dialog.text.split("\n").slice(1, 3).join(" / ")); await call("dismiss_dialog"); }
}
async function fight() {
  for (let round = 0; round < 40; round++) {
    await clearDialogs();
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

console.log((await client.listTools()).tools.length + " tools");
const rules = await call("get_rules"); console.log("rules:", rules.length, "chars");
await call("say", { text: "テストを始めるよ！" });
for (let t = 0; t < MAX_TURNS; t++) {
  let s = await clearDialogs();
  if (s.over) { console.log("終了:", s.over); break; }
  console.log(`ターン${s.turn} 資金${s.funds} 研究${s.research.next ? s.research.next.progress + "/" + s.research.next.need : "-"} 自軍艦隊${s.myFleets.length}`);
  if (s.research.next && s.funds >= 120) await call("invest_research", { amount: 60 });
  const home = s.planets.find(p => p.id === 0);
  if (t === 1) await call("build_facility", { planet_id: 1, facility: "mine" });
  if (t === 0) { const r = await call("set_formation", { fleet_id: s.myFleets[0].id, formation: "square" }); console.log("  陣形:", r.message); }
  if (t === 2) await call("refit_ship", { fleet_id: s.myFleets[0].id, ship_index: 0, sh: 2, ca: 2, bo: 2 });
  for (const f of (await call("get_state")).myFleets) {
    if (f.repairCost && (await call("get_state")).funds >= f.repairCost) await call("repair_fleet", { fleet_id: f.id });
    const opt = f.moveOptions.find(o => o.kind.includes("攻略") || o.kind.includes("艦隊戦")) ?? f.moveOptions.find(o => o.kind === "移動" && o.to > f.at);
    if (opt && f.power >= 12) {
      console.log(`  ${f.name} → ${opt.name}（${opt.kind}）`);
      const r = await call("move_fleet", { fleet_id: f.id, to: opt.to });
      if (r.battle) await fight();
    }
    if ((await call("get_state")).over) break;
  }
  void home;
  const r = await call("end_turn");
  for (const e of r.events ?? []) if (!e.startsWith("［戦闘］")) console.log("  · " + e);
  if (r.battle || r.dialog) { await fight(); }
  let st = await call("get_state");
  while (st.battle) { await fight(); st = await call("get_state"); }
}
const final = await call("get_state");
console.log(`\n最終：ターン${final.turn} 資金${final.funds} over=${final.over} 自国惑星${final.planets.filter(p => p.owner === "P").length} 異生体=${final.situation.xenoAppeared}`);
console.log(`ツール呼び出し ${calls} 回、拒否 ${errors} 回`);
await client.close();
