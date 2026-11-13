#!/usr/bin/env python3
"""紹介動画（トレーラー、約56秒・1920×1080・30fps）を組み立てる。python3 build.py
入力: promo/work/rec/*.mp4（shoot.mjs → assemble.py）、promo/work/gfx/（gfx.py）、game/audio の BGM
出力: promo/work/trailer.mp4、itch.io 用のスクリーンショット promo/screenshots/*.jpg"""
import subprocess, os, sys, shutil
HERE=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.abspath(os.path.join(HERE,'..','..'))
WORK=os.environ.get('PROMO_WORK') or os.path.join(REPO,'promo','work')
T=os.path.join(WORK,'gfx'); R=os.path.join(WORK,'rec'); AU=os.path.join(REPO,'game','audio'); TMP=os.path.join(WORK,'build')
os.makedirs(TMP,exist_ok=True)
FPS=30
def run(a): subprocess.run(['ffmpeg','-y','-loglevel','error',*a],check=True)
def q(p): return "'"+str(p).replace("'","'\\''")+"'"  # concat のリスト用に ' をエスケープ
def duration(p): return float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',p],check=True,capture_output=True,text=True).stdout)

BATTLE_CROP=None
# (種類, 素材, 開始, 終了/長さ, 速さ, 切り出し, テロップ[(画像,出,消)], フェード)
SHOTS=[
 ('still','key_title',5.5,(1.0,1.10),[('intro1',0.5,5.1)],0.6),
 ('clip','map',1.0,9.4,1.4,None,[('map',0.3,5.7)],0.25),
 ('clip','refit',1.8,4.6,1.0,None,[('refit',0.15,2.6)],0.2),
 ('clip','refit',8.8,11.3,1.0,None,[('form',0.15,2.3)],0.2),
 ('clip','battle',6.0,24.0,2.0,BATTLE_CROP,[('battle1',0.3,4.4),('battle2',4.6,8.7)],0.25),
 ('still','key_xeno',4.0,(1.12,1.0),[('xeno',0.4,3.7)],0.5),
 ('clip','seraph',14.0,26.0,3.0,BATTLE_CROP,[('xenob',0.2,3.8)],0.2),
 ('still','show_seraph',3.6,(1.0,1.09),[('seraph',0.4,3.3)],0.4),
 ('clip','hive',34.0,61.0,3.0,BATTLE_CROP,[('hive',0.3,8.7)],0.25),
 ('still','key_victory',3.2,(1.0,1.07),[],0.5),
 ('end','endcard',6.5,None,[],0.8),
]
segs=[]; starts=[]; t=0
for i,s in enumerate(SHOTS):
    out=f'{TMP}/seg{i:02d}.mp4'; kind=s[0]
    if kind=='clip':
        _,src,ss,to,sp,crop,caps,fd=s; dur=(to-ss)/sp
        inp=['-ss',str(ss),'-to',str(to),'-i',f'{R}/{src}.mp4']
        v=f'[0:v]setpts=(PTS-STARTPTS)/{sp},fps={FPS}'+(','+crop if crop else '')+',format=yuv420p[v0]'
    elif kind=='still':
        _,src,dur,(z0,z1),caps,fd=s; n=round(dur*FPS)
        inp=['-loop','1','-framerate',str(FPS),'-t',str(dur),'-i',f'{T}/{src}.png']
        v=(f"[0:v]scale=3840:2160:flags=lanczos,zoompan=z='{z0}+({z1}-{z0})*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps={FPS},format=yuv420p[v0]")
    else:
        _,src,dur,_,caps,fd=s
        inp=['-loop','1','-framerate',str(FPS),'-t',str(dur),'-i',f'{T}/{src}.png']
        v=f"[0:v]scale=1920:1080,format=yuv420p[v0]"
    fc=[v]; last='v0'
    for k,(cap,a,b) in enumerate(caps):
        inp+=['-loop','1','-framerate',str(FPS),'-t',str(dur),'-i',f'{T}/cap_{cap}.png']
        fc.append(f'[{k+1}:v]format=rgba,fade=in:st={a}:d=0.3:alpha=1,fade=out:st={b-0.3}:d=0.3:alpha=1[c{k}]')
        fc.append(f'[{last}][c{k}]overlay=0:0:shortest=1,format=yuv420p[o{k}]'); last=f'o{k}'
    fc.append(f'[{last}]fade=in:st=0:d={fd},fade=out:st={dur-fd:.3f}:d={fd},trim=duration={dur:.3f}[vo]')
    run([*inp,'-filter_complex',';'.join(fc),'-map','[vo]','-r',str(FPS),'-c:v','libx264','-crf','14','-preset','medium','-pix_fmt','yuv420p',out])
    segs.append(out); starts.append(t); t+=dur
    print(f'{i:2d} {kind:5s} {s[1]:12s} {starts[-1]:5.2f}–{t:5.2f}',flush=True)
