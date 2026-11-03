/* 撮影用の途中経過を作る：検証ボット（上手）に1ゲーム通して遊ばせ、毎ターンの終了直前の状態 S を保存する。
 *   node snaps.mjs [--seed 1] [--bot <bot.js>]
 * bot.js は research/overhaul-2026-10-22/balance-bot/bot.js（共有フォルダの research/ にある）。
 * 出力：promo/work/snaps.json（場面のターン番号は shoot.mjs が seed 1 の展開を前提にしている）
 */
import fs from "node:fs";
import path from "node:path";
import { REPO, WORK, prepareGame, playwright } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seed = Number(opt("seed", 1));
const BOT = [opt("bot", null), process.env.BOT_JS, path.join(REPO, "research/overhaul-2026-10-22/balance-bot/bot.js"),
  "/mnt/project-files/research/overhaul-2026-10-22/balance-bot/bot.js"].find(p => p && fs.existsSync(p));
if (!BOT) { console.error("bot.js が見つかりません（--bot で指定）"); process.exit(1); }
const { chromium } = playwright();
let api = fs.readFileSync(path.join(REPO, "mcp/game-api.js"), "utf8");
api = api.replace("const sleep=ms=>new Promise(r=>setTimeout(r,ms));", "const sleep=ms=>new Promise(r=>setTimeout(r,window.__BOTFAST?0:ms));");
const html = prepareGame();
const br = await chromium.launch();
const p = await br.newPage({ viewport: { width: 1280, height: 720 } });
await p.addInitScript(s => { window.FAST = true; let a = s >>> 0; Math.random = function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }, seed);
await p.goto("file://" + html);
await p.addScriptTag({ content: api });
await p.evaluate(() => { window.__snaps = []; const o = gameAPI.endTurn; gameAPI.endTurn = async (...a) => { window.__snaps.push({ turn: S.turn, S: JSON.stringify(S) }); return o(...a); }; });
await p.addScriptTag({ content: fs.readFileSync(BOT, "utf8") });
const rec = await p.evaluate(() => BOT.play({ level: "good", seed: 0, maxTurns: 60, trace: true }));
const snaps = await p.evaluate(() => window.__snaps);
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "snaps.json"), JSON.stringify({ seed, rec, snaps }));
console.log(`seed ${seed}: ${rec.result} ターン${rec.endTurn}・異生体出現 ターン${rec.monsterTurn}・艦級の完成 ${JSON.stringify(rec.tierTurn)}`);
await br.close();
