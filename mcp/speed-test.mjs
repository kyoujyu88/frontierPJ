/* 演出の倍速（server.mjs --battle-speed）とオート戦闘を飛ばす（--skip-battle）の確認：同じ場面（ターン1、第2艦隊でオルドを攻める）を
 * 1倍・2倍・2倍＋飛ばすで戦わせ、2倍のほうが十分に速く終わること、飛ばすとさらに短くなること、どれも決着して作戦卓に戻ることを確かめる。
 * 演出つきなので2分ほどかかる。
 *   node speed-test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

/* 先に、倍速で縮むのが本体の wait()・banner() のタイマーだけで、ほかの setTimeout（効果音・録画など）はそのままかを、ページの中で直接測る */
async function timersAtSpeed2() {
  const br = await chromium.launch(), pg = await br.newPage();
  await pg.goto(new URL("../game/frontier-war.html", import.meta.url).href);
  await pg.addScriptTag({ content: await readFile(new URL("./game-api.js", import.meta.url), "utf8") });
  const r = await pg.evaluate(`(async()=>{
    const ms=async f=>{const t=performance.now();await f();return performance.now()-t};
    gameAPI.setSpeed(2);B={};  // 戦闘中と同じ「倍速の場面」にする
    const w=await ms(()=>wait(400)), plain=await ms(()=>new Promise(r=>setTimeout(r,400)));
    B=null;const after=await ms(()=>wait(400));
    // オート戦闘を飛ばす：オートの戦闘中だけ wait が待たずに進み、効果音も鳴らさない。決着したあと（結果の帯）と手動の戦闘は倍速のまま
    gameAPI.setSkipBattle(true);gameAPI.setAutoBattle(true);
    B={auto:true};const skip=await ms(()=>wait(400)),skipPlain=await ms(()=>new Promise(r=>setTimeout(r,400)));
    B={auto:false};const manual=await ms(()=>wait(400));
    B={auto:true,ended:true};const ended=await ms(()=>wait(400));
    B=null;gameAPI.setSkipBattle(false);gameAPI.setAutoBattle(false);
    return {w,plain,after,skip,skipPlain,manual,ended};
  })()`);
  await br.close();
  return r;
}
const tm = await timersAtSpeed2();

async function battleAt(speed, skip = false) {
  const c = new Client({ name: "speed-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), "--headless", "--pace", "300", "--battle-speed", String(speed), ...(skip ? ["--skip-battle"] : [])], env: process.env, stderr: "inherit" }));
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
const a = await battleAt(1), b = await battleAt(2), k = await battleAt(2, true);
console.log(`1倍：戦闘 ${(a.battle / 1000).toFixed(1)}秒（${a.result}・${a.rounds}ラウンド）・陣形 ${a.map}ms`);
console.log(`2倍：戦闘 ${(b.battle / 1000).toFixed(1)}秒（${b.result}・${b.rounds}ラウンド）・陣形 ${b.map}ms`);
console.log(`2倍＋飛ばす：戦闘 ${(k.battle / 1000).toFixed(1)}秒（${k.result}・${k.rounds}ラウンド）・陣形 ${k.map}ms`);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed++; };
check(tm.w < 300, `倍速の場面では本体の wait(400) が縮む（${tm.w.toFixed(0)}ms）`);
check(tm.plain >= 380, `ほかの setTimeout(400) は縮まない（${tm.plain.toFixed(0)}ms）`);
check(tm.after >= 380, `戦闘が終われば wait(400) は元の長さ（${tm.after.toFixed(0)}ms）`);
check(tm.skip < 60, `オート戦闘を飛ばすと、戦闘中の wait(400) は待たない（${tm.skip.toFixed(0)}ms）`);
check(tm.skipPlain >= 380, `飛ばしていても、ほかの setTimeout(400) は縮まない（${tm.skipPlain.toFixed(0)}ms）`);
check(tm.manual >= 150 && tm.manual < 300, `手動の戦闘は飛ばさない（倍速だけ：${tm.manual.toFixed(0)}ms）`);
check(tm.ended >= 150 && tm.ended < 300, `決着したあと（結果の帯）は飛ばさない（倍速だけ：${tm.ended.toFixed(0)}ms）`);
check(a.ok && b.ok && k.ok && a.result && b.result && k.result, "どれも戦闘が決着して作戦卓に戻る");
check(k.battle < b.battle / 2 && k.battle < 8000, `飛ばすと、2倍よりさらに短い（${(k.battle / 1000).toFixed(1)}秒。移動の演出と結果の帯の1秒を含む）`);
check(a.battle / b.battle >= 1.6, `2倍にすると戦闘の時間がおよそ半分になる（${(a.battle / b.battle).toFixed(2)}倍速）`);
check(Math.abs(a.map - b.map) < 400, "作戦卓の操作（陣形の変更）の演出の長さは変わらない");
process.exit(failed ? 1 : 0);
