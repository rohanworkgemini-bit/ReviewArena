# Secret rotation playbook

This project has eight secrets that must be rotated together if any one
of them leaks. The leak vector doesn't matter — chat transcript, screen
share, accidental commit, lost laptop — once a secret has left this
machine, treat it as compromised and rotate.

## Inventory

| # | Name | Lives in | Used by |
|---|------|----------|---------|
| 1 | `ADMIN_TOKEN` | `.env` | `/admin/*` bearer auth |
| 2 | `PAIR_TOKEN_SECRET` | `.env` | HMAC key for the pair-token |
| 3 | `MODAL_SHARED_SECRET` | `.env` + Modal secret `modal-shared-auth` | DeepReviewer / OpenReviewer auth |
| 3b | `CHANDRA_API_KEY` | `.env` | Datalab hosted Chandra API (PDF parsing) |
| 4 | `DATABASE_URL` (password portion) | `.env` | Neon Postgres |
| 5 | `OPENAI_API_KEY` | `.env` | GPT adapter + LLM-as-judge |
| 6 | `GEMINI_API_KEY` | `.env` | Gemini adapter |
| 7 | `HF_TOKEN` | `.env` + Modal secret `hf-token` | gated model downloads (Llama-3.1, DeepReviewer-7B) |
| 8 | Neon session cookie | (none stored locally) | n/a — informational |

## Generating fresh values

The three local secrets use the same generator:

```bash
openssl rand -hex 32
```

The four external secrets are issued by their respective platforms (see
below). Always paste new values into `.env` via `code .env` — never echo
them in a terminal that's being recorded.

## Step-by-step rotation

### 1. ADMIN_TOKEN

```bash
NEW_ADMIN=$(openssl rand -hex 32)
# replace the line in .env:
#   ADMIN_TOKEN="<NEW_ADMIN>"
# then restart the API:
pnpm --filter @reviewarena/api dev
```

In-flight admin sessions die immediately. No further action needed.

### 2. PAIR_TOKEN_SECRET

Same shape as ADMIN_TOKEN. Rotating this invalidates every in-flight
pair-token (users mid-vote see a fresh pair on next refresh). For a
live user study, do this between sessions.

### 3. MODAL_SHARED_SECRET (two places, must match)

```bash
NEW_MODAL=$(openssl rand -hex 32)

# (a) update the local .env line:
#   MODAL_SHARED_SECRET="<NEW_MODAL>"

# (b) update the Modal-side secret of the same name:
modal secret create modal-shared-auth MODAL_SHARED_SECRET="$NEW_MODAL"
# (Modal's create is upsert — overwrites if it exists.)

# (c) redeploy the services so they pick up the new secret value:
modal deploy services/modal/deepreviewer/deepreviewer_modal.py
modal deploy services/modal/openreviewer/openreviewer_modal.py
```

vLLM picks up `--api-key` from the env at process start, so a redeploy
is mandatory.

### 4. DATABASE_URL — rotate Neon password

1. https://console.neon.tech → project → Roles → `neondb_owner` →
   Reset password.
2. Copy the new connection string.
3. Replace the `DATABASE_URL=` line in `.env`.
4. Restart the API.

There is no separate read-only role; the API has full write.

### 5. OPENAI_API_KEY

1. https://platform.openai.com/api-keys → revoke the leaked key.
2. Create a new key. Scope: same project; the GPT adapter and judge
   both use chat-completions.
3. Replace `OPENAI_API_KEY=` in `.env`.
4. Restart the Python service (`pnpm dev` reloads it).

### 6. GEMINI_API_KEY

1. https://aistudio.google.com/app/apikey → revoke + create.
2. Same restart loop as OpenAI.

### 7. HF_TOKEN (two places, must match)

1. https://huggingface.co/settings/tokens → revoke + create (read scope
   is enough for gated downloads).
2. Replace `HF_TOKEN=` in `.env`.
3. Update the Modal secret:

```bash
modal secret create hf-token HF_TOKEN="<new-value>"
```

4. Redeploy the gated services:

```bash
modal deploy services/modal/deepreviewer/deepreviewer_modal.py
modal deploy services/modal/openreviewer/openreviewer_modal.py
```

### 3b. CHANDRA_API_KEY — Datalab

1. https://www.datalab.to → revoke + regenerate.
2. Replace `CHANDRA_API_KEY=` in `.env`.
3. Restart the Python service (`pnpm dev` reloads it).

Datalab keys carry billing — rotate immediately on suspicion of leak.

## Verification

After rotation, smoke-test:

```bash
# (a) API still boots:
pnpm --filter @reviewarena/api dev

# (b) /healthz returns OK:
curl -s localhost:8000/healthz

# (c) Modal endpoints reject unauth requests:
curl -i $DEEPREVIEWER_URL/v1/models     # expect 401
curl -i $OPENREVIEWER_URL/v1/models     # expect 401

# (d) Modal endpoints accept the new secret:
curl -i -H "Authorization: Bearer $MODAL_SHARED_SECRET" $DEEPREVIEWER_URL/v1/models
```

## Hygiene rules

- Never paste a secret in chat, screen-share, or a public diff.
- Use `Edit` on specific lines of `.env`, never `cat` / `Read` the
  whole file — every read goes into the transcript.
- Pre-commit hook (todo): block any commit that touches `.env`.
- `.env.example` is the *only* env file safe to commit.
