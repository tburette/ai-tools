#!/usr/bin/env bash
if [ $# = 0 ]; then
  echo "missing arguments : "
  echo "$0 [URL] CSS-REF"
  exit 1
elif [ $# = 2 ]; then
  URL=$1
  shift
else
  URL="http://lepaysanurbain.test:8888/lpu-sections-patterns-test/"
fi
REF=$1
TMP=$(mktemp -d ~/Downloads/website-visual-diff/XXXXXX)
 
/home/tburette/dev/ai/ai-tools/website-visual-diff/scripts/run_visual_diff.mjs "$URL" \
  --css-ref "$REF" \
  --full-page \
  --output-dir $TMP \
  && open $TMP/index.html
