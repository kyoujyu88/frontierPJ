/* 作戦：のあに長期と短期の作戦を書かせ、ターンをまたいで持たせる
 *
 * のあは毎ターン状況テキストを読んでほぼ白紙から手を考えていて、「次の3ターンでミラを落とす」のような段取りが続かなかった。
 * そこで、作戦を set_plan（ai-player.mjs が受ける手。ゲームは進まない）で書かせて覚えておき、毎ターンの最初のメッセージに
 * 「■今の作戦」として見せる。会話を作り直しても（--keep-turns・あふれそうなとき）作戦は残る。
 *
 *   長期（long）  … ゲームの終わりまでの方針と、攻め取る星の順番
 *   短期（short） … このターンから2〜3ターンでやる具体的な手
 *   攻める順（targets）… 次に攻め取る星のID。持ち主はこちらで見て、落としたら「落とした」に移し、見直しの合図を出す
 *
 * 見直しの合図（cues）は、こちらがゲームの状態から機械的に出す：まだ作戦がない・攻める星を落とした・星を失った・
 * 攻める星がなくなった・短期の作戦を立ててから3ターンたった・異生体の出現や休戦のような情勢の変化。
 * 合図がなければ「作戦どおりなら、そのまま手を打つ」と添えるだけで、書き直しは求めない（毎ターン書かせると1手ぶん遅くなる）。
 *
 * 反省メモ（notes.mjs）とは役割を分ける：反省メモはゲームをまたいで残す教訓、作戦はこのゲームの中の段取りで、新しいゲームでは白紙から。
 * 作戦は会話の前のほう（システムプロンプト）には入れない。入れると書き直すたびにプロンプトの先頭が変わり、ローカルLLMが全部を読み直すため。
 * 毎ターンの最初のメッセージ（会話の後ろに足すもの）に入れる。
 */

export const PLAN_TOOL_NAME = "set_plan";
const TEXT_LEN = 100;     // 長期・短期それぞれの最大文字数（長すぎると毎ターン読む量が増える）
const MAX_TARGETS = 3;
export const STALE_TURNS = 3; // 短期の作戦をこのターン数ごとに見直させる
export const MAX_SETS_PER_TURN = 2; // 1ターンに書き直せる回数（作戦ばかり書いて手を打たないのを防ぐ）

export const PLAN_TOOL = {
  type: "function",
  function: {
    name: PLAN_TOOL_NAME,
    description: "作戦を書く・直す（ゲームは進まない）。long＝長期の作戦（ゲームの終わりまでの方針と、攻め取る星の順番）、short＝短期の作戦（このターンから2〜3ターンでやる具体的な手）、targets＝次に攻め取る星のID（順番に3つまで）。作戦はターンをまたいで覚えておき、毎ターンの最初に「■今の作戦」として見せる。変えるときだけ呼び、変えない欄は省く。ほかの手と同じ返事で呼んでよい。",
    parameters: {
      type: "object",
      properties: {
        long: { type: "string", description: "長期の作戦（100字まで。例：ヴァルガの前線を北から削り、異生体が出る前に艦隊を3つにする）" },
        short: { type: "string", description: "短期の作戦（100字まで。例：第1艦隊を修理してから7ミラを攻略、そのあいだに星2に研究所）" },
        targets: { type: "string", description: "次に攻め取る星のID（順番に、カンマ区切りで3つまで。例 \"7,9\"）" },
        say: { type: "string", description: "この操作と一緒に視聴者へ言うひとこと（字幕に出る。なくてもよい）" },
      },
    },
  },
};

export function newPlan() {
  return { long: "", short: "", targets: [], longTurn: null, shortTurn: null, sets: 0, hits: [], last: null, setsThisTurn: 0, turn: null };
}

const clip = (s) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > TEXT_LEN ? t.slice(0, TEXT_LEN) + "…" : t; };
const planetMap = (st) => new Map((st?.planets ?? []).map(p => [p.id, p]));
const ownedIds = (st) => (st?.planets ?? []).filter(p => p.owner === "P").map(p => p.id);
const label = (p) => p ? `${p.id}${p.name}` : "?";
const where = (p) => !p ? "" : p.owner === "P" ? "自国" : `${p.ownerLabel ?? p.owner}${p.maxDef ? `・防衛${p.def}/${p.maxDef}` : ""}`;

