"""web/serve.py is a dev script, but one behaviour is load-bearing enough to
pin: it must refuse a port something else already serves.

Windows treats SO_REUSEADDR as a licence to hijack — a second serve.py binds
the same port, prints its cheerful startup line, and then the ORIGINAL server
goes on answering every request. Start one in a git worktree while an older
server from the main checkout is still up and the page looks stale forever:
Ctrl-Shift-R and a second browser change nothing, because the bytes on the
wire really are the other checkout's. Same class of ghost as the caching one
NoCacheHandler exists to prevent.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "web"))
import serve  # noqa: E402


def test_a_busy_port_is_refused_not_hijacked():
    first = serve.make_server(port=0)  # 0 — let the OS pick a free one
    try:
        with pytest.raises(OSError):
            serve.make_server(port=first.server_address[1]).server_close()
    finally:
        first.server_close()


def test_the_banner_names_the_directory_being_served():
    """Which checkout a server serves is exactly the fact you need when a
    page looks stale, so the startup line has to say it out loud."""
    assert str(serve.HERE) in serve.banner(serve.PORT, serve.HERE)


def test_a_second_checkout_can_pick_another_port():
    assert serve.parse_args([]).port == serve.PORT
    assert serve.parse_args(["--port", "8614"]).port == 8614
