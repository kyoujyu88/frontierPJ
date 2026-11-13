/* LLM の返事から「字幕に出すセリフ」と「文字で書かれたツール呼び出し」を取り出す（ai-player.mjs と playlog.mjs で共通）
 *
 * ツール呼び出しの機能を使わずに、呼び出しを地の文に書いてしまうモデルがある。拾う書き方：
 *   dismiss_dialog()　move_fleet(fleet_id=1, to=2)　say(text="…")          … 関数呼び出しの形
 *   <|tool_call>call:battle_move{unit_id:30,x:3,y:2}<tool_call|>              … Gemma 系の特殊トークン（文字列は <|"|> で囲む）
 *   say{text:「…」} say{text:「…」}                                          … call: も特殊トークンも付かない形（gemma4 で実際に出た）
 * say の呼び出しはセリフとして1件ずつ字幕にし、ほかの呼び出しは実行する候補として返す。どちらも字幕には生の記法を出さない。
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

/* toolNames：拾うツールの名前、name：話し手の名前（「のあ：」の前置きを外す） */
export function makeTalk({ toolNames, name = "" }) {
  const names = [...toolNames].sort((a, b) => b.length - a.length).map(esc).join("|");
  const HEAD = new RegExp(`(?:<\\|tool_call\\|?>\\s*)?(?:call:)?\\b(${names})\\s*([({])`, "g");

  /* 文字で書かれた呼び出しを、書かれた順に { name, args, start, end } で返す（args が読めないものは null） */
  function findCalls(text) {
    const src = (text || "").replace(/<\|"\|>/g, '"');
    const out = [];
    HEAD.lastIndex = 0;
    for (let m; (m = HEAD.exec(src));) {
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
    return out;
  }

  /* 呼び出しの記法をすべて外して字幕向けに整える */
  function cleanTalk(text) {
    const calls = findCalls(text);
    if (!calls.length) return tidy(text, name);
    const src = calls[0].src;
    let rest = "", at = 0;
    for (const c of calls) { rest += src.slice(at, c.start) + " "; at = c.end; }
    return tidy(rest + src.slice(at), name);
  }

  /* 返事を字幕の行に分ける。地の文はまとめて1行、say の呼び出しは1件ずつ1行（書かれた順）。
   * calls は say 以外の呼び出し（OpenAI 形式。実行するかどうかは呼ぶ側が決める） */
  function splitReply(text) {
    const found = findCalls(text);
    const lines = [], calls = [];
    let buf = "", at = 0;
    const flush = () => { const t = tidy(buf, name); if (t) lines.push(t); buf = ""; };
    for (const c of found) {
      buf += c.src.slice(at, c.start) + " "; at = c.end;
      if (c.name === "say") {
        const t = typeof c.args?.text === "string" ? cleanTalk(c.args.text) : "";
        if (t) { flush(); lines.push(t); }
      } else if (c.args) {
        calls.push({ id: `text_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } });
      }
    }
    buf += found.length ? found.at(-1).src.slice(at) : (text || "");
    flush();
    return { lines, calls: calls.slice(0, 4) };
  }

  return { findCalls, cleanTalk, splitReply };
}

/* プレイログ用：記録済みのセリフに say{…} などの記法が残っていたら（この修正より前のログ）、1件ずつに分けて返す */
const SAY_ONLY = makeTalk({ toolNames: ["say"] });
export function splitRecordedTalk(text, who = "") {
  if (!/\bsay\s*[({]/.test(text || "")) return [text];
  const { lines } = (who ? makeTalk({ toolNames: ["say"], name: who }) : SAY_ONLY).splitReply(text);
  return lines.length ? lines : [text];
}
