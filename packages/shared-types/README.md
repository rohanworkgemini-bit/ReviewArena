# `@reviewarena/shared-types`

Zod schemas + inferred TypeScript types shared between `apps/api` and
`apps/web`. Pydantic mirrors of the same shapes live in
`services/review-gen/app/schemas.py` — **keep both sides in sync**.

## Layout

```
src/
├── index.ts             Barrel export
├── api.ts               HTTP request/response schemas (POST /papers, /pair, /votes, ...)
├── parsed-paper.ts      ParsedPaper schema (output of Marker / arxiv2md)
├── structured-review.ts StructuredReview schema (adapter output)
└── dimensions.ts        VoteDimension enum + labels
```

## When to update

Adding a new field to any wire payload requires:

1. Edit the Zod schema here (`src/...`)
2. Mirror in Python: `services/review-gen/app/schemas.py`
3. Update producers + consumers in `apps/api` and `apps/web`
4. Run `pnpm exec tsc --noEmit` at the root to catch import errors

The web + api both import from this package via `@reviewarena/shared-types`.
