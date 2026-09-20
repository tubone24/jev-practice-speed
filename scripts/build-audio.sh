#!/usr/bin/env bash
# public/audio/*.mp3 を素材から組み立て直すスクリプト。
#
# 素材はすべて CC0（パブリックドメイン相当）。出典は README の「効果音」節を参照。
# 取得先を .sfx-src/ に展開してから実行する:
#
#   mkdir -p .sfx-src && cd .sfx-src
#   curl -LO https://opengameart.org/sites/default/files/independent_nu_ljudbank-hits_and_punches.7z
#   curl -LO https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip
#   curl -LO https://opengameart.org/sites/default/files/sfx_100_v2.zip
#   curl -LO https://opengameart.org/sites/default/files/sfx_breaking_and_falling.zip
#   curl -LO https://opengameart.org/sites/default/files/water-splash-slime-sfx.zip
#   curl -LO https://opengameart.org/sites/default/files/sci-fi-sfx.zip
#   for z in *.zip; do unzip -oq "$z" -d "${z%.zip}"; done
#   mkdir -p hits && tar -xf independent_nu_ljudbank-hits_and_punches.7z -C hits
#
# 必要なもの: ffmpeg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.sfx-src"
OUT="$ROOT/public/audio"
mkdir -p "$OUT"

HIT="$SRC/hits/hits"
C0="$SRC/100-CC0-SFX_0"
V2="$SRC/sfx_100_v2"
BF="$SRC/sfx_breaking_and_falling"
WA="$SRC/water-splash-slime-sfx"
SF="$SRC/sci-fi-sfx"

# 共通の出力設定。ピークを揃えてから 128kbps mp3 に落とす
ENC=(-c:a libmp3lame -b:a 128k -ar 44100 -ac 2)
LIM="alimiter=limit=0.94:level=false,aformat=sample_fmts=fltp"

say() { printf '  → %s\n' "$1"; }

# ---------------------------------------------------------------- 1手ぶんの打撃

say 'place.mp3 — 自分がカードを置く（軽く鋭い打撃）'
ffmpeg -y -v error -i "$HIT/hit25.mp3.flac" \
  -af "atrim=0:0.42,asetpts=N/SR/TB,highpass=f=200,afade=t=out:st=0.34:d=0.08,volume=2.2,$LIM" \
  "${ENC[@]}" "$OUT/place.mp3"

say 'place-cpu.mp3 — Jev が置く（低く鈍い打撃）'
ffmpeg -y -v error -i "$HIT/hit12.mp3.flac" \
  -af "atrim=0:0.45,asetpts=N/SR/TB,asetrate=44100*0.82,aresample=44100,lowpass=f=3200,afade=t=out:st=0.38:d=0.1,volume=2.0,$LIM" \
  "${ENC[@]}" "$OUT/place-cpu.mp3"

# ---------------------------------------------------------------- コンボの属性

say 'combo-water.mp3 — 3連鎖: 水'
ffmpeg -y -v error -i "$WA/splash_08.ogg" -i "$WA/splash_12.ogg" \
  -filter_complex "[0:a]volume=2.4[a];[1:a]adelay=70|70,volume=1.7[b];[a][b]amix=inputs=2:normalize=0:duration=longest,highpass=f=120,$LIM" \
  "${ENC[@]}" "$OUT/combo-water.mp3"

say 'combo-fire.mp3 — 5連鎖: 炎'
ffmpeg -y -v error -i "$SF/rocket_01.ogg" -i "$SF/explosion_02.ogg" \
  -filter_complex "[0:a]atrim=0.15:1.5,asetpts=N/SR/TB,lowpass=f=5500,volume=2.6[a];\
[1:a]adelay=260|260,lowpass=f=4200,volume=1.6[b];\
[a][b]amix=inputs=2:normalize=0:duration=longest,afade=t=out:st=1.5:d=0.35,$LIM" \
  "${ENC[@]}" "$OUT/combo-fire.mp3"

say 'combo-thunder.mp3 — 7連鎖: 雷'
ffmpeg -y -v error -i "$V2/sfx100v2_thunder_01.ogg" -i "$BF/bfh1_metal_hit_03.ogg" \
  -filter_complex "[0:a]atrim=0.70:2.60,asetpts=N/SR/TB,volume=3.4[a];\
[1:a]highpass=f=900,volume=1.5[b];\
[a][b]amix=inputs=2:normalize=0:duration=longest,afade=t=out:st=1.6:d=0.3,$LIM" \
  "${ENC[@]}" "$OUT/combo-thunder.mp3"

say 'combo-god.mp3 — 10連鎖: OVERDRIVE'
ffmpeg -y -v error -i "$SF/explosion_01.ogg" -i "$C0/gong_01.ogg" -i "$V2/sfx100v2_thunder_01.ogg" -i "$HIT/hit08.mp3.flac" \
  -filter_complex "[0:a]volume=2.2[a];\
[1:a]adelay=110|110,volume=1.5[b];\
[2:a]atrim=0.72:2.30,asetpts=N/SR/TB,adelay=180|180,volume=2.6[c];\
[3:a]volume=2.4[d];\
[a][b][c][d]amix=inputs=4:normalize=0:duration=longest,$LIM" \
  "${ENC[@]}" "$OUT/combo-god.mp3"

