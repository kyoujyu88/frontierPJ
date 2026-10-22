#!/usr/bin/env node
/* 辺境星系戦記 MCPサーバー
 *
 * ゲーム（単一HTML）を Playwright で開いたブラウザに表示し、game-api.js を注入して
 * MCPツール経由で操作する。ブラウザ画面はそのまま OBS のウィンドウキャプチャで配信できる。
 *
 *   node server.mjs                 … stdio（Claude Desktop など一般的なMCPクライアント）
 *   node server.mjs --http 3939     … Streamable HTTP（http://127.0.0.1:3939/mcp）
 *
 * オプション（環境変数でも可）
 *   --game <path>     ゲームHTML（既定 ../game/frontier-war.html）           GAME_PATH
 *   --cdp <url>       起動済み Chrome に接続（例 http://127.0.0.1:9222）     GAME_CDP
 *   --headless        ウィンドウを出さない（テスト用）                        GAME_HEADLESS=1
 *   --pace <ms>       行動ごとの演出の間（既定 700、0で即時）                GAME_PACE
 *   --speaker <名前>  字幕・行動表示の名前（既定 のあ）                       GAME_SPEAKER
 *   --size 1280x720   ウィンドウの中身の大きさ                                GAME_SIZE
 *   --record <dir>    ゲーム画面を動画（.webm、音なし）で dir に録画する      GAME_RECORD
 *   --record-name <名前>  録画ファイルの名前（既定 日時。.webm は自動で付く）  GAME_RECORD_NAME
 *   --manual-battle   戦術戦闘を battle_* ツールで1隻ずつ操作する（既定はオート戦闘で、  GAME_MANUAL_BATTLE=1
 *                     戦闘は自動で決着して結果だけが返る。battle_* ツールは出さない）
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, env, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : (process.env[env] ?? def); };
const flag = (name, env) => argv.includes(`--${name}`) || process.env[env] === "1";

const GAME_PATH = path.resolve(HERE, opt("game", "GAME_PATH", "../game/frontier-war.html"));
const CDP = opt("cdp", "GAME_CDP", null);
const HEADLESS = flag("headless", "GAME_HEADLESS");
const PACE = Number(opt("pace", "GAME_PACE", 700));
const SPEAKER = opt("speaker", "GAME_SPEAKER", "のあ");
const [W, H] = opt("size", "GAME_SIZE", "1280x720").split("x").map(Number);
const HTTP_PORT = opt("http", "GAME_HTTP", null);
const RECORD_DIR = opt("record", "GAME_RECORD", null) && path.resolve(opt("record", "GAME_RECORD", null));
const RECORD_NAME = opt("record-name", "GAME_RECORD_NAME", null);
const MANUAL_BATTLE = flag("manual-battle", "GAME_MANUAL_BATTLE");
const API_JS = await fs.readFile(path.join(HERE, "game-api.js"), "utf8");
const err = (...a) => console.error("[frontier-war-mcp]", ...a); // stdout はMCP専用

/* ---------- ゲームファイルの配信（file:// だと音声ファイル等の読み込みで問題が出るため） ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const ROOT = path.dirname(GAME_PATH);
const staticServer = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/" + path.basename(GAME_PATH);
    const file = path.join(ROOT, path.normalize(p));
    if (!file.startsWith(ROOT)) throw new Error("forbidden");
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => staticServer.listen(0, "127.0.0.1", r));
const GAME_URL = `http://127.0.0.1:${staticServer.address().port}/`;

/* ---------- ブラウザ ---------- */
let browser = null, page = null, opening = null;
async function inject(pg) {
  if (await pg.evaluate(() => !!window.gameAPI).catch(() => false)) return;
  await pg.addScriptTag({ content: API_JS });
  const r = await pg.evaluate(([pace, sp, auto]) => { gameAPI.setPace(pace); gameAPI.setSpeaker(sp); return gameAPI.setAutoBattle(auto); }, [PACE, SPEAKER, !MANUAL_BATTLE]);
  if (!r.ok) err(r.message);
}
async function openGame() {
  if (CDP) {
    browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    page = await ctx.newPage();
  } else {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ["--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H + 90}`],
    });
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, ...(RECORD_DIR ? { recordVideo: { dir: RECORD_DIR, size: { width: W, height: H } } } : {}) });
    page = await ctx.newPage();
    if (RECORD_DIR) track(page);
  }
  page.on("load", () => inject(page).catch(e => err("inject failed", e.message)));
  page.on("close", () => { page = null; });
  browser.on("disconnected", () => { browser = null; page = null; });
  await page.goto(GAME_URL);
  await inject(page);
  err(`game opened: ${GAME_URL}`);
}
/* ---------- 録画（Playwright の recordVideo。ページを閉じると確定するので、閉じたあとで名前を付け直す） ---------- */
const recordings = [];
let recCount = 0;
function track(pg) {
  const v = pg.video();
  if (!v) return;
  const stamp = new Date().toLocaleString("sv-SE").replace(/[-: ]/g, "").replace(/^(\d{8})(\d{4}).*/, "$1-$2");
  const base = (RECORD_NAME || stamp).replace(/[\\/:*?"<>|]+/g, "_") + (recCount++ ? `-${recCount}` : "");
  err(`recording: ${path.join(RECORD_DIR, base + ".webm")}`);
  recordings.push(new Promise(r => pg.once("close", r)).then(async () => {
    await pg.context().close().catch(() => {}); // コンテキストを閉じると動画が書き終わる
    const src = await v.path();
    let dst = path.join(RECORD_DIR, base + ".webm");
    for (let i = 2; await fs.stat(dst).then(() => true, () => false); i++) dst = path.join(RECORD_DIR, `${base}-${i}.webm`);
    await fs.rename(src, dst);
    err(`recorded: ${dst}`);
  }).catch(e => err("recording failed:", e.message)));
}
async function finishRecording() {
  if (!recordings.length) return;
  try { await page?.context().close(); } catch {}
  await Promise.all(recordings);
}
if (RECORD_DIR && CDP) err("--record は --cdp と一緒には使えません（録画しません）");
if (RECORD_DIR) await fs.mkdir(RECORD_DIR, { recursive: true });

async function getPage() {
  if (page && !page.isClosed()) return page;
  if (!opening) opening = openGame().finally(() => { opening = null; });
  await opening;
  return page;
}
async function call(method, ...args) {
  const pg = await getPage();
  await inject(pg);
  return pg.evaluate(([m, a]) => window.gameAPI[m](...a), [method, args]);
}

/* ---------- MCPツール ---------- */
const asText = v => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], isError: v && v.ok === false });
const id = z.number().int();

