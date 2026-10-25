/* 辺境星系戦記 バランス検証ボット（ページ内で動く）
 * game-api.js（window.gameAPI）の後に読み込む。window.BOT.play(opts) で1ゲームを最後まで遊び、記録を返す。
 * 行動はすべて gameAPI 経由（画面のボタンと同じ検証を通る）。状態の読み取りだけ本体のグローバル（S, B, reach, bestAttack…）を直接見る。
 */
(function(){
"use strict";
const api=window.gameAPI;
const STATK=["sh","ca","mi","bo","sp"];
const sleep0=()=>new Promise(r=>setTimeout(r,0));
let LV=null,R=null;

/* ================= 強さの段階 ================= */
const LEVELS={
  // 下手：研究と造船はするが、施設は気まぐれ、改装・陣形はいじらない。戦力を比べずに近くの敵へ突っ込む。戦闘は「撃てるなら一番痛い攻撃、なければ敵旗艦へ寄る」
  novice:{key:"novice",battle:"naive",refit:"none",form:"none",margin:0,econ:"novice",reserve:0,maxRounds:30,stallAggro:3,stallRetreat:6,repairAt:.5,capital:"auto",survey:false},
  // 普通：特性に合う施設、研究と置換、修理。改装は固定の役割（旗艦・砲撃・爆撃×2）、陣形は方陣。戦力比1.1以上で攻める。戦闘は優先度つきの貪欲法
  normal:{key:"normal",battle:"normal",refit:"fixed",form:"square",margin:1.1,econ:"normal",reserve:40,maxRounds:30,stallAggro:3,stallRetreat:6,repairAt:.8,capital:"auto",survey:true},
  // 上手：普通に加えて、戦闘前に目的に合わせて改装（惑星・巣は爆装、艦隊戦は主砲・装甲）、敵の型に合わせた陣形、射程の外で待つ間合い取り、
  //       敵の進路を読んだ待ち伏せ、遺跡研究所の先行建設、セラフ級の最優先
  good:{key:"good",battle:"good",refit:"prebattle",form:"doctrine",margin:1.2,econ:"good",reserve:30,maxRounds:30,stallAggro:3,stallRetreat:6,repairAt:.9,capital:"auto",survey:true}
};

/* ================= 記録 ================= */
function newRecord(opts){
  return{level:LV.key,variant:opts.variant||"",seed:opts.seed??null,result:null,endTurn:null,
    monsterTurn:null,monsterReason:null,truce:null,evolvedTurn:null,tierTurn:{},
    funds:[],income:[],planets:[],strength:[],xenoFleets:[],
    spent:{research:0,ship:0,facility:0,repair:0,survey:0,fortify:0,newfleet:0},
    battles:[],captures:[],homeLostBy:null,homeLostTurn:null,
    dmg:{P:{},E:{}},zones:{P:{正面:0,側面:0,背面:0},E:{正面:0,側面:0,背面:0}},
    facBuilt:{},formUse:{},xenoSpawns:0,capitalTakenTurn:null,errors:[],stalls:0,longRetreats:0,
    hive:{attempts:0,wins:0,coreRounds:[],coreLeft:[]},timing:{}};
}
let hooked=false;
function hook(){
  if(hooked)return;hooked=true;
  const o={startBattle,finishBattle,doAttack,siege,checkMonsterTrigger,checkResearch,spawnXeno};
  startBattle=function(cfg){const pr=o.startBattle.apply(this,arguments);try{if(R)onBattleStart(cfg)}catch(e){R&&R.errors.push("hook:"+e.message)}return pr};
  finishBattle=function(result){const first=B&&!B.ended;const r=o.finishBattle.apply(this,arguments);try{if(first&&R)onBattleEnd(result)}catch(e){R&&R.errors.push("hook:"+e.message)}return r};
  doAttack=function(att,t,a){try{if(R)onAttack(att,t,a)}catch(e){}return o.doAttack.apply(this,arguments)};
  siege=function(f,p){const was=p.owner;const r=o.siege.apply(this,arguments);
    try{if(R&&p.owner!==was){R.captures.push({t:S.turn,p:p.id,from:was,to:p.owner});if(p.id===HOME&&was==="P"&&R.homeLostBy==null){R.homeLostBy=f.side;R.homeLostTurn=S.turn}}}catch(e){}return r};
  checkMonsterTrigger=function(){const was=S.monster,capP=planet(CAPITAL).owner==="P";const r=o.checkMonsterTrigger.apply(this,arguments);
    if(R&&!was&&S.monster){R.monsterTurn=S.turn;R.monsterReason=capP?"capital":"turn18";R.truce=!!S.truce}return r};
  checkResearch=function(){const was=S.tier;const r=o.checkResearch.apply(this,arguments);if(R&&S.tier>was)R.tierTurn[S.tier]=S.turn;return r};
  spawnXeno=function(){const r=o.spawnXeno.apply(this,arguments);if(R)R.xenoSpawns++;return r};
}
const hpSum=(side)=>B.units.filter(u=>u.side===side&&u.hp>0&&!u.core).reduce((s,u)=>s+u.hp,0);
function onBattleStart(cfg){
  const kind=cfg.kind,foe=cfg.ef?cfg.ef.side:cfg.planet.owner;
  const cur={t:S.turn,kind,foe,doc:cfg.ef&&cfg.ef.side==="E"?cfg.ef.doc:null,attack:!!cfg.attack,node:cfg.node,capital:cfg.node===CAPITAL&&kind==="planet",
    form:B.form,myN:cfg.pf.ships.length,myCls:cfg.pf.ships.map(s=>s.cls),myHp0:hpSum("P"),foeHp0:hpSum("E"),foeN:B.units.filter(u=>u.side==="E"&&!u.core).length,
    evolved:!!S.evolved,est:R.pendingEst??null,result:null,rounds:null};
  R.pendingEst=null;
  const core=B.units.find(u=>u.core);if(core)cur.coreHp0=core.hp;
  R.formUse[B.form]=(R.formUse[B.form]||0)+1;
  if(kind==="hive")R.hive.attempts++;
  R.battles.push(cur);R.cur=cur;
}
function onBattleEnd(result){
  const cur=R.cur;if(!cur)return;
  cur.result=result;cur.rounds=B.round;cur.maxStill=B.__maxStill||0;cur.stallRetreat=!!B.__stallRetreat;cur.longRetreat=!!B.__longRetreat;cur.aggro=!!B.__aggro;cur.myHp1=hpSum("P");cur.foeHp1=hpSum("E");
  cur.myLost=B.units.filter(u=>u.side==="P"&&u.hp<=0).length;cur.foeLost=B.units.filter(u=>u.side==="E"&&!u.core&&u.hp<=0).length;
  const core=B.units.find(u=>u.core);if(core)cur.coreHp1=Math.max(0,core.hp);
  if(cur.kind==="hive"){if(result==="win"){R.hive.wins++;R.hive.coreRounds.push(B.firstCoreHitRound!=null?B.round-B.firstCoreHitRound+1:B.round)}else R.hive.coreLeft.push(core?Math.max(0,Math.round(core.hp)):null)}
  if(cur.capital&&result==="win")R.capitalTakenTurn=S.turn;
}
function onAttack(att,t,a){
  const side=att.side==="P"?"P":"E",dmg=Math.min(a.dmg,Math.ceil(t.hp));
  R.dmg[side][a.w.n]=(R.dmg[side][a.w.n]||0)+dmg;
  if(a.zone)R.zones[side][a.zone]=(R.zones[side][a.zone]||0)+1;
  if(t.core&&B.firstCoreHitRound==null)B.firstCoreHitRound=B.round;
}

/* ================= 共通 ================= */
const dialogOpen=()=>!$("modal").hidden;
async function dismiss(){let n=0;while(dialogOpen()&&n++<10)await api.dismissDialog()}
async function A(name,...args){
  await dismiss();
  const t0=performance.now();
  let r=await api[name](...args);
  if(!r.ok&&/通信ウィンドウ/.test(r.message)){await dismiss();r=await api[name](...args)}
  const tm=(R.timing[name]??={n:0,ms:0});tm.n++;tm.ms+=performance.now()-t0;
  if(!r.ok&&R.errors.length<80)R.errors.push(`T${S.turn} ${name}(${args.map(a=>typeof a==="object"?JSON.stringify(a):a).join(",")}): ${r.message}`);
  return r;
}
/* 支出をカテゴリ別に数える */
async function spend(cat,name,...args){const f0=S.funds;const r=await A(name,...args);if(r.ok)R.spent[cat]+=f0-S.funds;return r}
const myFleets=()=>S.fleets.filter(f=>f.side==="P");
const myPlanets=()=>S.planets.filter(p=>p.owner==="P");
const shipHp=f=>f.ships.reduce((s,x)=>s+x.hp,0);
const shipMax=f=>f.ships.reduce((s,x)=>s+x.maxHp,0);
const hostileAt=n=>S.fleets.filter(x=>x.node===n&&(x.side==="M"||x.side==="E"));
const blockedByTruce=n=>S.truce&&(planet(n).owner==="E"||fleetsAt(n,"E").length>0);
/* 修正版：艦隊戦に勝って残った敵・中立の星は、その場から攻められる（assaultHere がある版だけ） */
const hereOK=f=>typeof assaultHere==="function"&&!!assaultHere(f);
function canEnter(f,n){if(f.moved)return false;if(n===f.node)return hereOK(f);if(n===HIVE&&!S.monster)return false;if(blockedByTruce(n))return false;return neighbors(f.node).includes(n)||planet(n).owner==="P"}
function gdist(from){const d={[from]:0},q=[from];while(q.length){const n=q.shift();for(const m of neighbors(n))if(!(m in d)){d[m]=d[n]+1;q.push(m)}}return d}

/* ---------- 戦力の見積もり（ランチェスター風：耐久×火力） ---------- */
function prof(s){
  if(s.xeno){const b=s.xeno==="brood";return{hp:s.hp,ar:b?3:2,dmg:b?7:6,xeno:true}}
  if(s.sat)return{hp:9,ar:1,dmg:4*.8};
  const st=shipStats(s);return{hp:s.hp,ar:st.armor,dmg:Math.max(st.cannon,st.missile||0),anti:!!CLASSES[s.cls].anti};
}
function lanc(a,b){
  const avgAr=b.reduce((s,u)=>s+u.ar,0)/Math.max(1,b.length),vsX=b.some(u=>u.xeno);
  let H=0,D=0;for(const u of a){H+=u.hp*(1+.12*u.ar);let d=u.dmg*10/(10+2*avgAr);if(u.anti&&vsX)d*=1.5;if(vsX&&!u.xeno)d*=1.1;D+=d}
  return H*D;
}
function ratioP(mine,foes){const a=mine.map(prof),b=foes.map(prof);return Math.sqrt(lanc(a,b)/Math.max(1e-6,lanc(b,a)))}
function guardsOf(p){
  const neo=!!S.evolved,X=(k)=>({xeno:k,hp:(k==="brood"?42:22)+(neo?8:0)});
  if(p.id===HIVE)return{coreHp:150,coreDmg:7,xeno:true,guards:[X("brood"),X("drone"),X("drone")]};
  if(p.owner==="M")return{coreHp:36,coreDmg:5,xeno:true,guards:[X("drone"),X("drone")]};
  const n=Math.min(6,1+Math.floor(p.def/14)+(hasF(p,"sats")?(p.trait==="要塞"?2:1):0));
  return{coreHp:16+p.def,coreDmg:5,xeno:false,guards:Array.from({length:n},()=>({sat:true}))};
}
/* 惑星・巣を攻める見込み。bombAlloc を渡すと「改装した後なら」の見積もり */
function assaultEval(f,p,ships){
  ships=ships||f.ships;
  const d=guardsOf(p);
  const bombs=ships.map(s=>{const st=shipStats(s),anti=CLASSES[s.cls].anti;return st.bomb*(d.xeno&&anti?1.5:1)*(p.id===HIVE&&!anti?nonAnti():1)}).filter(x=>x>0).sort((a,b)=>b-a).slice(0,4);
  if(!bombs.length)return{ok:false,r:0,rounds:99};
  const per=bombs.reduce((a,b)=>a+b,0)*(bombs.length>=3?.8:1); // 隣接マスは4つ、全員が毎ラウンド撃てるとは限らない
  const rounds=d.coreHp/per;
  const r=ratioP(ships,d.guards);
  const hp=ships.reduce((s,x)=>s+x.hp,0);
  const exposure=(3+rounds)*d.coreDmg*.8/hp;
  return{r,rounds,exposure,ok:true};
}
function fleetEval(f,ef,ships){return ratioP(ships||f.ships,ef.ships)}

/* ---------- 改装 ---------- */
const TPL={
  gun:["ca","sh","sp","ca","sh","sp","mi","bo"],
  flag:["sh","ca","sp","sh","ca","sp","mi","bo"],
  bomb:["bo","sh","sp","bo","sh","ca","sp","mi"],
  bombfull:["bo","sp","sh","bo","sp","sh","ca","mi"],
  flagbomb:["sh","bo","sp","sh","bo","ca","sp","mi"],
  missile:["mi","sh","sp","mi","sh","sp","ca","bo"]
};
function allocFor(tpl,pts,cap){
  const a={sh:0,ca:0,mi:0,bo:0,sp:0},order=TPL[tpl];let left=pts,g=0;
  while(left>0&&g<400){const k=order[g%order.length];if(a[k]<cap){a[k]++;left--}g++}
  return a;
}
const sameAlloc=(a,b)=>STATK.every(k=>a[k]===b[k]);
function roleOf(roles,i,s){if(roles==="HIVEGATE")return CLASSES[s.cls].anti?(i===0?"flagbomb":"bombfull"):(i===0?"flag":"gun");return roles[Math.min(i,roles.length-1)]}
async function refitFleet(f,roles){
  if(!S.fleets.includes(f))return;
  const cap=capOf("P");
  for(let i=0;i<f.ships.length;i++){
    const s=f.ships[i],want=allocFor(roleOf(roles,i,s),CLASSES[s.cls].pts,cap);
    if(!sameAlloc(s.a,want))await A("refitShip",f.id,i,want);
  }
}
function rolesFor(purpose){
  // 普通：固定の役割（旗艦・砲撃・爆撃・爆撃）
  if(LV.refit==="fixed")return["flag","gun","bomb","bomb"];
  if(LV.refit==="prebattle"){
    if(purpose==="hive")return nonAnti()<=0?"HIVEGATE":["flagbomb","bombfull","bombfull","bombfull"];
    if(purpose==="planet")return["flag","bombfull","bombfull","gun"];
    return["flag","gun","gun","gun"]; // 艦隊戦・待機
  }
  return null;
}
async function prepare(f,purpose,foe){
  if(LV.refit!=="none"){const roles=rolesFor(purpose);if(roles)await refitFleet(f,roles)}
  await setForm(f,purpose,foe);
}
function formFor(purpose,foe){
  if(LV.formFixed)return LV.formFixed;
  if(LV.form==="none")return null;
  if(LV.form==="square")return"square";
  // 敵の型に合わせる（ルール要約の目安どおり）
  if(purpose==="planet"||purpose==="hive")return"wedge";
  if(foe&&foe.side==="M")return"crane";
  if(foe&&foe.side==="E"){const d=foe.doc||"line";return{assault:"square",raid:"square",missile:"wedge",heavy:"crane",line:"crane"}[d]||"line"}
  return"square";
}
async function setForm(f,purpose,foe){
  const k=formFor(purpose,foe);if(!k||!S.fleets.includes(f))return;
  if((f.form||"line")!==k)await A("setFormation",f.id,k);
}

/* ================= 戦術戦闘 ================= */
function hasBomb(u){return u.w.some(w=>w.core)}
const nonAnti=()=>typeof HIVE_NONANTI!=="undefined"?HIVE_NONANTI:typeof hasSeraphBomb==="function"?0:1;
/* 中枢を傷つけられる艦か（調整版で「巣はセラフ級の爆装だけ」のときを考える） */
function coreHitter(u,core){return hasBomb(u)&&!(core&&core.hive&&!u.anti&&nonAnti()<=0)}
function canHitFrom(u,x,y,t){const d=Math.abs(x-t.x)+Math.abs(y-t.y);return u.w.some(w=>(t.core?w.core:w.unit)&&d>=w.min&&d<=w.max)}
function armorF(u){return 10/(10+2*(u.armor||0))}
function threatMap(foes){
  const m=new Map();
  for(const e of foes){const ws=e.w.filter(w=>w.unit);if(!ws.length)continue;const d=Math.max(...ws.map(w=>w.d));
    for(const k of threatOf(e))m.set(k,(m.get(k)||0)+d)}
  return m;
}
function multAt(x,y,t){if(t.core||t.sat)return 1;return mult({x,y},t)}
function goalSlots(u,foes){
  const kind=B.cfg.kind,core=foes.find(t=>t.core);
  let target=null;
  if(kind!=="fleet"&&coreHitter(u,core)&&core)target=core;
  else{
    const cand=foes.filter(t=>!t.core);
    if(kind==="fleet")target=cand.find(t=>t.flag)||cand[0];
    else{let bd=1e9;for(const t of cand){const d=dist(u,t)+(core?dist(t,core)*.5:0);if(d<bd){bd=d;target=t}}}
  }
  if(!target)return null;
  const slots=[];
  for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){
    if(isRock(x,y))continue;const o=unitAt(x,y);if(o&&o!==u)continue;
    if(!canHitFrom(u,x,y,target))continue;
    const pen=LV.battle==="naive"?0:(1.6-multAt(x,y,target))*(LV.battle==="good"?2:.8);
    slots.push([x,y,pen]);
  }
  return{target,slots};
}
function chooseMove(u,foes,wThreat,thr){
  const tiles=reach(u);if(!tiles.length)return null;
  const g=goalSlots(u,foes);if(!g||!g.slots.length)return null;
  const af=armorF(u);
  const score=(x,y)=>{
    let best=1e9;for(const[sx,sy,pen]of g.slots){const d=Math.abs(sx-x)+Math.abs(sy-y)+pen;if(d<best)best=d}
    let s=best;
    if(wThreat)s+=(thr.get(`${x},${y}`)||0)*af*wThreat;
    return s;
  };
  const cur=score(u.x,u.y);let best=null;
  for(const[x,y]of tiles){const sc=score(x,y)+Math.random()*.01;if(!best||sc<best.sc)best={x,y,sc}}
  return best&&best.sc<cur-.05?best:null;
}
function attackScore(u,t,a){
  let sc=a.dmg;const kill=t.hp<=a.dmg;
  if(t.flag)sc+=kill?1e4:(LV.battle==="good"?8:5);
  if(kill)sc+=12+Math.max(0,...t.w.filter(w=>w.unit).map(w=>w.d));
  if(B.cfg.kind!=="fleet"&&coreHitter(u,B.units.find(v=>v.core))&&!t.core&&!kill)sc-=50; // 爆撃艦は中枢を優先
  return sc;
}
function shouldRetreat(mine,foes){
  const kind=B.cfg.kind,all=B.units.filter(u=>u.side==="P"&&u.hp>0);
  const core=B.units.find(u=>u.core&&u.hp>0);
  if(kind!=="fleet"&&!all.some(u=>coreHitter(u,core)))return true; // 中枢を傷つけられる艦がいなければ落とせない
  if(B.round>LV.maxRounds){B.__longRetreat=true;R.longRetreats++;return true}
  if(LV.battle==="naive"||!B.cfg.attack)return false;              // 防衛戦では退かない
  const flag=all.find(u=>u.flag);if(!flag)return false;
  const efl=foes.find(u=>u.flag);
  if(efl&&mine.some(u=>{const a=bestAttack(u,efl);return a&&a.dmg>=efl.hp}))return false;
  const myHp=all.reduce((s,u)=>s+u.hp,0),foeHp=foes.filter(u=>!u.core).reduce((s,u)=>s+u.hp,0);
  if(LV.battle==="good"){
    const thr=threatMap(foes);
    if(flag.hp/flag.maxHp<.35&&(thr.get(`${flag.x},${flag.y}`)||0)*armorF(flag)>=flag.hp)return true;
    if(myHp<foeHp*.35)return true;
  }else if(myHp<foeHp*.25)return true;
  return false;
}
/* 膠着の検出：ラウンドが変わるたびに、前のラウンドで誰かが損害を受けたかを見る。損害なしが続いた回数を返す */
function stallTrack(){
  const tot=B.units.reduce((s,u)=>s+Math.max(0,u.hp),0);
  if(B.__r!==B.round){
    if(B.__r!=null){B.__still=Math.abs(tot-B.__hp)<1e-9?(B.__still||0)+1:0;B.__maxStill=Math.max(B.__maxStill||0,B.__still)}
    B.__r=B.round;B.__hp=tot;
  }
  return B.__still||0;
}
function decide(){
  const mine=B.units.filter(u=>u.side==="P"&&u.hp>0&&!u.acted);
  if(!mine.length)return{type:"end"};
  const foes=B.units.filter(u=>u.side==="E"&&u.hp>0);
  const still=stallTrack();
  // 3ラウンド続けて誰も損害を受けない → 間合い取りをやめて前へ。6ラウンド続いたら撤退（終わらない戦闘を打ち切る）
  if(still>=LV.stallRetreat){B.__stallRetreat=true;R.stalls++;return{type:"retreat"}}
  const aggro=still>=LV.stallAggro;if(aggro)B.__aggro=true;
  // 検証用：防衛の艦隊戦では一切撃たず、敵からいちばん遠いマスへ逃げ続ける（ラウンド上限で「守り抜いた」になるかを見る）
  if(LV.defKite&&B.cfg.kind==="fleet"&&!B.cfg.attack){
    const md=(x,y)=>Math.min(...foes.map(f=>Math.abs(f.x-x)+Math.abs(f.y-y)));
    for(const u of mine){const tiles=reach(u);let best=null;const cur=md(u.x,u.y);
      for(const[x,y]of tiles){const sc=md(x,y)+Math.random()*.01;if(!best||sc>best.sc)best={x,y,sc}}
      if(best&&best.sc>cur+.05)return{type:"move",u,x:best.x,y:best.y};}
    return{type:"end"};
  }
  if(shouldRetreat(mine,foes))return{type:"retreat"};
  if(LV.battle==="naive"){
    // 先頭の艦から順に：撃てるなら一番大きいダメージ、なければ敵旗艦（中枢）へ近づく
    const u=mine[0];let best=null;
    for(const t of foes){const a=bestAttack(u,t);if(a&&(!best||a.dmg>best.a.dmg))best={t,a}}
    if(best)return{type:"attack",u,t:best.t};
    let goal=foes.find(t=>t.flag)||foes[0];
    if(aggro){const c=foes.filter(t=>!t.core||coreHitter(u,t));if(c.length)goal=nearestOf(u,c)[0]}
    const tiles=reach(u).map(([x,y])=>({x,y,d:Math.abs(Math.abs(x-goal.x)+Math.abs(y-goal.y)-1)})).sort((p,q)=>p.d-q.d);
    if(tiles.length&&tiles[0].d<Math.abs(dist(u,goal)-1))return{type:"move",u,x:tiles[0].x,y:tiles[0].y};
    return{type:"wait",u};
  }
  // 攻撃：全艦の中で一番点の高い攻撃
  let best=null;
  for(const u of mine)for(const t of foes){const a=bestAttack(u,t);if(!a)continue;const sc=attackScore(u,t,a);if(!best||sc>best.sc)best={u,t,a,sc}}
  if(best&&best.sc>0)return{type:"attack",u:best.u,t:best.t};
  // 移動：随伴艦が先、旗艦は最後
  const thr=threatMap(foes);
  const order=[...mine].sort((a,b)=>(a.flag?1:0)-(b.flag?1:0));
  for(const u of order){
    let w;
    if(LV.battle==="good")w=u.flag?(B.round>=20||aggro?.3:3):(B.round>=6||aggro?0:.6);
    else w=u.flag?(B.round>=20||aggro?0:1):0;
    const m=chooseMove(u,foes,w,thr);
    if(m)return{type:"move",u,x:m.x,y:m.y};
  }
  return{type:"end"};
}
async function fight(){
  let guard=0;
  while(B&&guard++<4000){
    if(dialogOpen()){await dismiss();continue}
    if(B.ended){await A("battleClose");continue}
    if(B.phase!=="P"||B.busy){await sleep0();continue}
    const d=decide();
    let r;
    if(d.type==="attack")r=await A("battleAttack",d.u.uid,d.t.uid);
    else if(d.type==="move")r=await A("battleMove",d.u.uid,d.x,d.y);
    else if(d.type==="wait")r=await A("battleWait",d.u.uid);
    else if(d.type==="retreat")r=await A("battleRetreat");
    else r=await A("battleEndPhase");
    if(r&&!r.ok&&B&&!B.ended&&d.u&&!d.u.acted)await A("battleWait",d.u.uid);
  }
}

/* ================= 内政 ================= */
async function investUpTo(amount){
  // 投資は 30/60/120 刻み
  let left=Math.floor(amount/30)*30;
  while(left>=30&&researchOpen()){const v=left>=120?120:left>=60?60:30;if(S.funds<v)break;const r=await spend("research","investResearch",v);if(!r.ok)break;left-=v}
}
function researchNeed(){if(!researchOpen())return 0;return Math.max(0,CLASSES[S.tier+1].research-S.research)}
const BEST={鉱物:"mine",遺跡:"lab",要塞:"sats",工業:"yard"};
async function build(p,k){if(p.fac.length>=p.slots||hasF(p,k)||S.funds<FAC[k].cost)return false;const r=await spend("facility","buildFacility",p.id,k);if(r.ok)R.facBuilt[k]=(R.facBuilt[k]||0)+1;return r.ok}
async function fortifyTo(p,target){while(p.owner==="P"&&p.def<Math.min(target,p.maxDef)&&S.funds>=30){const r=await spend("fortify","fortify",p.id);if(!r.ok)break}}
function threatTo(pid){
  // 次の敵ターンにこの星へ来うる敵艦隊の最大戦力（ヴァルガは隣、異生体は2歩まで）
  let m=0;
  for(const h of S.fleets){
    if(h.side==="P"||(h.side==="E"&&S.truce))continue;
    const d=gdist(h.node)[pid];if(d==null)continue;
    if(d<=1||(d<=2&&(h.side==="M"||h.doc==="raid")))m=Math.max(m,fleetPower(h));
  }
  return m;
}
async function shipyardWork(f,budget){
  // 造船所のある星にいる艦隊：空きに追加、旧式を置換
  const yp=planet(f.node);if(yp.owner!=="P"||!yp.yard)return;
  let guard=0;
  while(guard++<8&&S.fleets.includes(f)){
    const ci=S.tier,cc=bcost(ci,yp);
    const avail=S.funds-budget;
    if(f.ships.length<4){if(avail<cc)break;const r=await spend("ship","buildShip",f.id,ci,false);if(!r.ok)break;continue}
    const worst=f.ships.reduce((m,s,i)=>s.cls<ci&&(m<0||s.cls<f.ships[m].cls)?i:m,-1);
    if(worst<0)break;
    const net=cc-Math.floor(CLASSES[f.ships[worst].cls].cost/2);
    if(avail<net)break;
    // 1段だけ古い艦は、資金に余裕があるときだけ置換
    if(ci-f.ships[worst].cls<2&&avail<net+LV.reserve+40&&LV.key!=="good"&&!(ci===4&&!f.ships.some(s=>CLASSES[s.cls].anti)))break;
    const r=await spend("ship","buildShip",f.id,ci,true);if(!r.ok)break;
  }
}
async function econNovice(){
  // 研究：資金100以上で60、250以上ならさらに60
  if(researchOpen()&&S.funds>=100)await investUpTo(60);
  if(researchOpen()&&S.funds>=250)await investUpTo(60);
  // 施設：半分くらいの確率で、でたらめな星に、でたらめな施設
  if(Math.random()<.5){
    const ps=myPlanets().filter(p=>p.fac.length<p.slots);
    if(ps.length){const p=ps[Math.floor(Math.random()*ps.length)];const ks=Object.keys(FAC).filter(k=>!hasF(p,k)&&FAC[k].cost<=S.funds);if(ks.length)await build(p,ks[Math.floor(Math.random()*ks.length)])}
  }
  for(const f of myFleets()){
    if(planet(f.node).owner==="P"&&shipHp(f)<shipMax(f)*LV.repairAt){const c=Math.ceil((shipMax(f)-shipHp(f))/2);if(S.funds>=c)await spend("repair","repairFleet",f.id)}
    const yp=planet(f.node);
    if(yp.owner==="P"&&yp.yard){
      let g=0;
      while(g++<4&&f.ships.length<4&&S.funds>=bcost(S.tier,yp)){const r=await spend("ship","buildShip",f.id,S.tier,false);if(!r.ok)break}
      if(f.ships.length>=4&&Math.random()<.5&&f.ships.some(s=>s.cls<S.tier)&&S.funds>=bcost(S.tier,yp))await spend("ship","buildShip",f.id,S.tier,true);
    }
  }
  const home=planet(HOME);
  if(home.owner==="P"&&home.def<home.maxDef/2&&Math.random()<.5)await fortifyTo(home,home.def+15);
  if(Math.random()<.2&&S.funds>=200){const ps=myPlanets().filter(p=>p.survey>0);if(ps.length)await spend("survey","survey",ps[Math.floor(Math.random()*ps.length)].id)}
  if(myFleets().length<3&&S.funds>=300){const y=myPlanets().find(p=>p.yard);if(y)await spend("newfleet","newFleet",y.id)}
}
async function econSmart(stage){
  const good=LV.key==="good",reserve=LV.reserve,home=planet(HOME);
  // 1. 主星の非常時：防衛修復
  const ht=threatTo(HOME);
  if(ht>0&&home.def<ht*1.1)await fortifyTo(home,Math.ceil(ht*1.1)+1);
  if(stage==="post"){
    // 異生体が近い星の防衛修復（上手のみ）
    if(good)for(const p of myPlanets()){const t=threatTo(p.id);if(t>0&&p.def<t&&p.maxDef>=t&&S.funds>reserve+60&&!fleetsAt(p.id,"P").length)await fortifyTo(p,Math.ceil(t)+1)}
    return;
  }
  // 2. 特性に合う、元が取りやすい施設（鉱物→採掘所、遺跡→研究所）
  for(const p of myPlanets()){
    if(p.fac.length>=p.slots)continue;
    if(p.trait==="鉱物"&&!hasF(p,"mine")&&S.funds>=60+(S.turn>1?reserve:0))await build(p,"mine");
    if(p.trait==="遺跡"&&!hasF(p,"lab")&&(good?(!S.monster||researchOpen()):researchOpen()&&S.funds>reserve+150))await build(p,"lab");
  }
  // 3. 研究
  if(researchOpen()){
    const need=researchNeed(),avail=S.funds-reserve;
    const urgent=good&&(S.monster||S.tier<3);
    let share=good?(S.monster?1:.75):.55;
    // 艦隊が貧弱（4隻未満）なら造船を優先
    const weak=myFleets().filter(f=>f.ships.length<4).length;
    if(weak&&!S.monster)share*=.6;
    if(avail>=need&&need>0&&(urgent||avail-need>40))await investUpTo(Math.ceil(need/30)*30);
    else await investUpTo(avail*share);
  }
  // 4. 造船所での建造・置換（造船所にいる艦隊だけ）
  for(const f of myFleets())await shipyardWork(f,reserve);
  // 5. 修理（自国の星にいる艦隊）
  for(const f of myFleets()){
    if(planet(f.node).owner!=="P")continue;
    const dmg=shipMax(f)-shipHp(f);if(!dmg)continue;
    if(shipHp(f)<shipMax(f)*LV.repairAt&&S.funds>=Math.ceil(dmg/2))await spend("repair","repairFleet",f.id);
  }
  // 6. 3つ目の艦隊
  if(myFleets().length<3&&S.funds>(good?220:320)){const y=planet(HOME).owner==="P"&&planet(HOME).yard?planet(HOME):myPlanets().find(p=>p.yard);if(y)await spend("newfleet","newFleet",y.id)}
  // 7. 余裕があれば：要塞→衛星、工業→造船所、その他→採掘所、主星→衛星・対空砲、探査
  const surplus=()=>S.funds-reserve-(researchOpen()?60:0);
  for(const p of myPlanets()){
    if(p.fac.length>=p.slots)continue;
    if(surplus()<70)break;
    if(p.id===HOME){if(!hasF(p,"sats"))await build(p,"sats");else if(S.monster&&!hasF(p,"flak"))await build(p,"flak");continue}
    const b=BEST[p.trait];
    if(b&&b!=="lab"&&!hasF(p,b)){await build(p,b);continue}
    if(S.turn<45&&!hasF(p,"mine"))await build(p,"mine");
  }
  if(LV.survey&&S.turn<30)for(const p of myPlanets()){if(p.survey>0&&surplus()>=(good?60:110)){await spend("survey","survey",p.id)}}
}

/* ================= 艦隊の行動 ================= */
function planetValue(p){
  if(p.id===HIVE)return 400;
  let v=8+planetIncome(p)/4;
  if(p.trait==="鉱物")v+=6;if(p.trait==="遺跡")v+=S.monster?2:(LV.key==="good"?8:4);if(p.trait==="工業")v+=3;
  if(p.owner==="M")v+=6;
  if(p.id===CAPITAL)v+=LV.capital==="rush"?80:LV.capital==="avoid"?-1e4:20;
  if(S.monster&&neighbors(p.id).includes(HIVE))v+=15;
  return v;
}
function hiveReady(f,ships){
  if(!S.monster)return false;
  const e=assaultEval(f,planet(HIVE),ships);
  if(!e.ok)return false;
  if(LV.key==="novice")return true;
  const m=LV.key==="good"?1.25:1.1;
  return e.r>=m&&e.rounds<=(LV.hiveMaxRounds||(LV.key==="good"?3.5:5))&&e.exposure<(LV.hiveMaxExp||.6);
}
/* 戦闘前に改装したら、という想定の艦（上手のみ） */
function hypo(f,purpose){
  if(LV.refit!=="prebattle")return f.ships;
  const roles=rolesFor(purpose),cap=capOf("P");
  return f.ships.map((s,i)=>({...s,a:allocFor(roleOf(roles,i,s),CLASSES[s.cls].pts,cap)}));
}
function candidates(f){
  const out=[];const own=new Set(myPlanets().map(p=>p.id));
  for(const p of S.planets){
    const n=p.id;if(n===f.node&&!hereOK(f))continue;
    if(n===HIVE&&!S.monster)continue;
    if(blockedByTruce(n))continue;
    const foes=hostileAt(n);
    if(p.owner==="P"&&!foes.length)continue;
    let turns;
    if(n===f.node||neighbors(f.node).includes(n)||own.has(n))turns=1;
    else{const st=neighbors(n).filter(m=>own.has(m)&&!hostileAt(m).length);if(!st.length)continue;turns=2}
    let value,r,kind;
    if(foes.length){
      kind="fleet";const ef=foes[0];
      r=fleetEval(f,ef,hypo(f,"fleet"))*(foes.length>1?.6:1);
      value=10+fleetPower(ef)/3+(p.owner==="P"?planetValue(p)+8:0);
    }else{
      kind=n===HIVE?"hive":"planet";
      if(n===HIVE){if(!hiveReady(f,hypo(f,"hive")))continue;const e=assaultEval(f,p,hypo(f,"hive"));r=e.r;value=planetValue(p)}
      else{const e=assaultEval(f,p,hypo(f,"planet"));if(!e.ok)continue;r=e.r;if(e.rounds>6||e.exposure>.7)r*=.5;value=planetValue(p)}
    }
    out.push({n,kind,turns,r,value,score:value*Math.min(1.6,r/Math.max(.5,LV.margin))/turns});
  }
  return out.sort((a,b)=>b.score-a.score);
}
function stagingFor(f,n){
  const own=myPlanets().filter(p=>neighbors(n).includes(p.id)&&!hostileAt(p.id).length);
  own.sort((a,b)=>(b.yard?1:0)-(a.yard?1:0)||b.def-a.def);
  return own[0];
}
/* 敵の次の行き先の予想（ヴァルガ：最寄りの自国・中立の星、異生体：最寄りの浸食されていない星） */
function predictNext(h){
  if(h.side==="E"){if(S.truce)return null;const p=vargaPath(h);return p?p[0]:null}
  const p=bfsPath(h.node,n=>n!==HIVE&&planet(n).owner!=="M");return p?p[0]:null;
}
async function moveTo(f,n,purpose,foe){
  if(!S.fleets.includes(f)||f.moved)return;
  if(n===f.node&&!hereOK(f))return;
  if(purpose)await prepare(f,purpose,foe);
  if(!S.fleets.includes(f)||f.moved)return;
  await A("moveFleet",f.id,n);
  if(B)await fight();
}
async function goHome(f){if(f.node!==HOME&&planet(HOME).owner==="P"&&canEnter(f,HOME))await moveTo(f,HOME,"idle")}
async function fleetsNovice(){
  // 主力は「いちばん番号の若い艦隊」で固定（毎ターン入れ替えると行ったり来たりになる）
  const fs=myFleets().sort((a,b)=>a.id-b.id);
  for(const f of fs){
    if(!S.fleets.includes(f)||f.moved||S.over)continue;
    // 同じ星に敵がいれば迎撃
    if(intruder(f)){await A("intercept",f.id);if(B)await fight();continue}
    if(f!==fs[0]){ // 2番目以降は主星の守り
      if(f.node!==HOME)await goHome(f);continue}
    if(shipHp(f)<shipMax(f)*.4){await goHome(f);continue}
    // 異生体が出たら巣を目指す（中枢を壊せる爆装があれば）。途中の星や艦隊は戦力を見ずに攻める
    if(S.monster&&f.ships.some(s=>shipStats(s).bomb>0&&!(nonAnti()<=0&&!CLASSES[s.cls].anti))){
      const path=bfsPath(f.node,n=>n===HIVE,n=>blockedByTruce(n));
      if(path&&canEnter(f,path[0])){await moveTo(f,path[0],null);continue}
      const st=myPlanets().find(p=>neighbors(p.id).includes(HIVE));if(st&&st.id!==f.node&&canEnter(f,st.id)){await moveTo(f,st.id,null);continue}
    }
    // 隣の敵・中立の星へ（戦力は見ない）。隣になければ最寄りの目標へ一歩
    const adj=[...(hereOK(f)?[f.node]:[]),...neighbors(f.node)].filter(n=>canEnter(f,n)&&(planet(n).owner!=="P"||hostileAt(n).length));
    if(adj.length){const n=adj.sort((a,b)=>planet(a).def-planet(b).def)[0];await moveTo(f,n,null);continue}
    const own=new Set(myPlanets().map(p=>p.id));
    const fr=myPlanets().filter(p=>neighbors(p.id).some(m=>!own.has(m)&&canEnter({node:p.id},m)!==false&&!(m===HIVE&&!S.monster)&&!blockedByTruce(m)));
    if(fr.length){const d=gdist(f.node);fr.sort((a,b)=>(d[a.id]??99)-(d[b.id]??99));const st=fr.find(p=>p.id!==f.node);if(st&&canEnter(f,st.id))await moveTo(f,st.id,null)}
  }
}
async function fleetsSmart(){
  const good=LV.key==="good",home=planet(HOME);
  let fs=myFleets().sort((a,b)=>shipHp(b)-shipHp(a));
  const assigned=new Set();
  // 1. 主星の守り：来うる敵が防衛力を上回るなら、一番勝てそうな艦隊を主星に置く
  const ht=threatTo(HOME);
  if(ht>home.def*.95){
    const threats=S.fleets.filter(h=>(h.side==="M"||(h.side==="E"&&!S.truce))&&(()=>{const d=gdist(h.node)[HOME];return d!=null&&d<=2})());
    const big=threats.sort((a,b)=>fleetPower(b)-fleetPower(a))[0];
    const cands=fs.filter(f=>f.node===HOME||canEnter(f,HOME));
    if(big&&cands.length){
      cands.sort((a,b)=>fleetEval(b,big)-fleetEval(a,big));
      const d=cands[0];assigned.add(d);
      if(d.node!==HOME)await moveTo(d,HOME,"idle");
      await setForm(d,"fleet",big);
    }
  }
  for(const f of fs){
    if(assigned.has(f)||!S.fleets.includes(f)||f.moved||S.over)continue;
    // 同じ星にいる敵
    if(intruder(f)){const ef=intruder(f);if(fleetEval(f,ef)>=LV.margin*.9||planet(f.node).owner==="P"){await prepare(f,"fleet",ef);await A("intercept",f.id);if(B)await fight();continue}}
    const hp=shipHp(f),mx=shipMax(f);
    const yardHere=planet(f.node).owner==="P"&&planet(f.node).yard;
    // 2. 弱っている／艦が少ない／旧式が多い → 主星（造船所）へ
    const old=f.ships.filter(s=>s.cls<S.tier-(good?0:1)).length;
    // セラフ級が使えるのに艦隊に1隻もいない（異生体相手に必要）→ 造船所へ
    const noSeraph=S.tier>=4&&!f.ships.some(s=>CLASSES[s.cls].anti)&&S.funds>=bcost(4,home)-80;
    const needYard=f.ships.length<(S.turn<4?2:4)&&S.funds>=bcost(S.tier,home)||old>=2&&S.funds>=120||noSeraph;
    if(!yardHere&&(hp<mx*.45||needYard)&&planet(HOME).owner==="P"){await goHome(f);if(f.node===HOME)await shipyardWork(f,LV.reserve);continue}
    // 3. 攻撃目標
    const cs=candidates(f).filter(c=>c.r>=LV.margin);
    // 上手：敵の進路を読んで待ち伏せ（自国の星に来る敵で、勝てそうなもの）
    if(good){
      let amb=null;
      for(const h of S.fleets){
        if(h.side==="P"||(h.side==="E"&&S.truce))continue;
        const nx=predictNext(h);if(nx==null||planet(nx).owner!=="P"||nx===f.node&&false)continue;
        if(fleetsAt(nx,"P").some(x=>x!==f))continue;
        const r=fleetEval(f,h);if(r<LV.margin*.95)continue;
        const sc=(14+planetValue(planet(nx))+(nx===HOME?30:0))*Math.min(1.6,r/LV.margin);
        if(!amb||sc>amb.sc)amb={n:nx,h,sc};
      }
      const top=cs[0];
      if(amb&&(!top||amb.sc>top.score*1.1)){
        if(amb.n!==f.node&&canEnter(f,amb.n))await moveTo(f,amb.n,"fleet",amb.h);
        else await setForm(f,"fleet",amb.h);
        continue;
      }
    }
    if(cs.length&&hp>=mx*(good?.6:.5)){
      const c=cs[0];
      if(c.turns===1&&canEnter(f,c.n)){
        const foe=hostileAt(c.n)[0];
        await moveTo(f,c.n,c.kind,foe);
      }else{
        const st=stagingFor(f,c.n);
        if(st&&st.id!==f.node&&canEnter(f,st.id))await moveTo(f,st.id,"idle");
      }
      if(planet(f.node).owner==="P"&&planet(f.node).yard)await shipyardWork(f,LV.reserve);
      continue;
    }
    // 4. 目標なし：傷んでいれば主星、そうでなければその場で待機（標準の改装に戻す）
    if(hp<mx*LV.repairAt&&planet(f.node).owner!=="P")await goHome(f);
    else if(LV.refit==="prebattle")await prepare(f,"idle");
  }
  // 待機中の艦隊の陣形・改装を防衛向けに
  if(LV.refit==="prebattle")for(const f of myFleets())if(!S.over&&!B)await refitFleet(f,rolesFor("idle"));
  for(const f of myFleets()){
    let near=null,bd=99;
    for(const h of S.fleets){if(h.side==="P"||(h.side==="E"&&S.truce))continue;const d=gdist(h.node)[f.node];if(d!=null&&d<bd){bd=d;near=h}}
    if(near)await setForm(f,"fleet",near);
  }
}

/* ================= 1ゲーム ================= */
async function play(opts){
  opts=opts||{};
  LV={...LEVELS[opts.level||"normal"],...(opts.overrides||{})};
  hook();
  // 描画は状態を変えないので、速さのために止める（--render で残せる）
  if(opts.turbo!==false&&!window.__turbo){window.__turbo=true;const no=()=>{};render=()=>{if(typeof nextComm==="function")nextComm()};renderBattle=no;openRefit=no;openFormation=no;openYard=no;openBuild=no}
  window.__BOTFAST=true;api.setPace(0);
  try{SND.on=false;if(SND.ctx)SND.master.gain.value=0}catch(e){} // 効果音の合成を止める（速度のため）
  await dismiss();
  await api.newGame();
  R=newRecord(opts);
  await dismiss();
  const maxTurns=opts.maxTurns||60;
  const t0=performance.now();
  while(!S.over&&S.turn<=maxTurns){
    if(performance.now()-t0>(opts.timeLimitMs||240000)){R.errors.push("time limit");break}
    await dismiss();
    R.funds.push(S.funds);R.income.push(income());R.planets.push(myPlanets().length);
    R.strength.push(myFleets().reduce((s,f)=>s+shipHp(f),0));R.xenoFleets.push(S.fleets.filter(f=>f.side==="M").length);
    if(S.evolved&&R.evolvedTurn==null)R.evolvedTurn=S.turn;
    if(opts.trace){const ev=api.getEvents(R.evSeq||0);if(ev.length){R.evSeq=ev[ev.length-1].seq;(R.trace??=[]).push(...ev.filter(e=>e.kind==="log").map(e=>e.text))}
      R.trace.push(`--- T${S.turn} 資金${S.funds} 収入${income()} 艦級${S.tier} 研究${S.research} | `+myFleets().map(f=>`${f.name}@${planet(f.node).name}[${f.ships.map(x=>CLASSES[x.cls].name[0]+x.hp+"/"+STATK.map(k=>x.a[k]).join("")).join(" ")}]`).join(" ")+" | 敵:"+S.fleets.filter(f=>f.side!=="P").map(f=>`${f.side}${f.doc?"("+f.doc+")":""}@${planet(f.node).name}:${Math.round(fleetPower(f))}`).join(" ")+" | 星:"+S.planets.map(p=>p.owner).join(""))}
    if(LV.econ==="novice")await econNovice();else await econSmart("pre");
    if(S.over)break;
    if(LV.econ==="novice")await fleetsNovice();else await fleetsSmart();
    if(S.over)break;
    if(LV.econ!=="novice")await econSmart("post");
    if(B)await fight();
    if(S.over)break;
    const r=await A("endTurn");
    if(B)await fight();
    await dismiss();
    if(!r.ok&&!S.over){R.errors.push("endTurn failed: "+r.message);break}
  }
  if(opts.trace){const ev=api.getEvents(R.evSeq||0);(R.trace??=[]).push(...ev.filter(e=>e.kind==="log").map(e=>e.text))}
  R.result=S.over==="win"?"win":S.over==="lose"?"lose":"timeout";
  R.endTurn=S.turn;R.finalFunds=S.funds;R.finalTier=S.tier;R.finalIncome=income();
  R.ms=Math.round(performance.now()-t0);
  delete R.cur;delete R.pendingEst;
  const out=R;R=null;return out;
}
window.BOT={play,LEVELS};
})();
