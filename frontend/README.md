# Sensory Map frontend

Next.js app running on local mock data. The data shapes follow `../docs/api.md`.
With a Kakao key it shows the real map and real place search.

## Run

```bash
npm install
cp .env.example .env.local   # optional: add the Kakao JavaScript key
npm run dev
```

## Structure

```text
src/
├─ app/          pages: / welcome refuges route navigate/[routeId]
├─ components/   shared UI, sheets, map stand-ins
├─ hooks/        useAsync, usePreview
└─ lib/
   ├─ api/          mock data functions and types
   ├─ kakao.ts      Kakao SDK loader, place search
   ├─ storage.ts    sensitivity, current trip, ratings
   ├─ location.ts   geolocation, map bounds
   └─ format.ts     Korean labels and formatting
```

Add `?state=loading|empty|error|stale` to a URL to preview that state.
