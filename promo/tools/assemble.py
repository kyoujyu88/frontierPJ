#!/usr/bin/env python3
"""shoot.mjs が保存したコマ（時刻つき）を 30fps の mp4 にする。python3 assemble.py [場面…]（省略でぜんぶ）"""
import json, os, subprocess, sys
q = lambda p: "'" + str(p).replace("'", "'\\''") + "'"  # concat のリスト用に ' をエスケープ
WORK = os.environ.get("PROMO_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "work")
names = sys.argv[1:] or sorted(n for n in os.listdir(f"{WORK}/rec") if os.path.isdir(f"{WORK}/rec/{n}"))
for name in names:
    d = f"{WORK}/rec/{name}"; fr = json.load(open(f"{d}/times.json"))["frames"]
    lines = []
    for i, ts in enumerate(fr):  # 各コマを次のコマまでの時間だけ見せる（画面が止まっている間はコマが来ない）
        nxt = fr[i + 1] if i + 1 < len(fr) else ts + 0.5
        lines.append(f"file {q(f'{d}/{i:05d}.jpg')}\nduration {max(nxt - ts, 0.001):.4f}")
    lines.append(f"file {q(f'{d}/{len(fr) - 1:05d}.jpg')}")
    open(f"{d}/list.txt", "w").write("\n".join(lines))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{d}/list.txt",
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "medium", f"{WORK}/rec/{name}.mp4"], check=True)
    print(f"{name}.mp4  {fr[-1] - fr[0]:.1f}秒")
