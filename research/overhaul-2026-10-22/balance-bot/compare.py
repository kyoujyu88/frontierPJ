#!/usr/bin/env python3
"""python3 -I compare.py label=file.jsonl ...  — 変種ごとの主要指標を並べる"""
import json,sys,statistics as st
def load(f): return [json.loads(l) for l in open(f)]
def m(a): return st.mean(a) if a else float('nan')
rows=[]
for arg in sys.argv[1:]:
    lab,fn=arg.split("=",1); R=load(fn)
    for lv in ['novice','normal','good']:
        rs=[r for r in R if r['level']==lv]
        if not rs: continue
        n=len(rs); w=[r for r in rs if r['result']=='win']
        bs=[b for r in rs for b in r['battles'] if b['result']]
        fE=[b for b in bs if b['kind']=='fleet' and b['foe']=='E']; fM=[b for b in bs if b['kind']=='fleet' and b['foe']=='M']
        hw=[b for b in bs if b['kind']=='hive' and b['result']=='win']
        phase=[r['endTurn']-r['monsterTurn'] for r in w if r['monsterTurn']]
        lostE=m([sum(1 for c in r['captures'] if c['from']=='P' and c['to']=='E') for r in rs])
        lostM=m([sum(1 for c in r['captures'] if c['from']=='P' and c['to']=='M') for r in rs])
        t3=[r['tierTurn'].get('3') for r in rs if r['tierTurn'].get('3')]; t4=[r['tierTurn'].get('4') for r in rs if r['tierTurn'].get('4')]
        loss=m([(b['myHp0']-b['myHp1'])/max(1,b['myHp0']) for b in fE+fM])
        lostShips=m([sum(b.get('myLost',0) for b in r['battles'] if b['result']) for r in rs])
        ff=[r['finalFunds'] for r in rs]
        f20=[r['funds'][19] for r in rs if len(r['funds'])>19]
        rows.append(dict(lab=lab,lv=lv,n=n,win=len(w)/n,lose=sum(r['result']=='lose' for r in rs)/n,to=sum(r['result']=='timeout' for r in rs)/n,
          wt=m([r['endTurn'] for r in w]),mon=m([r['monsterTurn'] for r in rs if r['monsterTurn']]),phase=m(phase),
          noSer=(sum(1 for b in hw if 4 not in b['myCls'])/len(hw)) if hw else float('nan'),t3=m(t3),t4=m(t4),
          fEw=sum(b['result']=='win' for b in fE)/max(1,len(fE)),fMw=sum(b['result']=='win' for b in fM)/max(1,len(fM)),loss=loss,ships=lostShips,
          lostE=lostE,lostM=lostM,f20=m(f20),ff=m(ff),ff500=sum(x>=500 for x in ff)/n,bat=len(bs)/n))
hdr="変種     段階 n  勝  負  切れ 勝ちT 出現T 異生体期間 巣勝ちでセラフ無し アークT セラフT 対ヴァ艦隊勝 対異艦隊勝 艦隊戦自損 失艦/局 星喪失E 星喪失M 資金T20 終了資金 終了500+ 戦闘/局"
print(hdr)
L={'novice':'下手','normal':'普通','good':'上手'}
for r in rows:
    print(f"{r['lab']:8s} {L[r['lv']]} {r['n']:3d} {r['win']:4.0%} {r['lose']:4.0%} {r['to']:4.0%} {r['wt']:5.1f} {r['mon']:5.1f} {r['phase']:6.1f} {r['noSer']:8.0%} {r['t3']:6.1f} {r['t4']:6.1f} {r['fEw']:7.0%} {r['fMw']:7.0%} {r['loss']:7.2f} {r['ships']:6.1f} {r['lostE']:6.1f} {r['lostM']:6.1f} {r['f20']:7.0f} {r['ff']:7.0f} {r['ff500']:6.0%} {r['bat']:5.1f}")
