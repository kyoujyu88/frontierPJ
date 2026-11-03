/* 紹介動画の撮影の共通部品：ゲームの準備・ブラウザ・場面の読み込み・録画（CDP screencast） */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
export const WORK = path.resolve(process.env.PROMO_WORK || path.join(REPO, "promo/work"));
const require = createRequire(import.meta.url);
export function playwright() {
  // この PC に入っている playwright を先に（ブラウザの版が合うもの）、なければ mcp/ のもの
  for (const p of ["playwright", path.join(REPO, "mcp/node_modules/playwright")]) { try { return require(p); } catch {} }
  throw new Error("playwright が見つかりません（mcp/ で npm install してください）");
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* WORK/game/main.html：本体 HTML の Google Fonts を、ローカル版（local/build_local.py の出力）のフォントと音に差し替えた写し */
export function prepareGame() {
  const LOCAL = path.join(REPO, "local/frontier-war");
  if (!fs.existsSync(path.join(LOCAL, "fonts/fonts.css"))) throw new Error("local/frontier-war がありません。先に python3 local/build_local.py を実行してください");
  const G = path.join(WORK, "game");
  fs.mkdirSync(G, { recursive: true });
  for (const d of ["art", "fonts", "audio"]) fs.cpSync(path.join(LOCAL, d), path.join(G, d), { recursive: true });
  let html = fs.readFileSync(path.join(REPO, "game/frontier-war.html"), "utf8");
  const before = html;
  html = html.replace(/<link rel="preconnect"[^>]*>\n?/g, "")
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="fonts/fonts.css"><script src="audio/audio-data.js"></script>');
  if (html === before || html.includes("fonts.googleapis.com")) throw new Error("フォントの読み込み行が見つかりません（本体 HTML の head が変わった？）");
  fs.writeFileSync(path.join(G, "main.html"), html);
  return path.join(G, "main.html");
}

/* ブラウザを開いてゲームを読み込み、game-api.js を差し込む。
   scale：1280×720 を何倍で撮るか（既定 1.5 → 1920×1080）。zoom：CSS の zoom（既定 scale と同じ。1 なら普通の 1920 幅の画面） */
export async function open({ seed = 7, scale = 1.5, zoom = scale } = {}) {
  const { chromium } = playwright();
  const html = prepareGame();
  const br = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await br.newContext({ viewport: { width: Math.round(1280 * scale), height: Math.round(720 * scale) } });
  const p = await ctx.newPage();
  p.on("pageerror", e => console.log("PAGEERR", e.message));
  await p.addInitScript(s => { let a = s >>> 0; Math.random = function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }, seed);
  // headless の screencast は CSS ピクセルの大きさで届くので、高解像度は deviceScaleFactor ではなく zoom で作る
  await p.addInitScript(z => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = String(z); }); }, zoom);
  await p.goto("file://" + html);
  await p.addScriptTag({ content: fs.readFileSync(path.join(REPO, "mcp/game-api.js"), "utf8") });
  await p.addStyleTag({ content: "#gapi-act,#gapi-cap{display:none!important}" }); // AIプレイ用の字幕・行動表示は隠す
  await p.evaluate(() => { gameAPI.setPace(500); gameAPI.setAutoBattle(true); });
  return { br, p, scale };
}

/* snaps.mjs で作った途中経過（ターンN の終了直前の S）を読み込む */
export async function load(p, turn, file = "snaps") {
  const d = JSON.parse(fs.readFileSync(path.join(WORK, `${file}.json`), "utf8"));
  const snap = d.snaps.find(s => s.turn === turn);
  if (!snap) throw new Error(`ターン${turn} の途中経過がありません`);
  await p.evaluate(s => { document.getElementById("modal").hidden = true; S = JSON.parse(s); S.mode = null; S.sel = 0; render(); }, snap.S);
}

/* 録画：CDP の screencast でコマを時刻つきで保存する。返り値の関数で止める（assemble.py で mp4 にする） */
export async function rec(p, name, scale) {
  const cdp = await p.context().newCDPSession(p);
  const dir = path.join(WORK, "rec", name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  cdp.on("Page.screencastFrame", f => {
    const i = frames.length; frames.push(f.metadata.timestamp);
    fs.writeFileSync(path.join(dir, String(i).padStart(5, "0") + ".jpg"), Buffer.from(f.data, "base64"));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(1280 * scale), maxHeight: Math.round(720 * scale), everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    fs.writeFileSync(path.join(dir, "times.json"), JSON.stringify({ frames }));
    console.log(`録画 ${name}: ${frames.length}コマ`);
  };
}
/* 画面が止まっていると screencast はコマを送らないので、隅の1ピクセルをかすかに変えて描き直させる */
export async function hold(p, ms) {
  for (let t = 0; t < ms; t += 250) {
    await p.evaluate(i => { let d = document.getElementById("promo-tick"); if (!d) { d = document.createElement("div"); d.id = "promo-tick"; d.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:99999;pointer-events:none"; document.body.append(d); } d.style.background = `rgba(8,11,22,${i % 2 ? 0.02 : 0.03})`; }, t / 250);
    await sleep(250);
  }
}
