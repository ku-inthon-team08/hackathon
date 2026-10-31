# BE API (Supabase RPC)

FE는 모든 데이터를 `supabase.rpc()`로 받습니다. 서울 열린데이터 API는 키가 노출되지 않도록 BE만 호출합니다.

> 모든 함수가 실제 데이터를 돌려줍니다(`mock: false`). 아래 예시의 값은 형식을 보여주기 위한 샘플입니다.
> BE가 실제 로직으로 바꿔도 형식은 그대로 둡니다. 형식을 바꿔야 하면 BE와 먼저 이야기해 주세요.

## 호출 방법

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_SUPABASE_URL!,
  process.env.NEXT_SUPABASE_ANON_KEY!,
)

const { data, error } = await supabase.rpc('nearby_shelters', { lat: 37.5894, lng: 127.0323 })
```

- URL과 anon 키는 BE에게 받아 Next.js 프로젝트의 `.env.local`에 `NEXT_` 접두사를 붙여 넣습니다.
- `SUPABASE_SERVICE_ROLE_KEY`는 모든 권한을 가진 키라서 FE 코드에 절대 넣지 않습니다.

## 공통 규칙

- **좌표**: 인자와 목록 항목은 `lat`, `lng`. GeoJSON 안의 좌표만 `[lng, lat]` 순서입니다.
- **민감도** `sens_sound`, `sens_light`, `sens_crowd`: 0~3 (0이면 무시, 기본 2). 온보딩 3문항 답을 그대로 넣습니다.
- **감각 부하** `load`: 0~1, 낮을수록 편한 곳. `load_level`: `low` / `mid` / `high`.
- **혼잡도** `crowd_level`: 1 여유 · 2 보통 · 3 약간 붐빔 · 4 붐빔.
- **소음 등급** `noise_grade`: 1 매우 조용(45dB 미만) · 2 조용(55 미만) · 3 보통(65 미만) · 4 시끄러움(75 미만) · 5 매우 시끄러움.
- **시간**: UTC ISO 문자열 (`2026-10-31T08:00:00+00:00`). 화면에는 한국 시간으로 바꿔 보여줍니다.
- **보행 속도** `walk_mpm`: m/분, 기본 75. 고령자·아이 동반 모드면 60 정도를 넘깁니다.

## 함수 목록

| 함수 | 쓰는 화면 | 데이터 |
|---|---|---|
| [`nearby_shelters`](#nearby_shelters) | 현장 쉼터 큰 버튼 | 실제 |
| [`place_detail`](#place_detail) | 장소 상세, 감각 미리듣기 | 실제 |
| [`quiet_routes`](#quiet_routes) | 출발 전 계획: 경로 후보 3개 | 실제 |
| [`best_times`](#best_times) | 출발 전 계획: 덜 붐비는 시간대 | 실제 |
| [`map_layers`](#map_layers) | 지도 레이어(소리·빛·인파) | 실제 |
| [`data_status`](#data_status) | "n분 전 데이터" 표시 | 실제 |

BE가 하지 않는 것:
- **목적지 검색**: 주소·장소 이름 검색은 지도 SDK의 검색 기능으로 하고, BE에는 좌표만 넘깁니다.
- **감각 미리듣기 소리**: FE(Web Audio)가 `noise_db`·`noise_grade`로 소리를 만듭니다.

---

### nearby_shelters

현재 위치에서 도보 `minutes`분 안(직선거리)의 쉼터. "감각 과부하가 왔을 때 걸어서 금방 가서, 무료로, 조용히 머물 수 있는 곳"을 기준으로 고릅니다.
지금 열린 곳 → 운영시간 모름 → 닫힌 곳 순으로, 같은 묶음 안에서는 `score` 높은 순으로 정렬됩니다.

| 인자 | 타입 | 기본값 |
|---|---|---|
| `lat`, `lng` | number | 필수 |
| `minutes` | number | 10 |
| `sens_sound`, `sens_light`, `sens_crowd` | number | 2 |
| `walk_mpm` | number | 75 |

```json
{
  "mock": false,
  "items": [
    {
      "id": "seoul-smlib-493",
      "kind": "library",
      "category": "작은도서관",
      "name": "합정동문고",
      "lat": 37.549572,
      "lng": 126.913422,
      "distance_m": 303,
      "walk_min": 5,
      "is_open": true,
      "indoor": true,
      "load": 0.24,
      "load_level": "low",
      "score": 0.68
    }
  ]
}
```

- 후보(서울 전체): 공공도서관 · 작은도서관(`kind: "library"`), 주민센터(`kind: "center"`), 공원(`kind: "park"`). 경로당처럼 회원만 쓰는 시설과 역은 빠집니다.
  고정 데이터를 서울 전체로 다시 적재하기 전까지는 마포구 후보만 나옵니다(`scripts/load_static.py shelters`).
- 주민센터 `id`는 서울 전체로 다시 적재한 뒤부터 `seoul-center-<구>-<이름>`입니다(예: `seoul-center-마포구-공덕동주민센터`, 지금은 `seoul-center-<이름>`). 동 이름이 구마다 겹쳐서 구를 넣었습니다. id를 저장해 두는 화면이 있으면 바뀌는 것에 대비해 주세요.
- `category`: 화면에 보여줄 세부 종류. `공공도서관` · `작은도서관` · `주민센터` · `공원`.
- `is_open`: 운영시간·정기 휴관일로 판단합니다(법정공휴일은 반영 안 함). 운영시간 데이터가 없으면 `null`("운영시간 확인 필요"). 공원은 늘 `true`.
- `indoor`: 도서관·주민센터는 `true`. 밤에는 실내 쉼터가 대부분 닫혀 공원만 열린 곳으로 나옵니다.
- `load`: 실내는 가정값(소음 0.15 · 조도 0.3 · 인파 0.3), 공원은 둘레 100m 도로의 실제 감각값. 둘 다 민감도로 가중 평균합니다.
- `score` = 0.6 × (1 − `load`) + 0.3 × (1 − min(도보분, 10) / 10) + 0.1 × 데이터 신뢰도 − 혼잡 감점
  - 데이터 신뢰도: 공원은 가까운 환경 센서가 200m·60분 안이면 1, 500m·120분 안이면 0.5, 아니면 0. 실내는 0.5
  - 혼잡 감점: 공원이 혼잡 장소 영역 안이고 지금 약간 붐빔(3) 이상이면 0.1 × (등급 − 2)

### place_detail

장소를 눌렀을 때 보여줄 근거. 좌표는 목록(`nearby_shelters`)에 있는 값을 씁니다.

| 인자 | 타입 |
|---|---|
| `place_id` | string (목록의 `id`) |

```json
{
  "mock": true,
  "place": {
    "id": "mock-1",
    "kind": "library",
    "name": "샘플 장소 mock-1",
    "address": "서울특별시 (샘플 주소)",
    "open_info": { "open": "09:00", "close": "22:00", "closed": "매주 월요일" }
  },
  "evidence": {
    "noise": { "db": 47.5, "grade": 2, "observed_at": "2026-10-31T07:00:00+00:00", "distance_m": 180, "confidence": 0.72, "source": "S-DoT" },
    "light": { "lux": 85, "observed_at": "2026-10-31T07:00:00+00:00", "distance_m": 180, "confidence": 0.72, "source": "S-DoT" },
    "crowd": { "level": 1, "label": "여유", "area_nm": "샘플 번화가", "observed_at": "2026-10-31T07:37:00+00:00", "source": "실시간 도시데이터" }
  }
}
```

- `distance_m`: 근거로 쓴 센서까지의 거리. `confidence`(0~1)가 낮으면 "추정값"으로 표시합니다.
- 도서관은 `address`와 `open_info`(`{"weekday": "09:00~22:00", "weekend": "09:00~20:00", "closed": "매주 화요일 및 법정공휴일"}`)가 있고, 공원·역은 `null`입니다.
- 없는 `place_id`면 오류 `NOT_FOUND`(HTTP 400)를 돌려줍니다.

### quiet_routes

경로 후보 3개. 항상 `shortest`(최단) · `balanced`(균형) · `quietest`(가장 조용한) 순서입니다.

| 인자 | 타입 | 기본값 |
|---|---|---|
| `from_lat`, `from_lng`, `to_lat`, `to_lng` | number | 필수 |
| `sens_sound`, `sens_light`, `sens_crowd` | number | 2 |
| `walk_mpm` | number | 75 |

```json
{
  "mock": true,
  "routes": [
    {
      "kind": "balanced",
      "label": "균형",
      "distance_m": 479,
      "walk_min": 7,
      "avg_load": 0.4,
      "load_level": "mid",
      "extra_distance_pct": 4,
      "exposure_change_pct": -36,
      "geometry": { "type": "LineString", "coordinates": [[127.0323, 37.5894], [127.03113, 37.587305], [127.029, 37.5862]] }
    }
  ]
}
```

- `extra_distance_pct`: 최단 경로보다 몇 % 더 걷는지.
- `exposure_change_pct`: 최단 경로 대비 감각 노출(부하 × 거리) 변화. 음수면 그만큼 덜 지칩니다. 예: "4% 더 걷고 노출 36% 감소".
- 서울 전체 보행 도로망에서 찾습니다. 오류(HTTP 400, `message`로 구분하고 `details`에 안내 문구):
  - `OUT_OF_COVERAGE`: 출발지나 도착지가 서울 밖이거나, 500m 안에 걸을 수 있는 길이 없음(한강 한가운데 등)
  - `NO_ROUTE`: 두 지점을 잇는 보행 경로가 없음

### best_times

목적지 근처 번화가의 앞으로 `hours`시간 예상 혼잡·소음. 가장 덜 붐비는 3개 시간대에 `recommended: true`가 붙습니다.

| 인자 | 타입 | 기본값 |
|---|---|---|
| `lat`, `lng` | number | 필수 |
| `hours` | number | 12 |

```json
{
  "mock": true,
  "area": { "area_cd": "POI000", "area_nm": "샘플 번화가", "distance_m": 300 },
  "slots": [
    { "at": "2026-10-31T08:00:00+00:00", "crowd_level": 3, "crowd_label": "약간 붐빔", "noise_db": 68, "noise_grade": 4, "recommended": false }
  ]
}
```

### map_layers

지도 화면 범위 안의 레이어 3개. 모두 GeoJSON FeatureCollection이라 지도 라이브러리에 바로 넣을 수 있습니다.

| 인자 | 타입 | 기본값 |
|---|---|---|
| `min_lat`, `min_lng`, `max_lat`, `max_lng` | number | 필수 |
| `sens_sound`, `sens_light`, `sens_crowd` | number | 2 |

```json
{
  "mock": true,
  "edges": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[127.024, 37.5875], [127.036, 37.5875]] },
      "properties": { "id": 3, "noise_n": 0.85, "light_n": 0.7, "crowd_n": 0.8, "load": 0.78, "load_level": "high", "confidence": 0.6 }
    }]
  },
  "sensors": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [127.026, 37.5845] },
      "properties": { "id": "MOCK-1", "kind": "env", "noise_db": 53, "noise_grade": 2, "lux": 70, "observed_at": "2026-10-31T07:00:00+00:00" }
    }]
  },
  "hotspots": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [127.03, 37.5875] },
      "properties": { "area_cd": "POI000", "area_nm": "샘플 번화가", "crowd_level": 4, "crowd_label": "붐빔", "observed_at": "2026-10-31T07:37:00+00:00" }
    }]
  }
}
```

- 소리·빛·인파 레이어는 도로 구간의 `noise_n`·`light_n`·`crowd_n`(0~1)으로 색을 칠하고, 종합 레이어는 `load`를 씁니다.

### data_status

데이터 종류별 마지막 수집 성공 시각. 이 함수만 처음부터 실제 데이터이고, 수집기가 돌기 전에는 `sources`가 빈 배열입니다.

```json
{
  "mock": false,
  "sources": [
    { "source": "citydata", "last_ok_at": "2026-10-31T07:30:48+00:00", "age_min": 12, "last_try_ok": false }
  ]
}
```

- `source`: `citydata`(혼잡도) · `sdot_env`(소음·조도) · `sdot_flow`(유동인구).
- `last_try_ok: false`면 마지막 수집이 실패해서 예전 값을 보여주는 중입니다.

## TypeScript 타입

```ts
export type LoadLevel = 'low' | 'mid' | 'high'
export type PlaceKind = 'library' | 'park'
export type LineString = { type: 'LineString'; coordinates: [number, number][] }
export type Point = { type: 'Point'; coordinates: [number, number] }
export type FeatureCollection<G, P> = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: G; properties: P }[] }

