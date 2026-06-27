Pok# External Review-System Adapter — Design Plan

Status: **deferred**, design only. Pick this back up when you're ready to
let third-party teams plug their own review system into ReviewArena.

## What we're enabling

External researchers (other labs, community contributors) can register
their own review-generation system with ReviewArena. They host the model
on their infra. We send them paper text over HTTP, they send back a
`StructuredReview`, and the review enters the same pipeline as the
internal `gpt-4o-mini` / `gemini` / `ai-scientist` / `tree-review`
adapters — including pair selection, voting, Elo, leaderboard.

Everything downstream of `POST /generate` is unchanged. The only new
thing is *where the review text comes from*.

## Mental model

```
ReviewArena (us)                           Participant
─────────────────                          ───────────
adapter dispatcher
  ├─ gpt-4o-mini     (internal)
  ├─ gemini          (internal)
  ├─ ai-scientist    (internal)
  ├─ tree-review     (internal)
  └─ external-http   ── POST {paper} + Bearer + HMAC ──▶  their webhook
                     ◀── 200 {review, raw, gen_ms} ────

Participant Portal API ◀── Bearer key ── their dashboard / CLI
```

Two distinct auth tracks:

| Direction | Purpose | Mechanism |
|---|---|---|
| **Outbound** (us → them) | They can prove the request is from us, not spam | Bearer token they configure + HMAC-SHA256 of body |
| **Inbound** (them → portal) | We authorize their portal calls | Bearer key, verified against bcrypt hash in DB |

For an MVP, plain Bearer is enough. HMAC + nonce can be a v2.

## Data model additions

| Table | Columns | Purpose |
|---|---|---|
| `participants` *(new)* | `id, name, organization, contactEmail, status (PENDING\|APPROVED\|REVOKED), approvedAt, createdAt` | Who's allowed to plug in |
| `participant_api_keys` *(new)* | `id, participantId, keyHash, keyPrefix, scopes jsonb, createdAt, expiresAt, lastUsedAt, revokedAt` | Bearer tokens. Only bcrypt hash stored. Plaintext shown once at issuance. |
| `external_adapter_calls` *(new)* | `id, reviewSystemId, paperId, requestId, status, latencyMs, errorMessage, requestBytes, responseBytes, createdAt` | Audit log of every webhook call |
| `reviewSystems` *(extended)* | + `participantId text references participants(id)` (nullable) | Links a review-system row to its owning participant |

The existing `reviewSystems` columns we already have do most of the work:
- `adapterKey = "external-http"` selects the new adapter
- `config` jsonb holds `{ endpoint, sharedSecretRef, timeoutMs, maxRpm }`
- `outage` boolean (from the LMArena port) is the kill-switch
- `enabled` controls whether they get votes
- `boost` (from the LMArena port) lets new entrants get fast cold-start coverage

## HTTP contracts

### Outbound — what participants implement

```
POST {their endpoint}                          # e.g., https://smith-lab.example/review
Content-Type: application/json
Authorization: Bearer <token-we-tell-them-to-expect>     # optional (their choice)
X-ReviewArena-Signature: sha256=HMAC(body, shared_secret)
X-ReviewArena-Request-Id: <uuid>                          # for their logs
X-ReviewArena-Adapter-Version: 1

Body: ParsedPaper       # exactly the schema we already use internally
                        # (title, abstract, authors, sections, figures,
                        # tables, references, pageCount, source)

Response:
  200  {
    "review": StructuredReview,   # exact same schema our internal adapters return
    "raw_output": string,
    "generation_ms": int
  }
  4xx  validation error    → marks review FAILED + logged, no retry
  5xx  their internal error → marks review FAILED + retried once
  timeout (90 s default)   → marks review FAILED + retried once
```

Their integration is one HTTP endpoint that accepts our schema and
returns our schema. Nothing else.

### Inbound — Participant Portal API (us)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /admin/participants` | `ADMIN_TOKEN` | Approve a registration, mint first key |
| `GET /participant/me` | Bearer | Account info |
| `PATCH /participant/me/endpoint` | Bearer | Update webhook URL |
| `GET /participant/me/stats` | Bearer | Votes, Elo, request count, error rate |
| `POST /participant/me/rotate-key` | Bearer | Get a fresh key; old one revoked after grace period |
| `DELETE /participant/me/endpoint` | Bearer | Pause (sets `outage=true` on their reviewSystem row) |

## Trust, safety, lifecycle

