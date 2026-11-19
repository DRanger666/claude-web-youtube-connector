#!/bin/sh
# Stands in for "python3 gemini_video.py ..." in tests. The prompt says what to
# do: "SECONDS ok" writes an answer after SECONDS, "SECONDS fail" fails.
shift
while [ $# -gt 0 ]; do
  case $1 in
    --output) output=$2; shift ;;
    --prompt) prompt=$2; shift ;;
  esac
  shift
done
set -- $prompt
echo "attempt 1 with FAKE_KEY: 200 in $1s" >&2
sleep "$1"
if [ "$2" = fail ]; then
  echo "Fake Gemini failure" >&2
  exit 1
fi
printf 'Answer for: %s\n' "$prompt" > "$output"
echo "$output"
