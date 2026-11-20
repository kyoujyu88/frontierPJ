/* MCP の約束ごとの回帰テスト（Issue #27・#28）
 *   node api-test.mjs
 * 1. tools/list の入力スキーマが、艦隊・星の名前と、施設・陣形の日本語名を許している（#28）
 *    スキーマどおりに検証してから送り、名前で書いても数字・英語キーで書いても同じ操作になる。いない艦隊の名前は理由つきで断る
 *    のあ（LLM）に見せる道具は、今までどおり整数のIDと英語キーだけの形に戻っている（llm-tools.mjs）
 * 2. new_fleet を応答を待たずに2件送っても、編成は1件だけ。もう1件は理由つきで断られ、3艦隊・資金-32 で止まる（#27）
 *    演出の待ちがある --pace 300 で起動する（待ちの間に2件目が検査を通り抜けていた）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { llmTools, llmLeftovers } from "./llm-tools.mjs";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), "--headless", "--pace", "300"],
  env: process.env, stderr: "inherit",
});
const client = new Client({ name: "api-test", version: "1" });
await client.connect(transport);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`); if (!ok) failures++; };

/* JSON Schema の小さな検証（tools/list に出る形：type・enum・const・anyOf・oneOf・allOf・properties・required・additionalProperties・minLength）。
 * 知らないキーワードは黙って通さずに失敗にする。SDK や zod の更新で出力の形が変わったとき（例：.pipe() が allOf や $ref になる）に、
 * 実際のクライアントでは弾かれるのにこのテストだけ通る、を防ぐため（PR #29 のレビュー） */
const KNOWN = new Set(["type", "enum", "const", "anyOf", "oneOf", "allOf", "properties", "required", "additionalProperties", "minLength", "description", "$schema", "default"]);
const unknownKeys = new Set();
function valid(schema, v) {
  if (schema === true || schema === undefined) return true;
  if (!schema || typeof schema !== "object") return false;
  const odd = Object.keys(schema).filter(k => !KNOWN.has(k));
  if (odd.length) { odd.forEach(k => unknownKeys.add(k)); return false; }
  if (schema.anyOf && !schema.anyOf.some(s => valid(s, v))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => valid(s, v)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(s => valid(s, v))) return false;
  if (schema.enum && !schema.enum.includes(v)) return false;
  if ("const" in schema && schema.const !== v) return false;
  if (schema.type) {
    const types = [].concat(schema.type);
    const is = t => t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : t === "string" ? typeof v === "string"
      : t === "boolean" ? typeof v === "boolean" : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : t === "array" ? Array.isArray(v) : t === "null" ? v === null : false;
    if (!types.some(is)) return false;
  }
  if (typeof v === "string" && schema.minLength != null && v.length < schema.minLength) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) return false;
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties?.[k];
      if (sub ? !valid(sub, x) : schema.additionalProperties === false ? true : schema.additionalProperties && typeof schema.additionalProperties === "object" && !valid(schema.additionalProperties, x)) return false;
    }
  }
  return true;
}
const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t]));
/* 公開スキーマで検証してから送る（検証で弾かれたら送らずに失敗にする） */
async function call(name, args = {}, { raw = false } = {}) {
  if (!raw && !valid(tools[name].inputSchema, args)) { check(false, `${name}(${JSON.stringify(args)}) が tools/list のスキーマで弾かれる`); return null; }
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
}
const state = () => call("get_state");

