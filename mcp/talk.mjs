/* LLM の返事から「字幕に出すセリフ」と「文字で書かれたツール呼び出し」を取り出す（ai-player.mjs と playlog.mjs で共通）
 *
 * ツール呼び出しの機能を使わずに、呼び出しを地の文に書いてしまうモデルがある。拾う書き方：
 *   dismiss_dialog()　move_fleet(fleet_id=1, to=2)　say(text="…")          … 関数呼び出しの形
 *   <|tool_call>call:battle_move{unit_id:30,x:3,y:2}<tool_call|>              … Gemma 系の特殊トークン（文字列は <|"|> で囲む）
 *   say{text:「…」} say{text:「…」}                                          … call: も特殊トークンも付かない形（gemma4 で実際に出た）
 *   say "…"　say「…」　say: "…"                                              … 行の頭の say のあとに引用符でセリフ（2026-11-16 のプレイログで出た）
 *   [{"say": "…"}, {"build_ship": {"fleet_id": 1}, "say": "…"}]              … ツール名をキーにした JSON（2026-11-17 のプレイログで出た。コードブロックの中の配列）
 *   {"name": "move_fleet", "arguments": {"fleet_id": 1, "to": 2}}             … OpenAI 形式の呼び出しを JSON で書いたもの
 * say の呼び出しはセリフとして1件ずつ字幕にし、ほかの呼び出しは実行する候補として返す。どちらも字幕には生の記法を出さない。
 *
 * 括弧の付かないツール名だけを書くこともある（2026-11 の録画で字幕に「end_turn」とだけ出た）：
 *   end_turn　　　　　　　　　… 行がツール名だけ → 字幕に出さず、引数なしの呼び出しの候補にする
 *   これで end_turn するね　　… 文の中のツール名（_ を含むもの）→ 日本語の操作名（ターン終了）に置き換える
 */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 値を囲む引用符（開き → 閉じ）。' は英語の地の文の I'm などと紛れるので、呼び出しの範囲を探すときは使わない
const OPEN = { '"': '"', "“": "”", "「": "」", "『": "』", "＂": "＂" };
const OPEN_VALUE = { ...OPEN, "'": "'", "‘": "’" };

/* src[i] が開き記号（( か {）のとき、対応する閉じ記号の次の位置を返す。引用符の中の括弧は数えない。閉じていなければ -1 */
function matchClose(src, i) {
  const open = src[i], close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (OPEN[ch]) {
      const end = OPEN[ch];
      for (k++; k < src.length && src[k] !== end; k++) if (ch === '"' && src[k] === "\\") k++;
      if (k >= src.length) return -1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return k + 1;
  }
  return -1;
}

/* 文の中に出たツール名を置き換える日本語の操作名（空文字は名前ごと外す）。載っていない名前も外す */
export const LABELS = {
  end_turn: "ターン終了", move_fleet: "艦隊の移動", intercept: "迎撃", invest_research: "研究への投資",
  refit_ship: "改装", set_flagship: "旗艦の変更", set_formation: "陣形の変更", build_ship: "造船",
  repair_fleet: "修理", new_fleet: "艦隊の編成", build_facility: "施設の建設", demolish_facility: "施設の撤去",
  survey: "探査", fortify: "防衛強化", dismiss_dialog: "通信を閉じる",
  battle_attack: "攻撃", battle_move: "移動", battle_wait: "待機", battle_end_phase: "フェイズ終了",
  battle_retreat: "撤退", battle_close: "戦闘の終了",
  get_summary: "状況の確認", get_state: "状況の確認", get_rules: "ルールの確認", get_screenshot: "画面の確認",
  battle_state: "戦況の確認", new_game: "新しいゲーム", say: "", finish_recording: "", recording_info: "",
};

const scalar = (v) => /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v === "null" ? null : v;

