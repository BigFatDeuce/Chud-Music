#!/usr/bin/env bash
# Generates tagged test tracks with embedded covers into tests/fixtures/music (needs ffmpeg).
set -euo pipefail
cd "$(dirname "$0")"
OUT=music
mkdir -p "$OUT" covers
q() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# Covers
q -f lavfi -i "gradients=s=600x600:c0=0xff3fa4:c1=0x2b0a5e:c2=0xc6ff2e:nb_colors=3:type=spiral:d=1" -frames:v 1 covers/neon.png
q -f lavfi -i "mandelbrot=s=600x600:end_scale=0.4" -frames:v 1 covers/aurora.png
q -f lavfi -i "gradients=s=600x600:c0=0x0a2a5c:c1=0x3fd8ff:type=radial:d=1" -frames:v 1 covers/aqua.png

# Small synth "songs": a bass pulse + an arpeggio, different key per track
song() { # $1=root Hz  $2=seconds
  echo "aevalsrc='0.35*sin(2*PI*($1/2)*t)*exp(-6*mod(t,0.5))+0.18*sin(2*PI*$1*pow(2,floor(mod(t*4,4))*4/12)*t)*exp(-3*mod(t,0.25))+0.05*(random(0)*2-1)*exp(-30*mod(t+0.25,0.5))':s=44100:d=$2"
}

# with_cover <root> <secs> <cover> <codec args...> -- <title> <artist> <album> <track> <file>
make() {
  local root=$1 secs=$2 cover=$3 title=$4 artist=$5 album=$6 track=$7 file=$8
  shift 8
  local meta=(-metadata "title=$title" -metadata "artist=$artist" -metadata "album=$album" -metadata "track=$track")
  if [[ -n "$cover" ]]; then
    q -f lavfi -i "$(song "$root" "$secs")" -i "covers/$cover" -map 0:a -map 1:v -c:v png -disposition:v attached_pic "$@" "${meta[@]}" -ac 2 "$OUT/$file"
  else
    q -f lavfi -i "$(song "$root" "$secs")" "$@" "${meta[@]}" -ac 2 "$OUT/$file"
  fi
}

make 220 40 neon.png   "Minuit Chrome"       "Les Cassettes" "Néon Boulevard" 1 "01 - Minuit Chrome.mp3"       -c:a libmp3lame -b:a 192k -id3v2_version 3
make 247 35 neon.png   "Boulevard des Ondes" "Les Cassettes" "Néon Boulevard" 2 "02 - Boulevard des Ondes.mp3" -c:a libmp3lame -b:a 192k -id3v2_version 3
make 196 45 aurora.png "Fractale"            "Aurora Static" "Aurora"         1 "Fractale.flac"                -c:a flac
make 262 30 aqua.png   "Verre Bleu"          "Aqua Glow"     "Lumières 2003"  1 "Verre Bleu (ALAC).m4a"        -c:a alac
make 175 30 ""         "Média Classique"     "Player 2000"   "Rétro"          1 "Media Classique.wma"          -c:a wmav2
q -f lavfi -i "$(song 294 25)" -c:a libmp3lame -map_metadata -1 -ac 2 "$OUT/Artiste Mystère - Sans Tags.mp3"
echo "ok: $(ls "$OUT" | wc -l) files in $OUT"
