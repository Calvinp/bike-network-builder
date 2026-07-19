# The bike-network YAML format (`network.yaml`)

One YAML file describes an entire bike network: city metadata, implementation
phases, and **every path — existing, funded, and proposed** — with its type,
phase, and exact geometry. It is bike-network-builder's portable interchange
format: what Export writes is exactly what Import reads, so files can be
shared, versioned, and passed around. The format is deliberately simple and
fully documented here so other software can consume it as well — treat it as
a **stable contract** (`network_format.py` implements it; a change old
readers can't understand must bump `format_version`).

## Example

```yaml
format: malden-bike-network
format_version: 1
city: Malden
state: Massachusetts
phases:
  - phase: 1
    label: Core Network (quick-build spine)
    deadline: December 31, 2029
  - phase: 2
    label: Connector Network
    deadline: December 31, 2032
paths:
  - name: Main Street (Salem to Pleasant)
    type: quick_build_separated
    status: proposed
    jurisdiction: city
    phase: 1
    directions: 2
    on_street: Main Street
    from: Main Street & Salem Street
    to: Main Street & Pleasant Street
    notes: Downtown spine.
    geometry:
      - [42.428104, -71.071734]   # [latitude, longitude], degrees
      - [42.426829, -71.07253]
  - name: Northern Strand Trail
    type: shared_use_path
    status: existing              # existing paths carry no phase
    jurisdiction: city
    directions: 2
    geometry:                     # a COMBINED path: several segments, one entry
      - - [42.421774, -71.066661]
        - [42.422375, -71.062099]
      - - [42.423011, -71.058442]
        - [42.423755, -71.054918]
```

## Fields

Top level:

| key | required | meaning |
|---|---|---|
| `format` | yes | always `malden-bike-network` |
| `format_version` | yes | currently `1`; tools reject newer versions |
| `city`, `state` | no (default Malden, Massachusetts) | used in map titles and generated documents |
| `ordinance_chapter` | no | optional municipal-code chapter reference; preserved on round-trip, never shown in the editor UI |
| `phases` | yes if any path is `proposed` | list of `{phase, label, deadline}`; `phase` is a positive integer, `deadline` free text |
| `paths` | yes | the network itself |

Each path:

| key | required | values / meaning |
|---|---|---|
| `name` | yes | human name; duplicates are allowed |
| `type` | yes | `quick_build_separated` \| `concrete_separated` \| `shared_use_path` \| `buffered_painted` \| `neighborway` |
| `status` | no (default `proposed`) | `proposed` (the new ask) \| `funded` (approved, unbuilt) \| `existing` (on the ground) |
| `jurisdiction` | no (default `city`) | `city` \| `state` (a MassDOT route the city must request — excluded from the mandate/cost) |
| `phase` | required for `proposed` | must appear in the top-level `phases` list; omit for `funded`/`existing` |
| `directions` | no (default `2`) | `2` = a facility each way, `1` = one-way. Drives *bicycle lane miles* (= corridor-miles × directions, the Cambridge/Somerville convention). For a one-way path, the **point order of the geometry is the travel direction** (maps draw an arrow) |
| `on_street`, `from`, `to` | no | street + endpoint intersections, for generated documents |
| `notes` | no | free text |
| `geometry` | yes | either **one segment** — a flat list of ≥ 2 `[lat, lon]` points — or **several segments** (a list of such lists), for one facility whose line is interrupted (e.g. a trail crossing streets). Degrees, rounded to 6 decimals (~10 cm) |

## Semantics every consumer agrees on

- **Lengths are derived, never stored.** Every consumer measures the geometry
  (geodesic/haversine) itself, and clips it to the city boundary before
  computing any total, so hand-edited files can't smuggle in stale mileage.
- **Only `proposed` + `jurisdiction: city` paths** count toward the build
  mandate and cost. `state` paths become requests to MassDOT; `funded` and
  `existing` are context.
- Parsers are lenient (unknown keys ignored, `treatment` accepted as a legacy
  alias for `type`); **validators are strict** and return human-readable
  errors — the builder shows them verbatim when you import a file.
