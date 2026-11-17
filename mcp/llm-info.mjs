/* 使っている LLM の詳細を調べる（ai-player.mjs がプレイの始めに画面とプレイログへ出す）
 *
 * Ollama の API で分かること
 *   /api/version … Ollama の版
 *   /api/show    … モデルの系統・パラメータ数・量子化・対応機能（ツール・考える・画像）、
 *                  モデル本来の最大コンテキスト長（model_info の <系統>.context_length）、Modelfile の num_ctx・num_predict（返事の上限）
 *   /api/ps      … 読み込まれたモデルの実際のコンテキスト長（context_length）と、
 *                  メモリの使い方（size：全体、size_vram：そのうち GPU のメモリ＝VRAM に載った分。残りはメインメモリで CPU が計算）
 * GPU の機種名は Ollama の API にない。--gpu <名前> で書けばログに出す。
 * Ollama が同じ PC（localhost）のときだけ、nvidia-smi があれば機種名と VRAM の大きさを自動で調べる。
 * Ollama でないサーバー（LM Studio など）では、どれも取れずに null になる（プレイには影響しない）
 */
import { execFile } from "node:child_process";

// ollama ps と同じく 1 GB = 10億バイトで表す
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;
const num = (n) => Number(n).toLocaleString("en-US");

async function getJson(url, init = {}, timeout = 3000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/* 名前の照合：noa-game と noa-game:latest を同じものとみなす */
export const sameModel = (a, b) => { a = String(a ?? ""); b = String(b ?? ""); return a === b || a === `${b}:latest` || `${a}:latest` === b; };
export const ollamaRoot = (baseUrl) => String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
export const isLocalHost = (baseUrl) => { try { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(baseUrl).hostname); } catch { return false; } };

/* モデルそのものの情報（読み込み前でも取れる）。Ollama でなければ null */
export async function modelInfo(baseUrl, model) {
  const root = ollamaRoot(baseUrl);
  let sh;
  try { sh = await getJson(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }); } catch { return null; }
  if (!sh || typeof sh !== "object" || (!sh.details && !sh.model_info)) return null;
  const version = await getJson(`${root}/api/version`).then(v => v.version ?? null, () => null);
  const d = sh.details ?? {}, mi = sh.model_info ?? {};
  const arch = mi["general.architecture"] || d.family || null;
  const maxCtx = Number(mi[`${arch}.context_length`]) || Number(d.context_length) || null;
  const param = (k) => String(sh.parameters ?? "").match(new RegExp(`(?:^|\\n)\\s*${k}\\s+(-?\\d+)`))?.[1];
  const numCtx = Number(param("num_ctx")) || null;
  const numPredict = param("num_predict") != null ? Number(param("num_predict")) : null; // -1 は上限なし
  return {
    version, family: d.family || arch, arch,
    parameterSize: d.parameter_size || null, parameterCount: Number(mi["general.parameter_count"]) || null,
    quantization: d.quantization_level || null, format: d.format || null, parent: d.parent_model || null,
    capabilities: Array.isArray(sh.capabilities) ? sh.capabilities : null,
    maxCtx, numCtx, numPredict,
  };
}

/* 読み込まれたモデルの状態（実際のコンテキスト長とメモリの載り方）。読み込まれていない・Ollama でなければ null */
export async function loadedInfo(baseUrl, model) {
  let ps;
  try { ps = await getJson(`${ollamaRoot(baseUrl)}/api/ps`); } catch { return null; }
  const m = (ps?.models ?? []).find(x => sameModel(x.name, model) || sameModel(x.model, model));
  if (!m) return null;
  const size = Number(m.size) || 0, vram = Math.min(Number(m.size_vram) || 0, size || Infinity);
  // ollama ps の PROCESSOR 欄と同じ計算（CPU の割合を四捨五入）
  const cpuPct = size ? Math.round((size - vram) / size * 100) : null;
  return {
    ctx: Number(m.context_length) || null, size: size || null, sizeVram: vram, sizeRam: size ? size - vram : null,
    gpuPct: cpuPct == null ? null : 100 - cpuPct, cpuPct,
    others: (ps.models ?? []).filter(x => x !== m).map(x => x.name || x.model), // 同時に読み込まれているほかのモデル（VRAM を取り合う）
  };
}