total=t
open(f'{TMP}/segs.txt','w').write(''.join(f"file {q(x)}\n" for x in segs))
run(['-f','concat','-safe','0','-i',f'{TMP}/segs.txt','-c','copy',f'{TMP}/video.mp4'])
# 音：前半は bgm-title、異生体の場面から bgm-crisis、勝利の画で se-win
tx=starts[5]; tv=starts[9]
CRISIS_FROM=34  # bgm-crisis はここ（秒）から使う
for f,need in [('bgm-title.mp3',tx+0.6),('bgm-crisis.mp3',CRISIS_FROM+total-tx+0.7)]:
    have=duration(f'{AU}/{f}')
    if have<need: sys.exit(f'{f} が {have:.1f}秒しかありません（{need:.1f}秒必要）。build.py の場面の長さか CRISIS_FROM を見直してください')
af=(f"[0:a]atrim=0:{tx+0.6},afade=t=in:d=0.4,afade=t=out:st={tx-0.6}:d=1.2,asetpts=PTS-STARTPTS[a0];"
    f"[1:a]atrim={CRISIS_FROM}:{CRISIS_FROM+total-tx+0.7},asetpts=PTS-STARTPTS,afade=t=in:d=0.8,adelay={int((tx-0.7)*1000)}|{int((tx-0.7)*1000)}[a1];"
    f"[2:a]volume=0.9,adelay={int((tv+0.2)*1000)}|{int((tv+0.2)*1000)}[a2];"
    f"[a0][a1][a2]amix=inputs=3:normalize=0:duration=longest,atrim=0:{total},afade=t=out:st={total-2.8}:d=2.8,loudnorm=I=-15:TP=-1.5:LRA=11[a]")
run(['-i',f'{AU}/bgm-title.mp3','-i',f'{AU}/bgm-crisis.mp3','-i',f'{AU}/se-win.mp3','-filter_complex',af,'-map','[a]','-ar','48000','-c:a','pcm_s16le',f'{TMP}/audio.wav'])
run(['-i',f'{TMP}/video.mp4','-i',f'{TMP}/audio.wav','-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest',f'{WORK}/trailer.mp4'])
print(f'紹介動画: {WORK}/trailer.mp4（{total:.1f}秒）')
# スクリーンショット（itch.io のページ用。録画の1コマ）
SS=os.path.join(REPO,'promo','screenshots'); os.makedirs(SS,exist_ok=True)
for name,src,at in [('1-map','map',3.6),('2-refit','refit',3.0),('3-battle','battle',19.6),('4-xeno','xeno',6.5),('5-hive','hive',59.5),('6-victory','hive',-0.5)]:
    pos=['-sseof',str(at)] if at<0 else ['-ss',str(at)]
    run([*pos,'-i',f'{R}/{src}.mp4','-frames:v','1','-q:v','2',f'{SS}/{name}.jpg'])
print('スクリーンショット:',SS)
