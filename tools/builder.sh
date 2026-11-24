#!/bin/sh
# Open the Archform builder locally: rebuild index.html from src/, serve it, open the browser.
# Usage: tools/builder.sh   (Ctrl+C to stop)
set -e
cd "$(dirname "$0")/../builder"
python3 build.py
PORT=8765
(sleep 1 && open "http://127.0.0.1:$PORT/") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
