/* 反省メモ：ローカルLLMのプレイヤーが、遊ぶほど上手になるための記憶
 *
 * LLM自体はプレイ中に学習しないので、プレイの記録（ターンごとの戦況・戦闘・失敗した操作）を
 * 本人に読ませて「次に活かすこと」を箇条書きで書かせ、ファイルに残す。
 * 次のプレイ（とプレイ中の以降のターン）では、そのメモをシステムプロンプトに入れる。
 *
 * - プレイヤーの名前ごとに1ファイル（notes/<名前>.md）。手で読んだり直したりできる Markdown。
 * - モデルは問わない。振り返りはツールなしの普通のチャットで、箇条書きの行だけを拾う。
 *   うまく書けなかったときは前のメモを残す。
 * - 文字数に上限をつけ、小さなコンテキストのモデルでも溢れないようにする。
 *
 * 2026-11-19 の作り直し（数字つき・差分更新）：
 *   丸ごと書き直す作りでは、メモが毎回ほぼ全部入れ替わり、一般論ばかりになって、メモありとなしで
 *   勝ったターンも失敗率も変わらなかった（11試合と10試合のプレイログ）。そこで
 *   - 振り返りに「今回と前回の数字」と「前回決めた目標を達成できたか」を渡す（数字はこちらで数える）
 *   - メモは「消す 番号」「足す：」の差分で直させ、1回に変えるのは2項目まで（書かなかった項目は残る）
 *   - 次のプレイの目標を、決まった物差し（METRICS）と数字で書かせる。次の振り返りで自動で答え合わせする
 *   古い形式（丸ごと書き直していたころ）のメモの項目は読み込まない（戦績は引き継ぐ）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { failKind } from "./logstats.mjs";

const MAX_RECORDS = 30;   // ファイルに残す戦績の数
const LESSON_LEN = 90;    // 1項目の最大文字数
const MAX_LESSONS = 10;   // 項目の数の上限
const MAX_CHANGES = 2;    // 1回の振り返りで消す・足すそれぞれの上限（メモが空のときの最初だけは足すを5まで）
const FIRST_ADDS = 5;
const MAX_GOALS = 3;
const MARK = "<!-- 反省メモ v2（数字つき・差分更新） -->";

/* 数字の物差し。目標はこの中から選ばせる。get(n) は Journal.numbers() の値から取り出す（取れないときは null） */
export const METRICS = [
  { key: "勝利ターン", unit: "ターン", better: "low", get: n => n.won ? n.turn : null, hint: "勝ったときのターン数" },
  { key: "操作失敗", unit: "回", better: "low", get: n => n.fails },
  { key: "資金不足", unit: "回", better: "low", get: n => n.failKinds?.["資金不足"] ?? 0, hint: "資金不足で断られた回数" },
  { key: "行動済みの失敗", unit: "回", better: "low", get: n => n.failKinds?.["行動済みの艦隊"] ?? 0, hint: "動かした艦隊をまた動かそうとした回数" },
  { key: "内政なしのターン", unit: "ターン", better: "low", get: n => n.noDevTurns },
  { key: "戦闘の敗北", unit: "回", better: "low", get: n => n.battleLosses },
  { key: "最大星", unit: "星", better: "high", get: n => n.peak, hint: "持っていた星の数の最大" },
  { key: "収入", unit: "", better: "high", get: n => n.income, hint: "最後のターンの収入" },
];
const metric = (key) => METRICS.find(m => m.key === key);

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "player";

