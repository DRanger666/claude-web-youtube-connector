#!/bin/sh
# Stands in for an installed skill older than this connector: its Gemini
# script rejects the options it does not know, as argparse does.
echo "usage: gemini_video.py [-h] --video-url VIDEO_URL ..." >&2
echo "gemini_video.py: error: unrecognized arguments: --caller connector" >&2
exit 2
