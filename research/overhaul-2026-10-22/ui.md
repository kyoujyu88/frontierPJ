# 画面（UI/UX）点検報告 — 辺境星系戦記

対象: SNAP/game/frontier-war.html（行番号はこのファイルのもの）
担当: 画面・操作の点検（Playwright で実際に表示して確認）

## 調べ方

- 撮影は、claude.ai で配信されるときと同じ条件にするため、先頭に `<!doctype html><meta charset><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` を足したコピー（WORK/std/frontier-war.html）で行った。生ファイルは quirks モードで viewport も無いので、その結果は `shots/raw/` に分けた（→ M7）。
- 画面サイズ: スマホ 390×844（isMobile・hasTouch・DPR2）、タブレット 820×1180（isMobile・hasTouch）、1366×768、1920×1080、1280×720、2560×1440。加えて、実際のノートPCでブラウザが使える高さの **1366×643 と 1366×610**。
- 状態は `page.evaluate` で S を書き換えたり、`startBattle`・`showEnd`・`checkMonsterTrigger` を直接呼んだりして作った。混んだ盤面は、異生体出現後で巣が見える状態、自軍3艦隊×4隻、敵艦隊との同居、異生体の群れ3つ、ログ30行で用意した（WORK/setup.js の `__crowd`）。
- 演出の確認は FAST=false で行い、時間を区切って撮った（ターン終了の帯、敵の行動中、戦闘の敵フェイズ）。
- 撮影スクリプトは WORK/t1.mjs〜t17.mjs、スクリーンショットは WORK/shots/（188枚）。
- **修正案の一部はコピー（WORK/fix/frontier-war.html）に当てて動作を確認した**（差分: WORK/fix.diff）。確認したのは H1・H2・H3・M1・M2・M3・M4・L2・L7。フックが呼ぶ関数（demolish・finishBattle・closeModal など）の中身は変えていないが、game-api.js 自体はこの差分に対して走らせていない。

スクリーンショットはすべて `/tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/` の下にある（以下、各指摘では完全なパスで書く）。

## コンソール

- 全場面・全サイズで、**JS のエラー・警告・pageerror は0件**。
- FAST=false で開くと、1回の読み込みごとに `Fetch API cannot load file:///…/audio/*.mp3. URL scheme "file" is not supported.` が7件出る。file:// で直接開いたときの想定どおりの挙動。ローカル版は data: URL を使うので出ない。

## 一覧（重大な順）

| ID | 重大度 | 内容 | 確認 |
|---|---|---|---|
| H1 | 高 | 戦闘の「撤退」がワンクリックで確定し、取り消せない。主星の防衛戦で押すと即敗北する | 確認済み |
| H2 | 高 | 施設の「撤去」がワンクリックで確定し、返金もない | 確認済み |
| H3 | 高 | 通信ウィンドウ（遊び方・異生体出現など）が一番下までスクロールした状態で開き、冒頭が見えない | 確認済み |
| M1 | 中 | ウィンドウ幅が1600pxをまたぐと、技術局・自軍艦隊一覧が消えるか、左列が空になる | 確認済み |
| M2 | 中 | 艦隊カードの「移動」が、別艦隊の移動モード中に押すと切り替わらず取消になる | 確認済み |
| M3 | 中 | スマホの戦闘で、操作バーが盤面の最下段（自軍後列）に重なる。ボタンの文字も2行に折れる | 確認済み |
| M4 | 中 | タブレット（701〜900px）と背の低いノートPC（高さ620px未満）で、艦隊パネルが画面外になり、ターン終了もスクロールで見えなくなる | 確認済み |
| M5 | 中 | タッチで星を長押しすると、確認なしで即移動する（contextmenu） | 合成イベントで確認済み／実機は未確認 |
| M6 | 中 | 移動先の表示で「ただの移動」と「戦闘になる移動」が同じ青い輪。休戦中で進めない星も輪が付く | 撮影で確認済み（休戦の件はコードで確認） |
| M7 | 中（条件付き） | 生ファイル／ローカル版に doctype・charset・viewport が無い。スマホで開くとPC表示を縮小した状態になる | 確認済み |
| L1〜L17 | 低 | スマホで星図が画面外のまま移動モードになる、巣の艦隊マーカーの欠け、敵行動中の表示、モーダルの背面操作、文言のゆれ ほか | 各項に記載 |

---

## 高