/* 同じ PC の NVIDIA GPU（nvidia-smi）。なければ null */
export function localGpus(timeout = 3000) {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"], { timeout, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const g = String(out).trim().split(/\r?\n/).map(l => l.split(",").map(s => s.trim())).filter(a => a[0])
        .map(([name, total, used]) => ({ name, totalMiB: Number(total) || null, usedMiB: Number(used) || null }));
      resolve(g.length ? g : null);
    });
  });
}
export const gpuText = (gpus) => gpus?.length ? gpus.map(g => `${g.name}${g.totalMiB ? `（VRAM ${(g.totalMiB / 1024).toFixed(0)} GB）` : ""}`).join("＋") : null;

const CAPS = { tools: "ツール", thinking: "考える", vision: "画像", completion: null, embedding: "埋め込み", insert: null };
/* 画面とログ用の1〜2行 */
/* maxTokens：ai-player が送る返事の上限（max_tokens。0 は送らない）。Modelfile の num_predict より優先される */
export function describeModel(model, info, { maxTokens = 0 } = {}) {
  if (!info) return null;
  const caps = (info.capabilities ?? []).map(c => c in CAPS ? CAPS[c] : c).filter(Boolean);
  const size = info.parameterSize || (info.parameterCount ? `${(info.parameterCount / 1e9).toFixed(1)}B` : null);
  const head = [info.family, size && `${size}パラメータ`, info.quantization && `量子化 ${info.quantization}`, caps.length && `${caps.join("・")}対応`].filter(Boolean).join("・");
  const ctx = [info.maxCtx && `モデル本来の上限 ${num(info.maxCtx)}`, info.numCtx && `Modelfile の num_ctx ${num(info.numCtx)}`].filter(Boolean).join("／");
  const np = info.numPredict != null && info.numPredict >= 0 ? `Modelfile の num_predict ${num(info.numPredict)}` : null;
  const out = maxTokens ? `${num(maxTokens)}（--max-tokens${np ? `。${np} より優先` : ""}）` : np ? `${np}（--max-tokens で変えられます）` : null;
  return `${model}（${head || "詳細なし"}）${info.version ? `　Ollama ${info.version}` : ""}${ctx ? `\n  コンテキスト長：${ctx}` : ""}${out ? `\n  返事の上限：${out}` : ""}`;
}
export function describeLoaded(l, { gpu } = {}) {
  if (!l) return null;
  const mem = l.size == null ? "メモリ不明"
    : l.cpuPct === 0 ? `メモリ ${gb(l.size)} すべて GPU（VRAM）`
    : l.gpuPct === 0 ? `メモリ ${gb(l.size)}：GPU を使っていません（すべてメインメモリ・CPU で計算）`
    : `メモリ ${gb(l.size)}：GPU（VRAM）${gb(l.sizeVram)} ${l.gpuPct}%／メインメモリ ${gb(l.sizeRam)} ${l.cpuPct}%`;
  return `コンテキスト長 ${l.ctx ? num(l.ctx) : "不明"}・${mem}${gpu ? `・GPU ${gpu}` : ""}`;
}
/* 遅くなりそうなときの注意 */
export function loadWarnings(l, info) {
  const w = [];
  // 一部だけメインメモリにはみ出したとき（GPU をまったく使っていないときは、読み込み状態の行に書くだけにする）
  if (l?.cpuPct > 0 && l.gpuPct > 0) w.push(`モデルの ${l.cpuPct}% がメインメモリに載っていて、その分は CPU で計算するので遅くなります（コンテキスト長を縮めるか、小さい量子化にすると GPU に収まります）`);
  if (l?.others?.length) w.push(`ほかのモデルも読み込まれています（${l.others.join("、")}）。VRAM を取り合います`);
  if (l?.ctx && info?.maxCtx && l.ctx > info.maxCtx) w.push(`コンテキスト長 ${num(l.ctx)} がモデル本来の上限 ${num(info.maxCtx)} を超えています`);
  return w;
}