/* 呼び出しの中身（text:「…」, x=3 / "text":"…" / {"a":1} / "…" だけ）を引数のオブジェクトにする。読めなければ null */
export function parseArgs(body) {
  let b = (body || "").trim();
  if (b.startsWith("{") && b.endsWith("}")) b = b.slice(1, -1).trim();
  if (!b) return {};
  try { const j = JSON.parse(`{${b}}`); if (j && typeof j === "object") return j; } catch { /* JSON ではない書き方 */ }
  const args = {};
  let i = 0, positional = 0;
  const ws = () => { while (i < b.length && /[\s,、]/.test(b[i])) i++; };
  const quoted = () => {
    const end = OPEN_VALUE[b[i]];
    if (!end) return null;
    const q = b[i++]; let s = "";
    for (; i < b.length && b[i] !== end; i++) {
      if (q === '"' && b[i] === "\\" && i + 1 < b.length) { i++; s += b[i] === "n" ? "\n" : b[i]; } else s += b[i];
    }
    i++; // 閉じ引用符（なければ最後まで）
    return s;
  };
  for (ws(); i < b.length; ws()) {
    const start = i;
    let key = quoted();
    if (key == null) { const m = b.slice(i).match(/^[A-Za-z_]\w*/); if (m) { key = m[0]; i += key.length; } }
    while (i < b.length && /[ \t]/.test(b[i])) i++;
    if (key != null && /[:=：]/.test(b[i] ?? "")) {
      i++; while (i < b.length && /\s/.test(b[i])) i++;
    } else {
      // キーなしの値（say("…") など）
      i = start; key = `$${positional++}`;
    }
    let val = quoted();
    if (val == null) {
      let k = i; while (k < b.length && b[k] !== ",") k++;
      val = scalar(b.slice(i, k).trim()); i = k;
    }
    if (key === "" && val === "") return null;
    args[key] = val;
  }
  return args;
}

export const stripThink = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "")
  .replace(/<\|channel\|?>\s*thought[\s\S]*?(<channel\|>|(?=<\|tool_call)|$)/g, "") // Gemma 系の考える部分
  // 開きの特殊トークンが落ちて「thought」の行から始まるもの（Ollama の gemma4 系で実際に出た）。閉じの <channel|> か
  // ツール呼び出しまでが考える部分。閉じが無ければ（返事が途中で切れた）最後まで考える部分とみなす
  .replace(/^\s*thought[ \t]*\r?\n[\s\S]*?(<channel\|>|(?=<\|tool_call)|$)/, "")
  .trim();

/* 字幕向けに整える：紛れ込んだHTMLタグ・名前の前置き・強調記号・セリフを囲む引用符や、片方だけ残った引用符を外す */
const QUOTES = [['"', '"'], ["＂", "＂"], ["“", "”"], ["〝", "〟"], ["「", "」"], ["『", "』"], ["'", "'"], ["‘", "’"]];
function tidy(s, name) {
  let t = (s || "").replace(/<\|tool_call\|?>[\s\S]*?(<tool_call\|>|$)/g, " ") // 知らない名前の呼び出しも特殊トークンごと外す
    .replace(/call:\w+\{[^{}]*\}?/g, " ")
    .replace(/<\|[^<>]{0,40}>|<[^<>]{0,40}\|>/g, " ") // <|channel> <channel|> などの特殊トークン
    .replace(/```[\s\S]*?(```|$)/g, " ") // コードブロック（ツール呼び出しを文字で書いたもの）
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, " ") // </td> や <dialog> など、紛れ込んだタグ
    .replace(/\*\*|__/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, "\n").trim()
    .replace(/(^|\n)thought$/i, "").trim(); // 考える部分の見出しだけが最後に残ったもの（Gemma 系）
  if (name) t = t.replace(new RegExp(`^${esc(name)}\\s*[：:]\\s*`), "");
  for (let changed = true; changed && t.length > 1;) {
    changed = false;
    for (const [a, b] of QUOTES) {
      const n = t.split(a).length - 1 + (a === b ? 0 : t.split(b).length - 1);
      if (n === 2 && t.length > 2 && t.startsWith(a) && t.endsWith(b)) { t = t.slice(1, -1).trim(); changed = true; }
    }
  }
  const count = (c) => t.split(c).length - 1;
  for (const [a, b] of QUOTES) {
    if (a === b) { if (count(a) % 2) t = t.startsWith(a) ? t.slice(1) : t.endsWith(a) ? t.slice(0, -1) : t; }
    else if (count(a) !== count(b)) { if (t.startsWith(a) && !count(b)) t = t.slice(1); else if (t.endsWith(b) && !count(a)) t = t.slice(0, -1); }
    t = t.trim();
  }
  return t;
}

