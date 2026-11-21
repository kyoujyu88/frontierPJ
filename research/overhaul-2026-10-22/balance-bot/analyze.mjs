#!/usr/bin/env node
/* 集計：node analyze.mjs results/base.jsonl [results/xxx.jsonl ...] */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
const pct = (k, n) => n ? `${Math.round(k / n * 100)}%` : "-";
const f1 = x => Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : "-";
const LVN = { novice: "下手", normal: "普通", good: "上手" };
const FOE = { E: "ヴァルガ", M: "異生体", N: "中立", H: "巣" };
export function bkey(b) {
  if (b.kind === "fleet") return `艦隊戦 対${FOE[b.foe] || b.foe}・${b.attack ? "攻" : "守"}`;
  if (b.kind === "hive") return "巣の突入戦";
  if (b.capital) return "惑星 ヴァルガ本星";
  if (b.foe === "M") return "惑星 浸食星";
  return `惑星 ${FOE[b.foe] || b.foe}`;
}
export function summarize(recs) {
  const groups = {};
  for (const r of recs) (groups[`${r.level}|${r.variant}`] ??= []).push(r);
  const L = [];
  for (const [k, rs] of Object.entries(groups)) {
    const [lv, variant] = k.split("|"), n = rs.length;
    const wins = rs.filter(r => r.result === "win"), loses = rs.filter(r => r.result === "lose"), tos = rs.filter(r => r.result === "timeout");
    L.push(`==== ${LVN[lv] || lv}（${variant}） ${n}ゲーム ====`);
    L.push(`勝ち ${pct(wins.length, n)}（決着ターン 平均${f1(mean(wins.map(r => r.endTurn)))}・中央${f1(med(wins.map(r => r.endTurn)))}・最短${Math.min(...wins.map(r => r.endTurn)) || "-"}）／負け ${pct(loses.length, n)}（中央T${f1(med(loses.map(r => r.endTurn)))}）／60ターン切れ ${pct(tos.length, n)}`);
    const lostBy = { E: 0, M: 0 }; loses.forEach(r => { if (r.homeLostBy) lostBy[r.homeLostBy]++; });
    if (loses.length) L.push(`  主星を落としたのは：ヴァルガ ${lostBy.E}・異生体 ${lostBy.M}（負けた時期：T1-10 ${loses.filter(r => r.endTurn <= 10).length}・T11-20 ${loses.filter(r => r.endTurn > 10 && r.endTurn <= 20).length}・T21-40 ${loses.filter(r => r.endTurn > 20 && r.endTurn <= 40).length}・T41- ${loses.filter(r => r.endTurn > 40).length}）`);
    const mon = rs.filter(r => r.monsterTurn != null);
    L.push(`異生体出現：${pct(mon.length, n)}・出現ターン 平均${f1(mean(mon.map(r => r.monsterTurn)))}（本星占領で ${mon.filter(r => r.monsterReason === "capital").length}・18ターンで ${mon.filter(r => r.monsterReason === "turn18").length}）・休戦 ${pct(mon.filter(r => r.truce).length, n)}・進化 ${pct(rs.filter(r => r.evolvedTurn != null).length, n)}（平均T${f1(mean(rs.filter(r => r.evolvedTurn != null).map(r => r.evolvedTurn)))}）・本星攻略成功 ${pct(rs.filter(r => r.capitalTakenTurn != null).length, n)}`);
    const tiers = [1, 2, 3, 4].map(t => { const a = rs.filter(r => r.tierTurn && r.tierTurn[t] != null).map(r => r.tierTurn[t]); return `${["", "ファルコ", "グレイヴ", "アーク", "セラフ"][t]} ${pct(a.length, n)}@T${f1(med(a))}`; });
    L.push(`艦級の到達（到達率@中央ターン）：${tiers.join("・")}`);
    const at = (arr, t) => mean(rs.map(r => r[arr][t - 1]).filter(x => x != null));
    L.push(`資金（ターン開始時の平均）：${[1, 5, 10, 15, 20, 25, 30, 40, 50, 60].map(t => `T${t}:${f1(at("funds", t))}`).join(" ")}`);
    L.push(`収入：${[1, 5, 10, 15, 20, 25, 30, 40, 50, 60].map(t => `T${t}:${f1(at("income", t))}`).join(" ")}`);
    L.push(`自国の星の数：${[1, 10, 20, 30, 40, 60].map(t => `T${t}:${f1(at("planets", t))}`).join(" ")}  艦隊の総耐久：${[1, 10, 20, 30, 40, 60].map(t => `T${t}:${f1(at("strength", t))}`).join(" ")}`);
    const late = rs.filter(r => r.funds.length >= 30).map(r => mean(r.funds.slice(-10)));
    const fin = rs.map(r => r.finalFunds);
    L.push(`手持ち資金：最後の10ターン平均 ${f1(mean(late))}（30ターン以上続いた${late.length}ゲーム）・終了時 平均${f1(mean(fin))}・終了時500以上 ${pct(fin.filter(x => x >= 500).length, n)}・1000以上 ${pct(fin.filter(x => x >= 1000).length, n)}`);
    const sp = {}; rs.forEach(r => { for (const [c, v] of Object.entries(r.spent)) sp[c] = (sp[c] || 0) + v; });
    const tot = Object.values(sp).reduce((a, b) => a + b, 0);
    L.push(`支出の内訳（1ゲーム平均）：${Object.entries(sp).map(([c, v]) => `${{ research: "研究", ship: "造船", facility: "施設", repair: "修理", survey: "探査", fortify: "防衛修復", newfleet: "新艦隊" }[c] || c} ${f1(v / n)}(${pct(v, tot)})`).join(" ")}`);
    const fb = {}; rs.forEach(r => { for (const [c, v] of Object.entries(r.facBuilt)) fb[c] = (fb[c] || 0) + v; });
    L.push(`建てた施設（1ゲーム平均）：${["mine", "yard", "sats", "lab", "flak"].map(k => `${{ mine: "採掘所", yard: "造船所", sats: "衛星", lab: "研究所", flak: "対空砲" }[k]} ${f1((fb[k] || 0) / n)}`).join(" ")}`);
    // 戦闘
    const bs = rs.flatMap(r => r.battles.filter(b => b.result));
    const byK = {};
    for (const b of bs) (byK[bkey(b)] ??= []).push(b);
    L.push(`戦闘（1ゲーム平均 ${f1(bs.length / n)} 回）：種類・回数・勝率・撤退率・平均ラウンド`);
    for (const [kk, a] of Object.entries(byK).sort()) L.push(`  ${kk.padEnd(14, "　")} ${String(a.length).padStart(4)}回 勝${pct(a.filter(b => b.result === "win").length, a.length).padStart(4)} 撤退${pct(a.filter(b => b.result === "retreat").length, a.length).padStart(4)} ${f1(mean(a.map(b => b.rounds)))}R`);
    const fl = bs.filter(b => b.kind === "fleet" && b.foe === "E");
    const byD = {}; fl.forEach(b => (byD[b.doc || "?"] ??= []).push(b));
    L.push(`  対ヴァルガの型別 勝率：${Object.entries(byD).map(([d, a]) => `${{ line: "戦列", assault: "突撃", missile: "砲撃", heavy: "重装", raid: "強襲" }[d] || d} ${pct(a.filter(b => b.result === "win").length, a.length)}(${a.length})`).join(" ")}`);
    const byF = {}; bs.filter(b => b.kind === "fleet").forEach(b => (byF[b.form || "line"] ??= []).push(b));
    L.push(`  陣形の使用（艦隊戦）と勝率：${Object.entries(byF).map(([d, a]) => `${{ line: "横陣", wedge: "楔形", square: "方陣", crane: "鶴翼", rear: "後衛" }[d] || d} ${a.length}回 ${pct(a.filter(b => b.result === "win").length, a.length)}`).join(" ")}`);
    const hv = rs.map(r => r.hive);
    const hiveB = bs.filter(b => b.kind === "hive");
    L.push(`巣：突入 ${f1(mean(hv.map(h => h.attempts)))}回/ゲーム・成功率 ${pct(hiveB.filter(b => b.result === "win").length, hiveB.length)}・中枢を割るまで（初撃から）中央${f1(med(hv.flatMap(h => h.coreRounds)))}R・戦闘全体 中央${f1(med(hiveB.filter(b => b.result === "win").map(b => b.rounds)))}R・失敗時の中枢残り 平均${f1(mean(hv.flatMap(h => h.coreLeft).filter(x => x != null)))}`);
    const dm = {}; rs.forEach(r => { for (const [w, v] of Object.entries(r.dmg.P)) dm[w] = (dm[w] || 0) + v; });
    const dt = Object.values(dm).reduce((a, b) => a + b, 0);
    L.push(`自軍の与ダメージ内訳：${Object.entries(dm).map(([w, v]) => `${w} ${pct(v, dt)}`).join(" ")}　向き：${Object.entries(rs.reduce((o, r) => { for (const [z, v] of Object.entries(r.zones.P)) o[z] = (o[z] || 0) + v; return o; }, {})).map(([z, v]) => `${z}${v}`).join(" ")}`);
    const er = rs.reduce((s, r) => s + r.errors.length, 0);
    const stB = bs.filter(b => b.stallRetreat), lgB = bs.filter(b => b.longRetreat), agB = bs.filter(b => b.aggro);
    const stK = {}; stB.forEach(b => { const k = bkey(b); stK[k] = (stK[k] || 0) + 1; });
    L.push(`膠着（終わらない戦闘）：6ラウンド続けて損害なし→撤退 ${stB.length}回（全戦闘の${pct(stB.length, bs.length)}${stB.length ? "：" + Object.entries(stK).map(([k, v]) => `${k}${v}`).join("・") : ""}）・30ラウンド超で打ち切り ${lgB.length}回・3ラウンド損害なしで前進に切替 ${agB.length}回（${pct(agB.length, bs.length)}）・最長の無損害連続 ${Math.max(0, ...bs.map(b => b.maxStill || 0))}R`);
    L.push(`その他：操作エラー ${er}件・1ゲーム平均 ${f1(mean(rs.map(r => r.ms)) / 1000)}秒`);
    L.push("");
  }
  return L.join("\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const recs = files.flatMap(f => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)));
  console.log(summarize(recs));
}