/* ---------- ファイル ---------- */
/* notes = { lessons, goals: [{key,n,dir}], records, prev: {物差し: 数字} | null, legacy: 古い形式で読まなかった項目 } */
export async function loadNotes(file) {
  const notes = { lessons: [], goals: [], records: [], prev: null, legacy: [] };
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch { return notes; }
  let sec = null;
  const v2 = text.includes(MARK);
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s*反省/.test(line)) sec = "lessons";
    else if (/^##\s*目標/.test(line)) sec = "goals";
    else if (/^##\s*前回の数字/.test(line)) sec = "prev";
    else if (/^##\s*戦績/.test(line)) sec = "records";
    else if (/^#/.test(line)) sec = null;
    else if (sec && /^\s*-\s+\S/.test(line)) {
      const v = line.replace(/^\s*-\s+/, "").trim();
      if (sec === "lessons") (v2 ? notes.lessons : notes.legacy).push(v);
      else if (sec === "goals") { const g = parseGoal(v); if (g) notes.goals.push(g); }
      else if (sec === "prev") { const m = v.match(/^(.+?)[：:]\s*(-?\d+)/); if (m && metric(m[1].trim())) (notes.prev ??= {})[m[1].trim()] = Number(m[2]); }
      else notes.records.push(v);
    }
  }
  return notes;
}

export async function saveNotes(file, name, notes) {
  const prev = notes.prev ? METRICS.filter(m => notes.prev[m.key] != null).map(m => `- ${m.key}：${notes.prev[m.key]}`) : [];
  const body = [
    `# ${name}の反省メモ`,
    MARK,
    "",
    "ai-player.mjs がプレイのたびに直します（1回に消す・足すのは2項目まで）。手で直したり、項目を消したりしてもかまいません。",
    "",
    "## 反省メモ（大事な順）",
    ...(notes.lessons.length ? notes.lessons.map(l => `- ${l}`) : ["（まだありません）"]),
    "",
    `## 目標（次のプレイで答え合わせします。物差し：${METRICS.map(m => m.key).join("・")}）`,
    ...(notes.goals?.length ? notes.goals.map(g => `- ${goalText(g)}`) : ["（まだありません）"]),
    "",
    "## 前回の数字（最後に終わったゲーム。自動で書きます）",
    ...(prev.length ? prev : ["（まだありません）"]),
    "",
    "## 戦績（新しい順）",
    ...notes.records.slice(0, MAX_RECORDS).map(r => `- ${r}`),
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body);
  // Windows では、ウイルス対策や検索インデックスがファイルを一瞬つかんでいると rename が EPERM になる。少し待って直し、だめなら直接書く
  for (let i = 0; ; i++) {
    try { await fs.rename(tmp, file); return; }
    catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      if (i < 4) { await new Promise(r => setTimeout(r, 250 * (i + 1))); continue; }
      await fs.writeFile(file, body); await fs.rm(tmp, { force: true }); return;
    }
  }
}

/* 上限の文字数に収まるだけ、前から（大事な順に）残す */
export function capLessons(lessons, maxChars) {
  const out = [];
  let n = 0;
  for (const l of lessons) {
    if (n + l.length + 3 > maxChars) break;
    out.push(l); n += l.length + 3;
  }
  return out;
}

function tally(records) {
  const c = { all: records.length, win: 0, lose: 0, other: 0 };
  for (const r of records) { if (/勝利/.test(r)) c.win++; else if (/敗北/.test(r)) c.lose++; else c.other++; }
  return c;
}

/* ---------- 目標 ---------- */
/* 「資金不足 3回以下」「勝利ターン：28ターン以内」「最大星 10以上」などを {key, n, dir} にする。物差しにないものは null */
export function parseGoal(text) {
  const t = String(text).replace(/\*\*/g, "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  for (const m of [...METRICS].sort((a, b) => b.key.length - a.key.length)) {
    const i = t.indexOf(m.key);
    if (i < 0) continue;
    const r = t.slice(i + m.key.length).match(/^\s*(?:を|は|が|[:：])?\s*(\d+)\s*(?:回|ターン|星)?\s*(以下|以内|未満|以上|超)?/);
    if (!r) continue;
    const dir = r[2] ? (/以上|超/.test(r[2]) ? "ge" : "le") : (m.better === "high" ? "ge" : "le");
    let n = Number(r[1]);
    if (r[2] === "未満") n -= 1; else if (r[2] === "超") n += 1;
    return { key: m.key, n, dir };
  }
  return null;
}
export const goalText = (g) => `${g.key} ${g.n}${metric(g.key)?.unit ?? ""}${g.dir === "ge" ? "以上" : "以下"}`;
/* 目標の答え合わせ。nums は Journal.numbers()。{ text, ok: true|false|null（測れない） } の配列 */
export function checkGoals(goals, nums) {
  return (goals ?? []).map(g => {
    const m = metric(g.key), v = m?.get(nums);
    if (v == null) return { ...g, value: null, ok: g.key === "勝利ターン" && nums.over ? false : null, text: `${goalText(g)} → 今回は${g.key === "勝利ターン" ? (nums.over ? "勝てなかった" : "まだ勝っていない") : "測れない"}` };
    const ok = g.dir === "ge" ? v >= g.n : v <= g.n;
    return { ...g, value: v, ok, text: `${goalText(g)} → 今回 ${v}${m.unit}：${ok ? "達成" : "未達成"}` };
  });
}
/* 数字の表（今回／前回）。前回がなければ今回だけ */
export function numbersTable(nums, prev) {
  return METRICS.map(m => {
    const v = m.get(nums), p = prev?.[m.key];
    return `- ${m.key}：${v ?? "—"}${prev ? `（前回 ${p ?? "—"}）` : ""}`;
  }).join("\n");
}
export const numbersToPrev = (nums) => Object.fromEntries(METRICS.map(m => [m.key, m.get(nums)]).filter(([, v]) => v != null));

/* システムプロンプトに差し込む部分 */
export function notesPrompt(notes, maxChars) {
  const lessons = capLessons(notes.lessons, maxChars);
  if (!lessons.length && !notes.records.length && !notes.goals?.length) return "";
  const L = ["# 前回までの反省メモ（あなたが過去のプレイを振り返って書いたもの）"];
  if (lessons.length) L.push(...lessons.map(l => `- ${l}`));
  else L.push("- （まだありません）");
  if (notes.goals?.length) L.push(`今回の目標：${notes.goals.map(goalText).join("、")}（ゲームのあとで数字で答え合わせする）`);
  if (notes.records.length) {
    const c = tally(notes.records);
    L.push(`これまでの戦績：${c.all}回（勝利${c.win}・敗北${c.lose}・途中終了${c.other}）。直近：${notes.records.slice(0, 2).join(" ／ ")}`);
  }
  L.push("このメモと目標を判断に活かす。メモどおりに動くときは「前回の反省を活かして」と視聴者にひとこと伝えてよい。");
  return L.join("\n");
}

/* ---------- 1ゲーム分の記録 ---------- */
/* 振り返りで内政も見えるように、成功した内政の操作を記録する */
const DEV_TOOLS = { invest_research: "研究", build_facility: "建設", survey: "探査", fortify: "防衛修復", build_ship: "造船", new_fleet: "新艦隊", refit_ship: "改装", repair_fleet: "修理", demolish_facility: "撤去" };

export class Journal {
  constructor() { this.turns = []; this.fails = new Map(); this.failKinds = {}; this.battles = []; this.peak = 0; this.autopilot = 0; this.noDevTurns = 0; this.prev = null; this.pending = []; this.dev = []; }

  begin(st) { if (st?.planets) { this.prev = new Set(st.planets.filter(p => p.owner === "P").map(p => p.name)); this.last = st; } }

  /* tool() を通ったすべての結果を見て、戦闘と失敗を拾う */
  onTool(name, r) {
    const j = r.json;
    if (!j || typeof j !== "object") return;
    if (j.battle?.title) this.battleTitle = j.battle.title;
    if (j.ok === false && j.message) {
      const key = `${name}：${j.message.replace(/\d+/g, "N").slice(0, 60)}`;
      this.fails.set(key, (this.fails.get(key) ?? 0) + 1);
      const k = failKind(j.message); this.failKinds[k] = (this.failKinds[k] ?? 0) + 1;
      this.turnFails = (this.turnFails ?? 0) + 1;
    }
    if (j.ok && DEV_TOOLS[name]) this.dev.push(`${DEV_TOOLS[name]}${j.message ? `(${j.message.replace(/。.*$/, "").slice(0, 30)})` : ""}`);
    // オート戦闘（既定）：行動の返り値に、その間に決着した戦闘の結果が入る
    for (const b of Array.isArray(j.battles) ? j.battles : []) {
      this.pending.push(`戦闘「${b.title}」${b.result}`);
      this.battles.push(`${b.title}：${b.result}`);
    }
    if (j.ok && name === "battle_close") {
      const res = /勝利/.test(j.message) ? "勝利" : /敗北/.test(j.message) ? "敗北" : "撤退";
      this.pending.push(`戦闘「${this.battleTitle ?? "?"}」${res}`);
      this.battles.push(`${this.battleTitle ?? "?"}：${res}`);
    }
  }

  /* 1ターン終わるごとに、そのターンの要点を1行にする */
  endTurn(turn, st, { talk = "", auto = false } = {}) {
    if (!st || !st.planets) return;
    const mine = st.planets.filter(p => p.owner === "P");
    const names = new Set(mine.map(p => p.name));
    const power = (st.myFleets ?? []).reduce((s, f) => s + (f.power ?? 0), 0);
    this.peak = Math.max(this.peak, mine.length);
    const L = [`T${turn}: 資金${st.funds} 収入+${st.incomePerTurn ?? "?"} 自国${mine.length}星 艦隊${st.myFleets?.length ?? 0}(戦力${power}) ${st.research?.currentClass ?? ""}`];
    L.push(this.dev.length ? `内政:${this.dev.join("、")}` : "内政なし");
    if (!this.dev.length) this.noDevTurns++;
    if (this.prev) {
      const got = [...names].filter(n => !this.prev.has(n)), lost = [...this.prev].filter(n => !names.has(n));
      if (got.length) L.push(`獲得:${got.join(",")}`);
      if (lost.length) L.push(`喪失:${lost.join(",")}`);
    }
    if (this.pending.length) L.push(this.pending.join("、"));
    if (this.turnFails) L.push(`操作失敗${this.turnFails}回`);
    if (auto) { L.push("自動進行に頼った"); this.autopilot++; }
    if (talk) L.push(`発言「${talk.slice(0, 40)}」`);
    this.turns.push(L.join(" "));
    this.prev = names; this.pending = []; this.turnFails = 0; this.dev = [];
    this.last = st;
  }

  /* 物差し（METRICS）で使う数字。over は "win" | "lose" | null */
  numbers(over = null) {
    const st = this.last;
    return {
      turn: st?.turn ?? this.turns.length, won: over === "win", over,
      fails: [...this.fails.values()].reduce((a, b) => a + b, 0), failKinds: { ...this.failKinds },
      noDevTurns: this.noDevTurns, battleLosses: this.battles.filter(b => !b.endsWith("勝利")).length,
      peak: this.peak, income: st?.incomePerTurn ?? null,
    };
  }

  /* 振り返り用の文章（長くなりすぎないよう、最初と最近のターンを残す） */
  text(maxChars = 3500) {
    let lines = this.turns;
    const join = (ls) => ls.join("\n");
    if (join(lines).length > maxChars) {
      const head = lines.slice(0, 3), tail = [];
      for (let i = lines.length - 1; i >= 3; i--) {
        if (join([...head, "…", lines[i], ...tail]).length > maxChars) break;
        tail.unshift(lines[i]);
      }
      lines = [...head, "…（中略）…", ...tail];
    }
    const fails = [...this.fails].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `- ${k}（${n}回）`);
    return [
      "## ターンごとの経過",
      join(lines),
      fails.length ? "## 失敗した操作（多い順）\n" + fails.join("\n") : "## 失敗した操作\nなし",
    ].join("\n");
  }
}

