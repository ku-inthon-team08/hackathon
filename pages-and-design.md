# Sensory Map — Pages, Style & Mascot Plan

Frontend plan based on the finalized User Flow & API Spec.
Style: **neumorphism** (cyan + white). Mascot: **Horangi**, the 3D chibi white tiger.

---

## 1. Page List

About **5 real pages** plus **2 overlays**.

| # | Page | Route | Type | APIs | Priority |
|---|---|---|---|---|---|
| 1 | Onboarding | `/welcome` | Page | none (localStorage) | Must |
| 2 | Home Map | `/` | Page | GET /load-map, /hotspots, /status | Must |
| 3 | Route Planning | `/route` | Page (2 steps) | GET /search, POST /routes | Next |
| 4 | Refuge Results | `/refuges` | Page | GET /refuges, GET /search (fallback) | Must |
| 5 | Navigation | `/navigate/:routeId` | Page | POST /routes | Next |
| 6 | Place Detail | — | Bottom sheet | GET /places/{placeId} | Must |
| 7 | Arrival Feedback | — | Modal | POST /feedback | Last |
| + | Edit Sensitivity | — | Sheet | none | Optional (not in spec) |

### 1. Onboarding `/welcome`
- First launch only.
- 3 questions: noise, light, crowd (1–5).
- Saves to localStorage.
- Default light = 2.
- Low-stimulus intro screen.

### 2. Home Map `/`
- Main page.
- Heatmap from `/load-map`.
- Crowded markers from `/hotspots`.
- "Data from n min ago" label from `/status`. Poll every 5 min.
- Layer toggle: load / noise / light / crowd.
- Two entry points:
  - "Plan a route" → page 3.
  - Big refuge button → page 4.

### 3. Route Planning `/route`
- Step 1: origin, destination, departure time. Uses `/search`.
- Step 2: up to 3 route cards from `/routes`.
- Each card: exposure, extra time, confidence.
- Show `live` or `forecast` from `meta.basis`.

### 4. Refuge Results `/refuges`
- Top 3 refuges from `/refuges`.
- Location denied → show "search by station/place" box.
- `openNow = null` → "check hours" tag.

### 5. Navigation `/navigate/:routeId`
- Route colored by segment level.
- "I've arrived" button → feedback modal.

### 6. Place Detail (bottom sheet)
- Opens from refuge card, hotspot marker, or destination.
- Current state, hourly forecast chart, evidence badges.
- Sensory preview button (Web Audio from level).
- "Go here" → page 5.

### 7. Arrival Feedback (modal)
- 3 buttons: quiet / normal / noisy.
- Optional mic measurement.
- Shows thanks and updated score.
- Handles 429 ("already rated").

### Shared Components
- Stale banner: "Data from n min ago" (`stale = true`).
- "Estimated" badge (`confidence = low`).
- Empty state: "This info isn't available right now."
- Level scale 1–5.
- Hotspot scale 1–4 (separate legend).

---

## 2. Neumorphism Rules for This App

The app serves sensory-sensitive users. Neumorphism fits well: soft, low-contrast, calm.
But it has known risks. Rules below handle them.

### Surfaces
- One base background for everything. Cards are the same color as the background.
- **Raised** (buttons, cards): light shadow top-left, dark shadow bottom-right.
- **Inset** (inputs, toggles "on", selected rating): shadows reversed, inside.
- Pressed state = raised → inset. This is the main interaction feedback.

```css
:root {
  --bg: #E6EEF1;
  --shadow-light: #FFFFFF;
  --shadow-dark: #B8C7CD;
  --accent: #00B8C8;      /* cyan, from the pitch deck */
  --text: #2E3E44;
  --text-muted: #5E7178;
}
.raised { background: var(--bg); box-shadow: -6px -6px 12px var(--shadow-light), 6px 6px 12px var(--shadow-dark); }
.inset  { background: var(--bg); box-shadow: inset -4px -4px 8px var(--shadow-light), inset 4px 4px 8px var(--shadow-dark); }
```