### H1 戦闘の「撤退」がワンクリックで確定する（主星の防衛戦では即敗北）
- **場所**: `renderBattle` 1256行（撤退ボタン）→ `finishBattle("retreat")` 1106行 → `closeBattle` 1127〜1131行。
- **何が起きるか**: 確認なしで押した瞬間に戦闘が終わり、取り消せない。撤退ボタンは「ターン終了」のすぐ右にある。スマホでは4つのボタンが同じ幅（`.bbar button{flex:1}`）で並ぶので、押し間違えやすい。迎え撃つ側の戦闘（`cfg.attack=false`）で撤退すると、敵艦隊がその星に入って `siege()` が走る。主星アステリアの防衛戦なら、防衛力によってはそのまま「アステリア陥落」になる。
- **再現（確認済み）**: 主星の防衛力を10にし、隣の突撃戦隊4隻で防衛戦を始めて「撤退」を1回クリックし、`closeBattle()` を呼んだ。結果は `S.over="lose"`、主星の持ち主は E、敗北画面が出た。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/46-home-retreat-gameover-laptop.png
  - 並び（スマホ）: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/20-battle-sel-phone.png
- **直し方（コピーで確認済み）**: 押すと「本当に？」に変わり、3秒以内にもう一度押したときだけ実行する二段階ボタンにする。モーダルを使わないので、フックの dismissDialog に影響しない。フックの `battleRetreat` は `finishBattle` を直接呼ぶので、これまでどおり動く。
  ```js
  /* closeModal の前あたりに追加 */
  function armed(btn,label,run){let t=null;btn.addEventListener("click",()=>{if(btn.dataset.armed){clearTimeout(t);run();return}
    btn.dataset.armed="1";const old=btn.textContent;btn.textContent=label;btn.classList.add("on");
    t=setTimeout(()=>{delete btn.dataset.armed;btn.textContent=old;btn.classList.remove("on")},3000)});return btn}
  // 1256行の撤退ボタンを置き換え
  armed(h("button",{class:"danger",disabled:B.busy},"撤退"),
    B.cfg.attack?"本当に撤退？":"撤退？(星が包囲される)",
    ()=>{if(!B||B.busy||B.ended)return;finishBattle("retreat")})
  ```
  確認後の見た目: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-04-retreat-armed-phone.png

  あわせて、撤退をバーの左端に移して「ターン終了」から離すとさらに安全になる（並び順の変更、または `.bbar .danger{order:-1;margin-right:auto}`）。

### H2 施設の「撤去」がワンクリックで確定し、返金もない
- **場所**: `renderSide` 495行（`slot-x` ボタン）、`demolish` 559行。
- **何が起きるか**: 押すとすぐ消える。返金なし、取り消しなし。造船所（80）のような高い施設も一瞬で消える。「撤去」と空きスロットの「建設」が同じ列の同じ位置に並ぶので、押し間違えやすい。
- **再現（確認済み）**: アステリアで最初の「撤去」を1回クリックした。施設は `["yard","mine"]` から `["mine"]` になり、資金は160のまま、モーダルも出なかった。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/13-demolished-laptop.png
  - 並び（スマホ）: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/02-map-phone-full.png
- **直し方（コピーで確認済み）**: H1 の `armed()` を使う。
  ```js
  p.owner==="P"&&!S.over?armed(h("button",{class:"slot-x","aria-label":`${FAC[k].name}を撤去`},"撤去"),
    "撤去する？(返金なし)",()=>demolish(p,k)):null
  ```
  フックの `demolishFacility` は `demolish()` を直接呼ぶので影響しない。半額を返金する場合は、`demolish` に `S.funds+=Math.floor(FAC[k].cost/2)` を足し、フックの返事の文（game-api.js 429行「返金なし」）も合わせて直す。

### H3 通信ウィンドウが一番下までスクロールした状態で開く
- **場所**: `openModal` 646行の `card.querySelector("button")?.focus()`。`showComm` では最初のボタンが一番下の「了解」なので、フォーカスを移すときにカードが末尾までスクロールする。
- **何が起きるか**: 見出し「通信」、キービジュアルの上半分、最初の台詞が隠れた状態で開く。測った値（`modalCard.scrollTop`）は次のとおり。
  - 遊び方: 1366×768 で 167px、1280×720 で 215px、スマホ 390×844 で 173px
  - 異生体出現（休戦あり）: 1366×768 で 90px、1280×720 で 138px

  さらに、了解ボタンにフォーカス枠が出たまま開く。
