#!/usr/bin/env bash
# Builds the FFmpeg shipped with Chud Music, from the official source release, for Linux and
# Windows (cross-compiled with MinGW), on Fedora (WSL works):
#   sudo dnf install gcc make nasm diffutils pkgconf glibc-static mingw64-gcc mingw64-winpthreads-static
#   bash scripts/build-ffmpeg.sh            → build/vendor/ffmpeg-linux/ and build/vendor/ffmpeg/ (Windows)
#
# Audio only, FFmpeg's own code only: no external library is enabled (--disable-autodetect, no
# --enable-lib*), so the program is covered by the LGPL v2.1 or later alone — no third-party
# notices to collect. One static executable per platform, with LICENSE.txt and SOURCE.txt.
# Chud Music only uses it to convert audio Chromium cannot decode (ALAC, WMA, AIFF, WavPack, AC3,
# APE, TTA, DSD…) to FLAC: every native decoder and demuxer is kept, only the FLAC encoder/muxer.
set -euo pipefail

VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e # ffmpeg.org release tarball
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${FFMPEG_WORK:-$HOME/ffmpeg-build}"
TARBALL="ffmpeg-$VERSION.tar.xz"
URL="https://ffmpeg.org/releases/$TARBALL"
JOBS="${JOBS:-$(nproc)}"

mkdir -p "$WORK"
cd "$WORK"
[ -f "$TARBALL" ] || curl -fsSLO "$URL"
SUM="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
if [ -n "$SHA256" ] && [ "$SUM" != "$SHA256" ]; then echo "checksum mismatch: $SUM" >&2; exit 1; fi

COMMON=(
  --disable-autodetect --disable-doc --disable-debug --disable-network
  --disable-programs --enable-ffmpeg
  --disable-avdevice --disable-indevs --disable-outdevs --disable-hwaccels
  --disable-encoders --enable-encoder=flac
  --disable-muxers --enable-muxer=flac
  --disable-protocols --enable-protocol=file,pipe
  --enable-static --disable-shared
)

build() { # $1 = name, rest = configure options
  local name="$1"; shift
  local exe="src-$name/ffmpeg"; [ "$name" = win ] && exe="$exe.exe"
  if [ -f "$exe" ] && [ -z "${FORCE:-}" ]; then return; fi # already built (FORCE=1 rebuilds)
  rm -rf "src-$name"; mkdir "src-$name"
  tar -xf "$TARBALL" -C "src-$name" --strip-components=1
  (cd "src-$name" && ./configure "${COMMON[@]}" "$@" > ../configure-$name.log && make -j"$JOBS" "ffmpeg$( [ "$name" = win ] && echo .exe )" > ../make-$name.log 2>&1)
}

build linux --extra-ldflags=-static
build win --arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- --extra-ldflags=-static
x86_64-w64-mingw32-strip "src-win/ffmpeg.exe"
strip "src-linux/ffmpeg"

notice() { # $1 = output dir, $2 = exe name, $3 = build name
  local conf; conf="$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "src-$3/config.h")"
  cp "src-$3/COPYING.LGPLv2.1" "$1/LICENSE.txt"
  {
    echo "FFmpeg $VERSION — https://ffmpeg.org"
    echo "Chud Music runs this program ($2) as a separate executable to convert audio formats"
    echo "Chromium cannot decode. It is FFmpeg's unmodified source, built without any external"
    echo "library. You may replace it with another build of FFmpeg."
    echo
    echo "Licence: GNU LGPL version 2.1 or later (LICENSE.txt)."
    echo "Source: $URL (sha256 $SUM),"
    echo "also attached to every Chud Music release on GitHub."
    echo "Build script: scripts/build-ffmpeg.sh (static, $( [ "$3" = win ] && echo 'MinGW-w64 cross-compiler' || echo 'GCC, glibc static' ))."
    echo "Configuration: $conf"
  } | sed 's/$/\r/' > "$1/SOURCE.txt"
}

for p in linux win; do
  out="$ROOT/build/vendor/$( [ $p = win ] && echo ffmpeg || echo ffmpeg-linux )"
  rm -rf "$out"; mkdir -p "$out"
  exe=ffmpeg; [ $p = win ] && exe=ffmpeg.exe
  cp "src-$p/$exe" "$out/$exe"
  notice "$out" "$exe" "$p"
  echo "$out/$exe: $(du -h "$out/$exe" | cut -f1)"
done
echo "source: $WORK/$TARBALL sha256 $SUM"
