/* 場面ごとに録画する。node shoot.mjs <場面…>（省略するとぜんぶ）
 *   map    星図：艦隊を選び、移動先を出して動かし、ターン終了（ターン14）
 *   refit  改装・造船所・陣形の画面（ターン16）
 *   battle 星図から艦隊戦へ（オート戦闘、ターン13）
 *   xeno   異生体「ゾア」出現の通信（ターン17→18）
 *   seraph 異生体の群れとの戦闘（ターン20→21）
 *   hive   深淵の巣への突入戦と勝利の画面（ターン21→22）
 * 出力：promo/work/rec/<場面>/（コマと時刻）。続けて assemble.py で mp4 にする
 */
import { open, load, rec, sleep, hold } from "./lib.mjs";

const SCENES = {
  async map(p, s) {
    await load(p, 14);
    await p.evaluate(() => { S.fleets.forEach(f => { if (f.side === "P") f.moved = false; }); render(); });
    await sleep(800);
    const stop = await rec(p, "map", s);
    await sleep(1500);
    await p.evaluate(() => { const f = S.fleets.find(x => x.id === 1); S.sel = f.node; S.selFleet = 1; render(); }); await sleep(1200);
    await p.keyboard.press("m"); await sleep(2000);
    await p.evaluate(() => gameAPI.moveFleet(1, 1)); await sleep(1500);
    await p.evaluate(() => gameAPI.endTurn());
    await hold(p, 4000);
    await stop();
  },
  async refit(p, s) {
    await load(p, 16); await sleep(800);
    const stop = await rec(p, "refit", s);
    const f6 = "S.fleets.find(f=>f.id===6)";
    await p.evaluate(() => { const f = S.fleets.find(x => x.id === 6); S.sel = f.node; S.selFleet = 6; render(); }); await sleep(1500);
    for (const fn of ["openRefit", "openYard", "openFormation"]) {
      await p.evaluate(`${fn}(${f6})`); await hold(p, 3000);
      await p.evaluate(() => { $("modal").hidden = true; render(); }); await sleep(500);
    }
    await stop();
  },
  async battle(p, s) {
    await load(p, 13); await sleep(800);
    const stop = await rec(p, "battle", s);
    await sleep(1500);
    await p.evaluate(() => { S.sel = 3; S.selFleet = 1; render(); }); await sleep(1200);
    await p.keyboard.press("m"); await sleep(1800);
    const r = await p.evaluate(() => gameAPI.moveFleet(1, 10)); console.log(r.message, JSON.stringify(r.battles));
    await hold(p, 2500);
    await stop();
  },
  async xeno(p, s) {
    await load(p, 17); await sleep(800);
    const stop = await rec(p, "xeno", s);
    await sleep(1000);
    await p.evaluate(() => gameAPI.endTurn());
    await hold(p, 6000);
    await stop();
  },
  async seraph(p, s) {
    await load(p, 20); await sleep(800);
    const stop = await rec(p, "seraph", s);
    await sleep(800);
    const r = await p.evaluate(() => gameAPI.endTurn()); console.log(JSON.stringify(r.battles));
    await hold(p, 4000);
    await stop();
  },
  async hive(p, s) {
    await load(p, 21); await sleep(800);
    const stop = await rec(p, "hive", s);
    await sleep(800);
    await p.evaluate(() => gameAPI.endTurn()); await hold(p, 4000);
    for (let i = 0; i < 6 && await p.evaluate(() => !$("modal").hidden); i++) { await p.evaluate(() => gameAPI.dismissDialog()); await sleep(800); }
    await p.evaluate(() => { const f = S.fleets.find(f => f.id === 1); S.sel = f.node; S.selFleet = 1; render(); }); await sleep(1200);
    const r = await p.evaluate(() => gameAPI.moveFleet(1, 12)); console.log(r.message, JSON.stringify(r.battles));
    await hold(p, 7000); // 勝利の画面
    await stop();
  },
};
// 星図は zoom なし（1920 幅のレイアウトのほうが星図が大きい）。ほかは 1280 幅のレイアウトを 1.5 倍に拡大して撮る
const ZOOM1 = new Set(["map"]);
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
for (const n of names) {
  if (!SCENES[n]) { console.error("知らない場面:", n); process.exit(1); }
  const { br, p, scale } = await open({ zoom: ZOOM1.has(n) ? 1 : 1.5 });
  try { await SCENES[n](p, scale); } finally { await br.close(); }
}