- **再現（確認済み）**:
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/01-intro-laptop.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/01-intro-phone.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/53-xeno-comm-hd.png
- **直し方（コピーで確認済み。修正後の scrollTop は0）**:
  ```js
  function openModal(build){hideTip();const card=$("modalCard");card.className="card";card.replaceChildren();build(card);
    $("modal").hidden=false;card.scrollTop=0;card.querySelector("button")?.focus({preventScroll:true})}
  ```
  確認後の見た目: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-01-intro-laptop.png

---

## 中

### M1 ウィンドウ幅が1600pxをまたぐと、技術局・自軍艦隊一覧が消える／左列が空になる
- **場所**: resize の処理（1650〜1652行）は `isNarrow()` の変化しか見ていない。一方、`renderSide` 464行は `isWide3()` を見て、パネルを左列（#sideL）に置くかどうかを決めている。
- **何が起きるか**: 1920→1440 のように1600pxを下回ると、#sideL が `display:none` になる。技術局と自軍艦隊一覧はその中に入ったままなので、次に何かを操作するまで画面から消える。逆に1500→1700では、左に空の300px列ができる。最大化の解除や画面の半分へのスナップで普通に起きる。
- **再現（確認済み）**:
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/51-resize-1920to1440.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/52-resize-1500to1700.png
- **直し方（コピーで確認済み）**:
  ```js
  let lastNarrow=null;const layoutKey=()=>`${isNarrow()}|${isWide3()}`;
  window.addEventListener("resize",()=>{const n=layoutKey();if(n!==lastNarrow){lastNarrow=n;if(S)render();if(B)renderBattle()}});
  function start(data){lastNarrow=layoutKey(); /* 以下そのまま */
  ```

### M2 艦隊カードの「移動」が切り替わらない
- **場所**: `fleetCard` 529行。`S.selFleet=f.id` を先に代入してから `S.selFleet===f.id` を比べているので、比較は常に真になる。
- **何が起きるか**: 同じ星に艦隊が2つあり、第1艦隊が移動モードのときに第2艦隊の「移動」を押すと、第2艦隊の移動モードにならず、移動モードそのものが解除される（選択だけ第2艦隊に移る）。
- **再現（確認済み）**: 結果は `{"mode":null,"selFleet":"第2艦隊"}` だった。/tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/12-movebtn-bug-laptop.png
- **直し方（コピーで確認済み。修正後は mode="move"、第2艦隊）**:
  ```js
  onclick:()=>{const on=S.mode==="move"&&S.selFleet===f.id;S.selFleet=f.id;S.mode=on?null:"move";render()}
  ```

### M3 スマホの戦闘：操作バーが盤面の最下段に重なる／ボタンの文字が折れる
- **場所**: CSS 113行（`.bbar` sticky）、130〜133行（スマホでの `.bhead`・`.bbar`）。
- **何が起きるか**: 390×844 では、盤面の下端が733px、追従する操作バーの上端が725px になる。最下段は自軍の後列で、そこにいる艦のHPバーがバーの下に隠れる。ボタンは「敵の射\n程」「ターン\n終了」と2行に折れて高さがそろわない。タイトルも2行になり、そのぶん盤面が押し下げられる。
- **再現（確認済み）**: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/20-battle-sel-phone.png
- **直し方（コピーで確認済み。盤面の下端697px、バーの上端708px、ボタンは42pxで1行）**: `@media (max-width:700px)` の中に次を足す。
  ```css
  .bbar button{white-space:nowrap;padding-inline:6px}
  .bhead{flex-wrap:nowrap;flex-direction:column;gap:2px}
  .bhead h2{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  #bsvg{max-height:calc(100dvh - 230px)}  /* 念のため。viewBox の meet で左右に余白が出るだけ */
  ```
  確認後の見た目: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-05-battle-longtitle-phone.png

