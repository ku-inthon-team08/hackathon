# /// script
# requires-python = ">=3.10"
# dependencies = ["osmnx>=2.0", "osmium>=4.0"]
# ///
"""Build the walking network from OpenStreetMap as CSV for road_nodes / road_edges.

Writes <out>/<name>_road_nodes.csv and <out>/<name>_road_edges.csv for upload_graph.py.
Every edge geom starts at its source node, so a route can be stitched by checking
which end pgr_dijkstra entered from. Road data (c) OpenStreetMap contributors (ODbL).

    uv run scripts/road_network/build_graph.py                      # Mapo-gu (one area)
    uv run scripts/road_network/build_graph.py --place "Gangnam-gu, Seoul, South Korea" --name gangnam
    uv run scripts/road_network/build_graph.py --seoul              # all 25 gu -> seoul_*.csv
    uv run scripts/road_network/build_graph.py --seoul --pbf Seoul.osm.pbf

Overpass times out (or answers 502) when asked for all of Seoul at once, so --seoul asks for
one gu at a time. Each answer is cached (~/.cache/osmnx), so a rerun skips the gu that already
came back, and a failed gu is retried with a growing pause. The raw OSM ways of every gu are
merged first and the graph is simplified once, so roads that cross a gu border come out the
same as inside one gu.

--pbf reads a local OSM extract (e.g. https://download.bbbike.org/osm/bbbike/Seoul/) instead
of Overpass. It applies OSMnx's own "walk" filter to the extract and then follows the same
steps as ox.graph_from_polygon, so both sources give the same graph for the same OSM data.
"""

import argparse
import csv
import re
import time
from collections import Counter
from pathlib import Path

import osmnx as ox
import shapely

ROOT = Path(__file__).resolve().parents[2]

SEOUL_GU = [
    "Jongno-gu", "Jung-gu", "Yongsan-gu", "Seongdong-gu", "Gwangjin-gu", "Dongdaemun-gu",
    "Jungnang-gu", "Seongbuk-gu", "Gangbuk-gu", "Dobong-gu", "Nowon-gu", "Eunpyeong-gu",
    "Seodaemun-gu", "Mapo-gu", "Yangcheon-gu", "Gangseo-gu", "Guro-gu", "Geumcheon-gu",
    "Yeongdeungpo-gu", "Dongjak-gu", "Gwanak-gu", "Seocho-gu", "Gangnam-gu", "Songpa-gu",
    "Gangdong-gu",
]
NETWORK = "walk"
# ox.graph_from_polygon downloads 500 m past the area so that simplification near the border
# sees the real intersections, then cuts back to the area
DOWNLOAD_MARGIN_M = 500


def tag(value):
    """Flatten an OSM tag value; osmnx keeps a list when merged ways disagree."""
    if isinstance(value, list):
        return ",".join(dict.fromkeys(map(str, value)))
    return "" if value is None or value != value else str(value)  # value != value catches NaN


def ewkt(geom):
    return "SRID=4326;" + shapely.to_wkt(geom, rounding_precision=7)


def area_polygons(places, buffer_m):
    """Each place's polygon widened by buffer_m (WGS84), plus their union."""
    gdf = ox.projection.project_gdf(ox.geocode_to_gdf(places))
    print(f"area: {len(places)} place(s), {gdf.area.sum() / 1e6:.1f} km2, +{buffer_m:.0f} m buffer")
    crs = gdf.crs
    to_wgs84 = lambda geom: ox.projection.project_geometry(geom, crs=crs, to_latlong=True)[0]  # noqa: E731
    union = gdf.geometry.union_all()
    return (
        [to_wgs84(g.buffer(buffer_m + DOWNLOAD_MARGIN_M)) for g in gdf.geometry],
        to_wgs84(union.buffer(buffer_m)),
        to_wgs84(union.buffer(buffer_m + DOWNLOAD_MARGIN_M)),
    )


