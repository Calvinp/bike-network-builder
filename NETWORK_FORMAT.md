# The bike-network YAML format (`network.yaml`), v2

One YAML file describes an entire bike network: the **areas** it covers, the
**authorities** who build things, the implementation **phases**, and every
**feature** — a place — with its **treatments** — the facilities built there.

It is bike-network-builder's portable interchange format: what Export writes is
exactly what Import reads, so files can be shared, versioned and passed around.
The format is deliberately simple and fully documented here so other software
can consume it too — treat it as a **stable contract**.

Implementations: `bikenetwork/network_format.py` (the reference reader and
validator) and `web/js/network_format.js`. Cross-implementation parity is
enforced by tests.

> **v2 is a break from v1.** v1 files (`format: malden-bike-network`) are
> upgraded on import and never written again; there is no downgrade export.
> See [Upgrading from v1](#upgrading-from-v1).

## Example

```yaml
format: bike-network
format_version: 2
crs: 'EPSG:4326'          # WGS84 lat/lon degrees — what GPS and GeoJSON use
units: metric             # storage unit; imperial is a display preference

meta:
  title: Malden Bike Network Vision
  license: ODbL-1.0
  contributors:
    - {name: Malden Safe Streets, kind: organization}

areas:
  - id: 'census:2510-0038805'
    name: Malden
    kind: municipality
    context: Massachusetts
    default_authority: malden
    boundary:                       # list of polygons; polygon = [outer, hole…]
      - - [[42.4512, -71.0721], [42.4498, -71.0605], ...]

authorities:
  - {id: malden,  name: City of Malden, level: municipal}
  - {id: massdot, name: MassDOT,        level: state}
  - {id: dcr,     name: DCR,            level: special, note: parkways}

phases:
  - id: core                        # stable identity — never renumbered
    number: 1                       # display order
    label: Core Network (quick-build spine)
    target_date: '2029'             # QUOTE IT — see Dates below

features:
  - id: f-main-st
    name: Main Street (Salem to Pleasant)
    on_street: Main Street
    start: Main Street & Salem Street
    end: Main Street & Pleasant Street
    treatments:
      - {id: t-main-qb, type: quick_build_separated, status: proposed,
         phase: core, authority: malden}
      - {id: t-main-cc, type: concrete_separated, status: proposed,
         phase: long-term, upgrades: [t-main-qb]}
    geometry:
      - - [42.428104, -71.071734]   # [latitude, longitude], degrees
        - [42.426829, -71.072530]

  - id: f-racks
    name: Malden Square racks
    treatments:
      - {id: t-racks, type: bike_parking, status: existing, quantity: 8}
    geometry:
      - [[42.4262, -71.0664]]       # ONE coordinate = a point
```

## The dividing rule

> **Anything describing the PLACE lives on the feature. Anything describing the
> FACILITY lives on the treatment.**

| Feature (the place) | Treatment (the facility) |
|---|---|
| `id`, `name`, `notes`, `tags` | `id`, `type`, `status`, `phase`, `authority` |
| `on_street`, `start`, `end` | `travel`, `sides`, `side`, `quantity` |
| `geometry` | `upgrades`, `proposed_by`, `notes`, `tags` |

Treatment fields may be **defaulted on the feature** and overridden per
treatment, so the common single-treatment case stays short:

```yaml
- id: f1
  name: Northern Strand Trail
  status: existing            # inherited by every treatment below
  authority: malden
  treatments:
    - {id: t1, type: shared_use_path}
    - {id: t2, type: street_trees, quantity: 120}
```

One feature carries several treatments when several things are built at one
place: a corridor that gets a bike lane now and a streetcar in 2040 is **one
feature with two treatments**, not two features with duplicated geometry.

## Top level

| key | required | meaning |
|---|---|---|
| `format` | yes | always `bike-network` |
| `format_version` | yes | currently `2`; tools reject newer versions |
| `crs` | no (default `EPSG:4326`) | WGS84 lat/lon degrees. Nothing else is supported |
| `units` | no (default `metric`) | the STORAGE unit. Imperial is a display preference, not a file format |
| `meta` | no | `title`, `description`, `created`, `updated`, `license`, `source_url`, `contributors`, `generated_by` |
| `areas` | yes | the geographies this network covers |
| `authorities` | no | who builds things — declared, not enumerated |
| `phases` | yes if anything is `proposed` | the implementation plan |
| `costs` | no | currency and any adjustments to the built-in rates |
| `features` | yes | the network itself |

Keys this version doesn't understand are **preserved untouched** on round-trip
(`ordinance_chapter` is the motivating case).

## Areas

| key | required | meaning |
|---|---|---|
| `id` | yes | stable and globally unique. Prefer a public registry id (`census:<GEOID>`, `osm:r<relation>`) so two people independently naming the same town agree |
| `name` | yes | "Malden" |
| `kind` | no (default `municipality`) | `municipality` \| `county` \| `tract` \| `state` \| `region` \| `custom` |
| `context` | no | what to say after the name — "Massachusetts". There is a Malden in Washington too |
| `default_authority` | no | the authority a new treatment here gets |
| `updated` | no | `YYYY[-MM[-DD]]` |
| `boundary` | no | a **multipolygon**: a list of polygons, each a list of rings, each a list of `[lat, lon]`. Ring 1 is the outer edge; any others are holes |
| `contributors`, `tags` | no | see below |

The boundary travels **inside the file** so a shared network is
self-describing: whoever receives it can draw and clip it with no lookup and no
network call.

## Authorities

Who would build a thing. Declared in the file rather than drawn from a fixed
list, because road ownership varies enormously: New York has county roads,
Massachusetts effectively doesn't, and DCR owns parkways that are neither
municipal nor MassDOT.

| key | required | meaning |
|---|---|---|
| `id` | yes | referenced by `treatment.authority` |
| `name` | yes | the DISPLAYED name, free text, never translated |
| `level` | no (default `municipal`) | `municipal` \| `county` \| `state` \| `federal` \| `special` \| `private`. Used only for rollups and defaults |
| `note` | no | free text |

## Phases

| key | required | meaning |
|---|---|---|
| `id` | yes | stable identity; `treatment.phase` references it |
| `number` | yes | display order and legend colour. A merge is free to renumber |
| `label` | no | "Core Network (quick-build spine)" |
| `target_date` | no | `YYYY`, `YYYY-MM` or `YYYY-MM-DD` — see Dates |
| `tags` | no | see below |

Identity and display order are separate on purpose: inserting a phase in the
middle renumbers, and every treatment reference keeps working.

## Features and treatments

Each feature:

| key | required | meaning |
|---|---|---|
| `id` | yes | unique across the whole file |
| `name` | yes | human name; duplicates are allowed |
| `on_street`, `start`, `end` | no | street and endpoint intersections, for generated documents |
| `notes` | no | free text |
| `treatments` | yes | at least one — a place with nothing built or proposed there isn't part of the network |
| `geometry` | yes | see below |
| `tags` | no | see below |

Each treatment:

| key | required | values / meaning |
|---|---|---|
| `id` | yes | unique across the whole file; `upgrades` references it |
| `type` | yes | a treatment id from the registry — see below |
| `status` | no (default `proposed`) | `existing` \| `under_construction` \| `funded` \| `proposed` |
| `phase` | required for `proposed` | a phase `id` |
| `authority` | no | an authority `id` |
| `travel` | no (default `two_way`) | `one_way` \| `two_way` — **which way you can ride**. For `one_way`, the point order of the geometry is the travel direction |
| `sides` | no (default `2`) | `1` \| `2` — **how many facilities exist**. Drives lane distance |
| `side` | no | `left` \| `right` \| `both` \| `median` \| `off_street`, relative to the geometry's point order |
| `quantity` | no | for counted treatments: how many trees, spaces, bollards |
| `upgrades` | no | a **list** of treatment ids this one replaces in a later phase |
| `proposed_by` | no | whose proposal this is — "the City's 2030 plan" vs. an advocacy ask |
| `notes`, `tags` | no | free text / see below |

`travel` and `sides` are separate because v1's single `directions` could not
express a **two-way cycle track on one side of the street** — one facility,
both directions — or a contraflow lane.

> ⚠️ Reversing a feature's geometry must also swap `side` between `left` and
> `right`, or the facility silently moves across the street.

## Geometry

`geometry` is a list of **parts**. A part is a list of one or more
`[lat, lon]` coordinates:

- **one coordinate → a point**
- **two or more → a line**

One feature may mix both — scattered trees plus a continuous row is one
feature. Coordinates are degrees, rounded to 6 decimals (~10 cm).

```yaml
geometry:
  - [[42.4251, -71.0662]]                          # a point
  - [[42.4280, -71.0717], [42.4268, -71.0725]]     # a line
```

There is no flat-versus-nested ambiguity: v1's `geometry` meant different
things depending on its shape, which is a trap for any consumer that meets a
combined path.

## Treatment types: the registry

`type` is resolved against the **treatment registry** — `data/treatments.json`,
shipped with the tool. The registry, not this spec, defines what can be
represented, which is what makes adding a new kind of improvement a data change
rather than a format change.

Each registry entry declares its `category` (only `bike` counts toward bicycle
lane distance), whether it is `linear` or `counted` (and in what `unit`), its
cost rates, which geometry kinds it applies to, its draw order and its style.

**A reader that meets a type it doesn't know does not fail.** It draws the
treatment neutrally, leaves it out of costs and lane totals, and reports it.
That is what lets a file written by a newer tool still open in an older one.

## Semantics every consumer agrees on

- **Lengths are derived, never stored.** Every consumer measures the geometry
  (geodesic) itself and clips it to the area boundary before computing any
  total, so a hand-edited file cannot disagree with its own geometry.
- **Only `bike`-category treatments count toward bicycle lane distance.** A bus
  lane or a row of trees on the same corridor must not inflate it.
- **Lane distance = corridor distance × `sides`.**
- **Upgrades count the corridor once, but every phase's work costs money.**
  When treatment B `upgrades` A, full-buildout totals count only B — A is
  *superseded*. Per-phase rows and the cost estimate still include both:
  building in 2028 and rebuilding in 2040 is two projects.
- **Treatment list order is INSIGNIFICANT.** Renderers order by the registry's
  draw rank; nothing may treat `treatments[0]` as primary. This is deliberate,
  so that a future key describing the arrangement of treatments across a street
  cross-section can be added without changing what existing files mean.
- **Structure is strict; vocabulary is lenient with a notice** — except where an
  unknown value would change the arithmetic. A malformed geometry or a dangling
  `upgrades` reference is an error that blocks import. An unknown `type` is a
  notice. An unknown `status` is an error, because it can't be bucketed as
  built-or-asked-for.
- **Ids share one namespace.** Areas, authorities, phases, features and
  treatments are all unique against each other, so a reference never has to say
  what kind of thing it points at.

## Dates ⚠️

`target_date` and `updated` are **strings**, always, and should be **quoted**.

YAML has an implicit timestamp type, and the two major implementations disagree
about it:

| YAML | PyYAML | js-yaml |
|---|---|---|
| `target_date: 2029-12-31` | a `date` object | a `Date` at **UTC midnight** |
| `target_date: 2029` | an **integer** | a **number** |
| `target_date: '2029-12-31'` | a string | a string |

An unquoted date read by js-yaml and formatted anywhere west of UTC renders a
day early. Writers must quote; readers should normalize a date object or number
back to `YYYY[-MM[-DD]]`.

## `tags`

An open key-value map, allowed on areas, phases, features and treatments.
**Preserved on round-trip, never interpreted, never shown in the UI.** It is the
pressure-release valve that keeps "can we also record the surface / the width /
the city's project number / which meeting approved it" from becoming a format
change every time.

```yaml
tags: {surface: asphalt, width_m: 2.4, city_project_id: 'TIP-12345', source: osm}
```

## Costs

```yaml
costs:
  currency: USD
  per_km:   {quick_build_separated: [95000, 310000]}   # optional overrides
  per_unit: {street_trees: [400, 1200]}
  by_area:
    'census:2510-0038805': {multiplier: 1.0}
    'census:2517-0062535': {multiplier: 1.15, per_km: {concrete_separated: [900000, 2600000]}}
```

All rates are per **kilometre** or per **unit**, in `currency`. Everything is
optional; with no `costs` block the registry's built-in ranges apply.

**If a file carries any override, exports say so.** These numbers end up on a
slide in front of a city council, and a footnote is the difference between a
planning estimate and a misleading one.

## Upgrading from v1

v1 files are recognised by `format: malden-bike-network` or
`format_version: 1`, and upgraded on import. The conversion is deterministic —
two people upgrading the same file get byte-identical output, which is what
makes their work mergeable.

| v1 | v2 |
|---|---|
| `city`, `state` | one entry in `areas` |
| `jurisdiction: city \| state` | `authority`, referencing declared authorities |
| `paths` + `spots` | one `features` list |
| `type` (or the `treatment` alias) | `treatments[0].type` |
| `kind` on a spot | `treatments[0].type` |
| a path's `id` | the **treatment's** id — that is what `upgrades` pointed at |
| `upgrades: <id>` | `upgrades: [<id>]` |
| `directions: 1 \| 2` | `travel` + `sides` |
| flat-or-nested `geometry` | a list of parts |
| a spot's `location` | a one-coordinate part |
| `phases[].phase` | `phases[].id` + `phases[].number` |
| `phases[].deadline` (free text) | `target_date`; unparseable text is kept in `tags.deadline_v1` |

Phase dates are the **only** part of the upgrade that can need a human: v1
deadlines were free text, so whatever parses is converted and the rest is
surfaced for someone to fill in. Nothing is invented on the user's behalf.

There is **no v2 → v1 downgrade export.**