### M4 タブレット・背の低いノートPCで、艦隊パネルが画面外、ターン終了もスクロールで消える
- **場所**: CSS 35行（900px以下で1列）、117〜128行（並べ替えと下部バーは700px以下だけ）、175行（PC用の固定レイアウトは `min-height:620px` 以上だけ）。
- **何が起きるか**: 701〜900px（820×1180 など）と、幅1100px以上で高さ620px未満（1366×768のノートPCで、ブックマークバーやタスクバーがあると 1366×610 前後になる）は、どちらの専用レイアウトにも入らない。そのためパネルが 技術局→惑星→駐留艦隊 の順に並び、艦隊を操作するには毎回下までスクロールしなければならない。ターン終了ボタンはヘッダーにしかなく、スクロールすると見えなくなる。1366×610 では、キー操作の表示（`.kbd`・`.maphint`）も消える。キー自体は効く。
- **再現（確認済み）**:
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/02-map-tablet.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/30-map-lap610.png
- **直し方（コピーで確認済み）**: 並び順はメディアクエリの外（全サイズの既定）に出す。PC用の176行より前に置けば、PCの並び（185行）はこれまでどおり優先される。下部バーとヘッダーのターン終了ボタンの切り替えは900px以下に広げる。
  ```css
  .side .p-fleet{order:1}.side .p-planet{order:2}.side .p-all{order:3}.side .p-research{order:4}
  @media (max-width:900px){
    #btnEnd{display:none}
    .app{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))}
    .mbar{display:flex;position:fixed;/* …今の700px内の .mbar・.mb-info・.mb-fleet の指定をここへ移す */}
  }
  ```
  確認後の見た目:
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-07-map-tablet.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-07-map-lap610.png

  PC用レイアウトの閾値を `min-height:560px` に下げる案もある（未確認。星図がやや小さくなる）。

### M5 タッチで星を長押しすると即移動する
- **場所**: `renderMap` 433行（contextmenu → `onPlanetRight`）。
- **何が起きるか**: 右クリックで移動する操作を、ポインタの種類を区別せずに受け付けている。Android の Chrome は長押しで contextmenu を出すので、星をじっくり押して見ようとしただけで、選択中の艦隊がその星へ移動または攻撃してしまう。確認は出ない。
- **再現**: スマホ表示で contextmenu を合成して送ると、第1艦隊がアステリアからリュネへ移動し、行動済みになった（確認済み）。実機での長押しは未確認。
- **直し方**:
  ```js
  let lastPtr="mouse";document.addEventListener("pointerdown",e=>{lastPtr=e.pointerType},{capture:true,passive:true});
  g.addEventListener("contextmenu",e=>{e.preventDefault();hideTip();if(lastPtr!=="mouse")return;onPlanetRight(p.id)});
  ```

### M6 移動先の輪が、移動・戦闘・進入不可を区別しない
- **場所**: `renderMap` 401行（隣の星をすべて targets に入れる）、412行（同じ青い輪を描く）。
- **何が起きるか**: 敵艦隊がいる星、敵や中立の星（どちらも攻略戦）、自国の星への移動が、すべて同じ青い輪で表示される。PC はツールチップで行き先の内容が分かるが、スマホでは区別する手段がなく、タップした瞬間に戦闘が始まる。休戦中のヴァルガの星も輪が付く（401行）のに、押すと拒否される（630行）。こちらはコードで確認した。
- **再現（確認済み）**: クオン（敵2艦隊）とミラ（自国）が同じ見た目になる。/tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/09-crowd-move-phone.png
- **直し方（未確認）**:
  ```js
  // 401行: 休戦中に進めない星は除外
  neighbors(selF.node).forEach(n=>{if(!(S.truce&&(planet(n).owner==="E"||fleetsAt(n,"E").length)))targets.add(n)});
  // 412行: 戦闘になる星は赤
  const hostile=S.fleets.some(x=>x.node===p.id&&(x.side==="E"||x.side==="M"))||p.owner!=="P";
  if(targets.has(p.id))g.append(svgEl("circle",{cx:x,cy:y,r:r+9,fill:hostile?"#ea5a4f22":"#3aa0ff22",stroke:hostile?"#ea5a4f":"#3aa0ff","stroke-width":2.5}));
  ```
  スマホの案内文（441行）も「移動先をタップ（赤＝戦闘）」にする。

### M7 生ファイル／ローカル版に doctype・charset・viewport が無い（条件付き）
- **場所**: 1〜2行。build_local.py もこれらを足していない。
- **何が起きるか**: file:// で直接開いたときやローカル版では `document.compatMode` が `BackCompat`（quirks モード）になる。スマホではレイアウト幅が980pxになり、PC表示を縮小した見た目で、文字も星図も非常に小さい。claude.ai での配信が骨組み（doctype・viewport）を付けているなら、そちらは問題ない。PCでは標準モードとの見た目の差は見つからなかった。
- **再現（確認済み）**: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/56-raw-noviewport-phone.png
- **直し方**: build_local.py の HTML 差し替えに次を足す。ゲーム本体の先頭に入れてもよく、同じ内容の meta が重複しても害はない。
  ```python
  html = '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + html
  ```

