/* MCP サーバーが公開する入力スキーマと、のあ（LLM）に見せる道具の形をつなぐ（server.mjs・ai-player.mjs・api-test.mjs で共通）
 *
 * サーバーの公開スキーマ（tools/list）は、艦隊・星の名前と、施設・陣形の日本語名も許す（Issue #28）。
 * のあに見せる形は、今までどおり整数のIDと英語キーだけにする。小さなモデルに見せる道具の説明が長く・複雑になると、
 * 読み直しの時間や引数の書き方が変わるため。名前や日本語で書いても、サーバーは今までどおり読む。
 *
 * 公開スキーマから LLM 向けの形へ戻すときの目印（説明の「（…でもよい）」と、日本語名の一覧）は、ここで決めて
 * server.mjs と共有する。どちらかの文言を変えても、LLM 向けの形が気づかないまま変わらないようにするため（PR #29 のレビュー）。
 * 戻した形は api-test.mjs が確かめる（anyOf・日本語の選択肢・「でもよい」が残っていないこと）。
 */

// 施設・陣形：日本語名 → 英語キー
export const FACILITIES = { 採掘所: "mine", 造船所: "yard", 防衛衛星群: "sats", 研究所: "lab", 対空砲台: "flak" };
export const FORMATIONS = { 横陣: "line", 楔形: "wedge", 方陣: "square", 鶴翼: "crane", 後衛陣: "rear" };
const JA_NAMES = new Set([...Object.keys(FACILITIES), ...Object.keys(FORMATIONS)]);

/* 名前でも書ける引数の説明：「自軍艦隊のID（艦隊の名前「第2艦隊」でもよい）」。LLM に見せるときは括弧ごと外す */
const ALSO = "でもよい";
export const alsoName = (base, alt) => `${base}（${alt}${ALSO}）`;
const ALSO_RE = new RegExp(`（[^（）]*${ALSO}）$`);

/* 公開スキーマの引数1つを、LLM に見せる形にする */
export function forLlm(p) {
  // 整数のIDか名前の文字列（anyOf）→ 整数のIDだけ。説明の「（…でもよい）」も外す
  const ints = p?.anyOf?.filter(x => x.type === "integer");
  if (ints?.length === 1) {
    const { anyOf, ...rest } = p;
    return { ...ints[0], ...rest, ...(rest.description ? { description: rest.description.replace(ALSO_RE, "") } : {}) };
  }
  // 英語キーと日本語名の選択肢 → 英語キーだけ。英語キーの意味は道具の説明に書いてあるので、日本語名を並べた引数の説明は外す
  if (Array.isArray(p?.enum) && p.enum.some(v => JA_NAMES.has(v))) {
    const { description, ...rest } = p;
    return { ...rest, enum: p.enum.filter(v => !JA_NAMES.has(v)) };
  }
  return p;
}
export const llmSchema = s => s?.properties ? { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, forLlm(p)])) } : s;

/* MCP の tools/list の結果 → LLM に渡す道具（OpenAI 形式）。hidden に入れた名前は渡さない */
export const llmTools = (mcpTools, hidden = new Set()) => mcpTools.filter(t => !hidden.has(t.name)).map(t => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: { type: "object", properties: {}, ...llmSchema(t.inputSchema) } },
}));

/* LLM 向けの形に、公開スキーマの広げた部分が残っていないか（api-test.mjs で使う）。残っていたら「道具名.引数名：理由」の一覧 */
export function llmLeftovers(tools) {
  const out = [];
  for (const t of tools) {
    for (const [k, p] of Object.entries(t.function.parameters?.properties ?? {})) {
      const at = `${t.function.name}.${k}`;
      if (p.anyOf || p.oneOf || p.allOf) out.push(`${at}：anyOf などが残っている`);
      if (Array.isArray(p.enum) && p.enum.some(v => JA_NAMES.has(v))) out.push(`${at}：日本語の選択肢が残っている`);
      if (typeof p.description === "string" && ALSO_RE.test(p.description)) out.push(`${at}：説明に「（…${ALSO}）」が残っている`);
    }
  }
  return out;
}
