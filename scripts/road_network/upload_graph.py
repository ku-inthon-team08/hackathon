"""Upload the CSVs from build_graph.py into road_nodes / road_edges.

Goes through the REST API with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env, so no
DB password is needed. The tables come from supabase/migrations/*_init_schema.sql.
Rows are upserted by id, so re-running is safe. Pass --replace when switching to another
area: it deletes every road row first, and edge_cell / edge_road_prior / edge_area rows go with
them (on delete cascade). After uploading, run in SQL:
select public.refresh_edge_road_prior(); select public.rebuild_edge_weights();

    python scripts/road_network/upload_graph.py
    python scripts/road_network/upload_graph.py --name gangnam --replace
"""

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BATCH = 1000
TABLES = {  # upload order: road_edges.source/target reference road_nodes.id
    "road_nodes": {"id": int, "osm_id": int},
    "road_edges": {"id": int, "source": int, "target": int, "length_m": float},
}


def read_env(path):
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.lstrip().startswith("#"):
            env[key.strip()] = value.strip().strip("\"'")
    return env


class Rest:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": key, "Content-Type": "application/json"}
        if key.startswith("eyJ"):  # legacy JWT keys also go in Authorization; new sb_secret_ keys must not
            self.headers["Authorization"] = f"Bearer {key}"

    def call(self, method, path, body=None, prefer=None):
        headers = {**self.headers, **({"Prefer": prefer} if prefer else {})}
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.headers
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            hint = "\n-> apply the migrations first: npx supabase db push (see supabase/README.md)" if e.code == 404 else ""
            sys.exit(f"{method} {path.split('?')[0]}: HTTP {e.code} {detail}{hint}")


def read_rows(path, types):
    with open(path, newline="", encoding="utf-8") as f:
        return [{k: None if v == "" else types.get(k, str)(v) for k, v in row.items()} for row in csv.DictReader(f)]


def count(rest, table):
    return int(rest.call("HEAD", f"/{table}?select=id", prefer="count=exact")["Content-Range"].split("/")[-1])


def main():
    parser = argparse.ArgumentParser(description="Upload road_nodes / road_edges CSV to Supabase.")
    parser.add_argument("--name", default="mapo", help="file prefix used by build_graph.py")
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "road_network")
    parser.add_argument("--replace", action="store_true", help="delete all road rows (and per-edge data) first")
    args = parser.parse_args()

    env = read_env(ROOT / ".env")
    if not env.get("SUPABASE_URL") or not env.get("SUPABASE_SERVICE_ROLE_KEY"):
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
    rest = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    rows = {table: read_rows(args.data / f"{args.name}_{table}.csv", types) for table, types in TABLES.items()}

    for table in TABLES:
        count(rest, table)  # fails early with a hint if the tables don't exist yet
    if args.replace:
        for table in reversed(TABLES):
            rest.call("DELETE", f"/{table}?id=not.is.null")
    for table, table_rows in rows.items():
        for i in range(0, len(table_rows), BATCH):
            rest.call("POST", f"/{table}", table_rows[i:i + BATCH], prefer="resolution=merge-duplicates,return=minimal")
            print(f"\r{table}: {min(i + BATCH, len(table_rows)):,}/{len(table_rows):,}", end="", flush=True)
        print(f"\r{table}: uploaded {len(table_rows):,}, table now has {count(rest, table):,} rows")


if __name__ == "__main__":
    main()
