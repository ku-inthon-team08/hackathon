"""고정 데이터를 Supabase에 적재한다.

    .venv/bin/python scripts/load_static.py hotspots
    .venv/bin/python scripts/load_static.py places
    .venv/bin/python scripts/load_static.py shelters  # 쉼터 후보: 공공·작은도서관, 주민센터, 공원(마포구)
    .venv/bin/python scripts/load_static.py sensors   # S-DoT 설치 위치 xlsx(환경·유동인구) → sensors
    .venv/bin/python scripts/load_static.py seed      # S-DoT 과거 CSV → sensor_obs

데이터 파일은 레포 바로 위 폴더(DATA_DIR)에 둔다.

.env의 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY로 REST API에 upsert한다.
"""
import glob
import json
import os
import sys
import urllib.request
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT.parent))

# 시연 지역: 마포구 홍대입구–연남–합정 (minLng, minLat, maxLng, maxLat)
BBOX = (126.905, 37.543, 126.935, 37.568)


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def upsert(table, rows, on_conflict):
    url = f"{os.environ['SUPABASE_URL']}/rest/v1/{table}?on_conflict={on_conflict}"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(
        url,
        data=json.dumps(rows).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        sys.exit(f"{table} upsert 실패: {e.code} {e.read().decode()}")
    print(f"{table}: {len(rows)}건 upsert")


def in_bbox(b):
    return not (b[2] < BBOX[0] or b[0] > BBOX[2] or b[3] < BBOX[1] or b[1] > BBOX[3])


def ring_wkt(points):
    return "(" + ",".join(f"{x} {y}" for x, y in points) + ")"


def load_hotspots():
    # shapefile은 WGS84. 폴리곤마다 part가 1개라 MULTIPOLYGON 하나로 감싼다
    shp = glob.glob(str(DATA_DIR / "*121*" / "*.shp"))[0]
    rows = []
    for sr in shapefile.Reader(shp, encoding="utf-8").iterShapeRecords():
        if not in_bbox(sr.shape.bbox):
            continue
        s = sr.shape
        parts = list(s.parts) + [len(s.points)]
        rings = [ring_wkt(s.points[a:b]) for a, b in zip(parts, parts[1:])]
        rows.append({
            "area_cd": sr.record["AREA_CD"],
            "area_nm": sr.record["AREA_NM"],
            "category": sr.record["CATEGORY"],
            "geom": f"SRID=4326;MULTIPOLYGON(({','.join(rings)}))",
        })
        print(" ", sr.record["AREA_CD"], sr.record["AREA_NM"])
    upsert("hotspots", rows, "area_cd")


# 시연용 출발지·목적지(역·공원). 도서관은 libraries 명령으로 넣는다. 좌표는 OpenStreetMap(Overpass)에서 가져왔다. id는 osm-<타입><OSM id>
PLACES = [
    ("osm-n13055976391", "station", "홍대입구역", 37.55663, 126.92345),
    ("osm-n5916874391", "station", "합정역", 37.54936, 126.91366),
    ("osm-n6041674902", "station", "상수역", 37.54776, 126.92289),
    ("osm-n6041674907", "station", "망원역", 37.55603, 126.91013),
    ("osm-w477482749", "park", "경의선숲길공원(연남)", 37.56277, 126.92193),
    ("osm-w216906544", "park", "와우근린공원", 37.55094, 126.92897),
    ("osm-w299780629", "park", "홍익문화공원", 37.55229, 126.92333),
    ("osm-w680086126", "park", "양화진역사공원", 37.54558, 126.91108),
    ("osm-w330666503", "park", "망원한강공원", 37.55038, 126.90177),
]


def load_places():
    upsert("places", [
        {"id": i, "kind": k, "category": "역" if k == "station" else "공원", "name": n,
         "geom": f"SRID=4326;POINT({lng} {lat})"}
        for i, k, n, lat, lng in PLACES
    ], "id")


def seoul_rows(service):
    # 서울 열린데이터광장 API에서 전체 행을 1000건씩 받는다
    key = os.environ["SEOUL_API_KEY"]
    get = lambda a, b: json.load(urllib.request.urlopen(
        f"http://openapi.seoul.go.kr:8088/{key}/json/{service}/{a}/{b}/", timeout=30))[service]
    total = get(1, 1)["list_total_count"]
    return [r for a in range(1, total + 1, 1000) for r in get(a, min(a + 999, total))["row"]]


def library_row(r, prefix, category):
    # 도서관 API 공통: XCNTS가 위도, YDNTS가 경도. OP_TIME은 "평일 : 09:00~22:00, 주말 : 09:00~20:00"
    week = dict(p.split(" : ", 1) for p in r["OP_TIME"].split(", ") if " : " in p)
    return {
        "id": f"{prefix}-{r['LBRRY_SEQ_NO']}",
        "kind": "library",
        "category": category,
        "name": r["LBRRY_NAME"],
        "address": r["ADRES"],
        "open_info": {"weekday": week.get("평일"), "weekend": week.get("주말"), "closed": r["FDRM_CLOSE_DATE"]},
        "geom": f"SRID=4326;POINT({float(r['YDNTS'])} {float(r['XCNTS'])})",
    }


def load_shelters():
    # 쉼터 후보(마포구): 공공도서관 · 작은도서관 · 주민센터 · 공원
    # 주민센터는 무더위쉼터 목록의 "공공청사"에서 가져온다(경로당 같은 회원 전용 시설은 뺀다).
    # 무더위쉼터 운영 요일·시간을 운영시간으로 쓰고, 요일에 없는 날은 휴관으로 적는다
    rows = []
    for r in seoul_rows("SeoulPublicLibraryInfo"):
        if r["CODE_VALUE"] == "마포구":
            rows.append(library_row(r, "seoul-lib", "공공도서관"))
    for r in seoul_rows("SeoulSmallLibraryInfo"):
        if r["CODE_VALUE"] == "마포구" and r["XCNTS"] and r["YDNTS"]:
            rows.append(library_row(r, "seoul-smlib", "작은도서관"))

    days = ["월", "화", "수", "목", "금", "토", "일"]
    centers = {}
    for r in seoul_rows("TbGtnHwcwP"):
        if r["FACILITY_TYPE2"] != "공공청사" or "마포구" not in r["R_DETL_ADD"] or not r["LAT"]:
            continue
        open_days = set(r["OPR_DAYS"].replace(" ", "").split(","))
        hours = f"{r['OPR_START_TIME']}~{r['OPR_END_TIME']}"
        centers[r["R_AREA_NM"]] = {
            "id": f"seoul-center-{r['R_AREA_NM']}",
            "kind": "center",
            "category": "주민센터",
            "name": r["R_AREA_NM"],
            "address": r["R_DETL_ADD"],
            "open_info": {
                "weekday": hours,
                "weekend": hours if open_days & {"토", "일"} else None,
                "closed": ", ".join(f"매주 {d}요일" for d in days if d not in open_days) or None,
            },
            "geom": f"SRID=4326;POINT({float(r['LON'])} {float(r['LAT'])})",
        }
    rows += centers.values()

    # 서울시 주요 공원. 시연용으로 OSM에서 넣어 둔 공원과 같은 곳은 건너뛴다
    osm_parks = [n for _, k, n, _, _ in PLACES if k == "park"]
    for r in seoul_rows("SearchParkInfoService"):
        if "마포구" not in (r["PARK_ADDR"] or "") or any(r["PARK_NM"][:4] in n for n in osm_parks):
            continue
        rows.append({
            "id": f"seoul-park-{r['SN']}",
            "kind": "park",
            "category": "공원",
            "name": r["PARK_NM"],
            "address": r["PARK_ADDR"],
            "geom": f"SRID=4326;POINT({float(r['XCRD'])} {float(r['YCRD'])})",
        })

    for kind in ("library", "center", "park"):
        upsert("places", [r for r in rows if r["kind"] == kind], "id")


ENV_CSV = DATA_DIR / "S_DOT_ENV_2026.10.12-10.18.csv"
PEOPLE_CSV = DATA_DIR / "S_DOT_PEOPLE_2026.10.12-10.18.csv"
GU = "Mapo-gu"


def read_csv(path):
    with open(path, encoding="cp949") as f:
        next(f)  # 헤더
        for line in f:
            yield line.rstrip("\n").split(",")


def env_rows():
    # 헤더에 같은 이름이 겹쳐 있어 위치로 읽는다: 1 시리얼, 2 센서 시간, 4 자치구, 19 평균 조도, 25 평균 소음
    for c in read_csv(ENV_CSV):
        if c[4] == GU:
            yield c[1], c[2], c[19], c[25]


def people_rows():
    # 헤더가 한 칸 밀려 있다: 값은 0 유동인구수, 2 시리얼, 3 센서 시간, 5 자치구
    for c in read_csv(PEOPLE_CSV):
        if c[5] == GU:
            yield c[2], c[3], c[0]


def num(s):
    try:
        return float(s)
    except ValueError:
        return None


def kst(s):
    # "2026-10-12_00:07:00". 일부 행은 "2026-10-11_00-07-24"처럼 시각도 -로 구분돼 있다
    d, t = s.split("_")
    return f"{d}T{t.replace('-', ':')}+09:00"


def find_col(header, *keys):
    for i, h in enumerate(header):
        if h and any(k in str(h).replace(" ", "").lower() for k in keys):
            return i
    sys.exit(f"설치 위치 파일에서 {keys} 열을 찾지 못했어요. 헤더: {header}")


def xlsx_rows(name_part):
    import openpyxl

    path = next(p for p in glob.glob(str(DATA_DIR / "*설치*.xlsx")) if name_part in Path(p).name)
    it = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0].iter_rows(values_only=True)
    return next(it), it