/* ---------- 振り返り ---------- */
/* 振り返りの返事から差分を拾う。返事の形が崩れていても、拾えたものだけ使う
 *   消す 2：理由 ／ 足す：新しい項目 ／ 目標：資金不足 3回以下 ／ 感想：ひとこと
 * 「足す」がなく「- 項目」の箇条書きだけのとき（前の形のまま丸ごと書いた）は、いまのメモにない項目を「足す」として扱う */
export function parseReflection(raw, lessons) {
  const removes = [], adds = [], bullets = [], goals = [];
  let comment = "";
  const clean = (t) => t.replace(/\*\*/g, "").replace(/^[「『]|[」』]$/g, "").trim().slice(0, LESSON_LEN);
  for (const line0 of String(raw).split(/\r?\n/)) {
    const line = line0.replace(/\*\*/g, "").replace(/^\s*(?:[-*・•]|\d+[.)．、])\s*(?=(?:消す|削除|足す|追加|目標|感想))/, "");
    let m;
    if ((m = line.match(/^\s*感想[:：]\s*(.+)/))) { comment = m[1].trim().slice(0, 60); continue; }
    if ((m = line.match(/^\s*(?:消す|削除)\s*[:：]?\s*(?:項目|番号)?\s*[\[［(（]?\s*([0-9０-９]+)/))) {
      const k = Number(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))) - 1;
      if (k >= 0 && k < lessons.length && !removes.includes(k)) removes.push(k);
      continue;
    }
    if ((m = line.match(/^\s*(?:足す|追加)\s*[:：]?\s*(.+)/))) { const l = clean(m[1]); if (l.length >= 4) adds.push(l); continue; }
    if ((m = line.match(/^\s*目標\s*[:：]?\s*(.+)/))) { for (const part of m[1].split(/[、,，／/]/)) { const g = parseGoal(part); if (g && !goals.some(x => x.key === g.key)) goals.push(g); } continue; }
    if ((m = line.match(/^\s*(?:[-*・•]|\d+[.)．、])\s*(.+)/))) { const l = clean(m[1]); if (l.length >= 4) bullets.push(l); }
  }
  return { removes, adds: adds.length ? adds : bullets, fromBullets: !adds.length && bullets.length > 0, goals, comment };
}

