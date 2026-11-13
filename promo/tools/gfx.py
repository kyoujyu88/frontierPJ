#!/usr/bin/env python3
"""サムネイル（itch.io のカバー画像など）と、紹介動画のテロップ・タイトル画面の画像を作る。python3 gfx.py
必要なもの: Pillow、フォントの元ファイル local/_src/fonts/*.ttf（入手先は local/_src/fonts/SOURCES.txt）
出力: promo/cover_630x500.png・cover_1260x1000.png・thumb_1920x1080.png、promo/work/gfx/（動画用）"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import sys, os
HERE=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.abspath(os.path.join(HERE,'..','..'))
FD=os.path.join(REPO,'local','_src','fonts')+'/'
ART=os.path.join(REPO,'game','art')+'/'
PROMO=os.path.join(REPO,'promo')
WORK=os.environ.get('PROMO_WORK') or os.path.join(PROMO,'work')
OUT=os.path.join(WORK,'gfx')
AMBER=(242,184,75); INK=(236,238,248); DIM=(206,212,236)
def art(name):
    """キービジュアルの上下の黒帯（1024×576 の絵で上下12px）を除き、16:9 に切り出す。
    帯の幅は高さに対する比率で決めるので、同じ構図のまま解像度を変えた絵でも合う"""
    im=Image.open(ART+name).convert('RGB'); w,h=im.size
    assert abs(w/h-16/9)<0.02, f'{name} が 16:9 ではありません（{w}×{h}）。切り出し方を見直してください'
    bar=round(h*12/576); ch=h-2*bar; cw=round(ch*16/9); x0=(w-cw)//2
    return im.crop((x0,bar,x0+cw,bar+ch))
def font(name,size): return ImageFont.truetype(FD+name,size)
DOT=lambda s:font('DotGothic16-Regular.ttf',s)
BOLD=lambda s:font('BIZUDPGothic-Bold.ttf',s)
REG=lambda s:font('BIZUDPGothic-Regular.ttf',s)

def text_center(d,cx,y,txt,f,fill,stroke=0,sf=(0,0,0)):
    w=d.textlength(txt,font=f); d.text((cx-w/2,y),txt,font=f,fill=fill,stroke_width=stroke,stroke_fill=sf)

def caption(name,main,sub=None,W=1920,H=1080):
    im=Image.new('RGBA',(W,H),(0,0,0,0))
    band=Image.new('L',(1,H),0)
    for y in range(H):
        t=(y-(H-400))/300
        band.putpixel((0,y),int(max(0,min(1,t))**0.9*225))
    shade=Image.new('RGBA',(W,H),(4,6,16,255)); shade.putalpha(band.resize((W,H)))
    im=Image.alpha_composite(im,shade)
    d=ImageDraw.Draw(im)
    fm=BOLD(60); y=H-(205 if sub else 165)
    w=d.textlength(main,font=fm)
    d.rectangle([W/2-60,y-26,W/2+60,y-22],fill=AMBER+(255,))
    text_center(d,W/2,y,main,fm,INK+(255,),stroke=3,sf=(4,6,16,200))
    if sub: text_center(d,W/2,y+84,sub,REG(36),DIM+(255,),stroke=2,sf=(4,6,16,200))
    im.save(f'{OUT}/cap_{name}.png')

def logo(size, glow=True):
    """タイトルロゴ（DotGothic16・琥珀色・暗い縁取りと光）。RGBA を返す"""
    f=DOT(size); txt='辺境星系戦記'
    tmp=Image.new('RGBA',(10,10)); dd=ImageDraw.Draw(tmp)
    l,t,r,b=dd.textbbox((0,0),txt,font=f,stroke_width=size//14)
    pad=size//2; W=r-l+pad*2; H=b-t+pad*2
    im=Image.new('RGBA',(W,H),(0,0,0,0))
    if glow:
        g=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(g).text((pad-l,pad-t),txt,font=f,fill=(255,170,60,200))
        g=g.filter(ImageFilter.GaussianBlur(size/6)); im=Image.alpha_composite(im,g)
    d=ImageDraw.Draw(im)
    d.text((pad-l,pad-t),txt,font=f,fill=(255,214,120,255),stroke_width=size//14,stroke_fill=(30,16,4,255))
    # 上半分を明るく（金属感）
    hl=Image.new('RGBA',(W,H),(0,0,0,0)); ImageDraw.Draw(hl).text((pad-l,pad-t),txt,font=f,fill=(255,240,200,255))
    mask=Image.new('L',(W,H),0); md=ImageDraw.Draw(mask)
    for y in range(H): md.line([(0,y),(W,y)],fill=int(max(0,1-(y-pad)/((H-2*pad)*0.55))*150))
    hl.putalpha(Image.composite(hl.getchannel('A'),Image.new('L',(W,H),0),mask))
    im=Image.alpha_composite(im,hl)
    return im

def endcard():
    W,H=1920,1080
    bg=art('key_title.webp').resize((W,H),Image.LANCZOS)
    bg=ImageEnhance.Brightness(bg.filter(ImageFilter.GaussianBlur(6))).enhance(0.38)
    im=bg.convert('RGBA')
    lg=logo(170); im.alpha_composite(lg,((W-lg.width)//2,300))
    d=ImageDraw.Draw(im)
    text_center(d,W/2,300+lg.height+10,'ターン制 SF戦略シミュレーション',BOLD(50),INK,stroke=3,sf=(4,6,16))
    text_center(d,W/2,300+lg.height+90,'ブラウザで遊べます',REG(38),DIM,stroke=2,sf=(4,6,16))
    im.convert('RGB').save(f'{OUT}/endcard.png')
    # 動画用：ロゴだけ（背景透過）
    lg.save(f'{OUT}/logo.png')

def thumb(src,crop_cx,W,H,name,logo_size,tag_size,top=True):
    s=art(src)
    sw,sh=s.size; ar=W/H
    cw=min(sw,int(sh*ar)); ch=int(cw/ar)
    x0=max(0,min(sw-cw,int(crop_cx*sw-cw/2))); y0=(sh-ch)//2
    im=s.crop((x0,y0,x0+cw,y0+ch)).resize((W,H),Image.LANCZOS)
    im=ImageEnhance.Contrast(im).enhance(1.05).convert('RGBA')
    # ロゴの下に暗いグラデーション
    gh=int(H*0.48); grad=Image.new('L',(1,gh))
    for y in range(gh): grad.putpixel((0,y),int((1-y/gh)**1.4*235))
    sh_=Image.new('RGBA',(W,gh),(4,6,16,255)); sh_.putalpha(grad.resize((W,gh)))
    im.alpha_composite(sh_,(0,0))
    lg=logo(logo_size)
    if lg.width>W*0.96: lg=lg.resize((int(W*0.96),int(lg.height*W*0.96/lg.width)),Image.LANCZOS)
    im.alpha_composite(lg,((W-lg.width)//2,int(H*0.015)))
    d=ImageDraw.Draw(im)
    text_center(d,W/2,int(H*0.015)+lg.height-logo_size//2+int(logo_size*0.1),'ターン制 SF戦略シミュレーション',BOLD(tag_size),INK,stroke=max(2,tag_size//14),sf=(4,6,16))
    im.convert('RGB').save(f'{OUT}/{name}.png')

if __name__=='__main__':
    os.makedirs(OUT,exist_ok=True)
    caps=[('intro1','星暦3990年、辺境星系。','隣国ヴァルガ帝国が、国境に艦隊を集めている'),
          ('map','星系を開き、艦隊を整える','施設の建設・研究・造船・小惑星探査'),
          ('refit','艦ごとに能力を振り分ける改装','装甲・主砲・ミサイル・爆装・機関'),
          ('form','陣形は5種類','横陣・楔形・方陣・鶴翼・後衛陣'),
          ('battle1','マス目で戦う戦術戦闘','敵の旗艦★を沈めれば勝利'),
          ('battle2','側面・背面を突けば大打撃','オート戦闘にも切り替えられる'),
          ('xeno','暗黒宙域から、異生体「ゾア」が現れる',None),
          ('xenob','群れは深淵の巣から何度でも湧いてくる',None),
          ('seraph','対異生体戦艦「セラフ級」',None),
          ('hive','巣の中枢を、爆装で撃ち抜け',None)]
    for c in caps: caption(*c)
    endcard()
    for n in ['key_title','key_xeno','key_victory','show_seraph']: art(n+'.webp').save(f'{OUT}/{n}.png')
    # サムネイル：itch.io のカバー画像は 630×500 推奨（同じ比率の大きい版も）、動画用は 16:9
    thumb('key_title.webp',0.5,1260,1000,'cover_1260x1000',185,46)
    thumb('key_title.webp',0.5,1920,1080,'thumb_1920x1080',230,58)
    for n in ['cover_1260x1000','thumb_1920x1080']: os.replace(f'{OUT}/{n}.png',f'{PROMO}/{n}.png')
    Image.open(f'{PROMO}/cover_1260x1000.png').resize((630,500),Image.LANCZOS).save(f'{PROMO}/cover_630x500.png')
    print('サムネイル:',', '.join(f'promo/{n}.png' for n in ['cover_630x500','cover_1260x1000','thumb_1920x1080']))
