/* LLM（のあ）に見せるツールの引数の形（server.mjs・ai-player.mjs・api-test.mjs で共通）
 *
 * MCP サーバーの公開スキーマ（tools/list）は、艦隊・星を名前でも、施設・陣形を日本語名でも受け付ける（anyOf と日本語の選択肢。Issue #28）。
 * のあに見せる道具の説明は、今までどおり整数のIDと英語キーだけにする（説明が長く・複雑になると、読み直しの時間や引数の書き方が変わるため）。
 * 名前や日本語で書いても、サーバーは今までどおり読む。
 *
 * 公開スキーマから のあ向けの形に戻すときの目印は、ここにある定数だけにする（説明文の言い回しや英語キーの綴りの形に頼らない。PR #29 のレビュー）：
 *  - 名前でも書けることを書き添えた説明は alsoOk() で作る（server.mjs）。forLlm はその書き添えだけを外す
 *  - 施設・陣形の英語キーと日本語名は FACILITY・FORMATION。forLlm は選択肢をこの英語キーだけに絞る
 */

/* 施設・陣形：日本語名 → 英語キー */
export const FACILITY = { 採掘所: "mine", 造船所: "yard", 防衛衛星群: "sats", 研究所: "lab", 対空砲台: "flak" };
export const FORMATION = { 横陣: "line", 楔形: "wedge", 方陣: "square", 鶴翼: "crane", 後衛陣: "rear" };
const ENGLISH_KEYS = new Set([...Object.values(FACILITY), ...Object.values(FORMATION)]);

/* 「（艦隊の名前「第2艦隊」でもよい）」のような書き添え。説明の最後に付ける */
const ALSO_OK_OPEN = "（", ALSO_OK_CLOSE = "でもよい）";
export const alsoOk = what => `${ALSO_OK_OPEN}${what}${ALSO_OK_CLOSE}`;
const dropAlsoOk = s => {
  if (!s.endsWith(ALSO_OK_CLOSE)) return s;
  const i = s.lastIndexOf(ALSO_OK_OPEN, s.length - ALSO_OK_CLOSE.length);
  return i >= 0 ? s.slice(0, i) : s;
};

/* 公開スキーマの引数1つを、のあ向けの形にする
 *  - 整数のIDか名前（anyOf の中に integer が1つ）→ integer だけ。説明の書き添えを外す
 *  - 英語キーか日本語名の選択肢 → 英語キーだけ（英語キーの意味は道具の説明に書いてあるので、選択肢の説明は外す） */
export function forLlm(p) {
  const ints = p?.anyOf?.filter(x => x.type === "integer");
  if (ints?.length === 1) {
    const { anyOf, ...rest } = p;
    return { ...ints[0], ...rest, ...(rest.description ? { description: dropAlsoOk(rest.description) } : {}) };
  }
  if (Array.isArray(p?.enum) && p.enum.some(v => ENGLISH_KEYS.has(v))) {
    const { description, ...rest } = p;
    return { ...rest, enum: p.enum.filter(v => ENGLISH_KEYS.has(v)) };
  }
  return p;
}
export const llmSchema = s => s?.properties ? { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, forLlm(p)])) } : s;