/* 差分をいまのメモに当てる。消すのも足すのも MAX_CHANGES まで（メモが空のときだけ足すを FIRST_ADDS まで）。
 * 項目が多すぎる・文字数を超えるときは、新しく足した項目は残し、もとの項目を後ろ（大事でない方）から落とす */
export function applyReflection(lessons, diff, maxChars) {
  const removed = diff.removes.slice(0, MAX_CHANGES).map(k => lessons[k]);
  const kept = lessons.filter(l => !removed.includes(l));
  const seen = new Set(lessons), added = [];
  for (const l of diff.adds) {
    if (added.length >= (lessons.length ? MAX_CHANGES : FIRST_ADDS)) break;
    if (seen.has(l)) continue;
    seen.add(l); added.push(l);
  }
  const chars = (ls) => ls.reduce((n, l) => n + l.length + 3, 0);
  while (kept.length && (kept.length + added.length > MAX_LESSONS || chars([...kept, ...added]) > maxChars)) kept.pop();
  return { lessons: capLessons([...kept, ...added], maxChars), removed, added };
}

/* chat(messages) はツールなしで呼べる関数。
 * final：ゲームの終わり（勝敗が決まった・止めた）なら true。目標の更新と、次のゲームのための「前回の数字」はこのときだけ
 * over："win" | "lose" | null
 * 返り値 { lessons, goals, comment, removed, added, goalResults, nums, raw }（何も拾えなかったら lessons は null） */
