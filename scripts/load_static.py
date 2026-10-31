"""고정 데이터(서울 전체)를 Supabase에 적재한다.

    .venv/bin/python scripts/load_static.py hotspots  # 실시간 도시데이터 장소 영역 shapefile → hotspots
    .venv/bin/python scripts/load_static.py shelters  # 쉼터 후보: 공공·작은도서관, 주민센터, 공원(서울 열린데이터광장 API)
    .venv/bin/python scripts/load_static.py sensors   # S-DoT 설치 위치 xlsx(환경·유동인구) → sensors
    .venv/bin/python scripts/load_static.py seed      # S-DoT 과거 CSV → sensor_obs

데이터 파일은 레포 바로 위 폴더(DATA_DIR)에 둔다. 모두 서울 열린데이터광장(data.seoul.go.kr)에서 받는다.
  *121*/*.shp                       서울시 실시간 도시데이터 장소 영역
  *설치*환경*.xlsx · *설치*유동인구*.xlsx  S-DoT 환경정보 · 유동인구 설치 위치정보
  S_DOT_ENV_*.csv · S_DOT_PEOPLE_*.csv  S-DoT 환경정보 · 유동인구 측정 1주 파일

.env의 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY로 REST API에 upsert한다(shelters는 SEOUL_API_KEY도).
REST는 한 번에 1000행까지만 돌려주고 요청마다 8초 제한이 있어서, 읽을 때는 페이지를 넘기고 쓸 때는 500행씩 나눈다.

hotspots · sensors를 넣은 뒤에는 칸 · 센서 가중치 · 혼잡 장소를 다시 만든다(SQL):
    select public.rebuild_edge_weights(); select public.refresh_edge_exposure();
"""
import glob
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT.parent))

# 좌표 확인용 서울 범위(경계 + 여유). 좌표가 빠졌거나 뒤바뀐 행을 거른다 (minLng, minLat, maxLng, maxLat)
SEOUL_BBOX = (126.76, 37.41, 127.19, 37.72)
BATCH = 500
REBUILD_HINT = "다음으로 SQL에서: select public.rebuild_edge_weights(); select public.refresh_edge_exposure();"


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def rest(method, path, body=None, prefer=None):
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        f"{os.environ['SUPABASE_URL']}/rest/v1/{path}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path.split('?')[0]} 실패: {e.code} {e.read().decode()[:300]}")


def upsert(table, rows, on_conflict):
    for i in range(0, len(rows), BATCH):
        rest("POST", f"{table}?on_conflict={on_conflict}", rows[i:i + BATCH], "resolution=merge-duplicates,return=minimal")
    print(f"{table}: {len(rows)}건 upsert")


def select_all(table, columns, filters=""):
    # REST는 한 번에 1000행까지만 준다. 1000행씩 넘겨 가며 모두 읽는다
    rows, page = [], 1000
    while True:
        got = rest("GET", f"{table}?select={columns}{filters}&order={columns.split(',')[0]}&limit={page}&offset={len(rows)}")
        rows += got
        if len(got) < page:
            return rows


def delete_ids(table, column, ids):
    ids = sorted(ids)
    for i in range(0, len(ids), 100):
        values = ",".join('"' + v.replace('"', '\\"') + '"' for v in ids[i:i + 100])
        rest("DELETE", f"{table}?{column}=in.({urllib.parse.quote(values, safe=',')})")


def sync_prefix(rows, prefix):
    # 이 적재기가 만드는 id(prefix-...)는 서울 전체 목록과 같게 맞춘다: 넣고 나서 목록에 없는 예전 행은 지운다
    old = {r["id"] for r in select_all("places", "id", f"&id=like.{urllib.parse.quote(prefix)}*")}
    upsert("places", rows, "id")
    stale = old - {r["id"] for r in rows}
    if stale:
        delete_ids("places", "id", stale)
        print(f"places: {prefix}* 목록에 없는 예전 행 {len(stale)}건 삭제")


def in_seoul(lng, lat):
    return SEOUL_BBOX[0] <= lng <= SEOUL_BBOX[2] and SEOUL_BBOX[1] <= lat <= SEOUL_BBOX[3]


def point(lng, lat):
    try:
        lng, lat = float(lng), float(lat)
    except (TypeError, ValueError):
        return None
    return f"SRID=4326;POINT({lng} {lat})" if in_seoul(lng, lat) else None


def ring_wkt(points):
    return "(" + ",".join(f"{x} {y}" for x, y in points) + ")"


