# Sensory Map frontend

Next.js app. It calls the Supabase RPCs in `../docs/api.md` and shows the real Kakao map.
Without keys it falls back to local mock data and a plain map.

## Run

```bash
cp ../.env.example ../.env   # fill in the keys; the whole repo shares this file
npm install
npm run dev
```

## Structure

```text
src/
├─ app/          pages: / welcome refuges route navigate/[routeId]
├─ components/   shared UI, sheets, map stand-ins
├─ hooks/        useAsync, usePreview
└─ lib/
   ├─ supabase.ts   Supabase client
   ├─ api/          one function per RPC, types, mock fallback
   ├─ kakao.ts      Kakao SDK loader, place search
   ├─ storage.ts    sensitivity, current trip, ratings
   ├─ location.ts   geolocation, map bounds
   └─ format.ts     Korean labels and formatting
```

Add `?state=loading|empty|error|stale` to a URL to preview that state.
