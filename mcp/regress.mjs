/* 回帰テスト：ゲーム本体（../game/frontier-war.html）の直した不具合が戻っていないか、短い決まった場面で確かめる。
 *   node regress.mjs
 * 1. スマホ幅で開くとスマホ用レイアウトになる（doctype・viewport）
 * 2. 主星に居座った異生体は、同じ星に残った守備艦隊をまず攻める
 * 3. 戦闘中は Tab で後ろの作戦卓に届かず、「最初から」も効かない。戦闘が終わるとフォーカスが作戦卓へ戻る
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../game");
const MIME = { ".html": "text/html", ".webp": "image/webp", ".mp3": "audio/mpeg" }; // わざと charset を付けない（文書の側で UTF-8 と分かること）
const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "frontier-war.html";
  const file = path.join(GAME_DIR, rel);
  if (!file.startsWith(GAME_DIR)) { res.writeHead(403); return res.end(); }
  try { const body = await fs.readFile(file); res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/frontier-war.html`;

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`); if (!ok) failures++; };
const browser = await chromium.launch({ headless: true });

/* 起動時のウィンドウ（遊び方・通信）を閉じる */
async function clearModals(page) {
  for (let i = 0; i < 10; i++) {
    if (await page.evaluate(() => document.getElementById("modal").hidden)) return;
    await page.evaluate(() => [...document.querySelectorAll("#modal button")].pop()?.click());
  }
}

try {
  console.log("1. スマホ幅（390×844）で開く");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.goto(URL_);
    const r = await page.evaluate(() => ({ w: window.innerWidth, narrow: isNarrow(), mode: document.compatMode, cs: document.characterSet, title: document.title }));
    check(r.w === 390, `innerWidth が端末幅（${r.w}）`);
    check(r.narrow, "isNarrow() が true（スマホ用レイアウト）");
    check(r.mode === "CSS1Compat", `標準モード（${r.mode}）`);
    check(r.cs === "UTF-8" && r.title === "辺境星系戦記", `文字コード ${r.cs}・タイトル「${r.title}」`);
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL_);
  await clearModals(page);

  console.log("2. 主星に居座った異生体と、残った守備艦隊");
  await page.evaluate(() => {
    window.FAST = true; window.AUTO_BATTLE = false;
    S.truce = true; S.monster = true; S.respawn = 0; // ヴァルガは動かさず、異生体だけを見る
    spawnXeno();
    const xf = S.fleets.find(f => f.side === "M"); xf.node = HOME;
    S.fleets.filter(f => f.side === "P").forEach(f => { f.moved = true; });
    S.noEndAsk = true; render();
    endTurn();
  });
  await page.waitForFunction(() => B || !ANIM.busy, null, { timeout: 15000 });
  const b = await page.evaluate(() => B && { home: B.cfg.node === HOME, xeno: B.cfg.ef.side === "M", where: planet(B.cfg.node).name });
  check(!!b && b.home && b.xeno, `主星で異生体との戦闘が始まる（${b ? b.where : "戦闘なし"}）`);

  console.log("3. 戦闘中のキーボード操作");
  await page.waitForFunction(() => B && !B.busy, null, { timeout: 15000 });
  const inBattle = await page.evaluate(() => document.getElementById("battle").contains(document.activeElement));
  check(inBattle, "戦闘が始まるとフォーカスが戦闘画面の中へ移る");
  let leaked = null;
  for (let i = 0; i < 40 && !leaked; i++) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    leaked = await page.evaluate(() => { const a = document.activeElement; return a && a.closest && a.closest(".app,#mbar") ? (a.textContent || a.id || a.tagName) : null; });
  }
  check(!leaked, `Tab / Shift+Tab で作戦卓に届かない${leaked ? `（${leaked} に届いた）` : ""}`);
  await page.evaluate(() => { openModal(card => card.append(h("button", { onclick: closeModal }, "閉じる"))); closeModal(); });
  check(await page.evaluate(() => document.querySelector(".app").inert), "戦闘中にウィンドウを開いて閉じても作戦卓は操作できないまま");
  await page.evaluate(() => document.getElementById("btnNew").click());
  check(await page.evaluate(() => document.getElementById("modal").hidden), "戦闘中に「最初から」を押してもやり直しの確認が出ない");
  await page.evaluate(() => toggleAuto());
  await page.waitForFunction(() => B && B.ended, null, { timeout: 60000 });
  const back = await page.evaluate(async () => {
    closeBattle(); await new Promise(r => setTimeout(r, 0)); // 戦闘画面を閉じた直後（このあと敵の行動の続きや通信が出ることがある）
    const a = document.activeElement;
    return { inert: document.querySelector(".app").inert, focus: !!(a && a.closest && a.closest(".app,#mbar")) };
  });
  await page.waitForFunction(() => !B && !ANIM.busy, null, { timeout: 30000 });
  check(!back.inert, "戦闘が終わると作戦卓を操作できる");
  check(back.focus, "戦闘が終わるとフォーカスが作戦卓へ戻る");
  check(!errors.length, `ページのエラーなし${errors.length ? `（${errors.join(" / ")}）` : ""}`);
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `✗ 回帰テスト失敗（${failures} 件）` : "✓ 回帰テスト成功");
process.exitCode = failures ? 1 : 0;
