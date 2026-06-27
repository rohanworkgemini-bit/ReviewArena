l# ReviewArena — Fairness & Validity Methodology

The leaderboard must reflect **review quality**, not which system parsed the
PDF better, saw more of the paper, wrote longer text, streamed faster, or
simply stayed up. This document is the methodological contract for that
claim. Every control below is paired with a concrete **test/assertion** and
its **current status**, because the thesis claim depends on them holding —
not on good intentions.

Guiding principle: **equalize everything that is not the reviewing itself;
preserve each system's own reviewing behaviour, but make it measurable.**

A note on scope and honesty: with a thesis-scale vote budget (~250 votes
across 7–9 systems), the binding constraint is **statistical power**, not
confound control. The controls below are necessary but not sufficient — see
§ Analysis & Power. The goal is to be able to say "these clusters of systems
separate; these do not," with the confounds ruled out, rather than to assert
a strict 1–N ranking the data cannot support.

---

## Tier A — Core validity (must hold)

### A1. Identical canonical input, then native truncation

Two layers, deliberately separated:

1. **Canonical text (identical).** Each paper is parsed **once** by a single
   pipeline into `papers.canonicalText` (+ `papers.parsedStructure`). Every
   system reviewing that paper is handed the *byte-for-byte identical*
   canonical string. No system re-parses; no system gets raw text while
   another gets structured text.
2. **Native truncation (per-system, logged).** How a system fits that string
   into its context window — truncate, chunk, long-context — *is part of the
   system* and is preserved. The only sin is **silent** truncation, so what
   each system actually consumed is logged (see A4).

Appendix/reference policy is fixed once and applied identically to all:
keep title + abstract + body + conclusions; drop the raw bibliography from
the review *input* (it inflates tokens without informing the critique). The
policy lives in one place (`render_canonical_text`).

> Parser note: the original spec said GROBID; the system uses **Marker**
> (PDF) — the principle (one canonical parse) is parser-agnostic. arXiv-URL
> uploads use arxiv2md; this does not affect within-comparison fairness
> (both systems in a comparison read the same per-paper parse) but for a
> single corpus pipeline, prefer routing all uploads through Marker.

**Tests**
- `canonicalText` is non-null for any paper that has reviews.
- The string passed to every adapter for a given paper is byte-for-byte
  equal **before** the adapter's own truncation step.
- The appendix/reference policy function has unit coverage.

**Status:** ⚠️ Partial. Parse-once ✅. Byte-for-byte parity ❌ — adapters
currently re-render the structure with per-system budgets, so the pre-
truncation string differs. Fix: materialize one `canonicalText`; adapters
truncate that identical string.

### A2. Blind, symmetric presentation

The voter cannot tell which system produced which review from anything but
the review's own content.

- Review A and B render through **one** component, identical styling, fonts,
  spacing, markdown handling. No badge, header, or formatting tell.
- The comparison-screen payload contains **no** system identity (slug/name).
- Identity is revealed only after the vote is submitted.

Inherent, accepted limitation: a system's *writing style* may self-identify
(e.g. an ICLR-format fine-tune vs a JSON-prompted LLM). This is intrinsic to
blind A/B of heterogeneous systems and is **not** a rendering confound; it is
disclosed, not "fixed."

**Tests**
- The `/pair` payload schema has no system-identity field (assertion test).
- Both panels are the same React component instance type (one render path).

**Status:** ✅ Met. Shared `ReviewPanel`; `/pair` returns only
`reviewId`/`structured`/`status`. Add the explicit guard tests.

### A3. Randomized, recorded side assignment

- A vs B is randomized per comparison (fair coin).
- The assignment is persisted **at comparison creation** (not only at vote
  time), so comparisons that are shown but not voted still record the side —
  needed to measure position bias and to detect drop-off.

**Tests**
- Over all comparisons, each system appears on side A within 50% ± a
  tolerance band (binomial check).
- Every comparison row has a recorded `systemAId`/`systemBId`.

**Status:** ⚠️ Mostly. Coin-flip ✅ (`select-pair.ts`); recorded via
`votes.reviewAId/reviewBId` ✅ — but only at vote time. Add a `comparisons`
record at creation + the 50/50 test.

### A4. Per-generation accounting (no silent truncation)

