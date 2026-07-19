#!/usr/bin/env python3
"""Serve the static web editor locally and open it in your browser.

    python web/serve.py          # or: python serve.py  (from inside web/)

Needed because the app is ES modules + fetch()ed data files, which browsers
refuse to load from file:// — any static HTTP server works, this is just the
zero-setup one.
"""
import functools
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8613
HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(HERE))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"Bike network builder (static) at {url}  (Ctrl+C to stop)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    server.serve_forever()
