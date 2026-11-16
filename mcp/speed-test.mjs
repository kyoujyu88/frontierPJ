/* 演出の倍速（server.mjs --battle-speed）の確認：同じ場面（ターン1、第2艦隊でオルドを攻める）を 1倍と2倍で戦わせ、
 * 2倍のほうが十分に速く終わること、戦闘の結果は変わらないことを確かめる。演出つきなので1分半ほどかかる。
 *   node speed-test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

async function battleAt(speed) {
  const c = new Client({ name: "speed-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), "--headless", "--pace", "300", "--battle-speed", String(speed)], env: process.env, stderr: "inherit" }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60 * 1000 }); try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
  await call("dismiss_dialog"); // 最初の通信（表示の間を待たないように、先に閉じる）
  let t = Date.now();
  const r = await call("move_fleet", { fleet_id: 6, to: 4 });
  const battle = Date.now() - t;
  t = Date.now();
  await call("set_formation", { fleet_id: 1, formation: "square" }); // 作戦卓の操作は倍速にならない（演出の間 pace はそのまま）
  const map = Date.now() - t;
  await c.close();
  return { battle, map, result: r.battles?.[0]?.result, rounds: r.battles?.[0]?.rounds, ok: r.ok };
}
const a = await battleAt(1), b = await battleAt(2);
console.log(`1倍：戦闘 ${(a.battle / 1000).toFixed(1)}秒（${a.result}・${a.rounds}ラウンド）・陣形 ${a.map}ms`);
console.log(`2倍：戦闘 ${(b.battle / 1000).toFixed(1)}秒（${b.result}・${b.rounds}ラウンド）・陣形 ${b.map}ms`);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed++; };
check(a.ok && b.ok && a.result && b.result, "どちらも戦闘が決着して作戦卓に戻る");
check(a.battle / b.battle >= 1.6, `2倍にすると戦闘の時間がおよそ半分になる（${(a.battle / b.battle).toFixed(2)}倍速）`);
check(Math.abs(a.map - b.map) < 400, "作戦卓の操作（陣形の変更）の演出の長さは変わらない");
process.exit(failed ? 1 : 0);