function buildServer() {
  const s = new McpServer({ name: "frontier-war", version: "1.0.0" }, {
    instructions: "SF戦略シミュレーション『辺境星系戦記』を操作するサーバー。最初に get_rules を読み、get_state で状況を確認してから行動する。通信ウィンドウ（dialog）が出たら内容を読んで dismiss_dialog。"
      + (MANUAL_BATTLE ? "戦闘が始まったら battle_* で戦い、終わったら battle_close。" : "戦術戦闘はオートで決着し、結果は行動の返り値（events・battles）に出る。")
      + "視聴者向けの一言は say で字幕に出せる。",
  });
  const tool = (name, description, shape, fn) =>
    s.registerTool(name, { description, inputSchema: shape }, async (a) => {
      try { const v = await fn(a ?? {}); return v && Array.isArray(v.content) ? v : asText(v); }
      catch (e) { return asText({ ok: false, message: `サーバーエラー：${e.message}` }); }
    });

  tool("get_rules", "ゲームのルール要約（目的・内政・改装・戦術戦闘の計算式）を読む。最初に一度読むこと。", {}, () => call("rules"));
  tool("get_state", "現在の全状況を取得：資金・研究・自軍艦隊（移動先の候補つき）・敵艦隊・惑星・最近のログ。通信ウィンドウや戦闘中ならその内容も含む。", {}, () => call("getState"));
  tool("get_summary", "現在の状況を短い日本語の文章で取得する（get_state より軽い。小さなモデル向け）。戦闘中は盤面図と各艦の攻撃候補・移動先を返す。", {}, () => call("getSummary"));
  tool("get_screenshot", "配信画面のスクリーンショットを取得する（画像）。", {}, async () => {
    const pg = await getPage();
    const buf = await pg.screenshot({ type: "jpeg", quality: 70 });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
  });
  tool("say", "視聴者に向けたセリフを画面下に字幕として表示する（ゲームには影響しない）。", {
    text: z.string().describe("表示するセリフ"),
    seconds: z.number().optional().describe("表示秒数（省略時は文字数から自動）"),
  }, ({ text, seconds }) => call("say", text, undefined, seconds ? seconds * 1000 : undefined));
  tool("dismiss_dialog", "開いている通信ウィンドウを閉じる（「了解」を押す）。", {}, () => call("dismissDialog"));

  // 作戦卓
  const BATTLE_NOTE = MANUAL_BATTLE ? "" : "戦闘はオートで決着してから返る（結果は events と battles）。";
  tool("move_fleet", "自軍艦隊を移動させる。隣接する星か、自国の星（亜空間移動）へ。敵のいる星や敵・中立の星へ入ると戦術戦闘が始まる（艦隊戦に勝っても星は占領されない。残った星は次のターンに to=いまいる星 で攻略戦）。" + BATTLE_NOTE + "候補は get_summary の「移動先」（get_state なら myFleets[].moveOptions）。", {
    fleet_id: id.describe("自軍艦隊のID"), to: id.describe("行き先の惑星ID"),
  }, ({ fleet_id, to }) => call("moveFleet", fleet_id, to));
  tool("intercept", "艦隊がいる星に居座る敵（異生体、休戦していなければヴァルガ艦隊も）を迎撃して戦闘を始める。自国の星なら対空砲台も働く。" + BATTLE_NOTE, { fleet_id: id }, ({ fleet_id }) => call("intercept", fleet_id));
  tool("invest_research", "資金を研究に投資する（30・60・120）。必要量に達すると次の艦級が完成し、改装上限も上がる。", {
    amount: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  }, ({ amount }) => call("investResearch", amount));
  tool("refit_ship", "艦の能力ポイントを振り直す。合計は艦級のポイント以下、各項目は改装上限以下。変える項目だけ書けばよく、書かない項目は今の値のまま（今の配分は get_summary の[装2砲2ミ0爆0機2]など）。", {
    fleet_id: id, ship_index: id.describe("艦隊内の番号（0が旗艦）"),
    sh: z.number().int().optional().describe("装甲"), ca: z.number().int().optional().describe("主砲"),
    mi: z.number().int().optional().describe("ミサイル"), bo: z.number().int().optional().describe("爆装（惑星・巣の中枢攻撃に必須）"),
    sp: z.number().int().optional().describe("機関（戦闘時の移動力）"),
  }, ({ fleet_id, ship_index, sh, ca, mi, bo, sp }) => call("refitShip", fleet_id, ship_index, { sh, ca, mi, bo, sp }));
  tool("set_flagship", "艦隊の旗艦（★、沈むと戦闘に負ける）を指定する。", { fleet_id: id, ship_index: id }, ({ fleet_id, ship_index }) => call("setFlagship", fleet_id, ship_index));
  tool("set_formation", "艦隊の陣形を変える（行動は消費しない）。line横陣＝補正なし／wedge楔形＝1ラウンド目の移動+1／square方陣＝旗艦の隣に味方がいる間、旗艦の被ダメージ-25%／crane鶴翼＝側面・背面への攻撃+15%／rear後衛陣＝ミサイル+1。", {
    fleet_id: id, formation: z.enum(["line", "wedge", "square", "crane", "rear"]),
  }, ({ fleet_id, formation }) => call("setFormation", fleet_id, formation));
  tool("build_ship", "造船所のある自国の星にいる艦隊に艦を建造する。replace=true なら最も旧式の艦を下取りして置き換える。", {
    fleet_id: id, class_index: id.describe("艦級 0ラーク 1ファルコ 2グレイヴ 3アークライト 4セラフ"),
    replace: z.boolean().optional(),
  }, ({ fleet_id, class_index, replace }) => call("buildShip", fleet_id, class_index, !!replace));
  tool("repair_fleet", "自国の星にいる艦隊を修理する（損傷の半分の資金）。", { fleet_id: id }, ({ fleet_id }) => call("repairFleet", fleet_id));
  tool("new_fleet", "造船所のある自国の星で新しい艦隊（ラーク級1隻）を編成する。自軍艦隊は最大3つ。", { planet_id: id }, ({ planet_id }) => call("newFleet", planet_id));
  tool("build_facility", "自国の星の空きスロットに施設を建てる。mine採掘所 yard造船所 sats防衛衛星群 lab研究所 flak対空砲台。", {
    planet_id: id, facility: z.enum(["mine", "yard", "sats", "lab", "flak"]),
  }, ({ planet_id, facility }) => call("buildFacility", planet_id, facility));
  tool("demolish_facility", "自国の星の施設を撤去してスロットを空ける（返金なし）。", {
    planet_id: id, facility: z.enum(["mine", "yard", "sats", "lab", "flak"]),
  }, ({ planet_id, facility }) => call("demolishFacility", planet_id, facility));
  tool("survey", "自国の星で小惑星探査（40）。45%で収入+20。", { planet_id: id }, ({ planet_id }) => call("survey", planet_id));
  tool("fortify", "自国の星の防衛力を修復（30で+15）。", { planet_id: id }, ({ planet_id }) => call("fortify", planet_id));
  tool("end_turn", "ターンを終了する。収入・研究が入り、敵が行動する。" + (MANUAL_BATTLE ? "敵に襲われると戦闘が始まった状態で返る。" : "敵に襲われたときの防衛戦もオートで決着してから返る（結果は events と battles）。"), {}, () => call("endTurn"));
  tool("new_game", "最初からやり直す（現在の戦況は失われる）。", { confirm: z.literal(true).describe("true を渡したときだけ実行") }, () => call("newGame"));

  // 戦術戦闘（--manual-battle のときだけ。既定のオート戦闘では出さない）
  if (!MANUAL_BATTLE) return s;
  tool("battle_state", "戦術戦闘の盤面（ユニット・座標・向き・各自軍艦の移動先と攻撃候補と予測ダメージ）を取得する。", {}, async () => (await call("getState")).battle ?? { ok: false, message: "戦闘中ではありません" });
  tool("battle_attack", "自軍艦で敵を攻撃する（射程内のみ。武器は最も効く物が自動で選ばれる）。その艦はこのラウンド行動済みになる。", {
    unit_id: id, target_id: id,
  }, ({ unit_id, target_id }) => call("battleAttack", unit_id, target_id));
  tool("battle_move", "自軍艦を移動する（移動先は get_summary の「移動先」、battle_state なら moves）。移動した艦はこのラウンド攻撃できない。移動方向を向く。", {
    unit_id: id, x: id, y: id,
  }, ({ unit_id, x, y }) => call("battleMove", unit_id, x, y));
  tool("battle_wait", "自軍艦を待機させる（何もしない）。", { unit_id: id }, ({ unit_id }) => call("battleWait", unit_id));
  tool("battle_end_phase", "自軍フェイズを終了し、敵フェイズを進める。まだ動いていない艦は何もしないまま終わる（全艦が攻撃・移動・待機を終えれば、呼ばなくても自動で敵の番になる）。", {}, () => call("battleEndPhase"));
  tool("battle_retreat", "戦闘から撤退する（艦隊は主星へ戻る。防衛戦で撤退すると、その星は敵に攻められる）。", {}, () => call("battleRetreat"));
  tool("battle_close", "終わった戦闘を閉じて作戦卓に戻る。ターン終了中なら次の戦闘やターン処理が続く。", {}, () => call("battleClose"));
  return s;
}