export interface Shelter {
  id: string; kind: PlaceKind; name: string; lat: number; lng: number
  distance_m: number; walk_min: number; is_open: boolean; load: number; load_level: LoadLevel
}
export interface NearbyShelters { mock: boolean; items: Shelter[] }

export interface PlaceDetail {
  mock: boolean
  place: { id: string; kind: PlaceKind; name: string; address: string | null; open_info: Record<string, string> | null }
  evidence: {
    noise: { db: number; grade: number; observed_at: string; distance_m: number; confidence: number; source: string }
    light: { lux: number; observed_at: string; distance_m: number; confidence: number; source: string }
    crowd: { level: number; label: string; area_nm: string; observed_at: string; source: string }
  }
}

export interface Route {
  kind: 'shortest' | 'balanced' | 'quietest'; label: string
  distance_m: number; walk_min: number; avg_load: number; load_level: LoadLevel
  extra_distance_pct: number | null; exposure_change_pct: number | null; geometry: LineString
}
export interface QuietRoutes { mock: boolean; routes: Route[] }

export interface TimeSlot {
  at: string; crowd_level: number; crowd_label: string; noise_db: number; noise_grade: number; recommended: boolean
}
export interface BestTimes { mock: boolean; area: { area_cd: string; area_nm: string; distance_m: number }; slots: TimeSlot[] }

export interface MapLayers {
  mock: boolean
  edges: FeatureCollection<LineString, {
    id: number; noise_n: number; light_n: number; crowd_n: number; load: number; load_level: LoadLevel; confidence: number
  }>
  sensors: FeatureCollection<Point, {
    id: string; kind: 'env' | 'flow'; noise_db: number | null; noise_grade: number | null; lux: number | null; observed_at: string
  }>
  hotspots: FeatureCollection<Point, {
    area_cd: string; area_nm: string; crowd_level: number; crowd_label: string; observed_at: string
  }>
}

export interface DataStatus {
  mock: boolean
  sources: { source: string; last_ok_at: string | null; age_min: number | null; last_try_ok: boolean }[]
}
```
