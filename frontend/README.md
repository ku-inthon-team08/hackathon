# Sensory Map frontend

Next.js app running on local mock data. The data shapes follow `../docs/api.md`.

## Run

```bash
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
   ├─ api/          mock data functions and types
   ├─ storage.ts    sensitivity, current trip, ratings
   ├─ location.ts   geolocation, map bounds
   └─ format.ts     Korean labels and formatting
```

Add `?state=loading|empty|error|stale` to a URL to preview that state.