def load_sensors():
    # 설치 위치 xlsx 두 개에서 위도·경도를 읽고, 마포 CSV에 나온 센서만 넣는다.
    # 환경: '모델 시리얼'이 CSV 시리얼과 같다. 유동인구: CSV 시리얼은 '방문자 센서코드'를 11자리로 0 채운 값이다
    wanted = {"env": {r[0] for r in env_rows()}, "floating": {r[0] for r in people_rows()}}
    rows = []
    for kind, name_part, keys in (("env", "환경", ("시리얼",)), ("floating", "유동인구", ("센서코드",))):
        header, it = xlsx_rows(name_part)
        si, la, lo = find_col(header, *keys), find_col(header, "위도"), find_col(header, "경도")
        for r in it:
            if not (r[si] and r[la] and r[lo]):
                continue
            sid = f"{int(r[si]):011d}" if kind == "floating" else str(r[si]).strip()
            if sid in wanted[kind]:
                rows.append({"sensor_id": sid, "kind": kind, "geom": f"SRID=4326;POINT({float(r[lo])} {float(r[la])})"})
    missing = (wanted["env"] | wanted["floating"]) - {r["sensor_id"] for r in rows}
    if missing:
        print(f"  위치를 못 찾은 센서 {len(missing)}개: {sorted(missing)[:10]}")
    upsert("sensors", rows, "sensor_id")