def download_overpass(name, polygon, attempts=6):
    """Overpass answers for one area. Waits 30 s, 60 s, ... (max 5 min) between failed tries."""
    for attempt in range(1, attempts + 1):
        try:
            return list(ox._overpass._download_overpass_network(polygon, NETWORK, None))
        except Exception as e:  # noqa: BLE001  502 / timeout / connection reset: all worth a retry
            if attempt == attempts:
                raise
            pause = min(30 * 2 ** (attempt - 1), 300)
            print(f"  {name}: {type(e).__name__}: {str(e)[:120]} -> retry {attempt}/{attempts - 1} in {pause}s")
            time.sleep(pause)


def filter_clauses(osm_filter):
    """Parse an Overpass way filter like ["highway"]["area"!~"yes"] into (key, op, value)."""
    clauses = re.findall(r'\["([^"]+)"(?:(!?~|!?=)"([^"]*)")?\]', osm_filter)
    if "".join(f"[{k}{op}{v}]" for k, op, v in clauses).count("[") != osm_filter.count("["):
        raise ValueError(f"could not parse the OSMnx filter: {osm_filter}")
    return clauses


def matches(tags, clauses):
    for key, op, value in clauses:
        have = tags.get(key)
        if op == "":
            ok = have is not None
        elif op == "~":
            ok = have is not None and re.search(value, have) is not None
        elif op == "!~":
            ok = have is None or re.search(value, have) is None
        elif op == "=":
            ok = have == value
        else:  # !=
            ok = have != value
        if not ok:
            return False
    return True


def read_pbf(path, polygon):
    """Overpass-like answer from a local extract: walkable ways with a node inside polygon, and their nodes.

    A way that leaves the extract loses the nodes outside it; it is split there instead of
    being joined across the gap. Those pieces lie at the extract's edge, outside the area.
    """
    import osmium
    from shapely import contains_xy, prepare

    clauses = filter_clauses(ox._overpass._get_network_filter(NETWORK))
    node_tag_keys = set(ox.settings.useful_tags_node)
    way_tag_keys = set(ox.settings.useful_tags_way)
    prepare(polygon)
    minx, miny, maxx, maxy = polygon.bounds

    node_tags, coords, ways = {}, {}, []
    split = 0
    for obj in osmium.FileProcessor(str(path)).with_locations():
        if obj.is_node():
            if obj.tags:
                tags = {t.k: t.v for t in obj.tags if t.k in node_tag_keys}
                if tags:
                    node_tags[obj.id] = tags
            continue
        if not obj.is_way():
            break  # relations come last and are not needed
        tags = {t.k: t.v for t in obj.tags}
        if not matches(tags, clauses):
            continue
        runs, run = [], []
        for n in obj.nodes:
            if n.location.valid():
                run.append((n.ref, n.location.lon, n.location.lat))
            elif run:
                runs.append(run)
                run = []
        runs.append(run)
        runs = [r for r in runs if len(r) >= 2]
        if not runs:
            continue
        xs = [x for r in runs for _, x, _ in r]
        ys = [y for r in runs for _, _, y in r]
        if max(xs) < minx or min(xs) > maxx or max(ys) < miny or min(ys) > maxy:
            continue
        if not contains_xy(polygon, xs, ys).any():
            continue
        split += len(runs) - 1
        kept = {k: v for k, v in tags.items() if k in way_tag_keys}
        for i, r in enumerate(runs):
            ways.append({"type": "way", "id": obj.id if i == 0 else -(obj.id * 1000 + i), "nodes": [ref for ref, _, _ in r], "tags": kept})
            coords.update((ref, (x, y)) for ref, x, y in r)

    elements = [
        {"type": "node", "id": ref, "lon": x, "lat": y, **({"tags": node_tags[ref]} if ref in node_tags else {})}
        for ref, (x, y) in coords.items()
    ]
    print(f"extract: {len(ways):,} walkable ways ({split:,} split at the extract edge), {len(elements):,} nodes")
    return [{"elements": elements + ways}]


