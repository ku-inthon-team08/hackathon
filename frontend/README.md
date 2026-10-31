# Sensory Map frontend

Next.js app. With Supabase keys set it calls the RPCs in `../docs/api.md`; without them it runs on
local mock data. With a Kakao key it shows the real map and real place search.

## Run

```bash
cp .env.example .env.local   # fill in the keys, or put them in ../.env instead
npm install
npm run dev
```

## Structure

```text
src/
├─ app/          pages: / refuges
├─ components/   shared UI, sheets, map stand-ins
├─ hooks/        useAsync, usePreview
└─ lib/
   ├─ api/          index (picks remote or mock), remote (Supabase RPC), mock, types
   ├─ supabase.ts   Supabase client (null when env vars are missing)
   ├─ kakao.ts      Kakao SDK loader, place search
   ├─ storage.ts    sensitivity, current trip, ratings
   ├─ location.ts   geolocation, map bounds
   └─ format.ts     Korean labels and formatting
```

Add `?state=loading|empty|error|stale` to a URL to preview that state.