For every `reviews` row, record and require:
- `inputTokensSent` — tokens of canonical text handed to the system
- `inputTokensConsumed` — tokens the model actually saw (post-truncation)
- `fractionOfPaperUsed` = consumed / full-paper tokens
- `contextWindow` — the system's declared window
- `outputTokens` — length of the produced review
- `timeToFirstTokenMs`, `generationMs` — latency (also feeds A6)
- `status` — COMPLETED / FAILED / TRUNCATED-EMPTY

A system that quietly drops half the paper and writes a worse review *should*
lose — **as long as the logs show that is what happened.**

**Tests**
- No `reviews` row may reach COMPLETED with any of the token fields null.
- `fractionOfPaperUsed ∈ (0, 1]`.

**Status:** ❌ Missing. `reviews` stores only `generationMs`. One migration
adds the columns; the standardized adapter framework already knows
`contextWindow` and computes the budget, so wiring is localized.

---

## Tier B — Confounds that actually bite at this scale

These are not in the original spec and will corrupt Elo more than position
bias will. They come from observed behaviour during integration.

### B1. Failed-generation exclusion

Systems fail for infra reasons — cold-start 303s, vLLM loops, empty streams,
rate limits — all observed during integration. A stub/empty review is an
**uptime failure, not low review quality.**

- A comparison where either side has `status != COMPLETED` (or
  `outputTokens` below a floor) is **excluded from the quality Elo** and
  tagged. Excluded comparisons are reported separately as a reliability
  metric per system.

**Test:** the Elo computation input contains zero comparisons with a
non-COMPLETED side; an `excluded_comparisons` count is reported per system.

**Status:** ❌ Missing. Today a FAILED review can still be paired (the pair
route accepts GENERATING/COMPLETED). Add the exclusion at Elo-build time.

### B2. Streaming-speed primacy

Gemini streams a full review in seconds; a Modal vLLM model takes minutes.
Even with a "both ready" vote gate, a voter who watches the fast side render
first forms an impression — a systematic advantage unrelated to quality.

- Default: hold **both** panels blank until both sides finish, then reveal
  simultaneously (removes the primacy channel entirely).
- Always log `timeToFirstTokenMs` per side so residual effects are
  measurable.

**Test:** with simultaneous-reveal on, neither panel renders content before
`bothReady`; `timeToFirstTokenMs` recorded for both sides.

**Status:** ❌ Missing. UI currently streams each side as it arrives.

### B3. Judge independence

The LLM-as-judge (dimension radar, claim-check) uses a GPT model. One of the
*systems under test* is also GPT — models exhibit measurable self-preference.

- The judge model must be from a **different family** than any system on the
  leaderboard, or self-preference is disclosed and quantified.

**Test:** judge model id ∉ set of system model ids (assertion at startup).

**Status:** ❌ Not addressed. Judge = gpt-4o-mini; GPT systems are on the
board. Switch the judge to a neutral family (or document).

### B4. Vote quality

10 students × 5 papers means a few careless voters can dominate Elo.

- Light attention controls: minimum decision time floor (already capture
  `decisionMs`), an occasional planted obvious pair, and per-session
  agreement/variance flags. Low-quality sessions are flagged, optionally
  excluded in a sensitivity analysis.

**Test:** analytics reports a per-session quality flag; Elo is recomputed
with/without flagged sessions (sensitivity).

**Status:** ❌ Missing. `decisionMs` is captured; no quality flagging yet.

### B5. Prompt-fairness disclosure

Zero-shot systems (GPT/Gemini/DeepSeek/Claude) receive **our** review prompt;
specialist fine-tunes (DeepReviewer/OpenReviewer/CycleReviewer/SEA) receive
**their** trained prompt. This is the correct "each system as intended"
choice — but it is a methodological decision, stated explicitly, not hidden.

**Status:** ✅ Implemented as designed; ❌ not yet documented in the writeup.
Add one paragraph to the thesis methods section. (No code change.)

---

## Tier C — Logged, analysed post-hoc (not separate leaderboards)

The original spec proposed per-length-band Elo. At ~250 votes this
**over-segments** the data into cells of ~10 votes with overlapping CIs —
noise dressed as findings. Instead:

### C1. Length as a covariate

- Tag every paper with `lengthBand` (short/medium/long) from token count and
  store the raw token count.
- Do **not** build per-band sub-leaderboards. Instead, the analysis script
  regresses vote outcome on `(system, length_band)` and reports whether
  length-band has a significant effect after controlling for system. "System
  X degrades on long papers" becomes a regression coefficient with a CI, not
  a separate noisy Elo number.

**Test:** `thesis_eval.py` outputs a length-effect estimate + CI.

### C2. Verbosity bias