---

## 低

### L1 スマホで艦隊カードの「移動」を押しても、星図が画面外のまま
- 艦隊カードは星図の下にある。押すと移動モードにはなるが、星図の大半（案内文「移動先をタップ」も含む）は画面の上に外れたまま。実測では、星図が画面に見えているのは下の151pxだけだった（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/50-phone-cardmove-viewport.png
- 直し方: 529行と451行の onclick の最後、`render()` の後に次を足す。
  ```js
  if(isNarrow()&&S.mode==="move")$("map").scrollIntoView({block:"nearest",behavior:"smooth"})
  ```

### L2 スマホの星図：巣の艦隊マーカーが左端で切れる／「移動先をタップ」が巣に重なる
- `markerPos` 392行は、マーカーを常に星の左へ並べる。スマホでは巣が左上（x=70）にあるので、異生体の群れ3つ目の丸が星図の外にはみ出す。441行の案内文（16,30）は、巣の絵とマーカーの上に重なる（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/08-crowd-phone.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/09-crowd-move-phone.png
- 直し方（コピーで確認済み）:
  ```js
  function markerPos(p,i,n){const{x,y}=mpos(p),r=p.id===HIVE?26:10+planetIncome(p)/6;n=Math.max(n||1,i+1);
    return x-r-14-(n-1)*15<10?[x+r+14+i*15,y-r-2]:[x-r-14-i*15,y-r-2]}
  // 425行: const mk=S.fleets.filter(f=>f.node===p.id&&!ANIM.hide.has(f.id));mk.forEach((f,i)=>{ … markerPos(p,i,mk.length) …
  // 441行: svgEl("text",{x:16,y:narrow?706:30, …})  // スマホでは下端に
  ```
  `animateFleetMove`（1578行）にも、その星にいる艦隊の数を n として渡す。
  - 確認後の見た目: /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-06-hive-markers-phone.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/fix-02-crowd-move-phone.png

### L3 敵の行動中の表示
- 星図での敵ターン中、指令パネルやスマホの「移動」ボタンは押せそうな見た目のままだが、押しても何も起きない（145行の `pointer-events:none` だけで、見た目の変化がない）。
- 「クリックで早送り」（241行、1251行）は、スマホでも「クリック」と表示される。
- この表示は、スマホでは艦隊カードの「待機中」に重なり、戦闘中は操作バーの枠に重なる。戦闘中は操作バーにも同じ文言があるので二重表示になる。
- 戦闘の敵フェイズ中に「敵の射程」を押すと、早送りも同時にかかる（1622行）。
- 確認済み:
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/14-endturn-phone-1300.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/14-endturn-laptop-1300.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/32-battle-enemyphase-phone.png
- 直し方:
  ```css
  body.anim .side,body.anim .mbar button{opacity:.55;filter:saturate(.5)}
  #battle:not([hidden]) ~ #ffwd{display:none!important}
  ```
  文言は `const TAP=matchMedia("(pointer:coarse)").matches?"タップ":"クリック"` を用意して、`${TAP}で早送り` にする。

### L4 モーダルを開いたまま Tab で背面へ移れ、背面の「ターン終了」を Enter で押せる
- 陣形ウィンドウを開いたまま Tab を10回押すとヘッダーの #btnEnd にフォーカスが移り、Enter でターンが進んだ（ターン1→2、モーダルは開いたまま。確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/57-enter-behind-modal-laptop.png
- 直し方: `$("modal").hidden` を直接書き換える箇所が本体にもフックにもあるので、属性を監視して背面を inert にする。
  ```js
  new MutationObserver(()=>{const open=!$("modal").hidden;for(const el of[document.querySelector(".app"),$("mbar"),$("battle")])el.inert=open})
    .observe($("modal"),{attributes:true,attributeFilter:["hidden"]});
  ```

### L5 ボタンを押すとフォーカスが body に戻る（キーボード操作）
- `render()` が指令パネルを毎回作り直すので、Tab で「投資 30」に合わせて Enter を押すと、フォーカスが BODY に戻る（確認済み）。次に押すには、また先頭から Tab し直しになる。
- 直し方: ボタンに固定の `data-k`（例: `invest30`、`fleet-${f.id}-move`）を付ける。`render()` の前に `const k=document.activeElement?.dataset?.k` を覚えておき、後で `if(k)document.querySelector(`[data-k="${k}"]`)?.focus()` で戻す。

