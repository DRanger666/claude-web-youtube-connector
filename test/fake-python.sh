#!/bin/sh
# Stands in for "python3 gemini_video.py ..." in tests. The prompt says what to
# do: "SECONDS ok" writes an answer after SECONDS, "SECONDS fail" fails. Like
# the script, it logs an attempt, then a summary line naming the settings it
# was given, then the error if it fails.
shift
settings=""
while [ $# -gt 0 ]; do
  case $1 in
    --output) output=$2; shift ;;
    --prompt) prompt=$2; shift ;;
    --caller|--model|--thinking-level|--max-output-tokens|--note) settings="$settings $1 $2"; shift ;;
  esac
  shift
done
set -- $prompt
echo "attempt 1 with FAKE_KEY: 200 in $1s" >&2
sleep "$1"
if [ "$2" = fail ]; then
  echo "request fake failed;$settings" >&2
  echo "Fake Gemini failure" >&2
  exit 1
fi
printf 'Answer for: %s\n' "$prompt" > "$output"
echo "request fake ok;$settings" >&2
echo "$output"