| Concern | Mechanism |
|---|---|
| Bad actor sends spam to our portal | Bearer revocation; rate limit per key (~60 rpm) |
| Their endpoint hangs / is slow | 90 s timeout, one retry, then FAILED. Same isolation as OpenAI flakes today. |
| Their endpoint returns garbage | Strict Pydantic validation of `StructuredReview` on receive. Cap free-text field lengths. |
| Compromised key | `participant_api_keys.revokedAt` flips → subsequent calls 401. No redeploy. |
| Their endpoint disappears mid-study | Set `outage=true` on their `reviewSystems` row → pair selection skips them; existing reviews/votes stay. |
| They abuse our paper feed | Daily call cap per participant (config). Above cap → 429. |
| Key replay over the network | HMAC of body + nonce + timestamp; reject requests > 5 min old. (v2) |
| Audit / accountability | `external_adapter_calls` table — full per-call record. |

## Privacy / consent — needs explicit thought before going live

We ship paper text (often unpublished) to a third party. Options,
weakest to strongest:

1. **Site-wide notice** at upload: "uploading consents to sharing with all
   enabled review systems including external participants."
2. **Per-upload opt-in checkbox**: "OK to share with external participants?"
   If no, those adapters are skipped for this paper.
3. **Per-participant opt-in**: list shown at upload, user checks who can see.
4. **Internal-only mode for the formal user study**: external participants
   disabled during the thesis run, enabled afterwards for community use.

For the thesis: ship **#2** as the floor, run with **#4** until external
participants are vetted.

## Onboarding flow

1. Researcher submits a form (or emails) with name, org, system slug,
   intended webhook URL.
2. Admin (you) reviews + approves in `/admin/participants`.
3. System mints a key, bcrypts it, shows plaintext once via one-time link.
4. You hand off the published `StructuredReview` spec + an example curl
   call.
5. They build + deploy their service.
6. They tell you "ready" → admin flips `enabled=true` on their reviewSystem row.
7. First few requests get `boost=true` so cold-start coverage is fast.

## Where each piece of code lives

| File | New / extended | Purpose |
|---|---|---|
| `apps/api/src/db/schema.ts` (+ ALTER) | extended | New tables + FK on `reviewSystems` |
| `apps/api/src/routes/admin.ts` | extended | `POST /admin/participants/approve` |
| `apps/api/src/routes/participant.ts` | new | Portal endpoints (bearer-auth middleware) |
| `apps/api/src/plugins/participant-auth.ts` | new | Verify bearer key against bcrypt hash |
| `services/review-gen/app/adapters/external_http.py` | new | Adapter dispatched by `adapterKey = "external-http"` |
| `apps/web/src/pages/ParticipantPortalPage.tsx` | new, optional | Visual dashboard (can ship later — HTTP API is enough) |
| `docs/participant-spec.md` | new | Their integration guide: HTTP contract, JSON schema, example |

## Minimum viable v1 (one afternoon)

1. **`external_http` Python adapter** (~80 LOC) — reads URL + auth from
   `config`, calls it, validates response with the existing
   `StructuredReview` Pydantic model, returns `GenerationResult`.
2. **One admin endpoint** to register an external system row with
   `adapterKey = "external-http"` and the participant's URL.
3. **One doc** (`docs/participant-spec.md`) with the JSON shape and an
   example curl request we'd send them.
4. **Plain Bearer, no HMAC** for MVP — HMAC comes in v2.
5. **No portal UI** — admin manages via SQL or a `curl /admin/...` call.

That's enough to **prove the round-trip works end-to-end** with one
trusted external participant (e.g., a colleague at TU Darmstadt). Once
that's stable, layer in:

- HMAC + nonce
- The participant portal (`/participant/me/*` endpoints)
- bcrypt key issuance + rotation
- Audit log (`external_adapter_calls` table)
- A web dashboard

## Open questions to settle before v1

1. **Who's in scope** — only TU Darmstadt labs, or anyone on the internet
   who fills out a form? Drives how paranoid the auth needs to be.
2. **Portal UI now or later** — HTTP API is identical either way; UI is
   sugar.
3. **Consent model** — pick one of the four above before any external
   participant goes live.
4. **Cost expectations of participants** — they pay for their own
   inference. We should be transparent: a study sends them ~100 papers
   and they need to absorb that load.

## Why this is mostly a contained change

The architecture is already correct for this:

- `reviewSystems` is a registry, keyed by `adapterKey`. New types just
  add a row.
- The orchestrator already runs adapters in parallel with per-adapter
  failure isolation (`FAILED` status on the review row).
- `enabled` / `outage` flags are already part of the LMArena-style pair
  selection — kill-switch is free.
- `boost` already handles cold-start coverage.
- `StructuredReview` is already the shape every adapter returns.

So the "external participants" feature is one Python adapter file + one
admin endpoint + a published spec, *not* a refactor.