/* ---------- 起動 ---------- */
getPage().catch(e => err("browser launch failed:", e.message)); // 配信用に先に窓を出しておく

if (HTTP_PORT) {
  const HOSTS = new Set([`127.0.0.1:${HTTP_PORT}`, `localhost:${HTTP_PORT}`]);
  const srv = http.createServer(async (req, res) => {
    try {
      // 別のサイトのページから操作されないように（DNSリバインディング対策。操作盤 control.mjs と同じ）
      if (!HOSTS.has(req.headers.host) || (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin))) { res.writeHead(403); return res.end(); }
      if (!req.url.startsWith("/mcp")) { res.writeHead(404); return res.end(); }
      let body;
      if (req.method === "POST") {
        const chunks = []; for await (const c of req) chunks.push(c);
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "null"); } catch { res.writeHead(400); return res.end("invalid JSON"); }
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) { err("http:", e.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  srv.listen(Number(HTTP_PORT), "127.0.0.1", () => err(`MCP (Streamable HTTP): http://127.0.0.1:${HTTP_PORT}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
  err("MCP (stdio) ready");
}
let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  try { await finishRecording(); } catch {}
  try { await browser?.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
process.stdin.on("close", () => { if (!HTTP_PORT) shutdown(); });
// クライアント（ai-player など）が先に終わると、返事を書くときに EPIPE になる。落ちずに録画を仕上げてから終わる
process.stdout.on("error", () => shutdown());
