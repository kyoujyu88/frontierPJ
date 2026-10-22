#!/usr/bin/env node
/* 「操作盤を開く.cmd」から呼ばれる起動係
 *
 * 1. 初回だけ部品を入れる（npm install と、Playwright の Chromium・ffmpeg）
 * 2. 操作盤（control.mjs）を窓なしで起動し、ブラウザで開く。もう動いていれば開くだけ
 * 3. 起動を確かめたら、この窓は自動で閉じる（操作盤の終了は画面右上の「終了」）
 *
 * 操作盤の出力は notes/.control.log に残る（うまく動かないときの手がかり）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const PORT = 3940;
const URL_ = `http://127.0.0.1:${PORT}/`;
const READY = path.join(HERE, "node_modules", ".frontier-ready");
const LOG = path.join(HERE, "notes", ".control.log");
const say = (s) => console.log(s);

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) { say(`Node.js ${process.versions.node} は古すぎます。https://nodejs.org/ja から LTS 版（20以上）を入れ直してください。`); process.exit(1); }

function run(cmd, args) {
  return new Promise((ok, ng) => {
    // Windows の npm / npx は .cmd なので shell 経由で動かす
    const p = spawn(cmd, args, { cwd: HERE, stdio: "inherit", shell: IS_WIN });
    p.on("error", ng);
    p.on("exit", (c) => c === 0 ? ok() : ng(new Error(`${cmd} ${args.join(" ")} が失敗しました（${c}）`)));
  });
}

const alive = () => fetch(`${URL_}api/state`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);

if (await alive()) {
  say("操作盤はもう動いています。ブラウザで開きます。");
  const [cmd, args] = IS_WIN ? ["cmd", ["/c", "start", "", URL_]] : process.platform === "darwin" ? ["open", [URL_]] : ["xdg-open", [URL_]];
  spawn(cmd, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
  await new Promise(r => setTimeout(r, 1500));
  process.exit(0);
}

if (!fs.existsSync(READY) || !fs.existsSync(path.join(HERE, "node_modules", "playwright"))) {
  say("はじめての準備をしています。部品のダウンロードで数分かかります。この窓は閉じずにお待ちください。\n");
  try {
    await run("npm", ["install", "--no-audit", "--no-fund"]);
    say("\nゲームを動かすブラウザ（Chromium）と録画用の部品を入れています…\n");
    await run("npx", ["playwright", "install", "chromium"]);
    fs.writeFileSync(READY, new Date().toISOString() + "\n");
    say("\n準備ができました。\n");
  } catch (e) {
    say(`\n準備に失敗しました：${e.message}\nインターネットにつながっているか確かめて、もう一度ダブルクリックしてください。`);
    process.exit(1);
  }
}

say("操作盤を起動しています…");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const out = fs.openSync(LOG, "a");
fs.writeSync(out, `\n===== ${new Date().toLocaleString("ja-JP")} 起動 =====\n`);
const child = spawn(process.execPath, [path.join(HERE, "control.mjs")], { cwd: HERE, stdio: ["ignore", out, out], detached: true, windowsHide: true });
child.unref();
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 500));
  if (await alive()) { say(`操作盤が開きました：${URL_}\nこの窓は自動で閉じます。操作盤を終えるときは、画面右上の「終了」を押してください。`); await new Promise(r => setTimeout(r, 2500)); process.exit(0); }
  if (child.exitCode !== null) break;
}
say(`操作盤を起動できませんでした。くわしくは ${LOG} を見てください。\n`);
try { say(fs.readFileSync(LOG, "utf8").split(/\r?\n/).slice(-15).join("\n")); } catch {}
process.exit(1);