### L6 PCの指令パネル：星を切り替えてもスクロール位置が残る
- パネルを下までスクロールしたまま別の星を選ぶと、新しい星の「駐留艦隊」の見出しが上に隠れた状態で表示される（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/09-hive-laptop.png
- 直し方（未確認）: `renderSide` の最初で、選んだ星が変わったときだけ位置を戻す。
  ```js
  if(renderSide.last!==S.sel){side.scrollTop=0;sideL.scrollTop=0;renderSide.last=S.sel}
  ```

### L7 body の既定 margin（8px）が残っている
- 16〜18行に `margin:0` が無い。PC用の固定レイアウトで上の余白が18px、下が2pxと非対称になり、文書の高さも 776 > 768 になる（はみ出した8pxは overflow:hidden で切れる）。確認済み。
- 直し方（コピーで確認済み）: `body{margin:0}`

### L8 文言のゆれ・誤り
- 「タップ」と「クリック」が端末に関係なく混在している。PCで「自軍の艦をタップ」（1251行、1267行）、遊び方の「敵をタップ」（736行）、スマホで「クリックで早送り」。→ L3 の `TAP` を使う。
- 遊び方の「右の指令パネルから」（734行）は、スマホとタブレットでは星図の下にある。→「指令パネル（スマホでは星図の下）から」にする。
- 遊び方にPCの操作説明（右クリックで移動、M／F／1〜3／E、戦闘のW／R、右クリックで選択解除）が無く、星図下の12pxの小さなヒントだけになっている。→ PC（`pointer:fine`）のときだけ1行足す。
- 巣の突入戦の説明が「中枢を落とせば占領」（914行）。巣は占領ではなく勝利なので、`isHive?"巣の中枢★を爆装で破壊すれば勝利。":…` にする。
- 戦闘の「ターン終了」（1255行）は、自軍フェイズを終えるボタン。星図の「ターン終了」と同じ名前と同じEキーなので、「フェイズ終了」のほうが誤解がない。
- 細かいところ: ログの「ターン2開始」とバナーの「ターン 2」で空白の有無が違う。

### L9 巣を選ぶと指令パネルに「特性 なし／収入 0／防衛力 0/0」と出る
- ツールチップ（604行）では巣を除外しているが、`renderSide` 480〜484行は除外していない（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/09-hive-laptop.png
- 直し方: `p.id===HIVE` のときは kv の代わりに「巣の中枢：耐久150・爆装でのみ破壊。破壊すれば勝利。」を表示する。

### L10 造船所の「旧艦と置換」が、どの艦を置き換えるか書いていない
- 707〜709行。置き換えられるのは最も古い艦級の1隻で、旗艦のこともある。改装した配分もリセットされるが、ボタンには「旧艦と置換（実費 53）」としか出ない。スマホでは「（実費\n53）」と2行に折れる（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/06-yard-t3-laptop.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/06-yard-t3-phone.png
- 直し方:
  ```js
  `${worst===0?"★":""}${CLASSES[f.ships[worst].cls].name}と置換（${cc-refund}）`
  ```
  あわせて `title:"改装の配分は初期値に戻ります"` を付ける。

### L11 改装は変更が即時に反映され、「元に戻す」が無い
- 648〜677行。試しに振り直すと元の配分に戻せない。ポイントを余らせて閉じても警告は出ない。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/05-refit-t3-laptop.png
- 直し方: 開いたときに `const snap=f.ships.map(s=>({...s.a}))` を取っておき、「元に戻す」ボタンで `f.ships.forEach((s,i)=>s.a={...snap[i]});draw()` を実行する。「残り」が0でないときは `.stat` を `color:var(--ally)` にして目立たせる。

### L12 状態や押せない理由が分かりにくい細部
- 無傷の艦隊でも「修理 0」が押せない状態で出る（532行）。→ 損傷が無いときは「修理（損傷なし）」と表示する。
- 理由を出さずに押せない／出てこないボタンがある。防衛修復（満タン）、追加建造（4隻で満杯）、新艦隊の編成（3艦隊で非表示）。→ `title` を付けるか、横に小さな注記を出す。
- 戦闘で行動済みの艦を押しても何も起きず、操作バーは「自軍の艦をタップ」のまま（1020行、確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/58-click-acted-unit-laptop.png

  → onCell で `tgt.side==="P"&&tgt.acted` のときに `B.note="この艦は行動済み"` を入れ、操作バーに出す。
