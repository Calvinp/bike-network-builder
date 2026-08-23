#!/usr/bin/env python3
"""Serve the static web editor locally and open it in your browser.

    python web/serve.py                 # or: python serve.py (from inside web/)
    python web/serve.py --port 8614     # a second checkout, side by side

Needed because the app is ES modules + fetch()ed data files, which browsers
refuse to load from file:// — any static HTTP server works, this is just the
zero-setup one. It serves with caching disabled so an edit always shows up on
the next reload (see NoCacheHandler), refuses a port someone else already
serves (see Server), and prints the folder it serves, because "which checkout
am I looking at?" is the question behind most stale-looking pages.
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


class Server(ThreadingHTTPServer):
    """A server that will not quietly shadow another one.

    ThreadingHTTPServer inherits allow_reuse_address = 1, and on Windows that
    is a licence to hijack: a second serve.py binds the SAME port, prints its
    cheerful startup line, and then the first server goes on answering every
    request. Run one from a git worktree while an older one from the main
    checkout is still up and the page looks stale forever — Ctrl-Shift-R and a
    second browser change nothing, because the bytes on the wire really are
    the other checkout's. Refusing the port turns that into an error message.
    """

    allow_reuse_address = False


def make_server(port: int = PORT, directory: Path = HERE) -> Server:
    handler = functools.partial(NoCacheHandler, directory=str(directory))
    return Server(("127.0.0.1", port), handler)


def banner(port: int, directory: Path) -> str:
    return (f"Bike network builder (static) at http://127.0.0.1:{port}"
            f"  (Ctrl+C to stop)\n  serving {directory}")


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=PORT,
                    help=f"port to listen on (default {PORT}); use another "
                         f"one to serve a second checkout alongside the first")
    return ap.parse_args(argv)


def main(argv=None) -> None:
    port = parse_args(argv).port
    try:
        server = make_server(port)
    except OSError as exc:
        raise SystemExit(
            f"Cannot serve on port {port}: {exc}\n"
            f"Something is already serving it — very likely another "
            f"serve.py from a different checkout, which is what your browser "
            f"would keep showing you. Stop that one, or run this with "
            f"--port {port + 1}.") from exc
    url = f"http://127.0.0.1:{port}"
    print(banner(port, HERE))
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
