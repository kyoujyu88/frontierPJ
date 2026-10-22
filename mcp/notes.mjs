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
 */
import fs from "node:fs/promises";
import path from "node:path";

const MAX_RECORDS = 30;   // ファイルに残す戦績の数
const LESSON_LEN = 90;    // 1項目の最大文字数

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "player";

/* ---------- ファイル ---------- */
export async function loadNotes(file) {
  const notes = { lessons: [], records: [] };
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch { return notes; }
  let sec = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s*反省/.test(line)) sec = "lessons";
    else if (/^##\s*戦績/.test(line)) sec = "records";
    else if (/^#/.test(line)) sec = null;
    else if (sec && /^\s*-\s+\S/.test(line)) notes[sec].push(line.replace(/^\s*-\s+/, "").trim());
  }
  return notes;
}

export async function saveNotes(file, name, notes) {
  const body = [
    `# ${name}の反省メモ`,
    "",
    "ai-player.mjs がプレイのたびに書き換えます。手で直したり、項目を消したりしてもかまいません。",
    "",
    "## 反省メモ（大事な順）",
    ...(notes.lessons.length ? notes.lessons.map(l => `- ${l}`) : ["（まだありません）"]),
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

/* システムプロンプトに差し込む部分 */
export function notesPrompt(notes, maxChars) {
  const lessons = capLessons(notes.lessons, maxChars);
  if (!lessons.length && !notes.records.length) return "";
  const L = ["# 前回までの反省メモ（あなたが過去のプレイを振り返って書いたもの）"];
  if (lessons.length) L.push(...lessons.map(l => `- ${l}`));
  else L.push("- （まだありません）");
  if (notes.records.length) {
    const c = tally(notes.records);
    L.push(`これまでの戦績：${c.all}回（勝利${c.win}・敗北${c.lose}・途中終了${c.other}）。直近：${notes.records.slice(0, 2).join(" ／ ")}`);
  }
  L.push("このメモを判断に活かす。メモどおりに動くときは「前回の反省を活かして」と視聴者にひとこと伝えてよい。");
  return L.join("\n");
}

/* ---------- 1ゲーム分の記録 ---------- */
/* 振り返りで内政も見えるように、成功した内政の操作を記録する */
const DEV_TOOLS = { invest_research: "研究", build_facility: "建設", survey: "探査", fortify: "防衛修復", build_ship: "造船", new_fleet: "新艦隊", refit_ship: "改装", repair_fleet: "修理", demolish_facility: "撤去" };

export class Journal {
  constructor() { this.turns = []; this.fails = new Map(); this.battles = []; this.peak = 0; this.autopilot = 0; this.prev = null; this.pending = []; this.dev = []; }

  begin(st) { if (st?.planets) { this.prev = new Set(st.planets.filter(p => p.owner === "P").map(p => p.name)); this.last = st; } }

  /* tool() を通ったすべての結果を見て、戦闘と失敗を拾う */
  onTool(name, r) {
    const j = r.json;
    if (!j || typeof j !== "object") return;
    if (j.battle?.title) this.battleTitle = j.battle.title;
    if (j.ok === false && j.message) {
      const key = `${name}：${j.message.replace(/\d+/g, "N").slice(0, 60)}`;
      this.fails.set(key, (this.fails.get(key) ?? 0) + 1);
      this.turnFails = (this.turnFails ?? 0) + 1;
    }
    if (j.ok && DEV_TOOLS[name]) this.dev.push(`${DEV_TOOLS[name]}${j.message ? `(${j.message.replace(/。.*$/, "").slice(0, 30)})` : ""}`);
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
/* chat(messages) はツールなしで呼べる関数。{ lessons, comment } を返す（書けなかったら lessons は null） */
export async function reflect({ chat, name, persona, notes, journal, outcome, maxChars, stripThink }) {
  const prev = notes.lessons.length ? notes.lessons.map(l => `- ${l}`).join("\n") : "（まだありません）";
  const messages = [
    { role: "system", content: `${persona}\n\nいまは配信の合間で、自分のプレイを振り返って「反省メモ」を書き直す時間。ツールは使わない。` },
    { role: "user", content: `「辺境星系戦記」の${outcome}。下の記録を読んで、次のプレイで${name}が勝つための反省メモを書き直してください。

# いまの反省メモ
${prev}

# 今回のプレイ記録
${journal.text()}

# 書き方
- 「- 」で始まる箇条書きで、大事な順に最大10項目。1項目は60字以内。
- 次に何をするかがわかる具体的な書き方にする（例：「- 爆装のない艦隊で惑星を攻めない。攻略前に bo を2以上積む」）。
- いまの反省メモのうち役に立つものは残し、間違っていたものや重なるものは消す。
- 失敗した操作が多いなら、その避け方も書く。
- 戦い方だけでなく、内政（研究・施設・探査・造船と資金の使い方）についても書く。収入の伸びと「内政なし」のターンも見る。
- 特定の星の名前より、どの星でも使えるコツを優先する。
- 最後に「感想：」で始まる1行で、視聴者へのひとこと（40字以内）。
- それ以外の文は書かない。` },
  ];
  const raw = stripThink(await chat(messages));
  const lessons = [], seen = new Set();
  let comment = "";
  for (const line of raw.split(/\r?\n/)) {
    const c = line.match(/^\s*感想[:：]\s*(.+)/);
    if (c) { comment = c[1].trim().slice(0, 60); continue; }
    const m = line.match(/^\s*(?:[-*・•]|\d+[.)．、])\s*(.+)/);
    if (!m) continue;
    const l = m[1].replace(/\*\*/g, "").trim().slice(0, LESSON_LEN);
    if (l.length < 4 || seen.has(l)) continue;
    seen.add(l); lessons.push(l);
  }
  return { lessons: lessons.length ? capLessons(lessons.slice(0, 12), maxChars) : null, comment, raw };
}

export function recordLine({ date, model, outcome, journal }) {
  const st = journal.last;
  const turn = st?.turn ?? "?";
  const won = journal.battles.filter(b => b.endsWith("勝利")).length;
  return `${date} ${model} ${outcome} ターン${turn} 最大${journal.peak}星 戦闘${journal.battles.length}回（勝${won}） 操作失敗${[...journal.fails.values()].reduce((a, b) => a + b, 0)}回`;
}