# ---------------------------------------------------------------- 状態の合図

say 'foul.mp3 — お手付き（ブザー + 鈍い打撃）'
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=147:duration=0.62" \
  -f lavfi -i "sine=frequency=139:duration=0.62" \
  -i "$HIT/hit05.mp3.flac" \
  -filter_complex "[0:a]volume=0.55[s1];[1:a]volume=0.55[s2];\
[s1][s2]amix=inputs=2:normalize=0[buzz];\
[buzz]atrim=0:0.62,asetpts=N/SR/TB,lowpass=f=900,afade=t=out:st=0.44:d=0.18,aformat=channel_layouts=stereo[bz];\
[2:a]atrim=0:0.5,asetpts=N/SR/TB,lowpass=f=1600,volume=1.4[hh];\
[bz][hh]amix=inputs=2:normalize=0:duration=longest,$LIM" \
  "${ENC[@]}" "$OUT/foul.mp3"

say 'break.mp3 — コンボが途切れる'
ffmpeg -y -v error -i "$BF/bfh1_glass_hit_01.ogg" \
  -af "volume=1.6,lowpass=f=6000,$LIM" "${ENC[@]}" "$OUT/break.mp3"

say 'flip.mp3 — 手詰まりで台札をめくる'
ffmpeg -y -v error -i "$C0/paper_01.ogg" \
  -af "volume=2.2,$LIM" "${ENC[@]}" "$OUT/flip.mp3"

say 'speed-call.mp3 — 手詰まりで「スピード！」を宣言する'
ffmpeg -y -v error \
  -i "$V2/sfx100v2_air_01.ogg" -i "$C0/bell_03.ogg" -i "$C0/slam_05.ogg" \
  -filter_complex "[0:a]atrim=0.05:0.50,asetpts=N/SR/TB,highpass=f=500,volume=1.6,afade=t=in:st=0:d=0.10[w];\
[1:a]adelay=200|200,volume=1.3[r];\
[2:a]adelay=190|190,volume=1.9[s];\
[w][r][s]amix=inputs=3:normalize=0:duration=longest,afade=t=out:st=1.1:d=0.4,$LIM" \
  "${ENC[@]}" "$OUT/speed-call.mp3"

say 'danger.mp3 — 相手がリーチに入った（ピンチの警告）'
ffmpeg -y -v error -i "$C0/gong_02.ogg" \
  -af "atrim=0:1.0,asetpts=N/SR/TB,asetrate=44100*0.72,aresample=44100,lowpass=f=2200,volume=1.7,$LIM" \
  "${ENC[@]}" "$OUT/danger.mp3"

say 'chance.mp3 — 自分がリーチに入った'
ffmpeg -y -v error -i "$C0/bell_02.ogg" \
  -af "asetrate=44100*1.18,aresample=44100,volume=1.5,$LIM" "${ENC[@]}" "$OUT/chance.mp3"

# ---------------------------------------------------------------- フィニッシュ

# 「バチッ」(高域の一撃) → 「コーン」(銅鑼の余韻) を作るために
# 溜めの風切り → 重い打撃 + スラム + 爆発 → 銅鑼 + 雷 → 締めの鐘 を重ねる。
finish() {
  local out="$1" tail="$2" tailrate="$3" tailvol="$4"
  ffmpeg -y -v error \
    -i "$SRC/sfx_100_v2/sfx100v2_air_01.ogg" \
    -i "$HIT/hit08.mp3.flac" \
    -i "$C0/slam_07.ogg" \
    -i "$SF/explosion_01.ogg" \
    -i "$C0/gong_01.ogg" \
    -i "$V2/sfx100v2_thunder_01.ogg" \
    -i "$tail" \
    -filter_complex "\
[0:a]atrim=0.05:0.24,asetpts=N/SR/TB,volume=0.5,afade=t=in:st=0:d=0.14,highpass=f=400[w];\
[1:a]adelay=180|180,volume=3.0[p];\
[2:a]adelay=180|180,volume=2.2[s];\
[3:a]adelay=200|200,volume=2.0[e];\
[4:a]adelay=230|230,volume=2.4[g];\
[5:a]atrim=0.72:2.60,asetpts=N/SR/TB,adelay=260|260,volume=2.6[t];\
[6:a]asetrate=44100*$tailrate,aresample=44100,adelay=1050|1050,volume=$tailvol[k];\
[w][p][s][e][g][t][k]amix=inputs=7:normalize=0:duration=longest,\
afade=t=out:st=2.5:d=0.6,$LIM" \
    "${ENC[@]}" "$out"
}

say 'finish-win.mp3 — バチコーン!!（勝ち: 締めが上に抜ける鐘）'
finish "$OUT/finish-win.mp3" "$C0/bell_01.ogg" "1.12" "1.7"

say 'finish-lose.mp3 — バチコーン!!（負け: 締めが沈む銅鑼）'
finish "$OUT/finish-lose.mp3" "$C0/gong_02.ogg" "0.70" "1.6"

echo
ls -lh "$OUT"