def load_hotspots():
    # shapefile은 WGS84. 폴리곤마다 part가 1개라 MULTIPOLYGON 하나로 감싼다. 서울 전체 장소를 넣는다
    shp = glob.glob(str(DATA_DIR / "*121*" / "*.shp"))[0]
    rows = []
    for sr in shapefile.Reader(shp, encoding="utf-8").iterShapeRecords():
        s = sr.shape
        parts = list(s.parts) + [len(s.points)]
        rings = [ring_wkt(s.points[a:b]) for a, b in zip(parts, parts[1:])]
        rows.append({
            "area_cd": sr.record["AREA_CD"],
            "area_nm": sr.record["AREA_NM"],
            "category": sr.record["CATEGORY"],
            "geom": f"SRID=4326;MULTIPOLYGON(({','.join(rings)}))",
        })
    upsert("hotspots", rows, "area_cd")
    print(REBUILD_HINT)


def seoul_rows(service):
    # 서울 열린데이터광장 API에서 전체 행을 1000건씩 받는다
    key = os.environ["SEOUL_API_KEY"]
    get = lambda a, b: json.load(urllib.request.urlopen(  # noqa: E731
        f"http://openapi.seoul.go.kr:8088/{key}/json/{service}/{a}/{b}/", timeout=30))[service]
    total = get(1, 1)["list_total_count"]
    return [r for a in range(1, total + 1, 1000) for r in get(a, min(a + 999, total))["row"]]


def library_row(r, prefix, category):
    # 도서관 API 공통: XCNTS가 위도, YDNTS가 경도. OP_TIME은 "평일 : 09:00~22:00, 주말 : 09:00~20:00"
    week = dict(p.split(" : ", 1) for p in (r["OP_TIME"] or "").split(", ") if " : " in p)
    return {
        "id": f"{prefix}-{r['LBRRY_SEQ_NO']}",
        "kind": "library",
        "category": category,
        "name": r["LBRRY_NAME"],
        "address": r["ADRES"],
        "open_info": {"weekday": week.get("평일"), "weekend": week.get("주말"), "closed": r["FDRM_CLOSE_DATE"]},
        "geom": point(r["YDNTS"], r["XCNTS"]),
    }


def gu_of(address):
    # "서울특별시 마포구 ..." → "마포구"
    m = re.search(r"([가-힣]+구)(\s|$)", address or "")
    return m.group(1) if m else None


def load_shelters():
    # 쉼터 후보(서울 전체): 공공도서관 · 작은도서관 · 주민센터 · 공원
    # 주민센터는 무더위쉼터 목록의 "공공청사"에서 가져온다(경로당 같은 회원 전용 시설은 뺀다).
    # 무더위쉼터 운영 요일·시간을 운영시간으로 쓰고, 요일에 없는 날은 휴관으로 적는다
    skipped = 0
    libraries = [library_row(r, "seoul-lib", "공공도서관") for r in seoul_rows("SeoulPublicLibraryInfo")]
    small = [library_row(r, "seoul-smlib", "작은도서관") for r in seoul_rows("SeoulSmallLibraryInfo")]

    days = ["월", "화", "수", "목", "금", "토", "일"]
    centers = {}
    for r in seoul_rows("TbGtnHwcwP"):
        if r["FACILITY_TYPE2"] != "공공청사":
            continue
        gu = gu_of(r["R_DETL_ADD"])
        if not gu or not (r["R_DETL_ADD"] or "").startswith("서울"):
            skipped += 1
            continue
        open_days = set((r["OPR_DAYS"] or "").replace(" ", "").split(","))
        hours = f"{r['OPR_START_TIME']}~{r['OPR_END_TIME']}"
        # 동 이름은 구가 다르면 겹친다(예: 신사동 · 중앙동). id에 구를 넣는다
        centers[(gu, r["R_AREA_NM"])] = {
            "id": f"seoul-center-{gu}-{r['R_AREA_NM']}",
            "kind": "center",
            "category": "주민센터",
            "name": r["R_AREA_NM"],
            "address": r["R_DETL_ADD"],
            "open_info": {
                "weekday": hours,
                "weekend": hours if open_days & {"토", "일"} else None,
                "closed": ", ".join(f"매주 {d}요일" for d in days if d not in open_days) or None,
            },
            "geom": point(r["LON"], r["LAT"]),
        }

    # 서울시 주요 공원(서울 밖의 시 소유 공원은 뺀다). OSM에서 따로 넣어 둔 공원과 같은 곳은 건너뛴다
    other_parks = [p["name"] for p in select_all("places", "id,name", "&kind=eq.park&id=not.like.seoul-park-*")]
    parks = []
    for r in seoul_rows("SearchParkInfoService"):
        if not (r["PARK_ADDR"] or "").startswith("서울") or any(r["PARK_NM"][:4] in n for n in other_parks):
            continue
        parks.append({
            "id": f"seoul-park-{r['SN']}",
            "kind": "park",
            "category": "공원",
            "name": r["PARK_NM"],
            "address": r["PARK_ADDR"],
            "geom": point(r["XCRD"], r["YCRD"]),
        })

    for prefix, rows in (("seoul-lib-", libraries), ("seoul-smlib-", small),
                         ("seoul-center-", list(centers.values())), ("seoul-park-", parks)):
        located = [r for r in rows if r["geom"]]
        skipped += len(rows) - len(located)
        sync_prefix(located, prefix)
    if skipped:
        print(f"좌표가 없거나 서울 밖이라 뺀 행: {skipped}건")