/* toolNames：拾うツールの名前、name：話し手の名前（「のあ：」の前置きを外す）、labels：文の中のツール名の言い換え */
export function makeTalk({ toolNames, name = "", labels = LABELS }) {
  const sorted = [...toolNames].sort((a, b) => b.length - a.length);
  const names = sorted.map(esc).join("|");
  const HEAD = new RegExp(`(?:<\\|tool_call\\|?>\\s*)?(?:call:)?\\b(${names})\\s*([({])`, "g");
  // 文の中で拾うのは _ を含む名前だけ（survey・intercept・say などは英語の地の文と紛れるため）
  const snake = sorted.filter(n => n.includes("_")).map(esc).join("|");
  const MENTION = snake ? new RegExp(`[ \\t]*\`?\\b(${snake})\\b\`?(?:[ \\t]*（([^（）\\n]{1,20})）)?[ \\t]*`, "g") : null;
  const NAME_SET = new Set(toolNames);
  const WORD = /[A-Za-z0-9]/;
  // JSON で書いた呼び出しの頭：{"ツール名": …} か {"name": …}
  const JSON_HEAD = new RegExp(`\\{\\s*"(name|${names})"\\s*:`, "g");

  /* 行がツール名だけ（飾りの記号を除いて）なら、その名前の並びを返す。そうでなければ null */
  function bareNames(line) {
    const words = line.replace(/[`'"“”「」『』（）()［］\[\]【】<>＜＞→⇒➡、。,.!！?？・:：;；…\-‐ー~〜*＊#\s]+/g, " ").trim().split(" ");
    return words[0] && words.every(w => NAME_SET.has(w)) ? words : null;
  }

  /* 置き換えた語の前後の空白。隣が英数字のときだけ入れる（日本語の文に「 ターン終了 」と空白が入らないように）
   *   「これで end_turn するね」→「これでターン終了するね」　「go end_turn now」→「go ターン終了 now」
   *   外すだけ（言い換えの無い名前）のときは、英数字にはさまれていれば空白を1つ残す */
  function spaced(word, before, after) {
    if (!word) return WORD.test(before) && WORD.test(after) ? " " : "";
    return (WORD.test(before) ? " " : "") + word + (WORD.test(after) ? " " : "");
  }

  /* 整えた字幕からツール名を外す。ツール名だけの行は捨てて bare に名前を足し、文の中の名前は操作名に置き換える */
  function dropNames(text, bare = []) {
    const out = [];
    for (const line of (text || "").split("\n")) {
      const only = bareNames(line);
      if (only) { bare.push(...only); continue; }
      let t = !MENTION ? line : line.replace(MENTION, (m, n, paren, off, src) =>
        spaced((paren ?? labels[n] ?? "").trim(), src[off - 1] ?? "", src[off + m.length] ?? ""));
      t = t.replace(/[ \t]{2,}/g, " ").trim();
      if (t && !/^[\p{P}\p{S}\s]*$/u.test(t)) out.push(t);
    }
    return out.join("\n");
  }
  const clean = (s, bare) => dropNames(tidy(s, name), bare);

  /* 行の頭の say のあとに引用符でセリフを書いた形（say "…"）。括弧の形（say(…)・say{…}）は HEAD で拾う */
  const SAY_LINE = /(^|\n)([ \t>*・-]*)say[ \t]*[:：]?[ \t]*(["“「『＂])/g;
  function sayLines(src, out) {
    const found = [];
    SAY_LINE.lastIndex = 0;
    for (let m; (m = SAY_LINE.exec(src));) {
      const start = m.index + m[1].length, open = m.index + m[0].length - 1, close = OPEN[m[3]];
      if (out.some(c => start < c.end && c.start < open + 1)) continue; // 括弧の呼び出しの中
      let k = open + 1, text = "";
      for (; k < src.length && src[k] !== close && src[k] !== "\n"; k++) {
        if (m[3] === '"' && src[k] === "\\" && k + 1 < src.length) { k++; text += src[k] === "n" ? "\n" : src[k]; } else text += src[k];
      }
      const end = src[k] === close ? k + 1 : k; // 閉じ引用符がなければ行の終わりまで
      found.push({ name: "say", args: { text }, start, end, src });
      SAY_LINE.lastIndex = end;
    }
    return found;
  }

  /* JSON で書いた呼び出しを { name, args } の並びにする。
   *   {"name": "move_fleet", "arguments": {…}}（arguments は parameters・args でも、文字列の JSON でもよい）
   *   {"build_ship": {…}, "say": "…"} … ツール名のキー。say はその操作のひとこと（say 引数）にする。
   *     1つの {} にツールが2つ以上あるときは、say は最初の手にだけ付ける（同じセリフを2回字幕に出さない）
   *   {"say": "…"} / {"say": {"text": "…"}} … セリフだけ */
  function jsonCalls(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return [];
    const obj = (a) => { if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } } return a && typeof a === "object" && !Array.isArray(a) ? { ...a } : {}; };
    if (typeof o.name === "string") return NAME_SET.has(o.name) ? [{ name: o.name, args: obj(o.arguments ?? o.parameters ?? o.args) }] : [];
    const sayText = typeof o.say === "string" ? o.say : typeof o.say?.text === "string" ? o.say.text : null;
    const out = Object.keys(o).filter(k => k !== "say" && NAME_SET.has(k)).map(k => ({ name: k, args: obj(o[k]) }));
    if (sayText == null) return out;
    if (!out.length) return NAME_SET.has("say") ? [{ name: "say", args: { text: sayText } }] : [];
    if (out[0].args.say == null) out[0].args.say = sayText;
    return out;
  }
  function findJson(src) {
    const out = [];
    JSON_HEAD.lastIndex = 0;
    for (let m; (m = JSON_HEAD.exec(src));) {
      const close = matchClose(src, m.index);
      if (close < 0) {
        // {"name": … で閉じていないものは、呼び出しかどうか分からないので触らない（字幕を文末まで消さない）
        if (m[1] === "name") { JSON_HEAD.lastIndex = m.index + 1; continue; }
        // 閉じていない（返事が途中で切れた）。引数がそろっているか分からないので実行はせず、字幕からだけ外す
        out.push({ name: m[1], args: null, start: m.index, end: src.length, src });
        break;
      }
      let o = null;
      try { o = JSON.parse(src.slice(m.index, close)); } catch { /* JSON ではない */ }
      const cs = jsonCalls(o);
      if (!cs.length && m[1] === "name") { JSON_HEAD.lastIndex = m.index + 1; continue; } // {"name": "のあ"} のような呼び出しではない JSON や、読めない JSON は触らない
      if (!cs.length) out.push({ name: m[1], args: null, start: m.index, end: close, src });
      for (const c of cs) out.push({ ...c, start: m.index, end: close, src });
      JSON_HEAD.lastIndex = close;
    }
    return out;
  }

  /* 文字で書かれた呼び出しを、書かれた順に { name, args, start, end } で返す（args が読めないものは null） */
  function findCalls(text) {
    const src = (text || "").replace(/<\|"\|>/g, '"');
    const json = findJson(src);
    const inJson = (i) => json.some(c => c.start <= i && i < c.end);
    const out = [];
    HEAD.lastIndex = 0;
    for (let m; (m = HEAD.exec(src));) {
      if (inJson(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchClose(src, open);
      let bodyEnd, end;
      if (close >= 0) { bodyEnd = close - 1; end = close; }
      else if (m[2] === "(") continue; // 閉じていない ( は地の文の一部とみなす
      else {
        // { は閉じていなくても拾う（Gemma 系の閉じ忘れ・返事が途中で切れたもの）。<tool_call|> があればそこまで
        const t = src.indexOf("<tool_call|>", open);
        bodyEnd = end = t >= 0 ? t : src.length;
      }
      const tail = src.slice(end).match(/^\s*<tool_call\|>/);
      if (tail) end += tail[0].length;
      let args = parseArgs(src.slice(open + 1, bodyEnd));
      if (args && m[1] === "say" && args.text == null && typeof args.$0 === "string") args = { text: args.$0 };
      if (args) for (const k of Object.keys(args)) if (k.startsWith("$")) delete args[k];
      out.push({ name: m[1], args, start: m.index, end, src });
      HEAD.lastIndex = end;
    }
    const all = [...out, ...json];
    return (NAME_SET.has("say") ? [...all, ...sayLines(src, all)] : all).sort((a, b) => a.start - b.start);
  }

  /* 呼び出しの記法をすべて外して字幕向けに整える */
  function cleanTalk(text, bare) {
    const calls = findCalls(text);
    if (!calls.length) return clean(text, bare);
    const src = calls[0].src;
    let rest = "", at = 0;
    for (const c of calls) { rest += src.slice(at, c.start) + " "; at = c.end; }
    return clean(rest + src.slice(at), bare);
  }

  /* 返事を字幕の行に分ける。地の文はまとめて1行、say の呼び出しは1件ずつ1行（書かれた順）。
   * calls は say 以外の呼び出し（OpenAI 形式。実行するかどうかは呼ぶ側が決める）。
   * ツール名だけの行（end_turn など）は字幕に出さず、引数なしの呼び出しとして calls の後ろに足す */
  function splitReply(text) {
    const found = findCalls(text);
    const lines = [], calls = [], bare = [];
    let buf = "", at = 0;
    const flush = () => { const t = clean(buf, bare); if (t) lines.push(t); buf = ""; };
    const add = (n, args) => calls.push({ id: `text_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: n, arguments: JSON.stringify(args) } });
    for (const c of found) {
      buf += c.src.slice(at, c.start) + " "; at = c.end;
      if (c.name === "say") {
        const t = typeof c.args?.text === "string" ? cleanTalk(c.args.text, bare) : "";
        if (t) { flush(); lines.push(t); }
      } else if (c.args) add(c.name, c.args);
    }
    buf += found.length ? found.at(-1).src.slice(at) : (text || "");
    flush();
    // ツール名だけの行から足すのは _ を含む名前だけ（survey・intercept など1語の英単語は、字幕から外すだけで実行しない）。
    // 括弧つきの呼び出しが4件を超えても切られないよう、上限は括弧つきの方にだけかける
    calls.splice(4);
    const have = new Set(calls.map(c => c.function.name));
    for (const n of bare) if (n.includes("_") && !have.has(n)) { have.add(n); add(n, {}); }
    return { lines, calls };
  }

  return { findCalls, cleanTalk, splitReply };
}

/* プレイログ用：記録済みのセリフに say{…} などの記法やツール名が残っていたら（この修正より前のログ）、直して1件ずつに分けて返す。
 * ツール名だけのセリフ（end_turn など）は空の配列になる（字幕に出さない） */
const RECORDED = new Map();
// 直すのは say の記法か、_ を含むツール名があるときだけ（say・survey などの英単語だけなら、ふつうのセリフとしてそのまま返す）
const NAME_HINT = new RegExp(`\\bsay\\s*[({]|(^|\\n)[ \\t>*・-]*say[ \\t]*[:：]?[ \\t]*["“「『＂]|\\b(${Object.keys(LABELS).filter(n => n.includes("_")).map(esc).join("|")})\\b`);
export function splitRecordedTalk(text, who = "") {
  if (!NAME_HINT.test(text || "")) return [text];
  if (!RECORDED.has(who)) RECORDED.set(who, makeTalk({ toolNames: Object.keys(LABELS), name: who }));
  const { lines, calls } = RECORDED.get(who).splitReply(text);
  // 整えて空になったのが操作（ツール名・呼び出し）だけのセリフなら外す。それ以外で空になったら元の文を残す
  return lines.length || calls.length ? lines : [text];
}
