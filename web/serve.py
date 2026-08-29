#!/usr/bin/env python3
"""Serve the static web editor locally and open it in your browser.

    python web/serve.py             # or: python serve.py  (from inside web/)
    python web/serve.py --no-browser    # don't open a tab (restarting a lot)
    python web/serve.py --port 9000     # serve somewhere else

Needed because the app is ES modules + fetch()ed data files, which browsers
refuse to load from file:// — any static HTTP server works, this is just the
zero-setup one. It serves with caching disabled so an edit always shows up on
the next reload (see NoCacheHandler).
"""
import argparse
import functools
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8613
HERE = Path(__file__).resolve().parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serve everything with caching switched off.

    The default handler sends only Last-Modified, which lets a browser apply
    *heuristic* caching: it may reuse a file for a while without asking the
    server whether it changed. ES modules get this treatment too, so after an
    edit the page can keep running the previous app.js — and since a plain
    reload revalidates the HTML but not always its module graph, the app looks
    like it silently ignored the change. A dev server should never do that.
    """

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_header(self, keyword, value):
        # Drop Last-Modified: without it there is nothing to cache heuristically.
        if keyword.lower() == "last-modified":
            return
        super().send_header(keyword, value)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-n", "--no-browser", action="store_true",
                    help="don't open a browser tab (handy when you're "
                         "restarting the server repeatedly)")
    ap.add_argument("-p", "--port", type=int, default=PORT,
                    help=f"port to listen on (default: {PORT})")
    args = ap.parse_args()

    handler = functools.partial(NoCacheHandler, directory=str(HERE))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"Bike network builder (static) at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    server.serve_forever()
