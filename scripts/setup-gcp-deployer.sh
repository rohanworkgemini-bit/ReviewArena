#!/usr/bin/env bash
# One-time GCP setup for GitHub Actions deploys to Cloud Run.
#
# Creates:
#   - Service account `github-deployer` with least-privilege roles
#   - JSON key at ./gh-deployer-key.json (gitignored)
#   - Artifact Registry repo `reviewarena` for Docker images
#   - Secret Manager entries for every app secret in .env
#
# After this runs, you:
#   1. Open ./gh-deployer-key.json, copy contents
#   2. GitHub repo → Settings → Secrets → Actions → New secret:
#        Name:  GCP_SA_KEY
#        Value: <paste JSON>
#   3. Delete the local file: rm gh-deployer-key.json
#
# Idempotent — safe to re-run. Skips anything that already exists.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-reviewarena-thesis}"
REGION="${GCP_REGION:-europe-west3}"
SA_NAME="github-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
AR_REPO="reviewarena"
KEY_FILE="gh-deployer-key.json"

echo "▶ Project: ${PROJECT_ID}"
echo "▶ Region:  ${REGION}"
echo "▶ Service account: ${SA_EMAIL}"
echo

# ── 1. Enable required APIs (idempotent) ────────────────────────────────
echo "▶ Enabling required APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"

# ── 2. Create service account if missing ────────────────────────────────
if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "✓ Service account ${SA_EMAIL} already exists"
else
  echo "▶ Creating service account ${SA_NAME}…"
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="GitHub Actions deployer"

  # IAM has eventual consistency — wait until the SA is actually visible
  # to other IAM endpoints before binding roles. Without this, the next
  # add-iam-policy-binding call races and fails with INVALID_ARGUMENT.
  echo "▶ Waiting for IAM to propagate (up to 60s)…"
  for i in $(seq 1 30); do
    if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
      echo "  ✓ visible after ${i}×2s"
      break
    fi
    sleep 2
  done
fi

# ── 3. Grant least-privilege roles ──────────────────────────────────────
# Each role narrowly scoped to what the workflows need:
#   run.admin               — deploy + configure Cloud Run services
#   cloudbuild.editor       — submit Docker builds (for --source deploys)
#   artifactregistry.writer — push Docker images
#   iam.serviceAccountUser  — let Cloud Run impersonate the deployer SA
#   secretmanager.accessor  — let Cloud Run read mounted secrets at runtime
ROLES=(
  "roles/run.admin"
  "roles/cloudbuild.builds.editor"
  "roles/artifactregistry.writer"
  "roles/iam.serviceAccountUser"
  "roles/secretmanager.secretAccessor"
  "roles/storage.admin" # needed for Cloud Build's source-staging bucket
)
echo "▶ Granting roles…"
for role in "${ROLES[@]}"; do
  # Retry up to 6× — defends against any remaining IAM propagation lag.
  for attempt in 1 2 3 4 5 6; do
    if gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
         --member="serviceAccount:${SA_EMAIL}" \
         --role="${role}" \
         --quiet >/dev/null 2>&1; then
      echo "  ✓ ${role}"
      break
    fi
    if [[ ${attempt} -eq 6 ]]; then
      echo "  ✗ ${role} (failed after 6 attempts)"
      exit 1
    fi
    sleep $((attempt * 2))
  done
done

# ── 4. Create Artifact Registry repo if missing ─────────────────────────
if gcloud artifacts repositories describe "${AR_REPO}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "✓ Artifact Registry repo ${AR_REPO} already exists"
else
  echo "▶ Creating Artifact Registry repo ${AR_REPO}…"
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="ReviewArena Docker images" \
    --project="${PROJECT_ID}"
fi

# ── 5. Generate JSON key for GitHub Secrets ─────────────────────────────
if [[ -f "${KEY_FILE}" ]]; then
  echo "⚠️  ${KEY_FILE} already exists — leaving it alone."
  echo "    Delete and re-run if you need a fresh key."
else
  echo "▶ Generating JSON key → ${KEY_FILE}"
  gcloud iam service-accounts keys create "${KEY_FILE}" \
    --iam-account="${SA_EMAIL}" \
    --project="${PROJECT_ID}"
  chmod 600 "${KEY_FILE}"
fi

# ── 6. Push every secret from .env to Secret Manager ────────────────────
# macOS ships with bash 3.2 (frozen for GPL3 reasons), which doesn't
# support associative arrays. We use a flat list of env-var names and
# derive the Secret Manager name by lowercasing + swapping _ for -:
#   OPENAI_API_KEY → openai-api-key
echo "▶ Pushing app secrets to Secret Manager…"
SECRET_ENV_VARS="
DATABASE_URL
ADMIN_TOKEN
PAIR_TOKEN_SECRET
REVIEW_GEN_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
DEEPSEEK_API_KEY
CHANDRA_API_KEY
MODAL_SHARED_SECRET
HF_TOKEN
DEEPREVIEWER_URL
OPENREVIEWER_URL
CYCLEREVIEWER_URL
SEA_URL
"

if [[ ! -f .env ]]; then
  echo "⚠️  No .env in cwd — skipping secret push."
  echo "    Run from repo root, or push secrets manually with:"
  echo "      echo -n '<value>' | gcloud secrets create <name> --data-file=-"
else
  for env_var in ${SECRET_ENV_VARS}; do
    # OPENAI_API_KEY → openai-api-key
    secret_name=$(echo "${env_var}" | tr '[:upper:]_' '[:lower:]-')
    # Extract value from .env without printing it
    value=$(grep -E "^${env_var}=" .env | head -1 | sed -E "s/^${env_var}=//; s/^\"//; s/\"$//")
    if [[ -z "${value}" ]]; then
      echo "  ⏭  ${env_var} not set in .env — skipping ${secret_name}"
      continue
    fi
    if gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
      # Already exists — add a new version
      echo -n "${value}" | gcloud secrets versions add "${secret_name}" \
        --data-file=- --project="${PROJECT_ID}" >/dev/null
      echo "  ↻ ${secret_name} (new version)"
    else
      # Create new
      echo -n "${value}" | gcloud secrets create "${secret_name}" \
        --data-file=- --replication-policy=automatic \
        --project="${PROJECT_ID}" >/dev/null
      echo "  ✓ ${secret_name} (created)"
    fi
    # Grant the deployer SA read access on the secret
    gcloud secrets add-iam-policy-binding "${secret_name}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="${PROJECT_ID}" --quiet >/dev/null
  done
fi

echo
echo "✅ Done."
echo
echo "Next steps:"
echo "  1. Open ${KEY_FILE} and copy the entire JSON content"
echo "  2. GitHub → repo Settings → Secrets and variables → Actions → New secret:"
echo "       Name:  GCP_SA_KEY"
echo "       Value: <paste the JSON>"
echo "  3. Add 3 more GH secrets:"
echo "       GCP_PROJECT_ID = ${PROJECT_ID}"
echo "       MODAL_TOKEN_ID = (from \`modal token current\`)"
echo "       MODAL_TOKEN_SECRET = (from \`modal token current\`)"
echo "  4. Add DATABASE_URL as a GH secret too (the deploy workflow needs"
echo "     it for the drizzle migrate step, which runs OUTSIDE Cloud Run):"
echo "       DATABASE_URL = (same value as in .env)"
echo "  5. Delete the local key file:"
echo "       rm ${KEY_FILE}"
echo "  6. Push to main → first deploy fires."