- `outputTokens` (from A4) per review.
- The analysis reports the correlation between "longer review" and "won the
  vote." If high, the thesis states it as a caveat and, ideally, reports Elo
  with a length control.

**Test:** `thesis_eval.py` outputs a verbosity-bias coefficient.

### C3. Minimum exposure (the useful half of "balanced matchmaking")

- The pair selector guarantees a **minimum number of comparisons per enabled
  system** so none is starved; among eligible rivals it still prefers
  similar-Elo pairs (more informative games).
- Length-neutral matchmaking is **already satisfied by construction** — pairs
  are drawn per-paper independently of length — so no extra mechanism is
  needed; it is merely verified.

**Tests**
- After N comparisons, `min(per-system count) / max(per-system count)` ≥ a
  floor.
- The distribution of `lengthBand` is similar across system pairs
  (verification, not enforcement).

**Status:** ⚠️ Partial. Proximity pairing + boost knob ✅; no hard
min-exposure floor ❌.

---

## Analysis & Power (the honest part)

- Report Elo with **bootstrap 95% CIs** (already implemented) and present the
  board as **clusters that separate vs overlap**, not a strict rank order.
- Pre-register the primary comparison(s) you are powered for (e.g.
  "specialist fine-tunes vs frontier zero-shot," a 2-group contrast) rather
  than all pairwise.
- Every confound above enters the writeup as either a **control** (removed by
  design) or a **logged covariate** (reported, with a sensitivity analysis).
- A result is only claimed when it survives: (a) failed-generation exclusion,
  (b) a length control, and (c) a low-quality-session sensitivity check.

---

## Summary table

| Source of unfairness | Control | Tier | Status |
|---|---|---|---|
| Different parsers / input text | One canonical text, rendered once, **byte-identical to all** | A1 | ✅ implemented + asserted |
| Unequal context/verbosity budget | **Equalized FAIR_INPUT (11k) + FAIR_OUTPUT (3072) for every system** | A1 | ✅ implemented |
| Silent truncation | Per-generation token accounting | A4 | ✅ implemented |
| Voter guessing the system | Identical render, reveal after vote | A2 | ✅ |
| Position bias (A vs B) | Randomize + record side | A3 | ⚠️ recorded at vote time |
| Infra failures losing votes | Exclude non-COMPLETED comparisons | B1 | ✅ implemented (3 battle-builders) |
| Streaming-speed primacy | Log TTFT + report as covariate | B2 | ✅ measured |
| Judge self-preference | Judge from a non-competing family | B3 | ❌ todo |
| Careless voters | Quality flags + sensitivity analysis | B4 | ❌ todo |
| Prompt asymmetry | Disclose "each system as intended" | B5 | ✅ (doc) |
| Length corrupting one number | Length band as covariate (no sub-leaderboards) | C1 | ✅ implemented |
| Votes tracking length not quality | Verbosity-bias P(longer wins) | C2 | ✅ implemented |
| Uneven exposure | Minimum-exposure floor | C3 | ✅ implemented |

**Implemented this build (verified by automated assertions):** A1 (identical
input across all 8 systems + equalized budget), A4 (token logging), B1
(failed-gen exclusion in votes/pair/upload-pair), B2 (TTFT logged + reported),
C1 (length band + covariate), C2 (verbosity-bias number), C3 (min-exposure
floor). **Remaining:** B3 (swap judge to a non-competing model), B4
(vote-quality flags — `decisionMs` is already captured), and persisting side
assignment at comparison-creation time (A3 hardening).

If Tier A holds and Tier B/C are logged and reported, Elo differences that
survive the sensitivity analyses are attributable to review quality — which
is what the study needs to claim, within the limits of its sample size.

---

## Implementation order (high-ROI first)

1. **A4 token accounting** — one migration; unlocks C2 verbosity and feeds
   A1/C1. The adapter framework already knows the context window.
2. **A1 canonical text** — render once, store, hand the identical string to
   every adapter; adapters truncate that string + log A4 fields.
3. **B1 failed-generation exclusion** — at Elo-build time; cheap, high impact.
4. **C1 length band + C3 min-exposure** — migration + selector floor + the
   regression in `thesis_eval.py`.
5. **B2 simultaneous reveal + TTFT**, **A3 comparison record + 50/50 test**,
   **B3 judge swap**, **A2 guard tests**, **B4 vote-quality flags** — mostly
   small, independent.
6. **B5 + power framing** — documentation in the thesis methods section.
