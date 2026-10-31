# 🐯 지금 상태 & 할 일 (10/31 저녁 기준)

## ✅ 방금 끝난 것

- **DB에 RPC 함수 올림**: `nearby_shelters`, `place_detail`, `quiet_routes`, `best_times`, `map_layers`, `data_status`
  - `data_status`만 진짜 데이터, 나머지는 아직 **가짜 응답**(`mock: true`)
- **마이그레이션 기록 정리**: 원격 DB 기록 = 레포 `supabase/migrations/` 3개. 이제 `npx supabase db push` 그대로 쓰면 됨
- **FE ↔ Supabase 연결**: `.env.local`에 키만 넣으면 실제 RPC 호출, 없으면 예전처럼 로컬 mock
  - URL에 `?state=loading|empty|error|stale` 붙이면 여전히 mock으로 미리보기
  - 지도 레이어는 BE가 진짜 데이터 줄 때까지 빈 지도로 둠 (가짜 격자선 안 그림)

## 🙋 다들 처음 한 번만

```bash
git pull origin main
cd frontend
npm install
cp .env.example .env.local
```

`.env.local`의 `NEXT_PUBLIC_SUPABASE_ANON_KEY=` 에 **publishable 키** 넣기
(Supabase 대시보드 → Project Settings → API Keys → `sb_publishable_...`)

```bash
npm run dev
```

## 👩‍💻 FE 담당

- [ ] 위 세팅 후 `/refuges`, `/route`에서 화면 잘 나오는지 확인
- [ ] 쉼터 `kind`에 `station`(역)도 올 수 있음 → 아이콘/라벨 추가 (`lib/api/types.ts`의 `PlaceKind`)
- [ ] 응답에 `mock: true`면 "샘플 데이터" 뱃지 띄울지 결정

## 🧑‍🔧 BE 담당 (위에서부터 순서대로)

1. [x] Edge Function 소스 커밋 (`supabase/functions/`)
2. [x] 수집 자동화: `pg_cron` 작업 3개 등록됨 (S-DoT 환경 1시간, 유동인구·도시데이터 10분)
3. [ ] **`edge_exposure` 채우기** (지금 0행): 센서값 → 도로 구간 IDW 보간
4. [ ] **RPC 진짜 로직으로 교체** (같은 이름·인자로 새 마이그레이션에서 `create or replace`)
       `nearby_shelters` → `place_detail` → `map_layers` → `best_times` → `quiet_routes`
5. [ ] 정할 것: 혼잡 예측 저장 테이블 / 쉼터 운영시간 컬럼 / `confidence` 값 체계

## 🚀 마무리

- [ ] Vercel 배포 (환경변수에 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_KAKAO_MAP_KEY`)
- [ ] 루트 `README.md` 채우기
- [ ] 발표 전에 Supabase 대시보드 → Advisors에서 보안 경고 확인

## ⚠️ 규칙

- `SUPABASE_SERVICE_ROLE_KEY`는 **FE 코드나 git에 절대 X**
- DB 바꿀 땐 대시보드 SQL 편집기 말고 **마이그레이션 파일로**
- push 전에 `git pull` 먼저
