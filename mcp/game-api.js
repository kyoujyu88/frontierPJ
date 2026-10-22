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
 */
(function(){
"use strict";
if(window.gameAPI)return;

/* ---------- イベント記録（log / bmsg を包む） ---------- */
const events=[];let seq=0;
function push(kind,text){events.push({seq:++seq,kind,text});if(events.length>400)events.shift()}
const origLog=window.log,origBmsg=window.bmsg;
window.log=function(m){push("log",m);return origLog(m)};
window.bmsg=function(m){push("battle",m);return origBmsg(m)};
function since(n){return events.filter(e=>e.seq>n).map(e=>e.kind==="battle"?`［戦闘］${e.text}`:e.text)}

/* ---------- 共通 ---------- */
const DIR_NAME=["右","下","左","上"];
const FAC_KEYS=Object.keys(FAC);
const STAT_KEYS=STATS.map(s=>s[0]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pace=700;          // 配信用の「間」(ms)。0で即時
let turnTask=null;     // 実行中の endTurn() の Promise

class GameError extends Error{}
const fail=m=>{throw new GameError(m)};
const dialogOpen=()=>!$("modal").hidden;
const fleetById=id=>S.fleets.find(f=>f.id===Number(id))||fail(`艦隊ID ${id} は存在しません`);
const myFleet=id=>{const f=fleetById(id);if(f.side!=="P")fail(`${f.name} は自軍艦隊ではありません`);return f};
const planetById=id=>{const p=S.planets[Number(id)];if(!p)fail(`惑星ID ${id} は存在しません`);return p};
const myPlanet=id=>{const p=planetById(id);if(p.owner!=="P")fail(`${p.name} は自国の星ではありません`);return p};
const needFunds=(v,what)=>{if(S.funds<v)fail(`資金不足：${what}には ${v} 必要（現在 ${S.funds}）`)};

function ensureMap(){
  if(!S)fail("ゲームが始まっていません");
  if(S.over)fail(S.over==="win"?"ゲームはクリア済みです。new_game で再開できます":"ゲームオーバーです。new_game で再開できます");
  if(dialogOpen())fail("通信ウィンドウが開いています。dialog の内容を読んでから dismiss_dialog を呼んでください");
  if(B)fail("戦術戦闘中です。battle_* の操作で戦闘を進めてください");
}
function ensureBattle(needTurn=true){
  if(dialogOpen())fail("通信ウィンドウが開いています。先に dismiss_dialog を呼んでください");
  if(!B)fail("戦闘中ではありません");
  if(needTurn){
    if(B.ended)fail("戦闘は終わっています。battle_close で作戦卓へ戻ってください");
    if(B.phase!=="P"||B.busy)fail("敵が行動中です");
  }
}
function focusPlanet(id,fleetId){S.sel=id;if(fleetId!=null)S.selFleet=fleetId;S.mode=null;render()}

/* 待機：アニメ・敵フェイズ・ターン処理が一段落するまで */
async function settle(timeout=120000){
  const t0=Date.now();
  await sleep(60);
  while(Date.now()-t0<timeout){
    if(B){if(B.ended||(B.phase==="P"&&!B.busy))return}
    else if(!turnTask)return;
    await sleep(50);
  }
}
/* 行動の実行ラッパー：成否・新しいログ・状況の要約を返す */
async function act(name,fn){
  const n=seq;
  try{
    const message=await fn();
    await settle();await sleep(80);
    return result(true,message,n);
  }catch(e){
    if(e instanceof GameError)return result(false,e.message,n);
    throw e;
  }
}
function result(ok,message,n){
  const r={ok,message:message||(ok?"完了":""),events:since(n),funds:S?S.funds:null,turn:S?S.turn:null,mode:B?(B.ended?"battle_ended":"battle"):(S&&S.over?"over":"map")};
  if(dialogOpen())r.dialog=dialogText();
  if(B)r.battle=battleState();
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
    else if(foes.length)kind=`艦隊戦（${foes[0].name}・戦力${Math.round(fleetPower(foes[0]))}）`;
    else if(p.owner==="H")kind="深淵の巣への突入戦";
    else if(p.owner!=="P")kind=`惑星攻略戦（${OWNER_LABEL[p.owner]}・防衛力${p.def}）`;
    else kind=warp?"亜空間移動":"移動";
    out.push({to:p.id,name:p.name,kind});
  }
  if(typeof hasBomb==="function"&&!hasBomb(f))out.forEach(o=>{if(/攻略|突入/.test(o.kind))o.kind+="（爆装なし：中枢を壊せない）"});
  return out;
}
function fleetInfo(f){
  const o={id:f.id,name:f.name,side:f.side,sideLabel:f.side==="P"?"自軍":f.side==="E"?"ヴァルガ帝国":"異生体",at:f.node,atName:planet(f.node).name,
    power:Math.round(fleetPower(f)),ships:f.ships.map(shipInfo)};
  if(f.side==="E"&&typeof docOf==="function"){const d=docOf(f);o.doctrine=`${d.name}：${d.tip}`}
  if(f.side==="P"){
    if(typeof formOf==="function"){const fm=formOf(f);o.formation=formKey(f);o.formationNote=`${fm.name}：${fm.tip}`}
    const p=planet(f.node),dmg=f.ships.reduce((s,x)=>s+(x.maxHp-x.hp),0);
    o.moved=!!f.moved;o.moveOptions=moveOptions(f);
    o.canIntercept=!f.moved&&!!intruder(f);
    o.repairCost=p.owner==="P"&&dmg?Math.ceil(dmg/2):null;
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
    if(u.core)o.kind="中枢（爆装でのみ破壊可）";else if(u.sat)o.kind="防衛衛星";else if(u.xeno)o.kind=u.neo?"異生体（改：正面が弱点）":"異生体（側面が弱点）";
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
/* 内政の候補：艦隊の移動先と同じように「打てる手」を呼び出しの形で並べ、内政を考えに入れやすくする */
function devSummary(st){
  const L=[],funds=S.funds,mark=c=>c>funds?" ※資金不足":"";
  const r=st.research;
  if(r.next)L.push(` 研究：invest_research(amount=30/60/120) → あと${r.next.need-r.next.progress}で${r.next.name}完成（新しい艦級・改装上限+1）`);
  const BEST={鉱物:"mine",遺跡:"lab",要塞:"sats",工業:"yard"};
  for(const p of S.planets.filter(p=>p.owner==="P")){
    const free=p.slots-p.fac.length;
    if(free>0){
      const opts=FAC_KEYS.filter(k=>!hasF(p,k)).map(k=>`${BEST[p.trait]===k?"◎":""}${k}=${FAC[k].name}${FAC[k].cost}（${FAC[k].desc(p)}）${mark(FAC[k].cost)}`);
      L.push(` 施設：${p.name}（${p.trait}・空き${free}）build_facility(planet_id=${p.id}, facility=…) ${opts.join("／")}`);
    }
    if(p.survey>0)L.push(` 探査：${p.name} survey(planet_id=${p.id}) 40 → 45%で収入+20（残り${p.survey}回）${mark(40)}`);
    if(p.def<p.maxDef)L.push(` 防衛修復：${p.name} 防衛${p.def}/${p.maxDef} fortify(planet_id=${p.id}) 30で+15${mark(30)}`);
  }
  for(const f of st.myFleets){
    if(f.repairCost)L.push(` 修理：${f.name} repair_fleet(fleet_id=${f.id}) ${f.repairCost}${mark(f.repairCost)}`);
    if(f.atShipyard){
      const cc=bcost(S.tier,planet(f.at));
      if(f.ships.length<4)L.push(` 造船：${f.name}（${f.ships.length}/4隻）build_ship(fleet_id=${f.id}, class_index=${S.tier}) で${CLASSES[S.tier].name}を追加 ${cc}${mark(cc)}`);
      else if(f.ships.some(x=>x.class<S.tier))L.push(` 造船：${f.name} build_ship(fleet_id=${f.id}, class_index=${S.tier}, replace=true) で旧艦を${CLASSES[S.tier].name}に置換`);
    }
    const bo=f.ships.reduce((s,x)=>s+(x.alloc?.bo||0),0);
    if(!bo&&f.moveOptions.some(o=>/攻略|突入/.test(o.kind))){
      const x=f.ships[f.ships.length-1],a=x.alloc,ch={bo:1};
      if(x.points.used>=x.points.max){const k=["ca","sh","sp","mi"].sort((p,q)=>a[q]-a[p])[0];ch[k]=a[k]-1} // 空きがなければ一番多い項目から1つ回す
      L.push(` 改装：${f.name} は爆装0なので惑星を落とせない → refit_ship(fleet_id=${f.id}, ship_index=${x.index}, ${Object.entries(ch).map(([k,v])=>`${k}=${v}`).join(", ")})（書かない項目は今の値のまま）`);
    }
  }
  const yards=S.planets.filter(p=>p.owner==="P"&&p.yard);
  if(st.myFleets.length<3&&yards.length)L.push(` 新艦隊：new_fleet(planet_id=${yards[0].id}) ${bcost(0,yards[0])}${mark(bcost(0,yards[0]))}（ラーク級1隻の艦隊が増える）`);
  return L.length?`■内政の候補（資金${funds}・収入+${st.incomePerTurn}/ターン。◎はその星の特性に合う施設）\n${L.join("\n")}`:"";
}
function getSummary(){
  if(!S)return"ゲームが始まっていません";
  const st=getState(),L=[];
  if(st.dialog)L.push(`【通信ウィンドウが開いています → 読んだら dismiss_dialog】\n${st.dialog.text}`);
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
    L.push(` ${f.name} ID${f.id} @${f.at}${f.atName} ${f.moved?"行動済":"未行動"} 戦力${f.power}${f.formation?` 陣形${f.formation}`:""}${f.atShipyard?" 造船所あり":""}${f.repairCost?` 修理${f.repairCost}`:""}${f.canIntercept?" 迎撃可":""}`);
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
  capTimer=setTimeout(()=>{el.hidden=true},dur);
  return{ok:true,message:"表示しました",durationMs:dur};
}
let actTimer=null,speaker="のあ";
function showAction(t){ensureOverlay();const el=$("gapi-act");el.textContent=`${speaker}：${t}`;el.hidden=false;clearTimeout(actTimer);actTimer=setTimeout(()=>{el.hidden=true},4000)}

/* ---------- 戦略コマンド ---------- */
const api={
  version:1,
  getState,
  getSummary,
  getEvents:(after=0)=>events.filter(e=>e.seq>after),
  setPace(ms){pace=Math.max(0,Number(ms)||0);window.FAST=pace===0;return{ok:true,pace}}, // 0なら戦闘・移動の演出も省く
  setSpeaker(n){speaker=String(n||"のあ");return{ok:true,speaker}},
  say,

  dismissDialog:()=>act("dismiss",async()=>{
    if(!dialogOpen())fail("開いている通信ウィンドウはありません");
    // 結果画面の「もう一度遊ぶ」は押さない（押すと勝敗が消えて新しいゲームになる。やり直しは new_game だけ）
    if(S&&S.over){$("modal").hidden=true;render();return`結果の画面を閉じました（${S.over==="win"?"勝利":"敗北"}）。次のゲームは new_game`}
    // 押すのは下の行のボタン（了解・完了・閉じる）。「やり直す」など danger のボタンや、建設・陣形の選択肢は押さない
    const foot=[...$("modalCard").querySelectorAll(":scope > .row")].pop(),btns=foot?[...foot.querySelectorAll("button")]:[];
    const btn=btns.find(b=>b.classList.contains("primary"))||btns.find(b=>!b.classList.contains("danger"));
    if(btn)btn.click();else closeModal();
    return"閉じました";
  }),

  moveFleet:(fleetId,to)=>act("move",async()=>{
    ensureMap();const f=myFleet(fleetId),p=planetById(to);
    if(f.moved)fail(`${f.name} はこのターン行動済みです`);
    const opt=moveOptions(f).find(o=>o.to===p.id);
    if(!opt)fail(`${f.name}（${planet(f.node).name}）から ${p.name} へは移動できません。隣接する星か、自国の星（亜空間移動）を選んでください`);
    if(opt.kind.startsWith("不可"))fail(`${p.name} へは進めません：${opt.kind}`);
    showAction(`${f.name} → ${p.name}（${opt.kind}）`);
    S.sel=f.node;S.selFleet=f.id;S.mode="move";render();await sleep(pace);
    S.mode=null;await orderMove(f,p.id,p.id!==f.node&&!neighbors(f.node).includes(p.id));
    return`${f.name} を ${p.name} へ：${opt.kind}`;
  }),
  intercept:(fleetId)=>act("intercept",async()=>{
    ensureMap();const f=myFleet(fleetId);
    if(f.moved)fail(`${f.name} はこのターン行動済みです`);
    const ef=intruder(f);if(!ef)fail(`${planet(f.node).name} に迎撃できる敵はいません`);
    showAction(`${f.name} が ${ef.name} を迎撃`);focusPlanet(f.node,f.id);await sleep(pace);
    intercept(f);return`${ef.name} との戦闘を開始`;
  }),
  investResearch:(amount)=>act("invest",async()=>{
    ensureMap();const v=Number(amount);
    if(![30,60,120].includes(v))fail("投資額は 30・60・120 のいずれかです");
    if(!researchOpen())fail(researchInfo().note);
    needFunds(v,"研究投資");showAction(`研究に ${v} 投資`);invest(v);
    const r=researchInfo();return r.next?`研究進捗 ${r.next.progress}/${r.next.need}（${r.next.name}）`:"研究完了";
  }),
  refitShip:(fleetId,shipIndex,alloc)=>act("refit",async()=>{
    ensureMap();const f=myFleet(fleetId),s=f.ships[Number(shipIndex)];
    if(!s)fail(`${f.name} に ${shipIndex} 番艦はいません（0〜${f.ships.length-1}）`);
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
    if(!FORM[key])fail(`陣形は ${FORM_KEYS.join("・")} のいずれかです`);
    f.form=key;focusPlanet(f.node,f.id);showAction(`${f.name} の陣形を${FORM[key].name}に`);
    openFormation(f);await sleep(pace*2);if(dialogOpen())closeModal();
    log(`${f.name}の陣形を${FORM[key].name}に変更。`);render();
    return`陣形を ${FORM[key].name} に変更（${FORM[key].tip}）`;
  }),
  buildShip:(fleetId,classIndex,replace)=>act("ship",async()=>{
    ensureMap();const f=myFleet(fleetId),yp=planet(f.node),ci=Number(classIndex),c=CLASSES[ci];
    if(yp.owner!=="P"||!yp.yard)fail(`${yp.name} には自国の造船所がありません`);
    if(!c)fail("艦級の番号が不正です");if(ci>S.tier)fail(`${c.name} はまだ開発されていません`);
    const cc=bcost(ci,yp);
    focusPlanet(f.node,f.id);
    if(replace){
      const worst=f.ships.reduce((m,s,i)=>s.cls<ci&&(m<0||s.cls<=f.ships[m].cls)?i:m,-1); // 同じ艦級なら随伴艦から（ゲームの造船所と同じ）
      if(worst<0)fail(`${f.name} に ${c.name} より旧式の艦がいません`);
      const refund=Math.floor(CLASSES[f.ships[worst].cls].cost/2);
      if(S.funds+refund<cc)fail(`資金不足：実費 ${cc-refund} 必要（現在 ${S.funds}）`);
      showAction(`${f.name} の旧艦を ${c.name} に置換`);openYard(f);await sleep(pace);
      S.funds+=refund-cc;const old=f.ships[worst];f.ships[worst]=makeShip(ci,"P");log(`${CLASSES[old.cls].name}を${c.name}に置換。`);
      openYard(f);await sleep(pace);closeModal();
      return`${CLASSES[old.cls].name} を ${c.name} に置換（実費 ${cc-refund}）。新しい艦は標準配分なので必要なら改装を`;
    }
    if(f.ships.length>=4)fail("艦隊は最大4隻です。replace=true で旧艦と置換できます");
    needFunds(cc,`${c.name}の建造`);
    showAction(`${f.name} に ${c.name} を建造`);openYard(f);await sleep(pace);
    S.funds-=cc;f.ships.push(makeShip(ci,"P"));log(`${f.name}に${c.name}を配備。`);
    openYard(f);await sleep(pace);closeModal();
    return`${c.name} を配備（${cc}）`;
  }),
  repairFleet:(fleetId)=>act("repair",async()=>{
    ensureMap();const f=myFleet(fleetId),p=planet(f.node);
    if(p.owner!=="P")fail("修理は自国の星にいる艦隊だけです");
    const dmg=f.ships.reduce((s,x)=>s+(x.maxHp-x.hp),0);if(!dmg)fail("損傷はありません");
    needFunds(Math.ceil(dmg/2),"修理");focusPlanet(f.node,f.id);showAction(`${f.name} を修理`);repair(f);
    return`修理完了（${Math.ceil(dmg/2)}）`;
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
    ensureMap();const p=myPlanet(planetId);
    if(!FAC[key])fail(`施設キーは ${FAC_KEYS.join("・")} のいずれかです`);
    if(hasF(p,key))fail(`${p.name} には ${FAC[key].name} が既にあります`);
    if(p.fac.length>=p.slots)fail(`${p.name} の施設スロットは満杯です（${p.slots}）。demolish_facility で空けられます`);
    needFunds(FAC[key].cost,FAC[key].name);
    focusPlanet(p.id);showAction(`${p.name} に ${FAC[key].name} を建設`);openBuild(p);await sleep(pace);$("modal").hidden=true;
    buildFac(p,key);return`${p.name} に ${FAC[key].name} を建設（${FAC[key].cost}）`;
  }),
  demolishFacility:(planetId,key)=>act("demolish",async()=>{
    ensureMap();const p=myPlanet(planetId);
    if(!hasF(p,key))fail(`${p.name} に ${FAC[key]?.name||key} はありません`);
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
    $("modal").hidden=true;newGame();render();return"新しいゲームを開始（最初の通信を dismiss_dialog で閉じてください）";
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

  rules:()=>RULES
};

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
- 研究投資（30/60/120）で次の艦級を開発。完成で改装上限（各項目）+1。セラフ級（対異生体。異生体と浸食核・巣の中枢への攻撃が1.5倍）はゾア出現後、アークライト級の次に開発できる。
- 艦級：0 ラーク級(耐久12,P6,40) 1 ファルコ級(20,P9,70,研究120) 2 グレイヴ級(30,P12,110,研究220) 3 アークライト級(44,P16,160,研究330) 4 セラフ級(56,P20,200,研究380)
- 造船：造船所のある自国の星で、艦隊に追加建造（工業惑星は20%引き）か、旧艦と置換（旧艦の半額下取り）。
- 施設（スロット数まで）：mine 採掘所60（収入+15、鉱物惑星+30）／yard 造船所80／sats 防衛衛星群50（防衛上限+20、要塞+35）／lab 研究所70（毎ターン研究+10、遺跡+25。開発できる艦級がないあいだは貯まらない）／flak 対空砲台60（この星での艦隊戦〈防衛戦・迎撃〉の開始時に敵全艦5ダメージ）。
- 遺跡惑星に研究所があると、ゾア出現時に研究 +150×その数（そのとき開発中の艦級に入り、完成時の余りは次へ持ち越し）。
- 小惑星探査40（45%で収入+20）、防衛修復30（防衛+15）、修理（損傷の半分の資金）。
## 改装（艦ごと）
- ポイント配分：sh装甲・ca主砲・mi ミサイル・bo爆装・sp機関。合計は艦級のP以下、各項目は改装上限以下。refit_ship は変える項目だけ書けばよい（書かない項目は今の値のまま）。
- 主砲＝3+主砲×2（射程1〜2）。ミサイル＝2+ミサイル×1.5を四捨五入（射程2〜4、1以上で搭載）。爆装＝4+爆装×3（射程1、中枢〈惑星中枢・浸食核・巣の中枢〉にだけ当たり、それらを壊せる唯一の武器）。移動＝1+機関。装甲は被ダメージ軽減（×10/(10+2×装甲)）。
- 惑星攻略・巣の攻略には爆装を持つ艦が必須。
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
- 通信ウィンドウ（dialog）が開いている間は他の操作ができない。内容を読んで dismiss_dialog。
- IDは状況テキスト（get_summary）や get_state に出る数値を使う。戦闘ユニットのIDは「ID30」のような番号（get_state なら battle.units[].id）。
`;

window.gameAPI=api;
})();
