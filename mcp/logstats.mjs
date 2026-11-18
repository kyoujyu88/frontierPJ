/* プレイログの集計：1試行ぶんのプレイログ（playlog.mjs の .jsonl を読んだもの）から、テンポと操作の質の数字を出す
 *
 * モデルやサーバー、設定を替えたときに、同じ物差しで比べるためのもの。どの OpenAI 互換サーバーのログでも数えられるものだけを使い、
 * サーバーが返さない数字（キャッシュしたトークン数など）は「分からない」として出す。
 *
 *   1ターンの秒数   … 最初のターンの始まりから、勝敗（over）か試行の終わり（end）まで ÷ ターン数
 *   内訳            … LLM の返事を待った時間（llm.sec の合計）／移動・戦闘の演出（move_fleet と end_turn の実行時間）／そのほか
 *                     ツールの実行時間は「その手を出した返事（または直前の手）からツールの結果まで」で測る
 *   読み直し        … キャッシュが効かずにプロンプト全体を読んだ返事（cached_tokens が 0）。サーバーが cached_tokens を返さないときは数えない
 *   読み込みの速さ  … 読み直しの返事の 送ったトークン ÷ 秒 の中央値（目安）。生成の速さは、読み直しなしの返事の
 *                     秒 ＝ 固定分 ＋ 足したトークン×a ＋ 出したトークン×b を最小二乗で当てはめた 1/b（キャッシュの量が分からなければ全部の返事で当てはめる）
 *   失敗率          … AI が選んだ操作のうち、ゲームに断られた割合（get_next など成否のないものは除く）。理由は文面から大まかに分ける
 *   会話の継続      … ターンの始まりに前のターンの会話を続けた回数（context の keep）と作り直した回数
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r0 = (v) => (v == null ? null : Math.round(v));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* 失敗の理由の分け方（上から順に見て、最初に当たったもの）。文面は game-api.js と server.mjs の断りの文 */
const FAIL_KINDS = [
  ["資金不足", /資金不足|資金が足りません/],
  ["行動済みの艦隊", /行動済み/],
  ["いまいる星への移動", /はいま .+ にいます/],
  ["行けない星", /行けません|行ける先/],
  ["造船所がない", /造船所がありません|造船所のある/],
  ["置換する艦がない", /置換するものがない|旧式の艦がいません/],
  ["施設が既にある・満杯", /既にあります|満杯/],
  ["研究できない・上限", /研究|投資/],
  ["迎撃できない", /迎撃/],
  ["引数の形", /引数が正しくありません|invalid|Invalid/],
  ["通信が開いている", /通信/],
];
export function failKind(message = "") {
  for (const [k, re] of FAIL_KINDS) if (re.test(message)) return k;
  return "そのほか";
}