def load_seed():
    # 과거 1주 CSV를 sensor_obs에 넣는다. sensors에 있는 센서만(외래키)
    url = f"{os.environ['SUPABASE_URL']}/rest/v1/sensors?select=sensor_id"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    known = {s["sensor_id"] for s in json.load(urllib.request.urlopen(req))}

    obs = {}
    for sid, t, lux, noise in env_rows():
        if sid in known:
            obs[(sid, t)] = {"sensor_id": sid, "observed_at": kst(t), "noise_db": num(noise), "lux": num(lux)}
    rows = list(obs.values())
    for i in range(0, len(rows), 1000):
        upsert("sensor_obs", rows[i:i + 1000], "sensor_id,observed_at")

    flow = {}
    for sid, t, count in people_rows():
        if sid in known:
            flow[(sid, t)] = {"sensor_id": sid, "observed_at": kst(t), "flow_count": int(float(count))}
    rows = list(flow.values())
    for i in range(0, len(rows), 1000):
        upsert("sensor_obs", rows[i:i + 1000], "sensor_id,observed_at")


if __name__ == "__main__":
    load_env()
    cmd, *args = sys.argv[1:]
    {"hotspots": load_hotspots, "places": load_places, "shelters": load_shelters, "sensors": load_sensors, "seed": load_seed}[cmd](*args)
