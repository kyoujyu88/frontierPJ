/* 辺境星系戦記 外部操作フック（window.gameAPI）
 *
 * frontier-war.html の本体スクリプトの「後」に、同じページへ通常の <script> として読み込む。
 * 本体のトップレベル宣言（S, B, CLASSES, orderMove など）をそのまま参照するので、
 * 本体側の書き換えは不要。MCPサーバー（server.mjs）は Playwright でこのファイルを注入する。
 * ゲームに直接組み込む場合は、本体 <script> の直後に <script src="game-api.js"></script> を置くだけでよい。
 *
 * 方針：
 *  - 行動は画面のボタンと同じ条件で検証し、同じ関数を呼ぶ（ルールを二重実装しない）。
 *  - 配信向けに、行動の前に対象を選択表示して少し間を置く（pace）。
 *  - 戦闘アニメと敵フェイズが終わるまで待ってから結果を返す（settle）。
 *  - オート戦闘（setAutoBattle(true)、MCPサーバーの既定）では、戦闘は本体のオートで決着させ、
 *    結果を見せてから作戦卓へ戻したうえで返す。戦闘の結果は events と battles に入る。
 */
(function(){
"use strict";
if(window.gameAPI)return;

/* ---------- イベント記録（log / bmsg を包む） ---------- */
const events=[];let seq=0;
function push(kind,text){events.push({seq:++seq,kind,text});if(events.length>400)events.shift()}
const origLog=window.log,origBmsg=window.bmsg;
window.log=function(m){push("log",m);return origLog(m)};
window.bmsg=function(m){if(!(autoBattle&&B&&B.auto))push("battle",m);return origBmsg(m)}; // オート戦闘の1発ごとの記録は省き、結果だけ残す
function since(n){return events.filter(e=>e.seq>n).map(e=>e.kind==="battle"?`［戦闘］${e.text}`:e.text)}

/* ---------- 共通 ---------- */
const DIR_NAME=["右","下","左","上"];
const FAC_KEYS=Object.keys(FAC);
const STAT_KEYS=STATS.map(s=>s[0]);
/* このファイルの待ち（配信の間・通信や結果を見せる時間）と字幕・行動表示の時間は、演出の倍速（setSpeed）の影響を受けない元の setTimeout で数える */
const realTimeout=window.setTimeout.bind(window);
const sleep=ms=>new Promise(r=>realTimeout(r,ms));
let pace=700;          // 配信用の「間」(ms)。0で即時
let turnTask=null;     // 実行中の endTurn() の Promise
let autoBattle=false;  // 戦術戦闘をオートで片付ける（MCPサーバーの既定。--manual-battle で手動）
const autoResults=[];  // オートで片付けた戦闘の結果

/* ---------- 演出の倍速（setSpeed） ----------
 * 戦闘・ターン処理（敵の移動）・艦隊の移動の演出だけを speed 倍の速さで流す。ゲームの中身（乱数・オートの判断・結果）は変わらず、待ち時間だけが縮む。
 * 本体の演出は wait()（setTimeout）・tween()（requestAnimationFrame）・banner()（帯の CSS アニメ）で時間を数えるので、
 * 倍速の場面のあいだだけ、wait・banner のタイマーと tween・帯の長さを 1/speed にする。作戦卓の操作や通信の表示は今までどおり */
let speed=1,moving=false;
const sped=()=>speed>1&&!window.FAST&&(!!B||!!turnTask||moving);
/* 縮めるのは本体の wait() と banner() から来たタイマーだけ（wait は const なので差し替えられず、呼び出し元で見分ける）。
 * 効果音・終わりの画面・録画などほかのタイマーは、倍速の場面でも元の長さのまま */
const fromAnim=()=>/\bat (?:wait|banner) \(/.test(new Error().stack||"");
window.setTimeout=function(fn,ms,...a){return realTimeout(fn,sped()&&fromAnim()?Math.max(0,Number(ms)||0)/speed:ms,...a)};
if(typeof tween==="function"){
  const orig=tween;
  // 本体の tween と同じ動き（進み具合は requestAnimationFrame の時刻で数え、画面が隠れていても止まらないよう時間切れでも終える）を、長さ 1/speed で
  window.tween=function(ms,frame){
    if(!sped())return orig(ms,frame);
    if(reduceMotion||ANIM.fast){frame(1);return Promise.resolve()}
    const d=Math.max(1,ms/speed);
    return new Promise(res=>{const t0=performance.now();let done=false;
      const fin=()=>{if(done)return;done=true;frame(1);res()};
      const tick=t=>{if(done)return;const k=Math.min(1,(t-t0)/d);if(k>=1||ANIM.fast)return fin();frame(k);requestAnimationFrame(tick)};
      requestAnimationFrame(tick);realTimeout(fin,d+300);
    });
  };
}
if(typeof banner==="function"){
  const orig=banner;
  // 帯を消すタイマーは上の setTimeout で縮むので、帯の CSS アニメの長さ（--bn-ms）も同じだけ縮める
  window.banner=function(main,sub,side,ms){
    const on=sped(),p=orig(main,sub,side,ms);
    if(on){const m=Math.min(ms||1100,ANIM.fast?350:Infinity),inn=$("banner")?.firstElementChild;if(inn)inn.style.setProperty("--bn-ms",`${m/speed}ms`)}
    return p;
  };
}

class GameError extends Error{}
const fail=m=>{throw new GameError(m)};
const dialogOpen=()=>!$("modal").hidden;
// 艦隊の損傷と修理費（修理費の式はゲーム本体の repair() と同じ。状況テキスト・のこりの手・修理の3か所でここを使う）
const fleetDamage=f=>f.ships.reduce((s,x)=>s+(x.maxHp-x.hp),0);
const repairCost=f=>Math.ceil(fleetDamage(f)/2);
/* 引数は寛容に読む：小さなモデルは「第2艦隊」の 2 をIDに書いたり、数字を文字列で渡したり、星や施設を名前で書いたりする。
 * 読み替えたときは actNotes に書いて返り値の message に付ける。断るときは、いま選べるものを一緒に返す */
let actNotes=[];
const note=m=>{actNotes.push(m)};
const myFleets=()=>S.fleets.filter(f=>f.side==="P");
const fleetList=()=>myFleets().map(f=>`${f.name}=ID${f.id}`).join("、")||"なし";
const blank=v=>v==null||v==="";
const FLEET_NAME=/第\s*(\d+)\s*艦隊/;
// 名前で書かれた自軍艦隊（「第2艦隊」）。名前の番号とIDは別物なので（全滅・再編成でずれる）、名前の番号をIDとしては読まない
const fleetNamed=s=>{const o=(s.match(FLEET_NAME)||[])[1];return myFleets().find(x=>x.name===s)||(o?myFleets().find(x=>x.name===`第${Number(o)}艦隊`):null)||null};
const noFleetNamed=s=>`${s} という自軍艦隊はいません。自軍艦隊：${fleetList()}`;
function myFleet(id){
  if(blank(id))fail(`fleet_id（艦隊ID）を指定してください。自軍艦隊：${fleetList()}`);
  const mine=myFleets(),s=String(id).trim(),n=Number(s);
  // 数字でないもの（艦隊の名前）は、名前で探す。数字だけのときはID
  if(!/^-?\d+$/.test(s)){const g=fleetNamed(s);if(g)return g;fail(noFleetNamed(s))}
  let f=mine.find(x=>x.id===n);
  if(!f){
    // 「第2艦隊」の 2 をIDに書いたもの（そのIDの自軍艦隊がいないときだけ、名前の番号として読む）
    f=mine.find(x=>x.name===`第${n}艦隊`);
    if(f)note(`艦隊ID ${id} は ${f.name}（ID ${f.id}）と読み替えました`);
  }
  if(!f){
    const other=S.fleets.find(x=>x.id===n);
    fail(`${other?`${other.name} は自軍艦隊ではありません`:`艦隊ID ${id} は存在しません`}。自軍艦隊：${fleetList()}`);
  }
  return f;
}
const planetNamed=s=>S.planets.find(q=>q.name===s||q.name===s.replace(/^\d+\s*/,""))||null; // 「リュネ」「1リュネ」
function planetById(id){
  if(blank(id))fail("惑星ID を指定してください（状況テキストの「■惑星」の行の先頭の数字）");
  const s=String(id).trim();
  const p=/^\d+$/.test(s)?S.planets[Number(s)]:planetNamed(s);
  if(!p)fail(`惑星ID ${id} は存在しません（0〜${S.planets.length-1}）`);
  return p;
}
const ownList=()=>S.planets.filter(p=>p.owner==="P").map(p=>`${p.id}${p.name}`).join("・")||"なし";
const myPlanet=id=>{const p=planetById(id);if(p.owner!=="P")fail(`${p.name} は自国の星ではありません。自国の星：${ownList()}`);return p};
const needFunds=(v,what)=>{if(S.funds<v)fail(`資金不足：${what}には ${v} 必要（現在 ${S.funds}）`)};
const facKey=k=>FAC[k]?k:FAC_KEYS.find(x=>FAC[x].name===String(k??"").trim())||fail(`施設は ${FAC_KEYS.map(x=>`${x}=${FAC[x].name}`).join("・")} のいずれかです`);
const shortKind=k=>k.replace(/（.*$/s,"");

function ensureMap(){
  if(!S)fail("ゲームが始まっていません");
  if(S.over)fail(S.over==="win"?"ゲームはクリア済みです。new_game で再開できます":"ゲームオーバーです。new_game で再開できます");
  if(dialogOpen())fail("通信ウィンドウを閉じられませんでした。dismiss_dialog を呼んでください");
  if(B)fail("戦術戦闘中です。battle_* の操作で戦闘を進めてください");
}
/* 通信ウィンドウは、次の操作が来たときに自動で閉じる（開いたまま操作して断られる・閉じるだけの往復、をなくす）。
 * 内容は、開いたときの返り値（dialog）か、ここで閉じたときの返り値（dialogs）のどちらかで必ず伝える。
 * 配信で読めるよう、出てから少しの間（文字数に応じて最大5秒）は閉じない */
let closedDialogs=[],dialogSeen={text:null,at:0};
function pressDialog(){
  // 押すのは下の行のボタン（了解・完了・閉じる）。「やり直す」など danger のボタンや、建設・陣形の選択肢は押さない
  const foot=[...$("modalCard").querySelectorAll(":scope > .row")].pop(),btns=foot?[...foot.querySelectorAll("button")]:[];
  const btn=btns.find(b=>b.classList.contains("primary"))||btns.find(b=>!b.classList.contains("danger"));
  if(btn)btn.click();else closeModal();
}
// 閉じたあとは記録を消す（同じ本文の通信がもう一度出たときも、新しい通信として伝え、表示の間も取り直す）
const forgetDialog=()=>{if(!dialogOpen())dialogSeen={text:null,at:0}};
function seeDialog(told){
  const t=dialogText().text;
  if(t!==dialogSeen.text)dialogSeen={text:t,at:Date.now(),told:false};
  if(told)dialogSeen.told=true;
  return t;
}
async function clearDialogs(){
  for(let i=0;i<8&&dialogOpen()&&!(S&&S.over);i++){
    const t=seeDialog(false);
    if(!dialogSeen.told){closedDialogs.push(t);dialogSeen.told=true}
    const wait=dialogSeen.at+(pace?Math.min(5000,1200+t.length*25):0)-Date.now();
    if(wait>0)await sleep(wait);
    pressDialog();await sleep(pace?120:0);forgetDialog();
  }
}
function ensureBattle(needTurn=true){
  if(dialogOpen())fail("通信ウィンドウを閉じられませんでした。dismiss_dialog を呼んでください");
  if(!B)fail("戦闘中ではありません");
  if(needTurn){
    if(B.ended)fail("戦闘は終わっています。battle_close で作戦卓へ戻ってください");
    if(B.phase!=="P"||B.busy)fail("敵が行動中です");
  }
}
function focusPlanet(id,fleetId){S.sel=id;if(fleetId!=null)S.selFleet=fleetId;S.mode=null;render()}

/* 待機：アニメ・敵フェイズ・ターン処理が一段落するまで。オート戦闘は決着して作戦卓に戻るまで待つ */
async function settle(timeout=120000){
  let t0=Date.now();
  await sleep(60);
  for(;;){
    if(B&&autoBattle&&B.auto){
      if(B.ended){await closeAutoBattle();t0=Date.now();continue}
      if(Date.now()-t0>900000)return; // オート戦闘が15分で終わらないときは、いったん返す
    }else{
      if(B){if(B.ended||(B.phase==="P"&&!B.busy))return}
      else if(!turnTask)return;
      if(Date.now()-t0>timeout)return;
    }
    await sleep(50);
  }
}
/* オート戦闘の決着：結果を記録し、結果の画面を少し見せてから作戦卓へ戻る */
async function closeAutoBattle(){
  const{title,result,units,round}=B;
  const mine=units.filter(u=>u.side==="P"),foes=units.filter(u=>u.side==="E");
  const lost=mine.filter(u=>u.hp<=0).length,downed=foes.filter(u=>u.hp<=0).length;
  const res=resultLabel(result);
  const text=`戦闘「${title}」：${res}（${round}ラウンド・自軍の損失${lost}/${mine.length}隻・敵の撃破${downed}/${foes.length}）`;
  push("log",text);autoResults.push({seq,title,result:res,rounds:round,lost,ships:mine.length,downed,foes:foes.length});
  if(autoResults.length>50)autoResults.shift();
  showAction(`${title}：${res}`);
  await sleep(Math.max(pace,window.FAST?0:600)/(speed>1?speed:1)); // 結果を見せる間も演出の倍速に合わせる
  if(B&&B.ended)closeBattle();
  await sleep(80);
}
/* 行動の実行ラッパー：成否・新しいログ・状況の要約を返す */
async function act(name,fn){
  const n=seq;
  actNotes=[];closedDialogs=[];
  try{
    if(B&&autoBattle)await settle(); // 前の呼び出しで終わりきらなかったオート戦闘を片付けてから
    if(name!=="dismiss"&&name!=="new"&&dialogOpen())await clearDialogs(); // 開いたままの通信は閉じてから操作する
    const message=await fn();
    await settle();await sleep(80);
    return result(true,[message,...actNotes].filter(Boolean).join("。"),n);
  }catch(e){
    if(e instanceof GameError)return result(false,e.message,n);
    throw e;
  }
}
function result(ok,message,n){
  const r={ok,message:message||(ok?"完了":""),events:since(n),funds:S?S.funds:null,turn:S?S.turn:null,mode:B?(B.ended?"battle_ended":"battle"):(S&&S.over?"over":"map")};
  const bs=autoResults.filter(b=>b.seq>n).map(({seq,...b})=>b);if(bs.length)r.battles=bs;
  if(closedDialogs.length)r.dialogs=closedDialogs.splice(0); // この操作の前に自動で閉じた通信（まだ知らせていなかったもの）
  if(dialogOpen()){r.dialog=dialogText();r.dialog.note="次の操作で自動的に閉じます（dismiss_dialog は不要）";seeDialog(true)}
  else forgetDialog(); // dismiss_dialog や画面の操作で閉じられたときも、記録を消す
  if(B)r.battle=battleState();
  // 戦闘のあとは、艦隊の残りの耐久も一緒に知らせる（状況テキストは付け直さない）
  const nx=nextHint();if(nx)r.next=bs.length?`${nx}\n自軍艦隊：${myFleets().map(f=>`${f.name} ID${f.id}@${f.node}${planet(f.node).name} ${f.ships.length}隻・耐久${f.ships.reduce((t,x)=>t+Math.ceil(x.hp),0)}/${f.ships.reduce((t,x)=>t+x.maxHp,0)}・${f.moved?"行動済":"未行動"}`).join("／")||"なし（全滅。造船所のある星で new_fleet）"}`:nx;
  return r;
}

/* ---------- 状態の読み出し ---------- */
function dialogText(){
  const card=$("modalCard");
  return{text:card.innerText.trim().replace(/\n{2,}/g,"\n"),buttons:[...card.querySelectorAll("button")].map(b=>b.textContent)};
}
function shipInfo(s,i){
  if(s.xeno)return{index:i,flagship:i===0,name:(s.xeno==="brood"?"ゾア・ブルード":"ゾア・ドローン")+(s.neo?"改":""),hp:s.hp,maxHp:s.maxHp};
  const c=CLASSES[s.cls],used=STAT_KEYS.reduce((a,k)=>a+s.a[k],0);
  return{index:i,flagship:i===0,class:s.cls,name:c.name,type:c.type,hp:s.hp,maxHp:s.maxHp,
    alloc:{...s.a},points:{used,max:c.pts},stats:shipStats(s)};
}
/* 相手ごとの陣形の目安（オート戦闘で相手5種＋異生体×陣形5種を試した勝率から） */
const FORM_HINT={line:["rear","crane"],assault:["square","rear"],missile:["rear","square"],heavy:["rear","line"],raid:["line","square"],xeno:["line"]};
function foeKey(ef){return ef.side==="M"?"xeno":(ef.doc&&FORM_HINT[ef.doc]?ef.doc:"line")}
function formHint(pf,ef){
  if(typeof FORM==="undefined")return"";
  const ks=FORM_HINT[foeKey(ef)],cur=formKey(pf);
  return`陣形の目安：${ks.map(k=>`${k}=${FORM[k].name}`).join("か")}${ks.includes(cur)?"（今の陣形でよい）":`（今は${FORM[cur].name}。set_formation で変えられる）`}`;
}
/* 相手の艦隊の短い紹介：ドクトリンか異生体の弱点・戦力の比べ */
/* 戦力の比べ：こちらが相手の1.3倍以上なら有利、0.9倍未満なら不利（2026-11-16 のプレイログでは、こちらが1.3倍未満の艦隊戦8回のうち4回負けた） */
function odds(pf,ef){const a=fleetPower(pf),b=fleetPower(ef);return a>=b*1.3?"有利":a>=b*.9?"互角":"不利＝見送るか戦力を足してから"}
function foeNote(pf,ef){
  const tag=ef.side==="M"?`異生体${S.evolved?"・進化後は正面が弱点":"・側面が弱点"}`:typeof docOf==="function"?docOf(ef).tag:"";
  return`${ef.name}〈${tag}〉・${ef.ships.length}隻・戦力${Math.round(fleetPower(ef))} 対 こちら${Math.round(fleetPower(pf))}（${odds(pf,ef)}）・${formHint(pf,ef)}`;
}
function moveOptions(f){
  if(f.moved)return[];
  const adj=neighbors(f.node),out=[];
  for(const p of S.planets){
    if(p.id===f.node){
      // 艦隊戦に勝って敵・中立の星に残ったときは、その星にいるまま攻略できる（to に今の星を指定）
      const k=typeof assaultHere==="function"&&assaultHere(f);
      if(k)out.push({to:p.id,name:p.name,kind:k==="巣への突入戦"?"深淵の巣への突入戦（いまいる星）":`惑星攻略戦（いまいる星・${OWNER_LABEL[p.owner]}・防衛力${p.def}）`});
      continue;
    }
    const isAdj=adj.includes(p.id),warp=!isAdj&&p.owner==="P";
    if(!isAdj&&!warp)continue;
    if(p.id===HIVE&&!S.monster)continue;
    let kind;
    const foes=S.fleets.filter(x=>x.node===p.id&&(x.side==="E"||x.side==="M"));
    if(S.truce&&(p.owner==="E"||fleetsAt(p.id,"E").length))kind="不可（ヴァルガとは休戦中）";
    else if(foes.length)kind=`艦隊戦（${foeNote(f,foes[0])}）`;
    else if(p.owner==="H")kind="深淵の巣への突入戦";
    else if(p.owner!=="P")kind=`惑星攻略戦（${OWNER_LABEL[p.owner]}・防衛力${p.def}）`;
    else kind=warp?"亜空間移動":"移動";
    out.push({to:p.id,name:p.name,kind});
  }
  if(typeof bombNote==="function")out.forEach(o=>{if(/攻略|突入/.test(o.kind))o.kind+=bombNote(f,planet(o.to))});
  else if(typeof hasBomb==="function"&&!hasBomb(f))out.forEach(o=>{if(/攻略|突入/.test(o.kind))o.kind+="（爆装なし：中枢を壊せない）"});
  return out;
}
function fleetInfo(f){
  const o={id:f.id,name:f.name,side:f.side,sideLabel:f.side==="P"?"自軍":f.side==="E"?"ヴァルガ帝国":"異生体",at:f.node,atName:planet(f.node).name,
    power:Math.round(fleetPower(f)),ships:f.ships.map(shipInfo)};
  if(f.side==="E"&&typeof docOf==="function"){const d=docOf(f);o.doctrine=`${d.name}：${d.tip}`}
  if(f.side==="P"){
    if(typeof formOf==="function"){const fm=formOf(f);o.formation=formKey(f);o.formationNote=`${fm.name}：${fm.tip}`}
    const p=planet(f.node),dmg=fleetDamage(f);
    o.moved=!!f.moved;o.moveOptions=moveOptions(f);
    o.canIntercept=!f.moved&&!!intruder(f);
    if(o.canIntercept)o.interceptNote=foeNote(f,intruder(f));
    o.repairCost=p.owner==="P"&&dmg?repairCost(f):null;
    o.atShipyard=p.owner==="P"&&!!p.yard;
  }
  return o;
}
function planetInfo(p){
  const o={id:p.id,name:p.name,owner:p.owner,ownerLabel:OWNER_LABEL[p.owner],trait:p.trait,income:planetIncome(p),def:p.def,maxDef:p.maxDef,
    slots:p.slots,facilities:p.fac.map(k=>({key:k,name:FAC[k].name})),neighbors:neighbors(p.id),fleets:S.fleets.filter(f=>f.node===p.id).map(f=>f.id)};
  if(p.owner==="P")o.surveyLeft=p.survey;
  return o;
}
function researchInfo(){
  const next=S.tier+1,open=researchOpen();
  return{currentClass:CLASSES[S.tier].name,tier:S.tier,
    next:open?{class:next,name:CLASSES[next].name,type:CLASSES[next].type,progress:S.research,need:CLASSES[next].research}:null,
    note:open?null:(next===4&&!S.monster?"現行技術の上限。異生体出現後にセラフ級の研究が解禁される":"全艦級開発済み"),
    labPerTurn:open?labRate():0,refitCap:capOf("P")};
}
function getState(){
  if(!S)return{started:false};
  const st={
    turn:S.turn,year:3989+S.turn,funds:S.funds,incomePerTurn:income(),
    research:researchInfo(),
    situation:{xenoAppeared:S.monster,xenoEvolved:S.evolved,truceWithVarga:S.truce,xenoKills:S.xenoKills,enemyTier:CLASSES[S.enemyTier].name},
    over:S.over||null,
    mode:B?(B.ended?"battle_ended":"battle"):(S.over?"over":"map"),
    myFleets:S.fleets.filter(f=>f.side==="P").map(fleetInfo),
    otherFleets:S.fleets.filter(f=>f.side!=="P").map(fleetInfo),
    planets:S.planets.filter(p=>p.id!==HIVE||S.monster).map(planetInfo),
    recentLog:S.log.slice(0,10)
  };
  if(dialogOpen())st.dialog=dialogText();
  if(B)st.battle=battleState();
  return st;
}

/* ---------- 戦術戦闘の状態 ---------- */
function unitLabel(u){
  const live=B.units.filter(v=>v.side===u.side);const i=live.indexOf(u);
  return u.side==="P"?String.fromCharCode(65+i):String.fromCharCode(97+i);
}
function battleState(){
  const units=B.units.filter(u=>u.hp>0).map(u=>{
    const o={id:u.uid,label:unitLabel(u),side:u.side==="P"?"自軍":"敵",name:u.name,flagship:!!u.flag,hp:Math.ceil(u.hp),maxHp:u.maxHp,x:u.x,y:u.y,facing:DIR_NAME[u.dir],
      armor:u.armor,move:u.move,weapons:u.w.map(w=>({name:w.n,damage:w.d,range:w.min===w.max?`${w.min}`:`${w.min}-${w.max}`,coreOnly:!!w.core}))};
    if(u.core)o.kind=u.hive?"中枢（セラフ級の爆装でのみ破壊可）":"中枢（爆装でのみ破壊可）";else if(u.sat)o.kind="防衛衛星";else if(u.xeno)o.kind=u.neo?"異生体（改：正面が弱点）":"異生体（側面が弱点）";
    if(u.side==="P"){
      o.acted=!!u.acted;
      if(!u.acted&&B.phase==="P"&&!B.ended){
        o.moves=reach(u);
        o.attacks=B.units.filter(t=>t.side==="E"&&t.hp>0).map(t=>{const a=bestAttack(u,t);return a?{target:t.uid,targetName:t.name,weapon:a.w.n,damage:a.dmg,zone:a.zone||null}:null}).filter(Boolean);
      }
    }
    return o;
  });
  const grid=[];
  for(let y=0;y<BH;y++){let row="";for(let x=0;x<BW;x++){const u=unitAt(x,y);row+=u?unitLabel(u):(typeof isRock==="function"&&isRock(x,y))?"#":"."}grid.push(row)}
  return{title:B.title,tip:B.tip,formation:B.form&&typeof FORM!=="undefined"?`${FORM[B.form].name}：${FORM[B.form].tip}`:null,phase:B.ended?"終了":B.phase==="P"?"自軍フェイズ":"敵軍フェイズ",round:B.round,maxRound:typeof roundCap==="function"?roundCap():null,ended:!!B.ended,result:B.result||null,
    board:{width:BW,height:BH,note:"x=0..10（左→右）, y=0..6（上→下）。大文字=自軍, 小文字=敵, #=小惑星（通れない）",grid},
    units,messages:B.msg.slice(0,8)};
}


/* ---------- 小型モデル向けの文章サマリー ---------- */
function shipShort(x){
  if(x.alloc)return`${x.flagship?"★":""}${x.name}${x.hp}/${x.maxHp}[装${x.alloc.sh}砲${x.alloc.ca}ミ${x.alloc.mi}爆${x.alloc.bo}機${x.alloc.sp}]`;
  return`${x.flagship?"★":""}${x.name}${x.hp}/${x.maxHp}`;
}
function resultLabel(r){return(typeof RESULT_LABEL!=="undefined"&&RESULT_LABEL[r])||(r==="win"?"勝利":r==="retreat"?"撤退":"敗北")}
function battleSummary(){
  const b=battleState(),L=[];
  L.push(`【戦闘】${b.title}／${b.ended?b.phase:`ROUND ${b.round}${b.maxRound?`/${b.maxRound}`:""}・${b.phase}`}${b.ended?`（結果：${resultLabel(b.result)}。battle_close で戻る）`:""}`);
  L.push(`ヒント：${b.tip}`);
  if(b.formation)L.push(`自軍の陣形：${b.formation}`);
  L.push("盤面（x→0..10, y↓0..6。大文字=自軍, 小文字=敵, #=小惑星で通れない）");
  b.board.grid.forEach((r,y)=>L.push(`${y} ${r}`));
  for(const u of b.units){
    const w=u.weapons.map(w=>`${w.name}${w.damage}(射程${w.range})`).join(" ");
    L.push(`${u.label} ID${u.id} ${u.side}${u.flagship?"★":""} ${u.name}${u.kind?`〈${u.kind}〉`:""} 耐久${u.hp}/${u.maxHp} 位置(${u.x},${u.y}) 向き${u.facing} 装甲${u.armor} 移動${u.move} ${w}${u.acted?" 行動済":""}`);
    if(u.attacks)L.push(`   攻撃候補：${u.attacks.length?u.attacks.map(a=>`ID${a.target}${a.targetName}へ${a.weapon}${a.damage}${a.zone?`(${a.zone})`:""}`).join("、"):"なし（射程外）"}`);
    if(u.moves)L.push(`   移動先：${u.moves.map(([x,y])=>`(${x},${y})`).join(" ")}`);
  }
  if(b.messages.length)L.push("直近："+b.messages.slice(0,4).join("／"));
  return L.join("\n");
}
/* 内政の候補：艦隊の移動先と同じように「打てる手」を呼び出しの形で並べ、内政を考えに入れやすくする。
 * いまの資金で払えるものだけを並べ、払えないものは最後の1行にまとめる（払えない手を呼んで断られるのを防ぐ） */
const BEST={鉱物:"mine",遺跡:"lab",要塞:"sats",工業:"yard"};
const investCap=()=>typeof INVEST_CAP!=="undefined"?INVEST_CAP:120;
const investRoom=()=>typeof investLeft==="function"?investLeft():investCap();
const investMax=()=>Math.min(investRoom(),Math.floor(S.funds/30)*30); // いま投資できる最大（30刻み）
/* 置換する艦（いちばん旧式。同じ艦級なら随伴艦から。ゲームの造船所と同じ）と実費 */
function replaceOf(f,ci,yp){
  const worst=f.ships.reduce((m,s,i)=>s.cls<ci&&(m<0||s.cls<=f.ships[m].cls)?i:m,-1);
  return worst<0?null:{index:worst,refund:Math.floor(CLASSES[f.ships[worst].cls].cost/2),net:bcost(ci,yp)-Math.floor(CLASSES[f.ships[worst].cls].cost/2)};
}
function devSummary(st){
  const L=[],no=[],funds=S.funds;
  const add=(cost,line,name)=>{if(cost<=funds)L.push(line);else no.push(`${name}${cost}`)};
  const r=st.research;
  if(r.next){
    const m=investMax();
    if(investRoom()<30)L.push(` 研究：このターンの投資は上限（${investCap()}）まで済み。invest_research はもう呼ばない`);
    else if(m>=30)L.push(` 研究：invest_research(amount=${m>30?`30〜${m}`:"30"}) → あと${r.next.need-r.next.progress}で${r.next.name}完成（新しい艦級・改装上限+1。30刻み、投資は1ターン${investCap()}まで）`);
    else no.push("研究30");
  }else L.push(` 研究：いまは投資できない（${r.note}）。invest_research は呼ばない`);
  for(const p of S.planets.filter(p=>p.owner==="P")){
    const free=p.slots-p.fac.length;
    if(free>0){
      const ks=FAC_KEYS.filter(k=>!hasF(p,k)),ok=ks.filter(k=>FAC[k].cost<=funds),ng=ks.filter(k=>FAC[k].cost>funds);
      const show=k=>BEST[p.trait]===k?`◎${k}=${FAC[k].name}${FAC[k].cost}（${FAC[k].desc(p)}）`:`${k}=${FAC[k].name}${FAC[k].cost}`;
      // 特性に合う施設がもうあるときは、そう書く（鉱物惑星＝採掘所と思い込んで、建設済みの星に何ターンも建てようとしたことがあった）
      const has=BEST[p.trait]&&hasF(p,BEST[p.trait])?`・${FAC[BEST[p.trait]].name}は建設済み`:"";
      if(ok.length)L.push(` 施設：${p.name}（${p.trait}・空き${free}${has}）build_facility(planet_id=${p.id}, facility=…) ${ok.map(show).join("／")}${ng.length?`（資金不足：${ng.map(k=>`${k}${FAC[k].cost}`).join("・")}）`:""}`);
      else if(ks.length)no.push(`${p.name}の施設${Math.min(...ks.map(k=>FAC[k].cost))}〜`);
    }
    if(p.survey>0)add(40,` 探査：${p.name} survey(planet_id=${p.id}) 費用40 → 45%で収入+15（残り${p.survey}回）`,`${p.name}の探査`);
    if(p.def<p.maxDef)add(30,` 防衛修復：${p.name} 防衛${p.def}/${p.maxDef} fortify(planet_id=${p.id}) 費用30で+15`,`${p.name}の防衛修復`);
  }
  for(const f of st.myFleets){
    if(f.repairCost)add(f.repairCost,` 修理：${f.name} repair_fleet(fleet_id=${f.id}) 費用${f.repairCost}`,`${f.name}の修理`);
    if(f.atShipyard){
      const yp=planet(f.at),cc=bcost(S.tier,yp),rp=replaceOf(S.fleets.find(x=>x.id===f.id),S.tier,yp);
      if(f.ships.length<4)add(cc,` 造船：${f.name}（${f.ships.length}/4隻）build_ship(fleet_id=${f.id}, class_index=${S.tier}) で${CLASSES[S.tier].name}を追加 費用${cc}`,`${f.name}に${CLASSES[S.tier].name}を追加`);
      else if(rp)add(rp.net,` 造船：${f.name} build_ship(fleet_id=${f.id}, class_index=${S.tier}, replace=true) で旧艦を${CLASSES[S.tier].name}に置換 実費${rp.net}`,`${f.name}の旧艦を置換`);
    }
    const bo=f.ships.reduce((s,x)=>s+(x.alloc?.bo||0),0);
    if(!bo&&f.moveOptions.some(o=>/攻略|突入/.test(o.kind))){
      const x=f.ships[f.ships.length-1],a=x.alloc,ch={bo:1};
      if(x.points.used>=x.points.max){const k=["ca","sh","sp","mi"].sort((p,q)=>a[q]-a[p])[0];ch[k]=a[k]-1} // 空きがなければ一番多い項目から1つ回す
      L.push(` 改装：${f.name} は爆装0なので惑星を落とせない → refit_ship(fleet_id=${f.id}, ship_index=${x.index}, ${Object.entries(ch).map(([k,v])=>`${k}=${v}`).join(", ")})（書かない項目は今の値のまま）`);
    }
  }
  const yards=S.planets.filter(p=>p.owner==="P"&&p.yard);
  if(st.myFleets.length<3&&yards.length)add(bcost(0,yards[0]),` 新艦隊：new_fleet(planet_id=${yards[0].id}) 費用${bcost(0,yards[0])}（ラーク級1隻の艦隊が増える。編成したターンは動けない）`,"新艦隊");
  if(no.length)L.push(` 資金不足でいまは打てない（呼ばない）：${no.join("、")}`);
  return L.length?`■内政の候補（資金${funds}・収入+${st.incomePerTurn}/ターン。いま払えるものだけ。◎はその星の特性に合う施設）\n${L.join("\n")}`:"";
}
/* 操作の返り値に付ける「のこりの手」：いまの資金で払える内政と、まだ動かしていない艦隊を短くまとめる。
 * 状況テキストはターンの最初のものなので、資金を使ったあと・艦隊を動かしたあとの手はここで知らせる */
function fleetNext(f){
  const opts=moveOptions(f).filter(o=>!o.kind.startsWith("不可"));
  const near=opts.filter(o=>o.kind!=="亜空間移動").map(o=>{const od=o.kind.match(/（(有利|互角|不利)/);return`${o.to}${o.name}=${shortKind(o.kind)}${od?`・${od[1]}`:""}${/爆装なし/.test(o.kind)?"・爆装なし":""}`});
  if(opts.some(o=>o.kind==="亜空間移動"))near.push("ほか自国の星へ亜空間移動");
  return`${f.name} ID${f.id}@${f.node}${planet(f.node).name}${intruder(f)?"（迎撃可）":""} → ${near.join("、")||"行ける星なし"}`;
}
let idleTold=null;
/* 費用は「費用N」と書き、艦隊・星はIDつきの呼び出しの形で書く（「新艦隊(32)」の 32 を艦隊IDと読んで build_ship(fleet_id=32) を呼んだことがあった） */
function nextHint(){
  if(!S||S.over||B)return null;
  const funds=S.funds,pay=[],own=S.planets.filter(p=>p.owner==="P"),mine=myFleets();
  if(researchOpen()&&investMax()>=30)pay.push(`研究 invest_research(amount=${investMax()>30?`30〜${investMax()}`:"30"})`);
  const sites=own.map(p=>({p,ks:p.fac.length<p.slots?FAC_KEYS.filter(k=>!hasF(p,k)&&FAC[k].cost<=funds):[]})).filter(x=>x.ks.length);
  if(sites.length)pay.push(`施設 build_facility(planet_id=…, facility=…)：${sites.slice(0,5).map(x=>`${x.p.id}${x.p.name}に${x.ks.join("/")}`).join("、")}${sites.length>5?` ほか${sites.length-5}星`:""}`);
  const sv=own.filter(p=>p.survey>0);if(funds>=40&&sv.length)pay.push(`探査 survey(planet_id=${sv.map(p=>p.id).join("か")}) 費用40`);
  const ft=own.filter(p=>p.def<p.maxDef);if(funds>=30&&ft.length)pay.push(`防衛修復 fortify(planet_id=${ft.map(p=>p.id).join("か")}) 費用30`);
  for(const f of mine){
    const p=planet(f.node);if(p.owner!=="P")continue;
    if(fleetDamage(f)&&repairCost(f)<=funds)pay.push(`修理 repair_fleet(fleet_id=${f.id}) 費用${repairCost(f)}`);
    if(p.yard){
      const cc=bcost(S.tier,p),rp=replaceOf(f,S.tier,p);
      if(f.ships.length<4){if(cc<=funds)pay.push(`造船 build_ship(fleet_id=${f.id}, class_index=${S.tier}) で${f.name}に${CLASSES[S.tier].name}を追加 費用${cc}`)}
      else if(rp&&rp.net<=funds)pay.push(`造船 build_ship(fleet_id=${f.id}, class_index=${S.tier}, replace=true) で${f.name}の旧艦を置換 実費${rp.net}`);
    }
  }
  const yards=own.filter(p=>p.yard);
  if(mine.length<3&&yards.length&&bcost(0,yards[0])<=funds)pay.push(`新艦隊 new_fleet(planet_id=${yards[0].id}) 費用${bcost(0,yards[0])}`);
  const idle=mine.filter(f=>!f.moved),full=idle.map(fleetNext).join("／"),key=`${S.turn}|${full}`;
  const L=[`のこりの手：資金${funds}。払える内政：${pay.join("、")||"なし"}`];
  // 行き先は、前に知らせたときから変わっていなければ繰り返さない（返り値を短く保つ）
  L.push(`未行動の艦隊：${!idle.length?"なし":key===idleTold?`${idle.map(f=>`${f.name} ID${f.id}`).join("・")}（行き先は前と同じ）`:full}`);
  idleTold=key;
  if(!pay.length&&!idle.length)L.push("→ 打てる手はもうありません。end_turn でターンを終えてください");
  return L.join("\n");
}
function getSummary(){
  if(!S)return"ゲームが始まっていません";
  const st=getState(),L=[];
  if(st.dialog){L.push(`【通信が届いています（次の操作で自動的に閉じます。dismiss_dialog は不要）】\n${st.dialog.text}`);seeDialog(true)}
  if(B){L.push(battleSummary());return L.join("\n\n")}
  if(st.over)L.push(`【ゲーム終了：${st.over==="win"?"勝利":"敗北"}】`);
  const r=st.research;
  L.push(`【ターン${st.turn}（星暦${st.year}年）】資金${st.funds}（収入+${st.incomePerTurn}/ターン）`);
  L.push(`研究：${r.next?`${r.next.name}（${r.next.type}）${r.next.progress}/${r.next.need}`:r.note}${r.next?`・研究所+${r.labPerTurn}/ターン`:""}・改装上限${r.refitCap}`);
  const sit=st.situation;
  L.push(`情勢：${sit.xenoAppeared?`異生体出現中${sit.xenoEvolved?"（進化済：新しく湧く群れは正面が弱点、進化前の群れは側面）":"（側面が弱点）"}`:"異生体は未出現（ターン18かヴァルガ本星占領で出現）"}${sit.truceWithVarga?"・ヴァルガと休戦中":""}・敵の艦級${sit.enemyTier}`);
  const dev=devSummary(st);if(dev)L.push(dev);
  L.push("■自軍艦隊");
  if(!st.myFleets.length)L.push(" なし（造船所のある星で new_fleet）");
  for(const f of st.myFleets){
    L.push(` ${f.name} ID${f.id} @${f.at}${f.atName} ${f.moved?"行動済":"未行動"} 戦力${f.power}${f.formation?` 陣形${f.formation}`:""}${f.atShipyard?" 造船所あり":""}${f.repairCost?` 修理${f.repairCost}`:""}${f.canIntercept?` 迎撃可（intercept：${f.interceptNote}）`:""}`);
    L.push(`   艦：${f.ships.map(x=>`${x.index}:${shipShort(x)}`).join(" ")}`);
    if(f.moveOptions.length)L.push(`   移動先：${f.moveOptions.map(o=>`${o.to}${o.name}=${o.kind}`).join("、")}`);
  }
  L.push("■惑星（ID 名前 持ち主 特性 収入 防衛 施設 隣接）");
  for(const p of st.planets){
    L.push(` ${p.id}${p.name} ${p.ownerLabel} ${p.trait} 収入${p.income} 防衛${p.def}/${p.maxDef} 施設[${p.facilities.map(f=>f.key).join(",")}]${p.slots?`${p.facilities.length}/${p.slots}`:""}${p.surveyLeft?` 探査余地${p.surveyLeft}`:""} 隣${p.neighbors.join(",")}`);
  }
  L.push("■他勢力の艦隊");
  if(!st.otherFleets.length)L.push(" なし");
  for(const f of st.otherFleets)L.push(` ${f.name} ID${f.id} ${f.sideLabel}${f.doctrine?`〈${f.doctrine.split("：")[0]}〉`:""} @${f.at}${f.atName} 戦力${f.power} ${f.ships.map(shipShort).join(" ")}`);
  L.push("■最近の出来事\n "+st.recentLog.slice(0,6).join("\n "));
  idleTold=`${S.turn}|${myFleets().filter(f=>!f.moved).map(fleetNext).join("／")}`; // 行き先は上の「移動先」で知らせた
  return L.join("\n");
}

/* ---------- 配信用：字幕オーバーレイ ---------- */
let capEl=null,capTimer=null;
function ensureOverlay(){
  if(capEl)return capEl;
  const st=document.createElement("style");
  st.textContent=`#gapi-cap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100;max-width:min(860px,92vw);
    background:rgba(8,12,30,.92);border:2px solid #f2b84b;border-radius:10px;padding:10px 18px 12px;color:#fff;font:600 20px/1.5 "DotGothic16",system-ui,sans-serif;
    box-shadow:0 6px 24px #0008;transition:opacity .25s;pointer-events:none}
  #gapi-cap[hidden]{display:block;opacity:0}
  #gapi-cap .who{display:block;font-size:13px;color:#f2b84b;letter-spacing:.1em}
  #gapi-act{position:fixed;right:12px;top:58px;z-index:100;background:rgba(8,12,30,.85);border:1px solid #3aa0ff;border-radius:6px;padding:4px 10px;
    color:#bfe0ff;font:13px/1.4 "DotGothic16",system-ui,sans-serif;pointer-events:none;transition:opacity .3s}
  #gapi-act[hidden]{display:block;opacity:0}`;
  document.head.append(st);
  capEl=document.createElement("div");capEl.id="gapi-cap";capEl.hidden=true;capEl.setAttribute("aria-live","polite");
  const act=document.createElement("div");act.id="gapi-act";act.hidden=true;
  document.body.append(capEl,act);
  return capEl;
}
function say(text,who,ms){
  const el=ensureOverlay();
  el.replaceChildren(Object.assign(document.createElement("span"),{className:"who",textContent:who||speaker}),document.createTextNode(String(text)));
  el.hidden=false;clearTimeout(capTimer);
  const dur=ms??Math.min(15000,2500+String(text).length*120);
  capTimer=realTimeout(()=>{el.hidden=true},dur);
  return{ok:true,message:"表示しました",durationMs:dur};
}
let actTimer=null,speaker="のあ";
function showAction(t){ensureOverlay();const el=$("gapi-act");el.textContent=`${speaker}：${t}`;el.hidden=false;clearTimeout(actTimer);actTimer=realTimeout(()=>{el.hidden=true},4000)}

/* ---------- 戦略コマンド ---------- */
function movedMsg(f){
  const idle=myFleets().filter(x=>!x.moved);
  return`${f.name} はこのターン行動済みです（艦隊が動けるのは1ターンに1回。続きは次のターン）。${idle.length?`未行動の艦隊：${idle.map(x=>`${x.name}=ID${x.id}`).join("、")}`:"未行動の艦隊はもうありません（内政が済んだら end_turn）"}`;
}
const api={
  /* 名前で書かれた艦隊・星をIDにする（MCPサーバーが引数を読むときに使う）。
   * 見つかれば {id}、艦隊の名前の形なのにいなければ {message}、名前として読めなければ null */
  idOf:(kind,text)=>{
    if(!S)return null;
    const s=String(text??"").trim();
    if(kind==="fleet"){const f=fleetNamed(s);return f?{id:f.id}:FLEET_NAME.test(s)?{message:noFleetNamed(s)}:null}
    if(kind==="planet"){const p=planetNamed(s);return p?{id:p.id}:null}
    return null;
  },
  version:1,
  getState,
  getSummary,
  getEvents:(after=0)=>events.filter(e=>e.seq>after),
  setPace(ms){pace=Math.max(0,Number(ms)||0);window.FAST=pace===0;return{ok:true,pace}}, // 0なら戦闘・移動の演出も省く
  // 戦闘・ターン処理・艦隊の移動の演出を何倍の速さで流すか（1〜4。1で今までどおり）
  setSpeed(x){const v=Number(x);speed=Number.isFinite(v)?Math.min(4,Math.max(1,v)):1;return{ok:true,speed}},
  // いまの「のこりの手」（行き先も省かずに）。ai-player が、LLM が手を選べずにいるときに見せる
  nextMoves(){idleTold=null;return nextHint()??(B?"戦闘中です":S&&S.over?"ゲームは終わっています":"")},
  setSpeaker(n){speaker=String(n||"のあ");return{ok:true,speaker}},
  // オート戦闘：true なら戦術戦闘は本体のオートで決着させ、作戦卓に戻ってから結果を返す（battle_* の操作は要らない）
  setAutoBattle(on){
    if(on&&typeof autoPhase!=="function")return{ok:false,message:"このゲームHTMLはオート戦闘に対応していません"};
    autoBattle=!!on;window.AUTO_BATTLE=autoBattle;
    if(B&&!B.ended){B.auto=autoBattle;if(autoBattle)autoPhase()}
    return{ok:true,autoBattle};
  },
  say,

  dismissDialog:()=>act("dismiss",async()=>{
    if(!dialogOpen())fail("開いている通信ウィンドウはありません");
    // 結果画面の「もう一度遊ぶ」は押さない（押すと勝敗が消えて新しいゲームになる。やり直しは new_game だけ）
    if(S&&S.over){$("modal").hidden=true;render();return`結果の画面を閉じました（${S.over==="win"?"勝利":"敗北"}）。次のゲームは new_game`}
    pressDialog();
    return"閉じました";
  }),

  moveFleet:(fleetId,to)=>act("move",async()=>{
    ensureMap();const f=myFleet(fleetId),p=planetById(to);
    if(f.moved)fail(movedMsg(f));
    const opts=moveOptions(f),opt=opts.find(o=>o.to===p.id);
    const can=`${f.name} が行ける先：${opts.filter(o=>!o.kind.startsWith("不可")).map(o=>`${o.to}${o.name}=${shortKind(o.kind)}`).join("、")||"なし"}`;
    if(!opt&&p.id===f.node)fail(`${f.name} はいま ${p.name} にいます（とどまるなら何もしなくてよい）。${can}`);
    if(!opt)fail(`${f.name}（${planet(f.node).name}）から ${p.name} へは移動できません（隣接する星か、自国の星への亜空間移動だけ）。${can}`);
    if(opt.kind.startsWith("不可"))fail(`${p.name} へは進めません：${opt.kind}。${can}`);
    showAction(`${f.name} → ${p.name}（${opt.kind}）`);
    S.sel=f.node;S.selFleet=f.id;S.mode="move";render();await sleep(pace);
    S.mode=null;moving=true;
    try{await orderMove(f,p.id,p.id!==f.node&&!neighbors(f.node).includes(p.id))}finally{moving=false}
    return`${f.name} を ${p.name} へ：${opt.kind}`;
  }),
  intercept:(fleetId)=>act("intercept",async()=>{
    ensureMap();const f=myFleet(fleetId);
    if(f.moved)fail(movedMsg(f));
    const ef=intruder(f);
    if(!ef){
      const can=myFleets().filter(x=>!x.moved&&intruder(x)).map(x=>`${x.name}=ID${x.id}`);
      fail(`${planet(f.node).name} に迎撃できる敵はいません（迎撃は、艦隊と同じ星に敵が居座っているときだけ。状況テキストに「迎撃可」と出る）。${can.length?`迎撃できる艦隊：${can.join("、")}`:"いま迎撃できる艦隊はありません"}。敵のいる星へ攻め込むなら move_fleet`);
    }
    showAction(`${f.name} が ${ef.name} を迎撃`);focusPlanet(f.node,f.id);await sleep(pace);
    intercept(f);return`${ef.name} との戦闘を開始`;
  }),
  investResearch:(amount)=>act("invest",async()=>{
    ensureMap();
    if(!researchOpen())fail(`いまは研究に投資できません（${researchInfo().note}）。資金は施設・造船・修理などに回してください`);
    // 額は30刻みに丸め、1ターンの上限と手持ちに収まる分だけ投資する（30・60・120 以外の額や、多すぎる額で断らない）
    let v=Math.floor(Number(amount)/30)*30;
    if(!(v>=30))fail(`投資額は 30 以上の数で指定してください（30刻み、1ターンに${investCap()}まで。例：amount=60）`);
    if(investRoom()<30)fail(`研究への投資は1ターンに${investCap()}まで。このターンはもう投資できません（次のターンに）`);
    if(S.funds<30)fail(`資金不足：研究投資には 30 必要（現在 ${S.funds}）`);
    const m=investMax();
    if(v>m){note(`${amount} は投資できないので ${m} にしました（1ターンの上限まであと${investRoom()}・資金${S.funds}）`);v=m}
    else if(v!==Number(amount))note(`投資額は30刻みなので ${v} にしました`);
    showAction(`研究に ${v} 投資`);
    let done=0;
    for(let rest=v;rest>0&&researchOpen();){const c=rest>=120?120:rest>=60?60:30;invest(c);rest-=c;done+=c} // 本体のボタンと同じ額（30・60・120）に分けて入れる。途中で開発が終わり、次の艦級がなければそこまで
    const r=researchInfo();return`${done} 投資。`+(r.next?`研究進捗 ${r.next.progress}/${r.next.need}（${r.next.name}）`:"研究完了");
  }),
  refitShip:(fleetId,shipIndex,alloc)=>act("refit",async()=>{
    ensureMap();const f=myFleet(fleetId),s=f.ships[Number(shipIndex)];
    if(blank(shipIndex)||!s)fail(`${f.name} に ${blank(shipIndex)?"ship_index（何番艦か）の指定がありません":`${shipIndex} 番艦はいません`}（0〜${f.ships.length-1} で指定。0 が旗艦）`);
    const c=CLASSES[s.cls],cap=capOf("P"),a={};
    if(!STAT_KEYS.some(k=>alloc?.[k]!=null))fail(`変える項目（${STAT_KEYS.join("・")}）を1つ以上書いてください`);
    // 書かなかった項目は今の値のまま
    for(const k of STAT_KEYS){const v=alloc?.[k]??s.a[k];if(!Number.isInteger(v)||v<0||v>cap)fail(`${k} は 0〜${cap} の整数で指定してください`);a[k]=v}
    const sum=STAT_KEYS.reduce((t,k)=>t+a[k],0);
    if(sum>c.pts)fail(`合計 ${sum} が上限 ${c.pts} を超えています（${c.name}。今の配分 ${STAT_KEYS.map(k=>`${k}=${s.a[k]}`).join(", ")}、書かなかった項目は今の値のまま。増やすなら別の項目を減らす）`);
    showAction(`${f.name} ${shipIndex}番艦を改装`);focusPlanet(f.node,f.id);
    s.a=a;openRefit(f);await sleep(pace*2);if(dialogOpen())closeModal();
    log(`${f.name}の${c.name}を改装（装甲${a.sh}・主砲${a.ca}・ミサイル${a.mi}・爆装${a.bo}・機関${a.sp}）。`);render();
    return`改装完了：${JSON.stringify(shipStats(s))}`;
  }),
  setFlagship:(fleetId,shipIndex)=>act("flag",async()=>{
    ensureMap();const f=myFleet(fleetId),i=Number(shipIndex),s=f.ships[i];
    if(!s)fail(`${f.name} に ${shipIndex} 番艦はいません`);
    if(i===0)fail("すでに旗艦です");
    f.ships.splice(i,1);f.ships.unshift(s);focusPlanet(f.node,f.id);showAction(`${f.name} の旗艦を ${CLASSES[s.cls].name} に`);
    return`${CLASSES[s.cls].name} を旗艦に指定`;
  }),
  setFormation:(fleetId,key)=>act("form",async()=>{
    ensureMap();const f=myFleet(fleetId);
    if(typeof FORM==="undefined")fail("このバージョンのゲームには陣形がありません");
    if(!FORM[key])key=FORM_KEYS.find(k=>FORM[k].name===String(key??"").trim())||fail(`陣形は ${FORM_KEYS.map(k=>`${k}=${FORM[k].name}`).join("・")} のいずれかです`);
    f.form=key;focusPlanet(f.node,f.id);showAction(`${f.name} の陣形を${FORM[key].name}に`);
    openFormation(f);await sleep(pace*2);if(dialogOpen())closeModal();
    log(`${f.name}の陣形を${FORM[key].name}に変更。`);render();
    return`陣形を ${FORM[key].name} に変更（${FORM[key].tip}）`;
  }),
  buildShip:(fleetId,classIndex,replace)=>act("ship",async()=>{
    ensureMap();const f=myFleet(fleetId),yp=planet(f.node),ci=Number(classIndex),c=CLASSES[ci];
    if(yp.owner!=="P"||!yp.yard){
      const at=myFleets().filter(x=>{const q=planet(x.node);return q.owner==="P"&&q.yard}).map(x=>`${x.name}=ID${x.id}`);
      fail(`${f.name} のいる ${yp.name} には自国の造船所がありません（造船は、造船所のある自国の星にいる艦隊だけ）。${at.length?`造船所にいる艦隊：${at.join("、")}`:"いま造船所にいる艦隊はありません"}`);
    }
    if(!c||!Number.isInteger(ci))fail(`艦級は class_index=0〜${S.tier} で指定してください（いま造れるいちばん新しい艦級は ${S.tier}=${CLASSES[S.tier].name}）`);
    if(ci>S.tier)fail(`${c.name} はまだ開発されていません。いま造れるのは class_index=0〜${S.tier}（${S.tier}=${CLASSES[S.tier].name}）`);
    const cc=bcost(ci,yp);
    focusPlanet(f.node,f.id);
    if(replace){
      const worst=f.ships.reduce((m,s,i)=>s.cls<ci&&(m<0||s.cls<=f.ships[m].cls)?i:m,-1); // 同じ艦級なら随伴艦から（ゲームの造船所と同じ）
      if(worst<0)fail(`${f.name} に ${c.name} より旧式の艦がいません（置換するものがない）。${f.ships.length<4?`追加で造るなら replace を付けずに build_ship(fleet_id=${f.id}, class_index=${ci})（${cc}）`:"この艦隊は4隻とも最新なので、造船は要りません"}`);
      const refund=Math.floor(CLASSES[f.ships[worst].cls].cost/2);
      if(S.funds+refund<cc)fail(`資金不足：実費 ${cc-refund} 必要（現在 ${S.funds}）`);
      showAction(`${f.name} の旧艦を ${c.name} に置換`);openYard(f);await sleep(pace);
      S.funds+=refund-cc;const old=f.ships[worst];f.ships[worst]=makeShip(ci,"P");log(`${CLASSES[old.cls].name}を${c.name}に置換。`);
      openYard(f);await sleep(pace);closeModal();
      return`${CLASSES[old.cls].name} を ${c.name} に置換（実費 ${cc-refund}）。新しい艦は標準配分なので必要なら改装を`;
    }
    if(f.ships.length>=4)fail(`艦隊は最大4隻です。${f.ships.some(x=>x.cls<ci)?`旧艦と置換するなら build_ship(fleet_id=${f.id}, class_index=${ci}, replace=true)`:`${f.name} は4隻とも ${c.name} 以上なので、造船は要りません`}`);
    needFunds(cc,`${c.name}の建造`);
    showAction(`${f.name} に ${c.name} を建造`);openYard(f);await sleep(pace);
    S.funds-=cc;f.ships.push(makeShip(ci,"P"));log(`${f.name}に${c.name}を配備。`);
    openYard(f);await sleep(pace);closeModal();
    return`${c.name} を配備（${cc}）`;
  }),
  repairFleet:(fleetId)=>act("repair",async()=>{
    ensureMap();const f=myFleet(fleetId),p=planet(f.node);
    if(p.owner!=="P")fail("修理は自国の星にいる艦隊だけです");
    if(!fleetDamage(f))fail("損傷はありません");
    const cost=repairCost(f);
    needFunds(cost,"修理");focusPlanet(f.node,f.id);showAction(`${f.name} を修理`);repair(f);
    return`修理完了（${cost}）`;
  }),
  newFleet:(planetId)=>act("newfleet",async()=>{
    ensureMap();const p=myPlanet(planetId);
    if(!p.yard)fail(`${p.name} に造船所がありません`);
    if(S.fleets.filter(f=>f.side==="P").length>=3)fail("自軍艦隊は最大3つです");
    needFunds(bcost(0,p),"新艦隊の編成");focusPlanet(p.id);showAction(`${p.name} で新艦隊を編成`);await sleep(pace/2);
    newFleet(p);const f=S.fleets.find(x=>x.id===S.selFleet);
    return`${f.name}（ID ${f.id}）を編成。このターンは行動済み`;
  }),
  buildFacility:(planetId,key)=>act("build",async()=>{
    ensureMap();const p=myPlanet(planetId);key=facKey(key);
    const can=()=>{const ks=p.fac.length<p.slots?FAC_KEYS.filter(k=>!hasF(p,k)):[];return ks.length?`${p.name} に建てられるのは：${ks.map(k=>`${k}=${FAC[k].name}${FAC[k].cost}`).join("・")}`:`${p.name} にはもう建てられません`};
    if(p.fac.length>=p.slots)fail(`${p.name} の施設スロットは満杯です（${p.slots}）。ほかの星に建ててください（どうしても入れ替えるなら demolish_facility）`);
    if(hasF(p,key))fail(`${p.name} には ${FAC[key].name} が既にあります。${can()}`);
    needFunds(FAC[key].cost,FAC[key].name);
    focusPlanet(p.id);showAction(`${p.name} に ${FAC[key].name} を建設`);openBuild(p);await sleep(pace);$("modal").hidden=true;
    buildFac(p,key);return`${p.name} に ${FAC[key].name} を建設（${FAC[key].cost}）`;
  }),
  demolishFacility:(planetId,key)=>act("demolish",async()=>{
    ensureMap();const p=myPlanet(planetId);key=facKey(key);
    if(!hasF(p,key))fail(`${p.name} に ${FAC[key].name} はありません（いまの施設：${p.fac.map(k=>`${k}=${FAC[k].name}`).join("・")||"なし"}）`);
    focusPlanet(p.id);showAction(`${p.name} の ${FAC[key].name} を撤去`);await sleep(pace/2);demolish(p,key);return"撤去しました（返金なし）";
  }),
  survey:(planetId)=>act("survey",async()=>{
    ensureMap();const p=myPlanet(planetId);
    if(p.survey<=0)fail(`${p.name} に探査余地はありません`);needFunds(40,"小惑星探査");
    focusPlanet(p.id);showAction(`${p.name} で小惑星探査`);await sleep(pace/2);survey(p);return"探査しました";
  }),
  fortify:(planetId)=>act("fortify",async()=>{
    ensureMap();const p=myPlanet(planetId);
    if(p.def>=p.maxDef)fail("防衛力は満タンです");needFunds(30,"防衛修復");
    focusPlanet(p.id);showAction(`${p.name} の防衛を修復`);await sleep(pace/2);fortify(p);return`防衛力 ${p.def}/${p.maxDef}`;
  }),
  endTurn:()=>act("end",async()=>{
    ensureMap();showAction("ターン終了");
    const t=S.turn;
    turnTask=endTurn().finally(()=>{turnTask=null});
    return`ターン${t}を終了`;
  }),
  newGame:()=>act("new",async()=>{
    if(B)fail("戦闘中はやり直せません");
    $("modal").hidden=true;newGame();render();return"新しいゲームを開始（最初の通信は、次の操作で自動的に閉じます）";
  }),

  /* ---------- 戦術戦闘 ---------- */
  battleAttack:(unitId,targetId)=>act("battack",async()=>{
    ensureBattle();
    const u=B.units.find(v=>v.uid===Number(unitId)&&v.side==="P"&&v.hp>0)||fail(`自軍ユニット ${unitId} が見つかりません`);
    const t=B.units.find(v=>v.uid===Number(targetId)&&v.side==="E"&&v.hp>0)||fail(`敵ユニット ${targetId} が見つかりません`);
    if(u.acted)fail(`${u.name} は行動済みです`);
    const a=bestAttack(u,t);
    if(!a)fail(t.core?`${t.name} は爆装（射程1）でしか攻撃できません。距離 ${dist(u,t)}`:`${t.name} は射程外です（距離 ${dist(u,t)}）`);
    B.sel=u.uid;renderBattle();showAction(`${u.name} → ${t.name}（${a.w.n}${a.zone?"・"+a.zone:""}）`);await sleep(pace);
    if(!B||B.busy||B.ended||u.acted||t.hp<=0)fail("待っている間に戦況が変わりました。状況を確かめ直してください");
    B.sel=null;B.busy=true;doAttack(u,t,a).then(()=>{B.busy=false;afterPlayerAct()});
    return`${u.name} が ${t.name} を${a.w.n}で攻撃（予測 ${a.dmg}）`;
  }),
  battleMove:(unitId,x,y)=>act("bmove",async()=>{
    ensureBattle();
    const u=B.units.find(v=>v.uid===Number(unitId)&&v.side==="P"&&v.hp>0)||fail(`自軍ユニット ${unitId} が見つかりません`);
    if(u.acted)fail(`${u.name} は行動済みです`);
    x=Number(x);y=Number(y);
    if(!reach(u).some(([a,b])=>a===x&&b===y))fail(`(${x},${y}) へは移動できません。移動可能：${JSON.stringify(reach(u))}`);
    B.sel=u.uid;renderBattle();showAction(`${u.name} が (${x},${y}) へ移動`);await sleep(pace);
    if(!B||B.busy||B.ended||u.acted||unitAt(x,y))fail("待っている間に戦況が変わりました。状況を確かめ直してください");
    B.sel=null;B.busy=true;doMove(u,x,y).then(()=>{B.busy=false;afterPlayerAct()});
    return`${u.name} を (${x},${y}) へ移動`;
  }),
  battleWait:(unitId)=>act("bwait",async()=>{
    ensureBattle();
    const u=B.units.find(v=>v.uid===Number(unitId)&&v.side==="P"&&v.hp>0)||fail(`自軍ユニット ${unitId} が見つかりません`);
    if(u.acted)fail(`${u.name} は行動済みです`);
    showAction(`${u.name} は待機`);u.acted=true;B.sel=null;afterPlayerAct();return`${u.name} は待機`;
  }),
  battleEndPhase:()=>act("bend",async()=>{
    ensureBattle();showAction("戦闘ターン終了");
    B.units.forEach(u=>{if(u.side==="P")u.acted=true});enemyPhase();return"自軍フェイズを終了";
  }),
  battleRetreat:()=>act("bretreat",async()=>{
    ensureBattle();showAction("撤退！");finishBattle("retreat");return"撤退しました（艦隊は主星へ戻ります）";
  }),
  battleClose:()=>act("bclose",async()=>{
    ensureBattle(false);if(!B.ended)fail("戦闘はまだ続いています");
    const r=B.result;closeBattle();await sleep(150);
    return`作戦卓へ戻りました（結果：${resultLabel(r)}）`;
  }),

  rules:()=>autoBattle?RULES.replace(/。目安：突撃や強襲には方陣.*$/m,"。").replace(/^- 撤退すると.*\n/m,"").replace(/^- 戦闘が終わったら battle_close.*$/m,AUTO_RULE).replace(/戦闘ユニットのIDは.*$/m,""):RULES
};
const AUTO_RULE=`- 戦術戦闘はオート（自動）で進む。艦隊を攻め込ませる（move_fleet・intercept）か、end_turn で敵に襲われると、戦闘は自動で決着し、結果は出来事（events）と battles に出る。戦闘中の操作はない。勝敗を分けるのは準備：艦隊の戦力（修理・造船）、改装の配分、陣形、旗艦の選び方、そして勝てる相手を選ぶこと。負けると艦隊は主星へ戻る（防衛戦で負けるとその星は敵に攻められる）。
- オートの戦い方：撃てる艦から、とどめと旗艦を優先していちばん効く攻撃をする。撃てない艦は敵旗艦（攻略戦では爆装艦は中枢〈巣ではセラフ級の爆装艦だけ〉、ほかは防衛衛星）へ寄り、側面・背面を取りに行く。ミサイルが主砲以上の艦は射程2〜4を保って撃つ。旗艦と傷ついた艦は敵の射程を避けて控える。方陣では護衛が旗艦の隣に残り、鶴翼では回り込みを重く見る。旗艦がただ1隻の爆装艦なら、護衛が防衛衛星を払い、中枢を落とし切るまで持ちこたえられる見込みが立ってから中枢に取りつく。中枢を壊せる爆装艦（巣ではセラフ級）がいない攻略戦や、誰も撃てず動けなくなった戦闘は、その場で時間切れとして切り上げる（攻めた艦隊は出撃元にとどまる）。つまり改装の配分がそのまま戦い方になる（主砲寄り＝前に出る、ミサイル寄り＝距離を保つ、装甲＝打たれ強い）。旗艦には打たれ強い艦（装甲・耐久が高い）を選ぶ。
- 陣形の目安（オートでの勝率から）：戦列には後衛陣か鶴翼／突撃には方陣か後衛陣／砲撃には後衛陣か方陣（横陣・楔形だと大きく負け越す）／重装には後衛陣か横陣／強襲には横陣か方陣／異生体には横陣。楔形は旗艦が前に出て狙われやすいので、オートでは勧めない。移動先の「艦隊戦（…）」と迎撃可の欄にも、相手に合わせた目安が出る。`;

const RULES=`# 辺境星系戦記 ルール要約（AIプレイヤー向け）
目的：北東の「深淵の巣」の中枢を破壊すれば勝利。主星アステリア（ID 0）を奪われたら敗北。
## ターンの流れ
- 自軍艦隊（最大3つ・各最大4隻）は1ターンに1回、隣接する星へ移動するか、自国の星へ亜空間移動できる。
- 敵艦隊のいる星へ入ると艦隊戦、敵や中立の星へ入ると惑星攻略戦（戦術戦闘）になる。攻略戦に勝てばその星を占領（艦隊戦に勝っただけでは占領しない）。
- 艦隊戦に勝って敵・中立の星に残ったときは、次のターンに move_fleet の to にいまいる星を指定すると、その場から惑星攻略戦を始められる（移動先に「いまいる星」と出る）。
- end_turn で収入と研究が入り、敵が動く。敵が自軍艦隊のいる星を襲うと防衛戦が始まる（その星でいちばん強い自軍艦隊が迎え撃つ。負けても同じ星に別の自軍艦隊が残っていれば星は守られる）。ヴァルガは同じ星に居座る自軍艦隊も攻める。
- 自軍艦隊のいない星に敵が入ると、敵の戦力（耐久合計÷3）が防衛力を上回れば陥落。下回れば防衛力が戦力の半分減り、敵はその星に居座る（迎撃できる）。中立の星はヴァルガが入るだけで併合。自国の星の防衛力は毎ターン+3回復。
- 敵の艦級は6ターンごとに上がる（ターン7・13・19）。ヴァルガは本星から3ターンごとに増援を出す。
- ターン18か、ヴァルガ本星（ID 6）占領で異生体ゾアが出現。そのときヴァルガ本星がヴァルガ領なら休戦になり、最後まで解けない（ヴァルガ艦隊は自領へ引き上げて動かなくなる。休戦中はヴァルガの星・ヴァルガ艦隊のいる星へ入れず、迎撃もできない）。巣からは群れが何度も湧く。群れに艦隊戦で3回勝つと進化し、以後に湧く群れは改になる（すでにいる群れは改にならない）。異生体に浸食された星は施設がなくなる。
## 内政
- 研究投資（30刻み、1ターンに合計120まで）で次の艦級を開発。完成で改装上限（各項目）+1。セラフ級（対異生体。異生体と浸食核・巣の中枢への攻撃が1.5倍）はゾア出現後、アークライト級の次に開発できる。
- 艦級：0 ラーク級(耐久12,P6,40) 1 ファルコ級(20,P9,70,研究160) 2 グレイヴ級(30,P12,110,研究300) 3 アークライト級(44,P16,160,研究450) 4 セラフ級(56,P20,200,研究600)
- 造船：造船所のある自国の星で、艦隊に追加建造（工業惑星は20%引き）か、旧艦と置換（旧艦の半額下取り）。
- 施設（スロット数まで）：mine 採掘所60（収入+10、鉱物惑星+20）／yard 造船所80／sats 防衛衛星群50（防衛上限+20、要塞+35）／lab 研究所70（毎ターン研究+10、遺跡+25。開発できる艦級がないあいだは貯まらない）／flak 対空砲台60（この星での艦隊戦〈防衛戦・迎撃〉の開始時に敵全艦5ダメージ）。
- 遺跡惑星に研究所があると、ゾア出現時に研究 +150×その数（そのとき開発中の艦級に入り、完成時の余りは次へ持ち越し）。
- 小惑星探査40（45%で収入+15）、防衛修復30（防衛+15）、修理（損傷の半分の資金）。
## 改装（艦ごと）
- ポイント配分：sh装甲・ca主砲・mi ミサイル・bo爆装・sp機関。合計は艦級のP以下、各項目は改装上限以下。refit_ship は変える項目だけ書けばよい（書かない項目は今の値のまま）。
- 主砲＝3+主砲×2（射程1〜2）。ミサイル＝2+ミサイル×1.5を四捨五入（射程2〜4、1以上で搭載）。爆装＝4+爆装×3（射程1、中枢〈惑星中枢・浸食核・巣の中枢〉にだけ当たり、それらを壊せる唯一の武器）。移動＝1+機関。装甲は被ダメージ軽減（×10/(10+2×装甲)）。
- 惑星攻略には爆装を持つ艦が必須。巣の中枢（耐久150）はセラフ級の爆装でしか壊せない（ほかの艦の爆装は当たらない）。巣で与えた損害は次の突入まで残る（1回ごとに20回復）。
## 戦術戦闘（11×7マス）
- 1隻につき1回、移動か攻撃のどちらか。行動後は向きが変わる（移動方向・攻撃方向を向く）。
- 旗艦★を沈めた側の勝ち（敵が全滅しても勝ち）。惑星攻略戦は中枢★を爆装で落とせば勝ち。
- 敵も1手番に移動か攻撃のどちらかしかできない。次の敵フェイズに撃たれるのは、敵の今の位置からの射程に入っているマスだけ。
- 向きによるダメージ倍率：通常艦は正面1.0・側面1.25・背面1.6。異生体は正面0.8・側面1.6・背面1.0、進化後は正面1.6・ほか0.9。
- 撤退・敗北すると、残った艦は主星へ戻る（防衛戦で撤退・敗北すると、その星は敵に攻められる）。
- ラウンド上限は艦隊戦12・惑星攻略戦と巣20。決着がつかなければ、防衛戦は持ちこたえて終わり（敵は退く）、攻めた側は出撃元にとどまる。
- 艦隊戦の盤面には小惑星（盤面図の #）があることがあり、通れない。
- ヴァルガ艦隊には戦い方の違う種類がある（状況テキストの〈突撃〉など。get_state なら otherFleets の doctrine）：戦列＝正面から押す／突撃＝旗艦へ突っ込む／砲撃＝距離を取ってミサイル／重装＝旗艦を盾艦で守る／強襲＝側面・背面へ回り込み、星図でもヴァルガ領を通るときは1ターンに2星進む。
- 自軍艦隊は陣形を持つ（set_formation、いつでも変更でき行動は消費しない）。戦闘開始時の並びと補正が変わる：line 横陣＝標準・補正なし／wedge 楔形＝前に出て始まり1ラウンド目は移動+1（旗艦も前に出る）／square 方陣＝旗艦を囲む、旗艦の隣に味方がいる間は旗艦の被ダメージ-25%／crane 鶴翼＝両翼が前に出る、側面・背面への攻撃+15%／rear 後衛陣＝後ろに下がって始まる、ミサイル+1。目安：突撃や強襲には方陣、砲撃には楔形、重装には鶴翼、ミサイル艦が多ければ後衛陣。
- 戦闘が終わったら battle_close で作戦卓へ戻る。
## 操作上の注意
- 通信ウィンドウ（dialog）は、次の操作をすると自動で閉じる（内容は返り値と状況テキストに出る。dismiss_dialog は呼ばなくてよい）。
- 操作の返り値の「のこりの手」（next）に、いまの資金で払える内政と未行動の艦隊が出る。資金を使ったあと・艦隊を動かしたあとは、状況テキストではなくこちらを見て次の手を選ぶ。断られたときは、理由と一緒に出る「選べるもの」から選び直す。
- IDは状況テキスト（get_summary）や get_state に出る数値を使う。戦闘ユニットのIDは「ID30」のような番号（get_state なら battle.units[].id）。
`;

window.gameAPI=api;
})();
