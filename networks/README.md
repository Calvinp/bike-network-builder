# networks/

A place to keep network files that aren't part of the repo.

**The repo ships no network data** (V2_PLAN.md §7): `network.yaml` and
`base_network.yaml` were removed in v2, and the convention is that a network is
something you hold, share and import — not something the tool carries.

This folder is **gitignored except for this file**, so it's a safe place for:

- your working copy of a network you're editing outside the browser
- existing-conditions files for your area, and ones other groups send you
- `build.py` output — `python build.py -o networks/malden.yaml`

Nothing here is read automatically. To make a deployment *open* on one of
these, name it in `data/place.json` as the `seed_network` asset instead.

## Why there is no canonical location outside the repo

This folder is a **relative path inside the repo**, which is the only kind of
location that behaves the same on macOS, Linux and Windows. It is for the
Python side — `build.py`, `fetch_layers.py`, the validator — which only runs on
a desktop.

**The app itself has no filesystem at all.** It runs in a browser, including on
Android and iOS, where a page cannot choose where a download lands: it goes to
the browser's own location (Downloads on desktop and Android, Files or the
share sheet on iOS), and an import comes back through a file picker. Any
"canonical folder" the tool tried to define would be a desktop-only fiction
that mobile users could not follow.

So the tool doesn't try. What it does instead is make files **easy to
recognise wherever they land**: exports are named for the area and the date —
`malden-bike-network-2026-08-24.yaml` rather than `network.yaml` — so a
Downloads folder with three towns' networks in it is still legible, and so
`network (3).yaml` never happens.
