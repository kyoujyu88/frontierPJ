/* 字幕の整え方の確認（talk.mjs）：LLM の返事に書かれたツール呼び出しの記法を字幕に出さず、say は1件ずつのセリフにする。
 * ブラウザも LLM も要らない。  node talk-test.mjs
 */
import { makeTalk, splitRecordedTalk, stripThink } from "./talk.mjs";

const T = makeTalk({ toolNames: ["say", "end_turn", "move_fleet", "dismiss_dialog", "battle_move", "research", "build"], name: "のあ" });
let failed = 0;
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${what}${ok ? "" : `\n    期待 ${JSON.stringify(want)}\n    実際 ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const lines = (s) => T.splitReply(stripThink(s)).lines;
const calls = (s) => T.splitReply(stripThink(s)).calls.map(c => [c.function.name, JSON.parse(c.function.arguments)]);

// 2026-11 の録画で字幕にそのまま出ていた形
const seen = "say{text:「研究にガッツリ投資して、次世代の戦力を手に入れちゃうよ！」} say{text:「カルセは要塞だし、防衛衛星で守りを固めておこうかな。」} say{text:「第1艦隊、リュネへ進軍！まずは勢いよく攻め込むよ！」}";
eq(lines(seen), ["研究にガッツリ投資して、次世代の戦力を手に入れちゃうよ！", "カルセは要塞だし、防衛衛星で守りを固めておこうかな。", "第1艦隊、リュネへ進軍！まずは勢いよく攻め込むよ！"], "say{text:「…」} が並んだら1件ずつのセリフにする");
eq(calls(seen), [], "say はツールとしては実行しない（セリフとして出す）");
eq(T.cleanTalk(seen), "", "cleanTalk は記法をすべて外す");
eq(lines("まずは研究！ say{text:「次は造船だよ」} 以上！"), ["まずは研究！", "次は造船だよ", "以上！"], "地の文と say は書かれた順に並べる");
eq(lines('<|tool_call>call:say{text:<|"|>やったね、勝ったよ！<|"|>}<tool_call|>'), ["やったね、勝ったよ！"], "Gemma の特殊トークンで書かれた say");
eq(lines('say(text="こんにちは, みんな")'), ["こんにちは, みんな"], "関数の形の say（値の中のカンマで切らない）");
eq(lines('say("位置だけ")'), ["位置だけ"], "キーなしの say");
eq(lines('say{"text":"JSONだよ"}'), ["JSONだよ"], "JSON の形の say");
eq(lines("say{text:「途中で切れ"), ["途中で切れ"], "途中で切れた say も記法を出さない");
eq(lines("say{text:「{かっこ}入り」}"), ["{かっこ}入り"], "引用符の中の括弧は数えない");
eq(lines("<think>どうしよう</think>のあ：「ふつうのセリフだよ」"), ["ふつうのセリフだよ"], "ふつうの地の文は今までどおり整える");
eq(lines("I'm ready! end_turn()"), ["I'm ready!"], "英語のアポストロフィで崩れない");

// ほかのツールの呼び出しは字幕から外し、実行の候補にする
eq(calls("よし行くよ！ move_fleet(fleet_id=1, to=2) end_turn()"), [["move_fleet", { fleet_id: 1, to: 2 }], ["end_turn", {}]], "関数の形の呼び出しを拾う");
eq(lines("よし行くよ！ move_fleet(fleet_id=1, to=2) end_turn()"), ["よし行くよ！"], "その記法は字幕に出さない");
eq(calls("<|tool_call>call:battle_move{unit_id:30,x:3,y:2}<tool_call|>前に出るよ"), [["battle_move", { unit_id: 30, x: 3, y: 2 }]], "Gemma の call:name{…} を拾う");
eq(calls("call:move_fleet{fleet_id:1,to:3<tool_call|>"), [["move_fleet", { fleet_id: 1, to: 3 }]], "閉じ括弧の無い call:name{… も拾う");
eq(calls("build{planet_id:2, kind:\"mine\"} say{text:「採掘所を建てたよ」}"), [["build", { planet_id: 2, kind: "mine" }]], "say 以外の name{…} の形も拾う");
eq(lines("end_turn（ターン終了）するね"), ["ターン終了するね"], "全角の括弧は呼び出しとみなさない（ツール名は外して括弧の中を残す）");
eq(calls("end_turn（ターン終了）するね"), [], "文の中のツール名は実行しない");

// 括弧の付かないツール名（2026-11 の録画で字幕に「end_turn」とだけ出た）
eq(lines("end_turn"), [], "ツール名だけの返事は字幕に出さない");
eq(calls("end_turn"), [["end_turn", {}]], "ツール名だけの返事は引数なしの呼び出しにする");
eq(lines("`end_turn`。"), [], "記号で飾ったツール名だけでも字幕に出さない");
eq(lines("よし、内政はおしまい！\nend_turn"), ["よし、内政はおしまい！"], "ツール名だけの行は外し、ほかの行は残す");
eq(calls("よし、内政はおしまい！\nend_turn"), [["end_turn", {}]], "ツール名だけの行は呼び出しにする");
eq(lines("dismiss_dialog → end_turn"), [], "ツール名を並べただけの行も出さない");
eq(calls("dismiss_dialog → end_turn"), [["dismiss_dialog", {}], ["end_turn", {}]], "並べたツール名は順に呼び出しにする");
eq(calls("move_fleet(fleet_id=1, to=2)\nmove_fleet"), [["move_fleet", { fleet_id: 1, to: 2 }]], "括弧つきで呼んだ名前は重ねて足さない");
eq(lines("これで end_turn するね！"), ["これでターン終了するね！"], "文の中のツール名は日本語の操作名に置き換える");
eq(lines("第1艦隊を move_fleet でリュネへ！"), ["第1艦隊を艦隊の移動でリュネへ！"], "文の中の別のツール名も置き換える");
eq(T.cleanTalk("end_turn"), "", "say ツールに渡されたツール名だけのセリフも出さない");
eq(lines('say{text:「end_turn」}'), [], "say の中身がツール名だけでも出さない");
eq(lines("I'll say hello and survey the area."), ["I'll say hello and survey the area."], "_ を含まない名前は英語の文の中では外さない");
eq(lines("say"), [], "ただし行が say だけなら出さない");
eq(lines("research"), [], "_ の無いツール名だけの行も字幕には出さない");
eq(calls("research"), [], "ただし _ の無い1語は英単語と紛れるので実行しない");
eq(calls("move_fleet(fleet_id=1, to=2) move_fleet(fleet_id=2, to=3) move_fleet(fleet_id=3, to=4) move_fleet(fleet_id=4, to=5) move_fleet(fleet_id=5, to=6)\nend_turn").map(c => c[0]),
  ["move_fleet", "move_fleet", "move_fleet", "move_fleet", "end_turn"], "括弧つきの呼び出しが4件を超えても、ツール名だけの行の end_turn は残す");
eq(lines("go end_turn now"), ["go ターン終了 now"], "英数字にはさまれた置き換えには空白を残す");

// 修正前のプレイログ（記法つきで1件に残ったセリフ）
eq(splitRecordedTalk(seen, "のあ").length, 3, "記録済みのセリフも1件ずつに分けられる");
eq(splitRecordedTalk("ふつうのセリフ", "のあ"), ["ふつうのセリフ"], "記法の無いセリフはそのまま");
eq(splitRecordedTalk("end_turn", "のあ"), [], "記録済みの操作名だけのセリフは出さない");
eq(splitRecordedTalk("I say yes", "のあ"), ["I say yes"], "記録済みのセリフの英単語は触らない");
eq(splitRecordedTalk("survey", "のあ"), ["survey"], "記録済みの _ の無い1語はそのまま（ふつうのセリフかもしれない）");
eq(splitRecordedTalk("これで end_turn するね", "のあ"), ["これでターン終了するね"], "記録済みのセリフの中のツール名も置き換える");

// 考える部分が「thought」の行から始まるもの（開きの特殊トークンが落ちた形。gemma4 系で字幕に考え途中の文が出た）
eq(lines("thought\n<channel|>"), [], "thought と閉じトークンだけの返事は字幕に出さない");
eq(lines("thought\nI should call invest_research first.\n1. Analyze"), [], "閉じていない thought は最後まで考える部分として外す");
eq(calls("thought\nI should call end_turn() now"), [], "考える部分に書かれた呼び出しは実行しない");
eq(lines("thought\nplan...<channel|>研究を進めるよ！"), ["研究を進めるよ！"], "閉じトークンのあとの本文は字幕に出す");
eq(lines("thoughtful な一手だね"), ["thoughtful な一手だね"], "thought で始まるふつうの文は触らない");

process.exit(failed ? 1 : 0);
