#!/usr/bin/env python3
"""Simple static server for the built Co-Viewer SPA.

Usage:
    python3 serve.py [port]        # default port 8000

Serves the ./dist folder if it exists (run `npm run build` first),
otherwise falls back to the project root. The app only uses the
`?room=<id>` query parameter (no path-based routing), so a plain
static file server is sufficient for local testing / simple hosting.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
ROOT = DIST if os.path.isdir(DIST) else HERE
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):
        pass  # quiet


if __name__ == "__main__":
    print(f"Co-Viewer serving {ROOT}")
    print(f"  -> http://localhost:{PORT}/")
    print("  (Ctrl+C to stop)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