export async function reflect({ chat, name, persona, notes, journal, outcome, maxChars, stripThink, final = true, over = null }) {
  const nums = journal.numbers(over);
  const goalResults = checkGoals(notes.goals, nums);
  const cur = notes.lessons.length ? notes.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n") : "（まだありません）";
  const metricList = METRICS.map(m => m.hint ? `${m.key}（${m.hint}）` : m.key).join("・");
  const messages = [
    { role: "system", content: `${persona}\n\nいまは配信の合間で、自分のプレイを振り返って「反省メモ」を直す時間。ツールは使わない。` },
    { role: "user", content: `「辺境星系戦記」の${outcome}。下の数字と記録を読んで、次に${name}がもっと上手に勝つために、反省メモを直してください。

# いまの反省メモ（番号つき）
${cur}

# ${notes.goals?.length ? "前に決めた目標の答え合わせ" + (final ? "" : "（ゲームの途中までの数字）") : "目標"}
${goalResults.length ? goalResults.map(r => `- ${r.text}`).join("\n") : "- （まだありません）"}

# 数字（今回${notes.prev ? "と、前回のゲーム" : ""}）
${numbersTable(nums, notes.prev)}

# 今回のプレイ記録
${journal.text()}

# 書き方（この形の行だけを書く）
消す 番号：理由      … 間違っていた・役に立たなかった・数字が良くならなかった項目（${MAX_CHANGES}つまで）
足す：新しい項目     … 次に何をするかがわかる具体的な行動を60字以内で（${notes.lessons.length ? MAX_CHANGES : FIRST_ADDS}つまで。例：「足す：爆装のない艦隊で惑星を攻めない。攻略前に bo を2以上積む」）
${final ? `目標：物差し 数字     … 次のゲームの目標を1〜${MAX_GOALS}個。物差しは ${metricList} から選ぶ（例：「目標：資金不足 3回以下」「目標：最大星 10以上」）\n` : ""}感想：視聴者へのひとこと（40字以内）

- 書かなかった項目はそのまま残る。直す必要がなければ、消す・足すは書かなくてよい。
- 数字が前回より悪くなったところ・目標を達成できなかったところを見て、その原因に効く項目を足す。良くなった項目は残す。
- いまの反省メモと同じことは足さない。ルールに書いてある一般論（「常に確認する」「バランスを取る」）より、この記録から分かった具体的なことを書く。
- 戦い方だけでなく、内政（研究・施設・探査・造船と資金の使い方）も見る。特定の星の名前より、どの星でも使えるコツを優先する。
- それ以外の文は書かない。` },
  ];
  const raw = stripThink(await chat(messages));
  const diff = parseReflection(raw, notes.lessons);
  const r = applyReflection(notes.lessons, diff, maxChars);
  const changed = r.removed.length || r.added.length;
  const goals = final && diff.goals.length ? diff.goals.slice(0, MAX_GOALS) : null;
  return { lessons: changed ? r.lessons : (diff.comment || goals ? notes.lessons : null), goals, comment: diff.comment, removed: r.removed, added: r.added,
    goalResults, nums, raw };
}

export function recordLine({ date, model, outcome, journal, goalResults = [] }) {
  const st = journal.last;
  const turn = st?.turn ?? "?";
  const won = journal.battles.filter(b => b.endsWith("勝利")).length;
  const k = journal.failKinds ?? {};
  const g = goalResults.filter(x => x.ok != null);
  return `${date} ${model} ${outcome} ターン${turn} 最大${journal.peak}星 戦闘${journal.battles.length}回（勝${won}） 操作失敗${[...journal.fails.values()].reduce((a, b) => a + b, 0)}回（資金不足${k["資金不足"] ?? 0}） 内政なし${journal.noDevTurns ?? 0}ターン${g.length ? ` 目標${g.filter(x => x.ok).length}/${g.length}達成` : ""}`;
}