def main():
    parser = argparse.ArgumentParser(description="Build the walking network CSVs.")
    parser.add_argument("--place", default="Mapo-gu, Seoul, South Korea", help="area name for Nominatim")
    parser.add_argument("--seoul", action="store_true", help="all 25 gu of Seoul, downloaded one gu at a time")
    parser.add_argument("--pbf", type=Path, help="read a local OSM extract (.osm.pbf) instead of Overpass")
    parser.add_argument("--buffer-m", type=float, default=300, help="widen the area so routes near the border work")
    parser.add_argument("--name", help="output file prefix (default: mapo, or seoul with --seoul)")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "road_network")
    args = parser.parse_args()
    name = args.name or ("seoul" if args.seoul else "mapo")
    places = [f"{gu}, Seoul, South Korea" for gu in SEOUL_GU] if args.seoul else [args.place]

    ox.settings.cache_folder = str(Path.home() / ".cache" / "osmnx")
    ox.settings.requests_timeout = 600  # also the [timeout:] Overpass gets: a large gu needs minutes

    download_polygons, polygon, polygon_dl = area_polygons(places, args.buffer_m)
    if args.pbf:
        responses = read_pbf(args.pbf, polygon_dl)
    else:
        responses = []
        for place, poly in zip(places, download_polygons):
            started = time.time()
            answers = download_overpass(place, poly)
            responses += answers
            count = sum(len(a.get("elements", [])) for a in answers)
            print(f"  {place}: {count:,} OSM elements ({time.time() - started:.0f}s)")

    # the same steps as ox.graph_from_polygon(polygon, network_type="walk", simplify=False),
    # with the raw OSM data of every gu merged before the graph is built
    G = ox.graph._create_graph(responses, bidirectional=NETWORK in ox.settings.bidirectional_network_types)
    del responses
    G = ox.truncate.largest_component(ox.truncate.truncate_graph_polygon(G, polygon_dl))
    # retain_all=False keeps only the largest connected piece, so every node is reachable
    G = ox.truncate.largest_component(ox.truncate.truncate_graph_polygon(G, polygon))
    print(f"raw graph: {len(G):,} nodes, {len(G.edges):,} directed edges")

    # split wherever the road type changes, so each edge has exactly one highway value
    G = ox.convert.to_undirected(ox.simplify_graph(G, edge_attrs_differ=["highway"]))
    nodes, edges = ox.convert.graph_to_gdfs(G)
    edges = edges.reset_index()
    edges = edges[edges["u"] != edges["v"]].sort_values(["u", "v", "key"])  # self-loops never shorten a route

    args.out.mkdir(parents=True, exist_ok=True)
    nodes_path = args.out / f"{name}_road_nodes.csv"
    edges_path = args.out / f"{name}_road_edges.csv"

    with open(nodes_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "osm_id", "geom"])
        for osmid, point in zip(nodes.index, nodes.geometry):
            w.writerow([osmid, osmid, ewkt(point)])  # osm_id stays null only for nodes we add ourselves

    xy = dict(zip(nodes.index, zip(nodes["x"], nodes["y"])))
    with open(edges_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "source", "target", "length_m", "highway", "geom"])
        # ids run 1..n over the whole merged graph, so no two edges share one
        for i, e in enumerate(edges.itertuples(index=False), start=1):
            line = e.geometry
            (x0, y0), (x1, y1), (ux, uy) = line.coords[0], line.coords[-1], xy[e.u]
            if (x1 - ux) ** 2 + (y1 - uy) ** 2 < (x0 - ux) ** 2 + (y0 - uy) ** 2:
                line = shapely.reverse(line)
            w.writerow([i, e.u, e.v, round(e.length, 2), tag(e.highway), ewkt(line)])

    highways = Counter(edges["highway"].map(tag))
    print(f"nodes: {len(nodes):,}  edges: {len(edges):,}  total length: {edges['length'].sum() / 1000:,.0f} km")
    print("top highway tags:", ", ".join(f"{k} {v:,}" for k, v in highways.most_common(8)))
    print("edges with mixed highway tags:", sum("," in h for h in highways.elements()))
    for path in (nodes_path, edges_path):
        shown = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path
        print(f"wrote {shown} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
