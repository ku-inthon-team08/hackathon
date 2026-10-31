# /// script
# requires-python = ">=3.10"
# dependencies = ["osmnx>=2.0"]
# ///
"""Build the demo area's walking network from OpenStreetMap as CSV for road_nodes / road_edges.

Writes <out>/<name>_road_nodes.csv and <out>/<name>_road_edges.csv for upload_graph.py.
Every edge geom starts at its source node, so a route can be stitched by checking
which end pgr_dijkstra entered from. Road data (c) OpenStreetMap contributors (ODbL).

    uv run scripts/road_network/build_graph.py
    uv run scripts/road_network/build_graph.py --place "Gangnam-gu, Seoul, South Korea" --name gangnam
"""

import argparse
import csv
from collections import Counter
from pathlib import Path

import osmnx as ox
import shapely

ROOT = Path(__file__).resolve().parents[2]


def tag(value):
    """Flatten an OSM tag value; osmnx keeps a list when merged ways disagree."""
    if isinstance(value, list):
        return ",".join(dict.fromkeys(map(str, value)))
    return "" if value is None or value != value else str(value)  # value != value catches NaN


def ewkt(geom):
    return "SRID=4326;" + shapely.to_wkt(geom, rounding_precision=7)


def main():
    parser = argparse.ArgumentParser(description="Build the walking network CSVs.")
    parser.add_argument("--place", default="Mapo-gu, Seoul, South Korea", help="area name for Nominatim")
    parser.add_argument("--buffer-m", type=float, default=300, help="widen the area so routes near the border work")
    parser.add_argument("--name", default="mapo", help="output file prefix")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "road_network")
    args = parser.parse_args()

    ox.settings.cache_folder = str(Path.home() / ".cache" / "osmnx")

    area = ox.projection.project_gdf(ox.geocode_to_gdf(args.place))
    print(f"area: {args.place} ({area.area.sum() / 1e6:.1f} km2, +{args.buffer_m:.0f} m buffer)")
    polygon = area.buffer(args.buffer_m).to_crs(epsg=4326).union_all()

    # "walk" = sidewalks, footways, crossings, steps and walkable roads (no transit).
    # retain_all=False (default) keeps only the largest connected piece, so every node is reachable.
    G = ox.graph_from_polygon(polygon, network_type="walk", simplify=False)
    # split wherever the road type changes, so each edge has exactly one highway value
    G = ox.convert.to_undirected(ox.simplify_graph(G, edge_attrs_differ=["highway"]))
    nodes, edges = ox.convert.graph_to_gdfs(G)
    edges = edges.reset_index()
    edges = edges[edges["u"] != edges["v"]].sort_values(["u", "v", "key"])  # self-loops never shorten a route

    args.out.mkdir(parents=True, exist_ok=True)
    nodes_path = args.out / f"{args.name}_road_nodes.csv"
    edges_path = args.out / f"{args.name}_road_edges.csv"

    with open(nodes_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "osm_id", "geom"])
        for osmid, point in zip(nodes.index, nodes.geometry):
            w.writerow([osmid, osmid, ewkt(point)])  # osm_id stays null only for nodes we add ourselves

    xy = dict(zip(nodes.index, zip(nodes["x"], nodes["y"])))
    with open(edges_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "source", "target", "length_m", "highway", "geom"])
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
        print(f"wrote {path.relative_to(ROOT).as_posix()} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
