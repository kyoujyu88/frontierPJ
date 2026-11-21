#!/usr/bin/env python3
"""調整案のJSON（HTMLへの文字列置き換え）をパラメータから作る。
python3 gentune.py <name> key=value ...   例: python3 gentune.py v2 tierEvery=5 spawnEvery=2 spawnMax=3 ...
"""
import json,sys
P=dict(tierEvery=6,spawnEvery=3,spawnMax=3,ship4After=10,
       rFalco=120,rGrave=220,rArc=330,rSeraph=380,investCap=0,
       brood=42,drone=22,neo=8,brArmor=3,drArmor=2,acid=7,fang=6,hive=150,hiveGun=7,nest=36,initSpawn=2,xcap=2,xcapEvo=3,
       gate=-1,mine=15,mineRich=30,survey=20)
for a in sys.argv[2:]:
    k,v=a.split("=");P[k]=float(v) if "." in v else int(v)
name=sys.argv[1];E=[];desc=[]
def ed(a,b):E.append({"find":a,"replace":b})
if P["tierEvery"]!=6: ed("S.turn++;S.enemyTier=Math.min(3,Math.floor((S.turn-1)/6));",f"S.turn++;S.enemyTier=Math.min(3,Math.floor((S.turn-1)/{P['tierEvery']}));")
if (P["spawnEvery"],P["spawnMax"],P["ship4After"])!=(3,3,10):
  ed("if(S.turn%3===0&&S.fleets.filter(f=>f.side===\"E\").length<3){\n        const nf=vargaFleet(null,CAPITAL,3+(S.turn>10?1:0));",
     f"if(S.turn%{P['spawnEvery']}===0&&S.fleets.filter(f=>f.side===\"E\").length<{P['spawnMax']}){{\n        const nf=vargaFleet(null,CAPITAL,3+(S.turn>{P['ship4After']}?1:0));")
for nm,ty,hp,pts,cost,r0,key,code,extra in [("ファルコ級","駆逐艦",20,9,70,120,"rFalco","FC-3",""),("グレイヴ級","巡洋艦",30,12,110,220,"rGrave","GV-7",""),("アークライト級","戦艦",44,16,160,330,"rArc","AL-12",""),("セラフ級","対異生体戦艦",56,20,200,380,"rSeraph","SR-0",",anti:true")]:
  if P[key]!=r0: ed(f'{{name:"{nm}",type:"{ty}",hp:{hp},pts:{pts},cost:{cost},research:{r0},code:"{code}"{extra}}}',f'{{name:"{nm}",type:"{ty}",hp:{hp},pts:{pts},cost:{cost},research:{P[key]},code:"{code}"{extra}}}')
if P["investCap"]:
  ed("function invest(v){\n  S.funds-=v;S.research+=v;checkResearch();render();\n}",
     "function invest(v){\n  if(S.invTurn!==S.turn){S.invTurn=S.turn;S.invT=0}\n  if(S.invT+v>"+str(P['investCap'])+"){toast(\"研究への投資は1ターンに"+str(P['investCap'])+"までです。\");return}\n  S.invT+=v;S.funds-=v;S.research+=v;checkResearch();render();\n}")
if (P["brood"],P["drone"])!=(42,22): ed('const T={brood:{hp:42,name:"ゾア・ブルード"},drone:{hp:22,name:"ゾア・ドローン"}};',f'const T={{brood:{{hp:{P["brood"]},name:"ゾア・ブルード"}},drone:{{hp:{P["drone"]},name:"ゾア・ドローン"}}}};')
if P["neo"]!=8: ed("return{id:uid(),xeno:kind,neo,hp:T[kind].hp+(neo?8:0),maxHp:T[kind].hp+(neo?8:0)};",f"return{{id:uid(),xeno:kind,neo,hp:T[kind].hp+(neo?{P['neo']}:0),maxHp:T[kind].hp+(neo?{P['neo']}:0)}};")
if (P["brArmor"],P["drArmor"],P["acid"],P["fang"])!=(3,2,7,6):
  ed('hp:s.hp,maxHp:s.maxHp,armor:brood?3:2,move:brood?3:4,\n    w:[{n:brood?"酸弾":"牙",d:brood?7:6,',f'hp:s.hp,maxHp:s.maxHp,armor:brood?{P["brArmor"]}:{P["drArmor"]},move:brood?3:4,\n    w:[{{n:brood?"酸弾":"牙",d:brood?{P["acid"]}:{P["fang"]},')
if (P["hive"],P["nest"],P["hiveGun"])!=(150,36,7):
  ed('hp:isHive?150:isNest?36:16+p.def,armor:0,move:0,\n        w:[{n:"迎撃砲",d:isHive?7:5,',f'hp:isHive?{P["hive"]}:isNest?{P["nest"]}:16+p.def,armor:0,move:0,\n        w:[{{n:"迎撃砲",d:isHive?{P["hiveGun"]}:5,')
if P["initSpawn"]!=2: ed("spawnXeno();spawnXeno();S.funds+=150;","spawnXeno();"*P["initSpawn"]+"S.funds+=150;")
if (P["xcap"],P["xcapEvo"])!=(2,3): ed('S.fleets.filter(f=>f.side==="M").length<(S.evolved?3:2)&&planet(HIVE).owner==="H"',f'S.fleets.filter(f=>f.side==="M").length<(S.evolved?{P["xcapEvo"]}:{P["xcap"]})&&planet(HIVE).owner==="H"')
if P["gate"]>=0:
  ed('const HOME=0, CAPITAL=6, HIVE=12;',f'const HOME=0, CAPITAL=6, HIVE=12;\nconst HIVE_NONANTI={P["gate"]}; // 巣の中枢へのセラフ級以外の爆装の倍率（0=通らない）')
  ed('core={uid:uid(),side:"E",core:true,name:isHive?"巣の中枢"','core={uid:uid(),side:"E",core:true,hive:isHive,name:isHive?"巣の中枢"')
  ed('if(t.core&&!w.core&&att.side==="P")continue;','if(t.core&&!w.core&&att.side==="P")continue;\n    if(t.hive&&att.side==="P"&&!att.anti&&HIVE_NONANTI<=0)continue;')
  ed('*(att.anti&&t.xeno?1.5:1)*(10/(10+2*t.armor));','*(att.anti&&t.xeno?1.5:1)*(t.hive&&att.side==="P"&&!att.anti?HIVE_NONANTI:1)*(10/(10+2*t.armor));')
if (P["mine"],P["mineRich"])!=(15,30):
  ed('function planetIncome(p){return p.income+(hasF(p,"mine")?(p.trait==="鉱物"?30:15):0)}',f'function planetIncome(p){{return p.income+(hasF(p,"mine")?(p.trait==="鉱物"?{P["mineRich"]}:{P["mine"]}):0)}}')
  ed('desc:p=>`収入 +${p.trait==="鉱物"?30:15}`',f'desc:p=>`収入 +${{p.trait==="鉱物"?{P["mineRich"]}:{P["mine"]}}}`')
if P["survey"]!=20:
  ed('if(Math.random()<.45){p.income+=20;log(`${p.name}で鉱物資源帯を発見。収入+20。`)}',f'if(Math.random()<.45){{p.income+={P["survey"]};log(`${{p.name}}で鉱物資源帯を発見。収入+{P["survey"]}。`)}}')
json.dump({"name":name,"params":{k:v for k,v in P.items()},"edits":E},open(f"tune/{name}.json","w"),ensure_ascii=False,indent=1)
print(name,len(E),"edits")
