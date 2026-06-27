"""Thesis-analysis script.

Pulls the canonical export from /admin/export.json and produces:
  - vote summary CSV
  - per-system Elo trajectory plot
  - human/LLM-judge agreement correlation table

Run:
    python scripts/thesis_eval.py \\
        --api http://localhost:8000 \\
        --token "$ADMIN_TOKEN" \\
        --out research/analysis/

Output files are written under --out. The script is deliberately
zero-dependency-on-the-app: it only needs httpx, pandas, matplotlib.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def fetch_export(api: str, token: str) -> dict:
    import httpx

    r = httpx.get(
        f"{api}/admin/export.json",
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def summarize_votes(export: dict, out_dir: Path) -> None:
    import pandas as pd

    votes_df = pd.json_normalize(export["votes"])
    if votes_df.empty:
        print("[summarize_votes] no votes yet")
        return

    systems = {s["id"]: s["slug"] for s in export["systems"]}
    reviews = {r["id"]: r for p in export["papers"] for r in p["reviews"]}
    votes_df["system_a"] = votes_df["reviewAId"].map(
        lambda rid: systems.get(reviews.get(rid, {}).get("reviewSystemId"), "?")
    )
    votes_df["system_b"] = votes_df["reviewBId"].map(
        lambda rid: systems.get(reviews.get(rid, {}).get("reviewSystemId"), "?")
    )
    votes_df.to_csv(out_dir / "votes_long.csv", index=False)
    print(f"[summarize_votes] wrote {len(votes_df)} votes to votes_long.csv")

    # Head-to-head matrix.
    pairs = defaultdict(lambda: {"a_wins": 0, "b_wins": 0, "ties": 0})
    for _, v in votes_df.iterrows():
        key = tuple(sorted([v["system_a"], v["system_b"]]))
        if v["winner"] == "TIE":
            pairs[key]["ties"] += 1
        elif (v["winner"] == "A" and v["system_a"] == key[0]) or (
            v["winner"] == "B" and v["system_b"] == key[0]
        ):
            pairs[key]["a_wins"] += 1
        else:
            pairs[key]["b_wins"] += 1

    rows = []
    for (a, b), counts in pairs.items():
        n = counts["a_wins"] + counts["b_wins"] + counts["ties"]
        rows.append({"system_a": a, "system_b": b, "n": n, **counts,
                     "a_winrate": counts["a_wins"] / n if n else 0})
    pd.DataFrame(rows).to_csv(out_dir / "head_to_head.csv", index=False)
    print(f"[summarize_votes] wrote {len(rows)} pair rows to head_to_head.csv")


def plot_elo_trajectory(export: dict, out_dir: Path) -> None:
    import matplotlib.pyplot as plt
    import pandas as pd

    snaps = pd.json_normalize(export.get("snapshots", []))
    if snaps.empty:
        print("[plot_elo_trajectory] no snapshots yet")
        return

    overall = snaps[snaps["dimension"].isna()].copy()
    systems = {s["id"]: s["slug"] for s in export["systems"]}
    overall["system"] = overall["reviewSystemId"].map(systems)
    overall["computedAt"] = pd.to_datetime(overall["computedAt"])
    overall = overall.sort_values("computedAt")

    fig, ax = plt.subplots(figsize=(10, 6))
    for system, group in overall.groupby("system"):
        ax.plot(group["computedAt"], group["rating"], marker="o", label=system, linewidth=1.5)
        ax.fill_between(
            group["computedAt"],
            group["ratingCiLow"],
            group["ratingCiHigh"],
            alpha=0.15,
        )
    ax.set_xlabel("Time")
    ax.set_ylabel("Elo rating")
    ax.set_title("ReviewArena: Elo trajectory by system (95% bootstrap CI shaded)")
    ax.legend(loc="best", fontsize=9)
    ax.grid(alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_dir / "elo_trajectory.png", dpi=200)
    plt.close(fig)
    print("[plot_elo_trajectory] wrote elo_trajectory.png")


def correlate_judge_vs_human(export: dict, out_dir: Path) -> None:
    """Per-system: human winrate vs LLM-judge overall score.
    Crude but useful for the 'do automatic metrics agree with humans' chapter."""
    import pandas as pd

    metrics = pd.json_normalize(export.get("metrics", []))
    if metrics.empty:
        print("[correlate] no metric scores yet (run /admin/papers/:id/score first)")
        return

    systems = {s["id"]: s["slug"] for s in export["systems"]}
    reviews = {r["id"]: r for p in export["papers"] for r in p["reviews"]}
    metrics["system"] = metrics["reviewId"].map(
        lambda rid: systems.get(reviews.get(rid, {}).get("reviewSystemId"))
    )

    judge_overall = metrics[metrics["kind"] == "LLM_JUDGE_OVERALL"].groupby("system")["value"].mean()
    verifiability = metrics[metrics["kind"] == "LLM_JUDGE_VERIFIABILITY"].groupby("system")["value"].mean()

    # Human winrate (overall): wins / (wins + losses), ties ignored.
    votes = pd.json_normalize(export["votes"])
    wins = defaultdict(int)
    losses = defaultdict(int)
    for _, v in votes.iterrows():
        sa = systems.get(reviews.get(v["reviewAId"], {}).get("reviewSystemId"))
        sb = systems.get(reviews.get(v["reviewBId"], {}).get("reviewSystemId"))
        if v["winner"] == "A":
            wins[sa] += 1
            losses[sb] += 1
        elif v["winner"] == "B":
            wins[sb] += 1
            losses[sa] += 1
    rows = []
    for s in set(judge_overall.index) | set(wins) | set(losses):
        n = wins[s] + losses[s]
        rows.append({
            "system": s,
            "human_winrate": wins[s] / n if n else None,
            "llm_judge_overall_mean": judge_overall.get(s),
            "llm_judge_verifiability_mean": verifiability.get(s),
            "n_votes": n,
        })
    pd.DataFrame(rows).to_csv(out_dir / "human_vs_judge.csv", index=False)
    print("[correlate] wrote human_vs_judge.csv")


def fairness_report(export: dict, out_dir: Path) -> None:
    """Fairness audit (docs/FAIRNESS.md). Produces fairness_report.json with:

      A1 input-parity : do all reviews of a paper share input_tokens_sent?
      A4 logging cov. : fraction of reviews with token accounting populated
      B1 failed-gen   : comparisons excluded because a side != COMPLETED
      C1 length bands : outcome distribution by paper length band
      C2 verbosity    : P(longer review wins) + length/win correlation
    """
    reviews_by_id: dict = {}
    paper_of_review: dict = {}
    for paper in export.get("papers", []):
        for r in paper.get("reviews", []):
            reviews_by_id[r["id"]] = r
            paper_of_review[r["id"]] = paper
    papers_by_id = {p["id"]: p for p in export.get("papers", [])}
    votes = export.get("votes", [])

    # ── A1: input parity per paper ─────────────────────────────────────────
    parity_violations = []
    for paper in export.get("papers", []):
        sent = {
            r.get("inputTokensSent")
            for r in paper.get("reviews", [])
            if r.get("status") == "COMPLETED" and r.get("inputTokensSent") is not None
        }
        if len(sent) > 1:
            parity_violations.append({"paperId": paper["id"], "distinct_input_tokens": sorted(sent)})

    # ── A4: logging coverage ───────────────────────────────────────────────
    completed = [r for r in reviews_by_id.values() if r.get("status") == "COMPLETED"]
    logged = [r for r in completed if r.get("outputTokens") is not None]
    coverage = (len(logged) / len(completed)) if completed else None

    # ── B1: failed-generation exclusions ───────────────────────────────────
    excluded = 0
    included = 0
    excluded_by_system: dict = defaultdict(int)
    # ── C1/C2: length band + verbosity ─────────────────────────────────────
    band_outcomes: dict = defaultdict(lambda: {"n": 0})
    longer_won = 0
    length_decided = 0  # non-tie comparisons with both output lengths known
    for v in votes:
        ra = reviews_by_id.get(v.get("reviewAId"))
        rb = reviews_by_id.get(v.get("reviewBId"))
        if not ra or not rb:
            continue
        if ra.get("status") != "COMPLETED" or rb.get("status") != "COMPLETED":
            excluded += 1
            for r in (ra, rb):
                if r.get("status") != "COMPLETED":
                    excluded_by_system[_sys_of(r, export)] += 1
            continue
        included += 1
        paper = papers_by_id.get(v.get("paperId"), {})
        band = paper.get("lengthBand") or "unknown"
        band_outcomes[band]["n"] += 1
        # verbosity: did the longer review win? (skip ties)
        la, lb = ra.get("outputTokens"), rb.get("outputTokens")
        if v.get("winner") in ("A", "B") and la is not None and lb is not None and la != lb:
            length_decided += 1
            longer_is_a = la > lb
            if (v["winner"] == "A") == longer_is_a:
                longer_won += 1

    # ── B2: streaming-speed (latency) per system, as a measured covariate ──
    ttft: dict = defaultdict(list)
    gen_ms: dict = defaultdict(list)
    for r in completed:
        s = _sys_of(r, export)
        if r.get("timeToFirstTokenMs") is not None:
            ttft[s].append(r["timeToFirstTokenMs"])
        if r.get("generationMs") is not None:
            gen_ms[s].append(r["generationMs"])
    latency = {
        s: {
            "mean_time_to_first_token_ms": (sum(ttft[s]) / len(ttft[s])) if ttft.get(s) else None,
            "mean_generation_ms": (sum(gen_ms[s]) / len(gen_ms[s])) if gen_ms.get(s) else None,
            "n": len(gen_ms.get(s, [])),
        }
        for s in set(list(ttft) + list(gen_ms))
    }

    report = {
        "A1_input_parity": {
            "violations": parity_violations,
            "ok": len(parity_violations) == 0,
        },
        "A4_token_logging_coverage": coverage,
        "B2_latency_by_system": latency,
        "B1_failed_generation": {
            "included_comparisons": included,
            "excluded_comparisons": excluded,
            "excluded_by_system": dict(excluded_by_system),
        },
        "C1_length_bands": {k: v["n"] for k, v in band_outcomes.items()},
        "C2_verbosity_bias": {
            "decided_by_length_pairs": length_decided,
            "longer_review_won": longer_won,
            "p_longer_wins": (longer_won / length_decided) if length_decided else None,
            "note": "0.5 = no length bias; >0.5 = longer reviews tend to win",
        },
    }
    (out_dir / "fairness_report.json").write_text(json.dumps(report, indent=2, default=str))
    print("[fairness] wrote fairness_report.json")
    print(f"  A1 input parity ok: {report['A1_input_parity']['ok']}")
    print(f"  A4 token-logging coverage: {coverage}")
    print(f"  B1 excluded (failed) comparisons: {excluded} / {included + excluded}")
    pl = report["C2_verbosity_bias"]["p_longer_wins"]
    print(f"  C2 P(longer review wins): {pl}")


def _sys_of(review: dict, export: dict) -> str:
    sid = review.get("reviewSystemId")
    for s in export.get("systems", []):
        if s.get("id") == sid:
            return s.get("slug", sid or "?")
    return sid or "?"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--api", default="http://localhost:8000")
    p.add_argument("--token", required=True, help="admin bearer token")
    p.add_argument("--out", default="research/analysis", type=Path)
    args = p.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"Fetching export from {args.api} …")
    export = fetch_export(args.api, args.token)
    (args.out / "export.json").write_text(json.dumps(export, indent=2, default=str))
    print(f"Saved raw export to {args.out / 'export.json'}")

    summarize_votes(export, args.out)
    plot_elo_trajectory(export, args.out)
    correlate_judge_vs_human(export, args.out)
    fairness_report(export, args.out)

    print("\nDone. Files in:", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main()) 