# DeepReviewer-7B on Modal

GPU-served DeepReviewer endpoint that ReviewArena's `deepreviewer-7b`
adapter calls. Scale-to-zero, ~$0.80/hr active, $0 idle.

## One-time setup

```bash
pip install modal              # if you don't have it
modal token new                # logs in via browser
```

## Deploy

```bash
cd services/modal/deepreviewer
modal deploy deepreviewer_modal.py
```

Modal prints two URLs:
```
✓ Created web endpoint:  https://<workspace>--reviewarena-deepreviewer-deepreviewer7b-review.modal.run
✓ Created web endpoint:  https://<workspace>--reviewarena-deepreviewer-deepreviewer7b-healthz.modal.run
```

Add the **review** URL to project-root `.env`:
```
DEEPREVIEWER_URL="https://<workspace>--reviewarena-deepreviewer-deepreviewer7b-review.modal.run"
```

## Smoke test

```bash
# Direct HTTP test (cold start ~60-120s first time, downloads weights to volume)
curl -sS -X POST "$DEEPREVIEWER_URL" \
  -H 'content-type: application/json' \
  -d '{"paper_text": "# Title\nTest\n\n# Abstract\nA test paper.", "mode": "Fast Mode", "reviewer_num": 1}' | jq .

# Or via the Modal CLI
modal run deepreviewer_modal.py::smoke
```

## Cost

| Item | Cost |
|---|---|
| L4 GPU active | $0.80/hour |
| Idle (scale-to-zero) | $0 |
| Volume storage (~14 GB weights) | $0.28/month |
| Modal free tier | $30/month — covers everything for thesis-scale |

Realistic 50-paper study: ~$0.50 of Modal credit.

## Update / redeploy

```bash
modal deploy deepreviewer_modal.py   # re-runs with latest code
```

## Stop billing

```bash
modal app stop reviewarena-deepreviewer
```
