#!/usr/bin/env node
/* 辺境星系戦記 バランス検証ランナー
 *   node run.mjs --html <frontier-war.html> [--api <game-api.js>] [--levels novice,normal,good] [--games 40]
 *                [--workers 4] [--max-turns 60] [--patch tune.js] [--overrides '{"capital":"avoid"}'] [--variant 名前]
 *                [--seed 1000] [--out results.jsonl] [--tune tune/a.json[,b.json]] [--quiet] [--render]
 *   --tune：HTML の写し（tuned/ の下）に文字列の置き換えを当てて遊ぶ。--render：描画・効果音を止めない（遅い）
 * 1ゲームごとに1行の JSON を --out に追記し、最後に analyze.mjs の集計を表示する。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarize } from "./analyze.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Playwright はリポジトリの mcp/node_modules（mcp で npm install したもの）から読む。無ければふつうの解決に任せる
const { chromium } = (() => { try { return createRequire(path.join(HERE, "../../../mcp/package.json"))("playwright"); } catch { return createRequire(import.meta.url)("playwright"); } })();
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const HTML = path.resolve(opt("html", path.join(HERE, "../../../game/frontier-war.html"))); // 既定はリポジトリのゲーム本体
const APIJS = path.resolve(opt("api", [path.join(path.dirname(HTML), "../mcp-src/game-api.js"), path.join(path.dirname(HTML), "../mcp/game-api.js")].find(p => fs.existsSync(p)) || "game-api.js"));
const LEVELS = opt("levels", "novice,normal,good").split(",");
const GAMES = Number(opt("games", 40));
const WORKERS = Number(opt("workers", 4));
const MAXT = Number(opt("max-turns", 60));
const PATCH = opt("patch", null);
const OVR = JSON.parse(opt("overrides", "{}"));
const VARIANT = opt("variant", PATCH ? path.basename(PATCH, ".js") : opt("tune", null) ? opt("tune").split(",").map(f => path.basename(f, ".json")).join("+") : "base");
const SEED0 = Number(opt("seed", 1000));
const OUT = path.resolve(opt("out", path.join(HERE, "results", `${VARIANT}.jsonl`)));
const QUIET = argv.includes("--quiet");
const TURBO = !argv.includes("--render");

if (!fs.existsSync(HTML)) { console.error("HTML がありません:", HTML); process.exit(1); }
/* --tune a.json[,b.json]：HTML の写しに文字列の置き換え（調整案）を当てて、それを遊ぶ。各置き換えはちょうど1か所に当たること */
const TUNES = opt("tune", null);
let PLAY_HTML = HTML;
if (TUNES) {
  let src = fs.readFileSync(HTML, "utf8");
  for (const tf of TUNES.split(",")) {
    const t = JSON.parse(fs.readFileSync(path.resolve(tf), "utf8"));
    for (const e of t.edits) {
      const n = src.split(e.find).length - 1;
      if (n !== 1) { console.error(`調整 ${tf} の置き換えが ${n} か所に当たりました（1か所のはず）: ${e.find.slice(0, 80)}`); process.exit(1); }
      src = src.replace(e.find, () => e.replace);
    }
  }
  const dir = path.join(HERE, "tuned", (opt("variant", null) || TUNES.split(",").map(f => path.basename(f, ".json")).join("+")) + "-" + path.basename(path.dirname(HTML)));
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ["art", "audio"]) { const l = path.join(dir, d); if (!fs.existsSync(l)) fs.symlinkSync(path.join(path.dirname(HTML), d), l); }
  PLAY_HTML = path.join(dir, "frontier-war.html");
  fs.writeFileSync(PLAY_HTML, src);
}
if (!fs.existsSync(APIJS)) { console.error("game-api.js がありません:", APIJS, "（--api で指定）"); process.exit(1); }
let apiSrc = fs.readFileSync(APIJS, "utf8");
// 演出の待ち時間（setTimeout）だけを0にする：検証ロジックは同じ
const SLEEP = "const sleep=ms=>new Promise(r=>setTimeout(r,ms));";
if (apiSrc.includes(SLEEP)) apiSrc = apiSrc.replace(SLEEP, "const sleep=ms=>new Promise(r=>setTimeout(r,window.__BOTFAST?0:ms));");
else console.warn("注意: game-api.js の sleep 定義が見つからず、高速化できません（遅くなるだけで結果は同じ）");
const botSrc = fs.readFileSync(path.join(HERE, "bot.js"), "utf8");
const patchSrc = PATCH ? fs.readFileSync(path.resolve(PATCH), "utf8") : null;
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const jobs = [];
for (const lv of LEVELS) for (let i = 0; i < GAMES; i++) jobs.push({ level: lv, seed: SEED0 + i });
const results = [];
const t0 = Date.now();
const browser = await chromium.launch({ headless: true });
const SEEDJS = () => {
  const m = location.search.match(/seed=(\d+)/); window.FAST = true;
  // ボット実行中は短い setTimeout を MessageChannel で即時に回す（4ms の切り上げを避けるだけ。順序は保つ）
  const st = window.setTimeout.bind(window), ch = new MessageChannel(), q = [];
  ch.port1.onmessage = () => { const fn = q.shift(); if (fn) fn(); };
  window.setTimeout = function (fn, ms, ...args) { if (window.__BOTFAST && typeof fn === "function" && !(ms > 100)) { q.push(() => fn(...args)); ch.port2.postMessage(0); return 0; } return st(fn, ms, ...args); };
  if (m) { let a = Number(m[1]) >>> 0; Math.random = function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
};
async function worker(wi) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.addInitScript(SEEDJS);
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  while (jobs.length) {
    const job = jobs.shift();
    errs.length = 0;
    try {
      await page.goto(pathToFileURL(PLAY_HTML).href + `?seed=${job.seed}`);
      await page.addScriptTag({ content: apiSrc });
      await page.addScriptTag({ content: botSrc });
      if (patchSrc) await page.addScriptTag({ content: patchSrc });
      const rec = await page.evaluate(o => window.BOT.play(o), { level: job.level, seed: job.seed, maxTurns: MAXT, overrides: OVR, variant: VARIANT, turbo: TURBO });
      rec.pageErrors = errs.slice(0, 5);
      results.push(rec);
      fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
      if (!QUIET) console.log(`[w${wi}] ${job.level} seed${job.seed}: ${rec.result} T${rec.endTurn} 異生体T${rec.monsterTurn ?? "-"}(${rec.monsterReason ?? "-"}) 艦級${rec.finalTier} 資金${rec.finalFunds} 戦闘${rec.battles.length} ${(rec.ms / 1000).toFixed(1)}s${rec.errors.length ? " err" + rec.errors.length : ""}${errs.length ? " PAGEERR:" + errs[0] : ""}`);
    } catch (e) {
      console.log(`[w${wi}] ${job.level} seed${job.seed}: 失敗 ${e.message.split("\n")[0]}`);
    }
  }
  await ctx.close();
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
await browser.close();
console.log(`\n${results.length} ゲーム / ${((Date.now() - t0) / 1000).toFixed(0)} 秒  → ${OUT}\n`);
console.log(summarize(results));
