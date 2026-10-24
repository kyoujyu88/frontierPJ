#!/usr/bin/env node
/* 録画（映像だけの .webm）に、別に録ったゲームの音を重ねる。server.mjs が切り離して起動する。
 *   node mux-audio.mjs <動画.webm> <音.webm> <音の開始の遅れ(秒)> <ffmpeg>
 * ストリームをコピーするだけなので、Playwright 付属の小さな ffmpeg でできる。失敗したら映像だけの動画を残す。 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const [video, audio, offset, ff] = process.argv.slice(2);
const tmp = video.replace(/\.webm$/, "") + ".mux.webm";
const code = await new Promise((ok) => {
  const p = spawn(ff, ["-y", "-loglevel", "error", "-i", video, "-itsoffset", offset, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", tmp], { stdio: "ignore", windowsHide: true });
  p.on("error", () => ok(-1)); p.on("exit", ok);
});
if (code === 0) {
  // 再生中などでつかまれていたら少し待ってやり直す
  for (let i = 0; i < 10; i++) { try { await fs.rename(tmp, video); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
}
await fs.rm(tmp, { force: true }).catch(() => {});
await fs.rm(audio, { force: true }).catch(() => {});