/* targets を星のIDの並びにする。[7,9]・7・"7,9"・"7 ミラ, 9"・["7","9"] などを受ける。名前（"ミラ"）も星の名前と合えば読む */
export function parseTargets(v, st) {
  const pm = planetMap(st);
  const byName = new Map((st?.planets ?? []).map(p => [p.name, p.id]));
  const parts = Array.isArray(v) ? v : v == null ? [] : String(v).split(/[,、，\s→>]+|-(?=\d)/);
  const out = [], unknown = [];
  for (const raw of parts) {
    if (raw == null || raw === "") continue;
    const s = String(raw).trim().replace(/^[\[\(（「"']+|[\]\)）」"']+$/g, "");
    if (!s) continue;
    const m = s.match(/^(\d+)/);
    const id = m ? Number(m[1]) : byName.get(s.replace(/^星/, "")) ?? null;
    if (id == null || (pm.size && !pm.has(id))) { unknown.push(s); continue; }
    if (!out.includes(id)) out.push(id);
  }
  return { ids: out.slice(0, MAX_TARGETS), unknown };
}

/* set_plan を当てる。args は {long?, short?, targets?}。st はいまの get_state。
 * 返り値 { ok, content（のあに返す文）, changed（変えた欄）, entry（プレイログに残すもの）} */
export function applyPlan(plan, args, { turn, st }) {
  const has = (k) => args?.[k] != null && String(Array.isArray(args[k]) ? args[k].join(",") : args[k]).trim() !== "";
  if (!has("long") && !has("short") && !has("targets"))
    return { ok: false, content: "失敗：long（長期の作戦）・short（短期の作戦）・targets（攻める星のID）のどれかを書いてください。", changed: [] };
  if (plan.turn === turn && plan.setsThisTurn >= MAX_SETS_PER_TURN)
    return { ok: false, refused: true, content: `失敗：このターンはもう${MAX_SETS_PER_TURN}回作戦を書きました。作戦は覚えているので、ゲームの手を打ってください。`, changed: [] };
  const changed = [], notes = [];
  if (has("long")) { const t = clip(args.long); if (t !== plan.long) { plan.long = t; plan.longTurn = turn; changed.push("long"); } }
  if (has("short")) { const t = clip(args.short); if (t !== plan.short) { plan.short = t; changed.push("short"); } plan.shortTurn = turn; } // 同じ文でも「見直した」として数え直す
  if (has("targets")) {
    const { ids, unknown } = parseTargets(args.targets, st);
    const pm = planetMap(st);
    const mine = ids.filter(id => pm.get(id)?.owner === "P");
    const next = ids.filter(id => !mine.includes(id));
    if (unknown.length) notes.push(`星のIDとして読めないもの（${unknown.slice(0, 3).join("・")}）は外しました`);
    if (mine.length) notes.push(`${mine.map(id => label(pm.get(id))).join("・")}はもう自国の星なので外しました`);
    if (next.join(",") !== plan.targets.join(",")) { plan.targets = next; changed.push("targets"); }
  }
  if (plan.turn !== turn) { plan.turn = turn; plan.setsThisTurn = 0; }
  plan.setsThisTurn++;
  plan.sets++;
  const pm = planetMap(st);
  const content = [`作戦を覚えました${changed.length ? "" : "（前と同じです）"}。毎ターンの最初に見せます。`,
    plan.targets.length ? `攻める順：${plan.targets.map(id => label(pm.get(id))).join(" → ")}` : null,
    ...notes, "続けてゲームの手を打ってください。"].filter(Boolean).join("\n");
  return { ok: true, content, changed, entry: planEntry(plan, st, { turn, changed }) };
}

/* プレイログに残す形（星は名前つき） */
export function planEntry(plan, st, extra = {}) {
  const pm = planetMap(st);
  return { ...extra, long: plan.long || null, short: plan.short || null, targets: plan.targets.map(id => ({ id, name: pm.get(id)?.name ?? null })),
    longTurn: plan.longTurn, shortTurn: plan.shortTurn };
}

/* ターンの始まりに、作戦と状態を突き合わせる。落とした攻める星は targets から「落とした」（hits）に移す。
 * 返り値 { cues: [{kind, text}], hits: 今回落とした星 } */
export function checkPlan(plan, st, turn) {
  const pm = planetMap(st), owned = ownedIds(st);
  const sit = st?.situation ?? {};
  const cues = [], hits = [];
  const last = plan.last;
  if (!plan.sets) cues.push({ kind: "none", text: "まだ作戦がありません。" });
  else {
    for (const id of [...plan.targets]) {
      if (pm.get(id)?.owner !== "P") continue;
      hits.push({ id, name: pm.get(id)?.name ?? null, turn });
      plan.targets = plan.targets.filter(x => x !== id);
    }
    plan.hits.push(...hits);
    if (hits.length) cues.push({ kind: "hit", text: `攻める星だった${hits.map(h => label(pm.get(h.id))).join("・")}を落としました。` });
    if (last) {
      const lost = last.owned.filter(id => !owned.includes(id));
      if (lost.length) cues.push({ kind: "lost", text: `${lost.map(id => `${label(pm.get(id))}（いま${where(pm.get(id))}）`).join("・")}を失いました。` });
      if (sit.xenoAppeared && !last.xeno) cues.push({ kind: "event", text: "異生体が現れました。" });
      if (sit.xenoEvolved && !last.evolved) cues.push({ kind: "event", text: "異生体が進化しました。" });
      if (!!sit.truceWithVarga !== !!last.truce) cues.push({ kind: "event", text: sit.truceWithVarga ? "ヴァルガと休戦しました。" : "ヴァルガとの休戦が終わりました。" });
    }
    if (!plan.targets.length && (hits.length || last?.targets?.length)) cues.push({ kind: "empty", text: "攻める星がもう残っていません。" });
    const age = plan.shortTurn != null ? turn - plan.shortTurn : null;
    if (age != null && age >= STALE_TURNS && age % STALE_TURNS === 0) cues.push({ kind: "stale", text: `短期の作戦はターン${plan.shortTurn}に立てたものです。` });
  }
  plan.last = { turn, owned, xeno: !!sit.xenoAppeared, evolved: !!sit.xenoEvolved, truce: !!sit.truceWithVarga, targets: [...plan.targets] };
  return { cues, hits };
}

/* 毎ターンの最初のメッセージに入れる「■今の作戦」。cues を渡すと見直しの合図も書く（null なら作戦だけ） */
export function planBlock(plan, st, cues = null) {
  const pm = planetMap(st);
  if (!plan.sets) {
    return `■作戦：まだありません。最初の手と同じ返事で set_plan を呼び、長期の作戦（ゲームの終わりまでの方針と攻め取る星の順番）、短期の作戦（このターンから2〜3ターンの手）、攻める星のID（targets）を書いてください。`;
  }
  const L = ["■今の作戦"];
  if (plan.long) L.push(`長期（ターン${plan.longTurn}から）：${plan.long}`);
  if (plan.short) L.push(`短期（ターン${plan.shortTurn}から）：${plan.short}`);
  const got = plan.hits.slice(-3).map(h => `${h.id}${h.name ?? ""}（ターン${h.turn}）`);
  L.push(`攻める順：${plan.targets.length ? plan.targets.map(id => `${label(pm.get(id))}（${where(pm.get(id))}）`).join(" → ") : "なし"}${got.length ? `　落とした：${got.join("・")}` : ""}`);
  if (cues) {
    const c = cues.filter(x => x.kind !== "none");
    L.push(c.length ? `見直しの合図：${c.map(x => x.text).join("")}作戦を見直して、変えるなら最初の手と同じ返事で set_plan を呼んでください（変えない欄は省く）。`
      : "作戦どおりなら、そのまま手を打ってください（変えるときだけ set_plan）。");
  }
  return L.join("\n");
}
