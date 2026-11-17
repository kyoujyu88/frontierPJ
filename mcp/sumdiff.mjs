/* 状況テキスト（game-api.js の getSummary）の「前のターンから変わったところ」だけを作る。
 *
 * ターンをまたいで会話を続けるとき（ai-player.mjs の B2）、毎ターン状況テキスト全体（約2,500字）を後ろに足すと、
 * コンテキスト 16K では1ターンおきにしか続けられなかった（2026-11-17 のログ）。
 * 会話の前のほうには前の状況テキストが残っているので、惑星の一覧と最近の出来事は変わった行だけを渡す。
 * 内政の候補・自軍艦隊・他勢力の艦隊は毎ターン変わり、手を選ぶのに使うので、そのまま全部渡す。
 */

// 「■」で始まる行ごとに区切る。先頭（ターン・資金・研究・情勢・通信）は "" に入る
export function sections(text) {
  const out = [{ head: "", lines: [] }];
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("■")) out.push({ head: line, lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}
/* 最近の出来事は新しい順に並んでいる（ゲーム本体の log() が先頭に足す）。前の一覧の先頭からの並びが、新しい一覧のどこから続いているかを探し、
 * それより前の行を新しい出来事とする（行の文字列が一致するかだけで見ると、同じ文面の出来事が続けて起きたときに落ちる。
 * 実際には各行に [年]＝ターンが付くので、ターンをまたいで同じ文面にはならない）。つながる所がなければ全部が新しい */
export function newEvents(prev, next) {
  for (let i = 0; i < next.length; i++) {
    const rest = next.slice(i);
    if (rest.length && prev.length >= rest.length && rest.every((l, k) => l === prev[k])) return next.slice(0, i);
  }
  return next;
}
const kindOf = (head) => head.startsWith("■惑星") ? "planets" : head.startsWith("■最近の出来事") ? "events" : "keep";

/* prev（前に渡した状況テキスト）から next への差分。作戦卓の状況テキストでなければ（戦闘中など）null を返し、呼び出し側は全文を渡す */
export function summaryDelta(prev, next) {
  if (!prev || !next || !/^■惑星/m.test(prev) || !/^■惑星/m.test(next)) return null;
  const old = new Map(sections(prev).map(s => [kindOf(s.head) === "keep" ? s.head : kindOf(s.head), s.lines.filter(l => l.trim())]));
  const out = [];
  for (const s of sections(next)) {
    const k = kindOf(s.head);
    if (k === "keep") { if (s.head) out.push(s.head); out.push(...s.lines); continue; }
    const before = old.get(k) ?? [], lines = s.lines.filter(l => l.trim());
    // 惑星は一覧から消えることがない（持ち主・防衛・施設が変わるだけ）ので、新しい一覧にあって前に無い行だけを渡せばよい
    const fresh = k === "planets" ? lines.filter(l => !before.includes(l)) : newEvents(before, lines);
    if (k === "planets") {
      out.push(`${s.head.replace(/（.*$/, "")}（前のターンから変わった星だけ。ほかは前の状況テキストと同じ）`);
      out.push(...(fresh.length ? fresh : [" 変わった星はありません"]));
    } else {
      out.push(`${s.head}（前のターンのあとの出来事）`);
      out.push(...(fresh.length ? fresh : [" なし"]));
    }
  }
  return out.join("\n");
}