### Accessibility Fixes (Required)
- **Text contrast:** text must be 4.5:1 against `--bg`. Shadows alone are not enough.
- **Button edges:** shadows are weak on some screens. Add a 1px subtle border or the accent color on key buttons.
- **State not by shadow only:** "selected" also gets an icon, color, or label.
- **Focus ring:** visible accent outline for keyboard users.
- **Reduced motion:** respect `prefers-reduced-motion`. No bouncing.

### Level Colors (1–5)
- Use soft, muted colors. No neon red. The users are sensitive to light.
- Suggested: 1 calm teal → 2 mint → 3 soft yellow → 4 soft orange → 5 dusty red.
- Always pair color with the level number or label.
- Hotspots (1–4) use a different marker shape, not the same legend.

### Map
- Use a muted / light base map style (Kakao Map).
- Neumorphic controls float on top: layer toggle, refuge button, "data time" chip.
- Heatmap opacity about 0.5 so streets stay readable.

### Big Refuge Button
- Large circle, raised, cyan accent.
- Becomes inset while loading.
- Must work one-handed (bottom center).

---
## 3. Mascot Plan

Full rules, sizes, screen map, and code helper: see `mascot-usage.md`.

### Usage Rules
- **Calm poses only.** Keep the "nicely dumb cute" look. No dramatic poses.
- **Never on the map itself.** It clutters the main view.
- **One mascot per screen.**
- Use in onboarding, sheet headers, empty states, errors, loading, and feedback.
- Small in cards and chips. Larger only on full-screen states.
- Always grounded with a soft floor shadow (same as the deck). Never stretch.
- Always pair with text. The mascot is never the only signal.
- No looping animation. A single gentle fade-in at most.
- Files: `/assets/mascot/horangi-3d-<pose>.webp` (transparent). Pick poses from `mascot.js`.

### 23 Poses → Where to Use

| Pose file (`horangi-3d-…`) | Use in |
|---|---|
| `wave` | Onboarding welcome |
| `sit-wave` | Onboarding finish ("All set") |
| `shhhh` | Noise question, refuge button icon, sensory preview, quiet route card |
| `hold-lightbulb` | Light question (onboarding) |
| `peek-side` | Crowd question (onboarding), out of Seoul (422) |
| `peek-down` | Place detail sheet header, location-denied fallback |
| `peek` | Peeking behind a button (spare) |
| `point-present` | Refuge TOP 3 header, route compare header |
| `point-side` | "Go here" button in place detail |
| `lie-down` | #1 refuge card ("rest here") |
| `lie-down-side` | Empty state: "This info isn't available", no refuge in range, 503 |
| `sleep-curled` | Night gap (01–05h city data empty) |
| `search` | Loading / searching refuges |
| `hold-tablet` | Evidence section, stale data chip |
| `walking` | Navigation header |
| `hold-phone` | Start guidance (optional) |
| `stand` | Feedback question, generic fallback |
| `heart` | Rated "quiet" |
| `thumbs-up` | Rated "normal" |
| `wink` | Rated "noisy", demo mode chip |
| `sit` | Already rated (429) |
| `idea` | First-time tip (layer toggle help) |
| `settings-gear` | Edit sensitivity sheet |

### Optional Extra Poses
Not needed for the MVP demo. `shhhh` covers several spots for now.

| Pose | Would replace | Where |
|---|---|---|
| `cover-ears` | `shhhh` | Noise question, "noisy" rating |
| `headphones` | `shhhh` | Sensory preview button |
| `cover-eyes` | `hold-lightbulb` | Light question |
| `sorry` | `wink` / `lie-down-side` | "Noisy" rating, errors |

---


## 4. Build Order

1. Shared tokens + raised/inset components.
2. Home Map (page 2) with heatmap and hotspots.
3. Refuge Results (page 4) + Place Detail sheet (6).
4. Onboarding (page 1).
5. Route Planning (page 3) → Navigation (page 5).
6. Feedback modal (7).
7. Swap in new mascot poses as they arrive.
