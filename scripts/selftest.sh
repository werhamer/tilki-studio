#!/usr/bin/env bash
# Tek bir otomatik kayıt testi çalıştırır ve çıkan dosyaları ffprobe ile doğrular.
#   bash scripts/selftest.sh <çıktı-klasörü> ['<ayar JSON>']
# Not: test sırasında pencere birkaç saniye en üstte kalır, iki kez beyaz parlar
# ve kısık bir bip sesi çıkarır (ses-görüntü senkronu ölçümü için).
set -u
out="$1"
json="${2:-}"
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$out"
export TILKI_SELFTEST_DIR="$out"
export TILKI_SELFTEST_SETTINGS="$json"
timeout 120 npx electron . --selftest > "$out/log.txt" 2>&1
echo "##### $(basename "$out") exit=$? ${json}"
grep -E '"ok"|"error"|videoCodec|hardware|audioCodec|"width"|"height"|"dropped"|maxLate' "$out/log.txt" | tr -s ' ' | tr '\n' ' '
echo
for f in "$out"/Tilki_2*.* "$out"/Tilki_Replay*.*; do
  [ -f "$f" ] || continue
  echo "-- $(basename "$f")"
  ffprobe -v error -show_entries stream=index,codec_name,width,height,avg_frame_rate,duration,nb_frames:stream_tags=title,handler_name,DURATION:format=duration,format_name -of compact "$f" | cut -c1-190
  ffmpeg -v error -i "$f" -f null - 2>&1 | head -3
done