ENV_CSV = DATA_DIR / "S_DOT_ENV_2026.10.12-10.18.csv"
PEOPLE_CSV = DATA_DIR / "S_DOT_PEOPLE_2026.10.12-10.18.csv"


def read_csv(path):
    with open(path, encoding="cp949") as f:
        next(f)  # 헤더
        for line in f:
            yield line.rstrip("\n").split(",")


def env_rows():
    # 헤더에 같은 이름이 겹쳐 있어 위치로 읽는다: 1 시리얼, 2 센서 시간, 19 평균 조도, 25 평균 소음 (4는 자치구)
    for c in read_csv(ENV_CSV):
        yield c[1], c[2], c[19], c[25]


def people_rows():
    # 헤더가 한 칸 밀려 있다: 값은 0 유동인구수, 2 시리얼, 3 센서 시간 (5는 자치구)
    for c in read_csv(PEOPLE_CSV):
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
    # 설치 위치 xlsx 두 개에서 위도·경도를 읽고, 1주 CSV에 측정값이 있는 센서(서울 전체)만 넣는다.
    # 환경: '모델 시리얼'이 CSV 시리얼과 같다. 유동인구: CSV 시리얼은 '방문자 센서코드'를 11자리로 0 채운 값이다
    wanted = {"env": {r[0] for r in env_rows()}, "floating": {r[0] for r in people_rows()}}
    rows, outside = [], 0
    for kind, name_part, keys in (("env", "환경", ("시리얼",)), ("floating", "유동인구", ("센서코드",))):
        header, it = xlsx_rows(name_part)
        si, la, lo = find_col(header, *keys), find_col(header, "위도"), find_col(header, "경도")
        for r in it:
            if not (r[si] and r[la] and r[lo]):
                continue
            sid = f"{int(r[si]):011d}" if kind == "floating" else str(r[si]).strip()
            if sid not in wanted[kind]:
                continue
            geom = point(r[lo], r[la])
            if geom:
                rows.append({"sensor_id": sid, "kind": kind, "geom": geom})
            else:
                outside += 1
    rows = list({r["sensor_id"]: r for r in rows}.values())  # 같은 센서가 두 번 적힌 행
    missing = (wanted["env"] | wanted["floating"]) - {r["sensor_id"] for r in rows}
    if missing:
        print(f"  위치를 못 찾은 센서 {len(missing)}개(좌표가 서울 밖이면 {outside}개 포함): {sorted(missing)[:10]}")
    upsert("sensors", rows, "sensor_id")
    print(REBUILD_HINT)


def load_seed():
    # 과거 1주 CSV를 sensor_obs에 넣는다. sensors에 있는 센서만(외래키)
    known = {s["sensor_id"] for s in select_all("sensors", "sensor_id")}

    obs = {}
    for sid, t, lux, noise in env_rows():
        if sid in known:
            obs[(sid, t)] = {"sensor_id": sid, "observed_at": kst(t), "noise_db": num(noise), "lux": num(lux)}
    upsert("sensor_obs", list(obs.values()), "sensor_id,observed_at")

    flow = {}
    for sid, t, count in people_rows():
        if sid in known:
            flow[(sid, t)] = {"sensor_id": sid, "observed_at": kst(t), "flow_count": int(float(count))}
    upsert("sensor_obs", list(flow.values()), "sensor_id,observed_at")


if __name__ == "__main__":
    load_env()
    cmd, *args = sys.argv[1:]
    {"hotspots": load_hotspots, "shelters": load_shelters, "sensors": load_sensors, "seed": load_seed}[cmd](*args)