- 戦闘のキー1〜4に対応する番号が盤面に出ていないので、どの艦が何番か分からない。→ PC（`pointer:fine`）のときだけ、自軍艦の右下に小さく番号を描く。

### L13 スマホの星図の記号が小さい
- 390幅では viewBox 540 を 358px に縮めて描く（約0.66倍）。そのため、特性の一文字（工・鉱・要・遺）は約7px、施設スロットの四角は約4px、艦隊マーカーは約9pxになる。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/02-map-phone.png
- 直し方: `narrow` のときは、421行の font-size を 11→16、420行の rect を 6→9（間隔 8→11）、428行の三角形を1.4倍にする。

### L14 タッチのボタンの高さが42px
- 116行の `min-height:42px` は、目安の44pxに少し足りない。改装の −/＋ は 40×38。→ `min-height:44px`、`.alloc button{height:44px;width:44px}` にする。

### L15 2560×1440 の戦闘画面が狭い
- `.battle-in{max-width:1880px}`（191行）が効いて、盤面が画面の約6割になり、下の1/3が空く。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/21-battle-hover-qhd.png
- 直し方: `@media (min-width:2200px){.battle-in{max-width:none}.bgrid{grid-template-columns:minmax(0,1fr) 380px}}`

### L16 勝敗の画面
- 結果のウィンドウは閉じられず（Escも効かない、1620行）、最後の星図を見られない。敗北の画面にはターン数などの記録が無い。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/45-defeat-phone.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/44-victory-laptop.png
- 直し方: 「盤面を見る」ボタン（`$("modal").hidden=true;render()`）を足し、ヘッダーに「もう一度遊ぶ」を出す。敗北の文にも「星暦◯年・◯ターン」を入れる。

### L17 スマホの移動モード中、「取消」と「ターン終了」が同じ黄色で隣り合う
- 451行で、移動モード中の取消ボタンが `primary` になる。ターン終了は確認なしなので、押し間違えるとターンが終わる（確認済み）。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/03-move-phone.png
- 直し方: 取消は青系の通常ボタン（`class:moving?"cancel":""`、`.mbar .cancel{border-color:var(--move-line);color:#9fd4ff}`）にし、`#mbEnd{margin-left:12px}` で離す。

---

## 返事待ちの案の根拠（今回の観察から）

- **ターン終了の確認**: スマホでは、取消と同じ黄色のボタンが隣にある（L17）。PCはEキー1つでターンが終わる。モーダルの背面からもEnterで押せてしまう（L4）。未行動の艦隊が残っているときだけ確認を出す形なら、邪魔にならない。
- **艦隊名ラベル**: 1つの星に4艦隊いると、マーカーは色と濃さの違う三角が並ぶだけで、どれがどの艦隊か分からない。PCはツールチップで補えるが、スマホでは手段が無い。
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/08-crowd-laptop.png
  - /tmp/claude-0/-home-user-frontierPJ/00c9b965-31a0-5f90-ad0c-904132688cff/scratchpad/agents/ui/shots/08-crowd-phone.png
- **ズーム**: スマホの星図の記号が7px前後しかない（L13）。ただし L13 の拡大だけでもかなり改善する。
- **ドラッグ移動（戦闘）**: タッチではホバーによる移動先の確認（残像と予想ダメージ）が無く、青いマスをタップした瞬間に移動が確定する。誤タップの取り消しもできない。「1回目のタップで移動先を確定表示、2回目で実行」でも代わりになる。

## 未確認・参考

- M5 の実機での長押し（Android Chrome と iOS Safari）。iOS は長押しで contextmenu を出さないことが多い。
- `#map` に `touch-action:manipulation` が無いので、iOS で星をすばやく2回タップすると拡大されるおそれがある（未確認）。
- ローカル版を Windows の Chrome で file:// 直開きしたときに文字化けするか（charset meta が無いため、自動判定に依存）は未確認。
- 色のコントラストは概ね十分。dim文字はdeck背景に対して 6.1:1、中立色は 4.3:1 でぎりぎり、押せないボタン（opacity .4）は読みにくい程度。直す必要があるほどではない。
