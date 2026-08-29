"""Fetch the context "map layers" reference data into data/layers/.

Like build.py this is a manual, NETWORKED script (never run by tests): run it
occasionally to refresh the data, review the diff, and check the results in.
The editor and the HTML export read whatever data/layers/ holds; layers that
fail to fetch simply stay at their previous checked-in version.

    python fetch_layers.py                 # refresh everything
    python fetch_layers.py --skip-crashes  # only the OSM layers

Layers:
  bike-parking            OSM amenity=bicycle_parking (nodes + way centers)
  street-trees            OSM natural=tree (coverage depends on OSM mappers)
  crashes-bike-ped        MassDOT open data: crashes involving a bicyclist or
                          pedestrian (all severities)
  crashes-fatal-serious   the subset with a fatality or suspected serious injury

If the MassDOT endpoint moves (it has before), pass --crash-url with the new
per-year MapServer query URL, or export manually from the IMPACT portal
(apps.impact.dot.state.ma.us) and drop the GeoJSON into data/layers/.

The bounding box is derived from the boundary named in data/place.json, so pointing
this script (and the boundary file) at another city needs no code changes.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from bikenetwork.osm import USER_AGENT, OverpassClient
from bikenetwork.place import BBOX_PAD_LAYERS, load_place

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LAYERS = DATA / "layers"
PLACE = load_place(ROOT)

# Per-year MassDOT crash MapServers (f=geojson supported on layer 0 "Crash").
# {year} is substituted; some years carry a suffix (2023 is "...2023v"), so
# the fetcher tries the plain name first, then with a "v".
CRASH_URL_TEMPLATE = ("https://gis.crashdata.dot.mass.gov/arcgis/rest/services/"
                      "MassDOT/MASSDOT_ODP_OPEN_{year}{suffix}/MapServer/0/query")
CRASH_YEARS_BACK = 10   # how many years of crashes to request
CRASH_FIELDS = ("CRASH_DATETIME,CRASH_SEVERITY_DESCR,MAX_INJR_SVRTY_CL,"
                "NON_MTRST_TYPE_CL,NUMB_FATAL_INJR,NUMB_NONFATAL_INJR,YEAR")


def boundary_bbox(pad: float = BBOX_PAD_LAYERS):
    """(south, west, north, east) around the deployment's boundary.

    Derived from data/place.json, so another town needs no code change. The
    layer padding is deliberately tighter than the one OSM street resolution
    uses — a tree layer shouldn't drag in a thousand trees from next door.
    """
    bbox = PLACE.bbox(pad=pad)
    if bbox is None:
        raise SystemExit("no boundary to derive a bounding box from — check "
                         "the 'boundary' asset in data/place.json")
    return bbox


def overpass_point_features(result: dict, keep_tags: dict) -> list:
    """Overpass elements -> GeoJSON Point features (way/relation use 'center').

    `keep_tags` maps an OSM tag to the plain-language property name we store.
    Popups in the editor and the exported map show property names verbatim to
    non-technical readers, so the renaming happens HERE — the layer code stays
    generic and knows nothing about any particular dataset.
    """
    features = []
    for el in result.get("elements", []):
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            center = el.get("center") or {}
            lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        tags = el.get("tags") or {}
        props = {label: tags[tag] for tag, label in keep_tags.items()
                 if tags.get(tag)}
        features.append({"type": "Feature",
                         "geometry": {"type": "Point",
                                      "coordinates": [round(lon, 6), round(lat, 6)]},
                         "properties": props})
    return features


def fetch_bike_parking(client: OverpassClient, bbox) -> list:
    b = ",".join(str(x) for x in bbox)
    ql = (f'[out:json][timeout:90];'
          f'(node["amenity"="bicycle_parking"]({b});'
          f'way["amenity"="bicycle_parking"]({b}););out center;')
    return overpass_point_features(client.query(ql), {
        "capacity": "Spaces", "covered": "Covered", "bicycle_parking": "Rack type"})


def fetch_street_trees(client: OverpassClient, bbox) -> list:
    b = ",".join(str(x) for x in bbox)
    ql = f'[out:json][timeout:90];node["natural"="tree"]({b});out;'
    return overpass_point_features(client.query(ql), {
        "species": "Species", "genus": "Genus", "leaf_type": "Leaf type"})


def _http_json(url: str, params: dict) -> dict:
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def fetch_crashes(city_name: str, crash_url: str | None) -> list:
    """All bike/ped-involved crashes for the last CRASH_YEARS_BACK years, as
    GeoJSON Point features. Raises on total failure; individual missing years
    are skipped (services only exist for recent years)."""
    this_year = _dt.date.today().year
    features, got_any = [], False
    for year in range(this_year - CRASH_YEARS_BACK + 1, this_year + 1):
        urls = ([crash_url.format(year=year)] if crash_url else
                [CRASH_URL_TEMPLATE.format(year=year, suffix=s) for s in ("", "v")])
        params = {
            "where": (f"CITY_TOWN_NAME='{city_name.upper()}' AND "
                      f"(NON_MTRST_TYPE_CL LIKE '%Bicyclist%' OR "
                      f"NON_MTRST_TYPE_CL LIKE '%Pedestrian%')"),
            "outFields": CRASH_FIELDS,
            "outSR": "4326",
            "f": "geojson",
        }
        for url in urls:
            try:
                data = _http_json(url, params)
            except Exception:
                continue
            if "features" not in data:
                continue
            for feat in data["features"]:
                geom = feat.get("geometry") or {}
                if geom.get("type") == "Point" and geom.get("coordinates"):
                    lon, lat = geom["coordinates"][:2]
                    feat["geometry"]["coordinates"] = [round(lon, 6), round(lat, 6)]
                    feat["properties"] = crash_properties(feat.get("properties") or {})
                    features.append(feat)
            got_any = True
            print(f"  {year}: {len(data['features'])} bike/ped crashes")
            break
    if not got_any:
        raise RuntimeError("no crash year could be fetched")
    return features


# MassDOT KABCO severity codes -> plain words. "Serious" and "Fatal" also
# decide which crashes land in the fatal/serious layer (is_fatal_or_serious).
SEVERITY_LABELS = {
    "Fatal injury (K)": "Fatal",
    "Suspected Serious Injury (A)": "Serious injury",
    "Suspected Minor Injury (B)": "Minor injury",
    "Possible Injury (C)": "Possible injury",
    "No Apparent Injury (O)": "No apparent injury",
    "Property damage only (none injured)": "Property damage only",
    "Non-fatal injury": "Injury",
}


def crash_properties(raw: dict) -> dict:
    """MassDOT's coded fields -> the plain language a resident reads in a popup.
    Raw names like NON_MTRST_TYPE_CL (and epoch-millisecond dates) are useless
    to the audience for this tool, so they never reach the layer file."""
    out = {}
    stamp = raw.get("CRASH_DATETIME")
    if isinstance(stamp, (int, float)):
        # ArcGIS returns epoch milliseconds, UTC.
        when = _dt.datetime.fromtimestamp(stamp / 1000, _dt.timezone.utc)
        out["Date"] = f"{when.strftime('%B')} {when.day}, {when.year}"
    elif raw.get("YEAR"):
        out["Year"] = str(raw["YEAR"])

    # The most specific severity lives in the max-injury field — the crash-level
    # one only says fatal / non-fatal. Both carry KABCO codes ("(A)", "(K)")
    # that mean nothing to a resident, so map them to plain words.
    severity = str(raw.get("MAX_INJR_SVRTY_CL") or "").strip()
    if not severity or "Unknown" in severity or "Not Reported" in severity:
        severity = str(raw.get("CRASH_SEVERITY_DESCR") or "").strip()
    if severity:
        out["Severity"] = SEVERITY_LABELS.get(severity, severity)

    # e.g. " VU1: Bicyclist, VU2: Pedestrian" -> "Bicyclist, Pedestrian"
    involved = str(raw.get("NON_MTRST_TYPE_CL") or "")
    parts = [p.split(":", 1)[-1].strip() for p in involved.split(",") if p.strip()]
    parts = [p for p in dict.fromkeys(parts) if p and p.lower() != "not applicable"]
    if parts:
        out["Involved"] = ", ".join(parts)

    for key, label in (("NUMB_FATAL_INJR", "People killed"),
                       ("NUMB_NONFATAL_INJR", "People injured")):
        try:
            n = int(float(raw.get(key) or 0))
        except (TypeError, ValueError):
            n = 0
        if n:
            out[label] = n
    return out


def is_fatal_or_serious(props: dict) -> bool:
    """Runs on the already-renamed properties from crash_properties()."""
    if props.get("People killed"):
        return True
    severity = str(props.get("Severity", ""))
    return "Fatal" in severity or "Serious" in severity


def features_extent(features: list):
    """(south, west, north, east) covering a layer's features, or None.

    Recorded in the manifest so the app can HIDE a layer that has nothing to
    say about the area on screen. MassDOT crash data is meaningless outside
    Massachusetts; showing an empty layer there is a small lie, and a layer
    list full of them is a useless one.
    """
    lats, lons = [], []

    def walk(coords):
        if (isinstance(coords, (list, tuple)) and len(coords) == 2
                and all(isinstance(v, (int, float)) for v in coords)):
            lons.append(coords[0])
            lats.append(coords[1])
            return
        for c in coords if isinstance(coords, (list, tuple)) else []:
            walk(c)

    for feat in features:
        walk((feat.get("geometry") or {}).get("coordinates") or [])
    if not lats:
        return None
    return [min(lats), min(lons), max(lats), max(lons)]


_EXTENTS: dict = {}


def write_layer(layer_id: str, features: list) -> None:
    LAYERS.mkdir(parents=True, exist_ok=True)
    out = LAYERS / f"{layer_id}.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                              separators=(",", ":")), encoding="utf-8")
    extent = features_extent(features)
    if extent:
        _EXTENTS[layer_id] = extent
    print(f"  wrote {out.relative_to(ROOT)} ({len(features)} features, "
          f"{out.stat().st_size / 1024:.0f} KB)")


# Manifest entries (style colors are Okabe-Ito, matching the map palette).
LAYER_MANIFEST = [
    {"id": "bike-parking", "label": "Bike parking (existing)",
     "description": "Bike racks mapped in OpenStreetMap.",
     "style": {"color": "#0072B2", "radius": 4},
     "attribution": "© OpenStreetMap contributors",
     "source": "https://overpass-api.de"},
    {"id": "street-trees", "label": "Street trees",
     "description": "Trees mapped in OpenStreetMap (coverage varies).",
     "style": {"color": "#009E73", "radius": 3},
     "attribution": "© OpenStreetMap contributors",
     "source": "https://overpass-api.de"},
    {"id": "crashes-bike-ped", "label": "Bike & pedestrian crashes",
     "description": "Crashes involving a bicyclist or pedestrian, 2021 on "
                    "(MassDOT publishes this service from 2021).",
     "style": {"color": "#E69F00", "radius": 4},
     "attribution": "MassDOT IMPACT crash data",
     "source": "https://gis.crashdata.dot.mass.gov"},
    {"id": "crashes-fatal-serious", "label": "Fatal & serious-injury crashes",
     "description": "The subset of bike/ped crashes with a death or "
                    "suspected serious injury.",
     "style": {"color": "#D55E00", "radius": 5},
     "attribution": "MassDOT IMPACT crash data",
     "source": "https://gis.crashdata.dot.mass.gov"},
    # The national floor. Serious-injury data is state by state, but FATAL
    # crashes are published for the whole country with coordinates, so an area
    # outside Massachusetts still has something honest to show.
    {"id": "crashes-fatal-nationwide",
     "label": "Fatal crashes (nationwide)",
     "description": "Bicyclist and pedestrian deaths from NHTSA FARS. "
                    "Nationwide, but fatalities only — serious-injury data is "
                    "published state by state.",
     "style": {"color": "#D55E00", "radius": 5},
     "attribution": "NHTSA FARS",
     "source": "https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/"},
]


def write_manifest() -> None:
    """Manifest lists only layers whose .geojson actually exists, so a failed
    fetch never advertises a broken layer.

    Existing extents are preserved for layers this run didn't refresh, so
    `--skip-crashes` doesn't quietly strip them.
    """
    existing = {}
    manifest_path = LAYERS / "layers.json"
    if manifest_path.exists():
        try:
            for old in json.loads(manifest_path.read_text(encoding="utf-8")).get("layers", []):
                if old.get("extent"):
                    existing[old["id"]] = old["extent"]
        except (ValueError, OSError):
            pass
    for layer_id, extent in existing.items():
        _EXTENTS.setdefault(layer_id, extent)
    today = _dt.date.today().isoformat()
    entries = []
    for entry in LAYER_MANIFEST:
        if (LAYERS / f"{entry['id']}.geojson").exists():
            item = dict(entry, fetched=today)
            # The app hides a layer whose extent misses the area on screen.
            extent = _EXTENTS.get(entry["id"])
            if extent:
                item["extent"] = [round(v, 4) for v in extent]
            entries.append(item)
    (LAYERS / "layers.json").write_text(
        json.dumps({"layers": entries}, indent=2), encoding="utf-8")
    print(f"  manifest: {len(entries)} layer(s)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skip-osm", action="store_true",
                    help="don't refresh the OpenStreetMap layers")
    ap.add_argument("--skip-crashes", action="store_true",
                    help="don't refresh the MassDOT crash layers")
    ap.add_argument("--city-name",
                    default=PLACE.fetch.get("crash_city_name") or PLACE.name,
                    help="city name in the crash data "
                         f"(default: {PLACE.fetch.get('crash_city_name') or PLACE.name})")
    ap.add_argument("--crash-url", default=None,
                    help="override the per-year crash query URL "
                         "({year} is substituted)")
    args = ap.parse_args(argv)

    failures = []
    if not args.skip_osm:
        bbox = boundary_bbox()
        client = OverpassClient(bbox=bbox)
        for layer_id, fetch in (("bike-parking", fetch_bike_parking),
                                ("street-trees", fetch_street_trees)):
            print(f"{layer_id}: querying OpenStreetMap…")
            try:
                write_layer(layer_id, fetch(client, bbox))
            except Exception as e:
                failures.append(layer_id)
                print(f"  FAILED ({e}) — previous data (if any) kept.")

    if not args.skip_crashes:
        print("crashes: querying MassDOT open data…")
        try:
            crashes = fetch_crashes(args.city_name, args.crash_url)
            write_layer("crashes-bike-ped", crashes)
            write_layer("crashes-fatal-serious",
                        [f for f in crashes
                         if is_fatal_or_serious(f.get("properties") or {})])
        except Exception as e:
            failures.append("crashes")
            print(f"  FAILED ({e}).\n"
                  f"  The MassDOT endpoint may have moved. Options:\n"
                  f"   - pass --crash-url with the new per-year query URL\n"
                  f"   - or export manually: apps.impact.dot.state.ma.us ->\n"
                  f"     Crash Data Portal -> filter city + vulnerable users ->\n"
                  f"     export GeoJSON -> save as data/layers/crashes-bike-ped.geojson\n"
                  f"  Previous data (if any) kept.")

    write_manifest()
    if failures:
        print(f"done with failures: {', '.join(failures)}")
        return 1
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