/* 3つの未知数の最小二乗（正規方程式をガウスの消去法で解く）。解けなければ null */
function lsq3(rows, ys) {
  if (rows.length < 6) return null;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  rows.forEach((x, k) => { for (let i = 0; i < 3; i++) { b[i] += x[i] * ys[k]; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; } });
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j < 3; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

export function statsOf(events) {
  const start = events.find(e => e.type === "start") ?? {};
  const model = events.find(e => e.type === "model") ?? null;
  const loaded = events.findLast(e => e.type === "loaded") ?? null;
  const ctxEv = events.findLast(e => e.type === "ctx") ?? null;
  const over = events.find(e => e.type === "over"), end = events.findLast(e => e.type === "end");
  const turns = events.filter(e => e.type === "turn");
  const lastMs = events.length ? events[events.length - 1].ms : 0;
  const t0 = turns[0]?.ms ?? 0, t1 = over?.ms ?? end?.ms ?? lastMs;
  const playSec = Math.max(0, (t1 - t0) / 1000), nTurns = turns.length;
  const per = (v) => (nTurns && v != null ? v / nTurns : null);
  const share = (v) => (playSec && v != null ? v / playSec * 100 : null);
  const arg = (n) => { const a = start.serverArgs ?? [], i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : null; };

  /* LLM */
  const llm = events.filter(e => e.type === "llm");
  const isPlay = (e) => (e.kind ?? "play") === "play" || e.kind === "text"; // 振り返り（reflect）は数えない
  const play = llm.filter(isPlay);
  const llmSec = play.reduce((s, e) => s + (num(e.sec) ?? 0), 0);
  const hasCache = play.some(e => e.usage?.prompt_tokens_details && "cached_tokens" in e.usage.prompt_tokens_details);
  const cachedOf = (e) => e.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reread = hasCache ? play.filter(e => num(e.usage?.prompt_tokens) && cachedOf(e) === 0) : [];
  const warm = hasCache ? play.filter(e => num(e.usage?.prompt_tokens) && cachedOf(e) > 0) : [];
  // 最初の返事はモデルの読み込みが入ることが多いので、速さの見積もりからは外す
  const ok = (e) => num(e.usage?.prompt_tokens) && num(e.sec) > 0;
  let promptTps = null, genTps = null;
  if (hasCache) {
    // 生成の速さ：読み直しなしの返事を 秒 ＝ 固定分 ＋ 足したトークン×a ＋ 出したトークン×b で当てはめた 1/b。
    // 読み込みの速さ：読み直しの返事の 送ったトークン ÷ 秒 の中央値（生成の時間も入るので少し遅めに出る。
    // サーバーが cached_tokens を 0 と返しても一部は使い回していることがあり、補正するとかえって速く出すぎるため、補正しない）
    const w = warm.filter(ok);
    const k = lsq3(w.map(e => [1, e.usage.prompt_tokens - cachedOf(e), e.usage.completion_tokens ?? 0]), w.map(e => e.sec));
    if (k && k[2] > 0) genTps = 1 / k[2];
    const rr = reread.filter(ok).filter(e => e !== play[0]).map(e => e.usage.prompt_tokens / e.sec);
    promptTps = median(rr);
  } else {
    // キャッシュの量が分からないサーバー：全部の返事を 秒 ＝ 固定分 ＋ 送ったトークン×a ＋ 出したトークン×b で当てはめる（キャッシュが効いていると速めに出る）
    const f = play.slice(1).filter(ok);
    const k = lsq3(f.map(e => [1, e.usage.prompt_tokens, e.usage.completion_tokens ?? 0]), f.map(e => e.sec));
    if (k && k[1] > 0) promptTps = 1 / k[1];
    if (k && k[2] > 0) genTps = 1 / k[2];
  }
  const finish = {};
  for (const e of play) finish[e.finish ?? "?"] = (finish[e.finish ?? "?"] ?? 0) + 1;
  const sayOnly = play.filter(e => e.calls?.length && e.calls.every(c => c.name === "say")).length;

  /* ツールの実行時間（その手を出した返事か直前の手から、結果まで）。AI の手だけでなく自動進行・人の手も数える
   *（「移動・戦闘の演出」は誰が動かしても画面で流れる時間なので、1ターンの内訳としては全部入れる） */
  const dur = {};
  let prev = null;
  for (const e of events) {
    if (e.type === "tool" && prev != null) (dur[e.name] ??= []).push((e.ms - prev) / 1000);
    if (e.type === "llm" || e.type === "tool") prev = e.ms;
  }
  const sum = (a) => (a ?? []).reduce((s, v) => s + v, 0);
  const battleSec = sum(dur.move_fleet) + sum(dur.end_turn);

  /* 操作の成否 */
  const ai = events.filter(e => e.type === "tool" && e.by === "ai");
  const judged = ai.filter(e => e.ok === true || e.ok === false);
  const fails = judged.filter(e => e.ok === false);
  const failKinds = {};
  for (const e of fails) { const k = failKind(e.message); failKinds[k] = (failKinds[k] ?? 0) + 1; }
  // 同じ手（名前と引数が同じ）を、失敗した直後にもう一度呼んだ回数
  let repeatFails = 0;
  for (let i = 1; i < ai.length; i++) if (ai[i].ok === false && ai[i - 1].ok === false && ai[i].name === ai[i - 1].name && JSON.stringify(ai[i].args) === JSON.stringify(ai[i - 1].args)) repeatFails++;

  /* 会話 */
  const ctx = events.filter(e => e.type === "context");
  const keep = ctx.filter(e => e.keep === true).length, rebuild = ctx.filter(e => e.keep === false).length, compact = ctx.filter(e => e.compact).length;
  const empty = events.filter(e => e.type === "empty");

  return {
    name: start.name ?? null, model: start.model ?? null, baseUrl: start.baseUrl ?? null,
    outcome: end?.outcome ?? (over ? ({ win: "勝利", lose: "敗北" }[over.result] ?? over.result) : "途中"), startedAt: start.t ?? null,
    settings: { think: start.think ?? null, maxTokens: start.maxTokens ?? null, temperature: start.temperature ?? null,
      battleSpeed: arg("battle-speed"), pace: arg("pace"), ctx: ctxEv?.ctx ?? loaded?.ctx ?? null,
      gpuPct: loaded?.gpuPct ?? null, quantization: model?.quantization ?? null, parameterSize: model?.parameterSize ?? null },
    turns: nTurns, playSec: r0(playSec), secPerTurn: r1(per(playSec)),
    time: {
      llmPerTurn: r1(per(llmSec)), llmShare: r0(share(llmSec)),
      battlePerTurn: r1(per(battleSec)), battleShare: r0(share(battleSec)),
      otherPerTurn: r1(per(Math.max(0, playSec - llmSec - battleSec))),
      moveFleetMedian: r1(median(dur.move_fleet ?? [])),
    },
    llm: {
      replies: play.length, perTurn: r1(per(play.length)), cacheKnown: hasCache,
      reread: hasCache ? reread.length : null, rereadAvgSec: r1(mean(reread.map(e => e.sec))), rereadSec: r0(sum(reread.map(e => e.sec))),
      turnFirstReread: hasCache ? turnFirstRereads(events, isPlay) : null,
      warmAvgSec: r1(mean(warm.map(e => e.sec))),
      addedTokensAvg: r0(mean(warm.map(e => e.usage.prompt_tokens - cachedOf(e)))),
      promptTps: r0(promptTps), genTps: r1(genTps),
      promptMax: play.reduce((m, e) => Math.max(m, e.usage?.prompt_tokens ?? 0), 0) || null,
      completionMax: play.reduce((m, e) => Math.max(m, e.usage?.completion_tokens ?? 0), 0) || null,
      finish, cutByLimit: finish.length ?? 0, sayOnly, textAsk: llm.filter(e => e.kind === "text").length,
    },
    ops: { total: judged.length, fails: fails.length, failRate: judged.length ? r1(fails.length / judged.length * 100) : null, failKinds, repeatFails },
    empty: empty.length, emptyText: empty.filter(e => e.text).length,
    cut: events.filter(e => e.type === "cut").length, refuse: events.filter(e => e.type === "refuse").length,
    auto: events.filter(e => e.type === "auto").length, errors: events.filter(e => e.type === "error").length,
    context: { keep, rebuild, compact },
  };
}
/* 各ターンの最初の返事が読み直しだった回数（読み直しの回数と同じく、プレイの返事だけを見る） */
function turnFirstRereads(events, isPlay) {
  let n = 0, waiting = false;
  for (const e of events) {
    if (e.type === "turn") waiting = true;
    else if (waiting && e.type === "llm" && isPlay(e)) { waiting = false; if ((e.usage?.prompt_tokens_details?.cached_tokens ?? 0) === 0 && e.usage?.prompt_tokens) n++; }
  }
  return n;
}

/* ---------- 文字にする ---------- */
const fmt = (v, unit = "") => (v == null ? "—" : `${v}${unit}`);
const kinds = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join("・") || "なし";
/* 1本ぶん・何本かを横に並べた表の行（見出し, 値を出す関数） */
const ROWS = [
  ["結果", s => `${s.outcome}（${s.turns}ターン・${Math.round(s.playSec / 60)}分）`],
  ["モデル", s => `${s.model ?? "—"}${s.settings.ctx ? `・ctx ${s.settings.ctx}` : ""}${s.settings.gpuPct != null ? `・GPU ${s.settings.gpuPct}%` : ""}`],
  ["1ターン", s => fmt(s.secPerTurn, "秒")],
  ["  LLM", s => `${fmt(s.time.llmPerTurn, "秒")}（${fmt(s.time.llmShare, "%")}）`],
  ["  移動・戦闘の演出", s => `${fmt(s.time.battlePerTurn, "秒")}（${fmt(s.time.battleShare, "%")}）${s.settings.battleSpeed ? `・倍速${s.settings.battleSpeed}` : ""}`],
  ["  そのほか", s => fmt(s.time.otherPerTurn, "秒")],
  ["返事", s => `${s.llm.replies}回（${fmt(s.llm.perTurn, "回")}/ターン）・セリフだけ ${s.llm.sayOnly}回`],
  ["読み直し", s => s.llm.cacheKnown ? `${s.llm.reread}回・1回 ${fmt(s.llm.rereadAvgSec, "秒")}（ターン最初 ${s.llm.turnFirstReread}回）` : "—（サーバーがキャッシュの量を返さない）"],
  ["読み直しなしの返事", s => s.llm.cacheKnown ? `${fmt(s.llm.warmAvgSec, "秒")}（足したトークン 平均${fmt(s.llm.addedTokensAvg)}）` : "—"],
  ["読み込み／生成の速さ", s => `${fmt(s.llm.promptTps)} ／ ${fmt(s.llm.genTps)} トークン/秒`],
  ["会話の継続", s => `続けた ${s.context.keep}・作り直し ${s.context.rebuild}${s.context.compact ? `・途中で作り直し ${s.context.compact}` : ""}`],
  ["失敗率", s => s.ops.failRate == null ? "—" : `${s.ops.failRate.toFixed(1)}%（${s.ops.fails}/${s.ops.total}）`],
  ["  失敗の理由", s => kinds(s.ops.failKinds) + (s.ops.repeatFails ? `／同じ失敗の繰り返し ${s.ops.repeatFails}` : "")],
  ["空の返事", s => `${s.empty}回${s.llm.textAsk ? `（文字で聞き直し ${s.llm.textAsk}）` : ""}`],
  ["上限で切れた", s => `${s.llm.cutByLimit}回（最長の返事 ${fmt(s.llm.completionMax)}トークン・上限 ${fmt(s.settings.maxTokens)}）`],
  ["断った・自動進行", s => `${s.refuse}・${s.auto}`],
];
/* 見出しと値の組（操作盤は表にする） */
export const statsRows = (s) => ROWS.map(([h, f]) => [h.trim(), f(s), h.startsWith(" ")]);
export function statsText(s, { name = "" } = {}) {
  const w = Math.max(...ROWS.map(([h]) => width(h)));
  return [`# 集計 ${name}`.trim(), ...ROWS.map(([h, f]) => `${h}${" ".repeat(w - width(h))}  ${f(s)}`)].join("\n") + "\n";
}
/* 何本かを並べる（列は古い順に渡す） */
export function compareText(list) {
  const w = Math.max(...ROWS.map(([h]) => width(h)));
  const head = list.map((x, i) => `[${i + 1}] ${x.name}`).join("\n");
  const lines = ROWS.map(([h, f]) => `${h}${" ".repeat(w - width(h))}  ${list.map(x => f(x.stats)).join("  │  ")}`);
  return `${head}\n\n${lines.join("\n")}\n`;
}
/* 全角は2文字ぶんとして数える（等幅で揃えるため） */
function width(s) { let n = 0; for (const ch of s) n += /[\u0000-ÿ]/.test(ch) ? 1 : 2; return n; }

/* 1行の要約（プレイの終わりに ai-player がログに出す） */
export function statsLine(s) {
  return [`1ターン${fmt(s.secPerTurn, "秒")}（LLM ${fmt(s.time.llmPerTurn)}・移動と戦闘 ${fmt(s.time.battlePerTurn)}）`,
    s.llm.cacheKnown ? `読み直し${s.llm.reread}回×${fmt(s.llm.rereadAvgSec, "秒")}` : null,
    s.llm.promptTps ? `読み込み${s.llm.promptTps}トークン/秒` : null,
    s.ops.failRate != null ? `失敗${s.ops.failRate.toFixed(1)}%` : null, `空の返事${s.empty}`,
    `会話継続${s.context.keep}/${s.context.keep + s.context.rebuild}`].filter(Boolean).join("・");
}