try {
  console.log("1. 入力スキーマ（tools/list）");
  {
    const sf = tools.set_formation.inputSchema.properties, bf = tools.build_facility.inputSchema.properties, nf = tools.new_fleet.inputSchema.properties;
    const mv = tools.move_fleet.inputSchema.properties;
    check(valid(sf.fleet_id, 2) && valid(sf.fleet_id, "第2艦隊") && !valid(sf.fleet_id, 1.5), "fleet_id は整数IDと艦隊名の両方（小数は不可）");
    check(valid(nf.planet_id, 0) && valid(nf.planet_id, "ヴェスタ") && valid(mv.to, "リュネ"), "planet_id・to は整数IDと星の名前の両方");
    check(["line", "wedge", "square", "crane", "rear", "横陣", "楔形", "方陣", "鶴翼", "後衛陣"].every(v => valid(sf.formation, v)) && !valid(sf.formation, "円陣"), "formation は英語キーと日本語名（それ以外は不可）");
    check(["mine", "yard", "sats", "lab", "flak", "採掘所", "造船所", "防衛衛星群", "研究所", "対空砲台"].every(v => valid(bf.facility, v)), "facility は英語キーと日本語名");
    check(!!sf.fleet_id.description && !!sf.formation.description, "fleet_id・formation に説明が付いている");
    // 検証そのもの：知らないキーワードは失敗、allOf は全部、const は一致だけ
    check(!valid({ $ref: "#/x" }, 1) && !valid({ not: { type: "string" } }, 1) && !valid({ allOf: [{ type: "integer" }, { type: "string" }] }, 1)
      && valid({ allOf: [{ type: "integer" }, { type: "number" }] }, 1) && valid({ const: true }, true) && !valid({ const: true }, false), "検証：知らないキーワード（$ref・not）は失敗、allOf は全部を満たすときだけ、const は一致だけ");
    unknownKeys.clear();
    const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "properties") Object.values(v).forEach(walk); else { if (!KNOWN.has(k)) unknownKeys.add(k); walk(v); } } };
    Object.values(tools).forEach(t => walk(t.inputSchema));
    check(!unknownKeys.size, `tools/list のスキーマはこの検証が知っているキーワードだけ${unknownKeys.size ? `（知らない：${[...unknownKeys].join("・")}）` : ""}`);
    unknownKeys.clear();
  }

  console.log("1b. のあ（LLM）に見せる道具の形（llm-tools.mjs）");
  {
    const llm = llmTools(Object.values(tools));
    const left = llmLeftovers(llm);
    check(!left.length, `公開スキーマの広げた部分（anyOf・日本語の選択肢・「でもよい」）が残っていない${left.length ? `：${left.join("、")}` : ""}`);
    const P = Object.fromEntries(llm.map(t => [t.function.name, t.function.parameters.properties]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check(same(P.set_formation.fleet_id, { type: "integer", description: "自軍艦隊のID" }) && same(P.new_fleet.planet_id, { type: "integer", description: "自国の惑星のID" })
      && same(P.move_fleet.to, { type: "integer", description: "行き先の惑星ID" }), "ID の引数は整数だけで、説明から名前の案内を外す");
    check(same(P.set_formation.formation, { type: "string", enum: ["line", "wedge", "square", "crane", "rear"] }) && same(P.build_facility.facility, { type: "string", enum: ["mine", "yard", "sats", "lab", "flak"] }),
      "施設・陣形の選択肢は英語キーだけ（引数の説明なし）");
    check(same(P.move_fleet.say, tools.move_fleet.inputSchema.properties.say), "ほかの引数（say など）はそのまま");
  }

  const s0 = await state();
  await call("dismiss_dialog"); // 開始時の通信を閉じる
  const home = s0.planets.find(p => p.owner === "P" && p.facilities.some(f => f.key === "yard"));
  const [f1, f2] = s0.myFleets;

  console.log("2. 名前・日本語で書いた引数と、ID・英語キーで書いた引数が同じ操作になる");
  {
    const r = await call("set_formation", { fleet_id: f2.name, formation: "方陣" });
    const now = (await state()).myFleets.find(f => f.id === f2.id);
    check(r?.ok === true && now.formation === "square", `set_formation(${f2.name}, 方陣) → ${now.formation}（${r?.message}）`);
    const r2 = await call("set_formation", { fleet_id: f2.id, formation: "wedge" });
    const now2 = (await state()).myFleets.find(f => f.id === f2.id);
    check(r2?.ok === true && now2.formation === "wedge", `set_formation(${f2.id}, wedge) → ${now2.formation}`);
    const r3 = await call("set_formation", { fleet_id: String(f1.id), formation: "鶴翼" });
    check(r3?.ok === true && (await state()).myFleets.find(f => f.id === f1.id).formation === "crane", `set_formation("${f1.id}", 鶴翼)（数字の文字列）`);
    const dupJa = await call("build_facility", { planet_id: home.name, facility: "造船所" });
    const dupEn = await call("build_facility", { planet_id: home.id, facility: "yard" });
    check(dupJa?.ok === false && dupEn?.ok === false && dupJa.message === dupEn.message && /既にあります/.test(dupJa.message), `build_facility(${home.name}, 造船所) と (${home.id}, yard) が同じ理由で断られる`);
    const ghost = await call("set_formation", { fleet_id: "第9艦隊", formation: "方陣" });
    check(typeof ghost === "string" && /第9艦隊 という自軍艦隊はいません。自軍艦隊：/.test(ghost), `いない艦隊の名前は理由つきで断る（${String(ghost?.message ?? ghost).slice(0, 80)}）`);
    const up = await call("set_formation", { fleet_id: f1.id, formation: " CRANE " }, { raw: true }); // スキーマには無いが、サーバーは今までどおり寛容に読む
    check(up?.ok === true, "前後の空白・英語キーの大文字も今までどおり読む（スキーマを通さずに送ったとき）");
    const odd = await call("set_formation", { fleet_id: f1.id, formation: "円陣" }, { raw: true });
    check(typeof odd === "string" && /formation（陣形）は line=横陣・/.test(odd), `選択肢に無い陣形は選べるものを返す（${String(odd).slice(0, 60)}）`);
    const half = await call("set_formation", { fleet_id: 1.5, formation: "方陣" }, { raw: true });
    const none = await call("move_fleet", { fleet_id: f1.id }, { raw: true });
    check(/整数で指定してください/.test(String(half)) && /to（行き先の惑星ID）を指定してください/.test(String(none)), "小数のID・足りない引数は今までどおり日本語で案内する");
  }

  console.log("3. new_fleet を応答を待たずに2件送る");
  {
    const before = await state();
    check(before.myFleets.length === 2, `前提：自軍2艦隊（${before.myFleets.length}）・資金${before.funds}`);
    const rs = await Promise.all([call("new_fleet", { planet_id: home.id }), call("new_fleet", { planet_id: home.id })]);
    const ok = rs.filter(r => r?.ok === true), ng = rs.filter(r => r?.ok === false);
    check(ok.length === 1 && ng.length === 1, `成功1件・拒否1件（${rs.map(r => r?.message).join(" ／ ")}）`);
    check(ng.length === 1 && /最大3つ/.test(ng[0].message), "拒否の理由が付く");
    const after = await state();
    check(after.myFleets.length === 3 && after.funds === before.funds - 32, `最終：自軍${after.myFleets.length}艦隊・資金${before.funds}→${after.funds}（3艦隊・-32 のはず）`);
    // 新しい艦隊も名前で動かせる（名前の番号ではなく名前で探す）
    const nf = after.myFleets.find(f => !before.myFleets.some(b => b.id === f.id));
    if (nf) { const r = await call("set_formation", { fleet_id: nf.name, formation: "後衛陣" }); check(r?.ok === true && (await state()).myFleets.find(f => f.id === nf.id).formation === "rear", `新しい ${nf.name}（ID ${nf.id}）を名前で指定`); }
  }
} finally {
  await client.close();
}
if (failures) { console.log(`✗ テスト失敗（${failures} 件）`); process.exitCode = 1; } else console.log("✓ テスト成功");
