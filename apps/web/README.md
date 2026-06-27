# `@reviewarena/web` — React SPA

Vite + React + Tailwind. TanStack Query for server state; sessionStorage
for the in-flight pair token; native `EventSource` for SSE.

## Layout

```
src/
├── App.tsx              Router + global layout (sidebar + top bar)
├── main.tsx             Vite entry
├── pages/
│   ├── UploadPage.tsx      PDF / arXiv link upload
│   ├── ComparisonPage.tsx  Vote-Mode A/B view (streaming reviews)
│   ├── GeneratePage.tsx    Generate-Mode single-system view
│   ├── RevealPage.tsx      Post-vote system reveal + Elo delta
│   ├── LeaderboardPage.tsx Per-system ratings + bootstrap CI bars
│   └── AdminPage.tsx       System management (auth: ADMIN_TOKEN)
├── components/
│   ├── comparison/      Sub-components of ComparisonPage (extracted)
│   ├── layout/          Sidebar, ModeDropdown, TopBar, Header
│   └── ui/              shadcn-style primitives
├── hooks/
│   └── useReviewStream  EventSource hook with stall watchdog + retry
└── lib/
    ├── api.ts           Typed fetch wrappers (shared-types)
    ├── cn.ts            Tailwind class composer
    ├── mode.ts          Vote-vs-Generate global mode (useSyncExternalStore)
    └── theme.ts         Dark/light persistence
```

## Hot paths

- **Streaming UX:** `ComparisonPage` polls `/papers/:id` for the chosen
  pair's reviewIds, then opens 2 SSE streams via `useReviewStream`.
  Tokens render with a live caret until 'done' arrives, then swap to
  the structured `<ReviewPanel>`.
- **Mode store:** global Vote/Generate state lives in
  `lib/mode.ts` as an external store (not Context) so the TopBar
  dropdown updates the UploadPage without prop-drilling.

## Dev

```bash
pnpm --filter @reviewarena/web dev
```

Vite proxies `/api/*` to the Node API on `:8000` (see `vite.config.ts`).
