"""Turning OSM ways into existing-infrastructure candidates.

The mapping is deliberately CONSERVATIVE: an unprotected painted lane is
recorded as `buffered_painted`, never as anything "separated". Calling paint
protection is how a map starts lying about what is on the ground — and the
Centre St lane in Malden, a painted strip between a bus lane and a traffic
lane, is exactly the case that must not come back as a protected facility.

Offline: the Overpass response is a fixture, never a live call.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from fetch_existing_infra import features_from_osm, treatment_for  # noqa: E402

# A unit square area, lat 0..1 / lon 0..1.
SQUARE = [[[(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]]]


def way(wid, tags, pts=((0.5, 0.2), (0.5, 0.4))):
    return {"type": "way", "id": wid, "tags": tags,
            "geometry": [{"lat": la, "lon": lo} for la, lo in pts]}


def test_a_painted_lane_is_never_recorded_as_separated():
    assert treatment_for({"cycleway": "lane"}) == "buffered_painted"
    assert treatment_for({"cycleway:right": "lane"}) == "buffered_painted"
    # A track IS physically separated, so it may say so.
    assert treatment_for({"cycleway": "track"}) == "concrete_separated"


def test_an_off_street_way_becomes_a_shared_use_path():
    assert treatment_for({"highway": "cycleway"}) == "shared_use_path"
    assert treatment_for({"highway": "path",
                          "bicycle": "designated"}) == "shared_use_path"


def test_a_way_with_no_bike_tagging_is_not_a_candidate():
    assert treatment_for({"highway": "residential"}) is None


def test_candidates_are_existing_and_carry_osm_provenance():
    feats = features_from_osm({"elements": [way(1, {"highway": "cycleway",
                                                    "name": "Northern Strand"})]},
                              SQUARE, "Testville")
    assert len(feats) == 1
    f = feats[0]
    assert f.name == "Northern Strand"
    assert f.treatments[0].status == "existing"
    # Provenance is what lets the import sheet open the review list, and what
    # keeps OSM-derived content identifiable for the licence question.
    assert f.tags["source"] == "osm"
    assert f.treatments[0].tags["source"] == "osm"
    assert f.treatments[0].tags["osm_way"] == "1"


def test_a_way_entirely_outside_the_area_is_skipped():
    outside = way(2, {"highway": "cycleway"}, pts=((9.0, 9.0), (9.0, 9.2)))
    assert features_from_osm({"elements": [outside]}, SQUARE, "T") == []


def test_a_way_that_only_reaches_in_is_kept_for_the_app_to_clip():
    straddler = way(3, {"highway": "cycleway"}, pts=((0.5, 0.9), (0.5, 1.5)))
    assert len(features_from_osm({"elements": [straddler]}, SQUARE, "T")) == 1


def test_an_unnamed_way_still_gets_a_usable_name():
    feats = features_from_osm({"elements": [way(4, {"highway": "cycleway"})]},
                              SQUARE, "T")
    assert feats[0].name.startswith("Unnamed path")


def test_the_result_validates_as_a_network():
    from bikenetwork.network_format import Network, validate_network
    feats = features_from_osm(
        {"elements": [way(5, {"highway": "cycleway", "name": "Trail"})]},
        SQUARE, "T")
    assert validate_network(Network(features=feats)) == []
