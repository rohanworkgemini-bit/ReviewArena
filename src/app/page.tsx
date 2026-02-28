"use client";

import { useEffect, useState } from "react";

type Comparison = {
  comparison_id: number;
  review_a: string;
  review_b: string;
};

type VoteResult = {
  model_a: string;
  model_b: string;
};

export default function ArenaPage() {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [voteResult, setVoteResult] = useState<VoteResult | null>(null);

  const fetchComparison = async () => {
    setLoading(true);
    setVoteResult(null);
    try {
      const res = await fetch("/api/comparison");
      if (res.ok) {
        setComparison(await res.json());
      } else {
        setComparison(null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchComparison();
  }, []);

  const handleVote = async (winner: "A" | "B" | "tie") => {
    if (!comparison || voting || voteResult) return;
    setVoting(true);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comparison_id: comparison.comparison_id, winner }),
      });
      if (res.ok) {
        const data = await res.json();
        setVoteResult({ model_a: data.model_a, model_b: data.model_b });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setVoting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: "center", padding: "4rem" }}>Loading...</div>;
  }

  if (!comparison) {
    return <div style={{ textAlign: "center", padding: "4rem", color: "#888" }}>No comparisons available.</div>;
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ textAlign: "center", marginBottom: "0.5rem" }}>Blind Comparison</h1>
      <p style={{ textAlign: "center", color: "#888", marginBottom: "2rem" }}>
        Vote for the better review. Model names are hidden until you vote.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "1.5rem" }}>
        {/* Review A */}
        <div style={{ border: "1px solid #333", borderRadius: 8, padding: "1.25rem" }}>
          <h2 style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "1.1rem" }}>
            {voteResult ? `Model A: ${voteResult.model_a}` : "Review A"}
          </h2>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, color: "#ccc", margin: 0 }}>
            {comparison.review_a}
          </p>
        </div>

        {/* Review B */}
        <div style={{ border: "1px solid #333", borderRadius: 8, padding: "1.25rem" }}>
          <h2 style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "1.1rem" }}>
            {voteResult ? `Model B: ${voteResult.model_b}` : "Review B"}
          </h2>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, color: "#ccc", margin: 0 }}>
            {comparison.review_b}
          </p>
        </div>
      </div>

      {/* Vote buttons or post-vote state */}
      <div style={{ textAlign: "center" }}>
        {voteResult ? (
          <div>
            <p style={{ color: "#4ade80", marginBottom: "1rem" }}> Vote recorded! Models revealed above.</p>
            <button onClick={fetchComparison} style={btnStyle}>
              Next Comparison →
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button onClick={() => handleVote("A")} disabled={voting} style={{ ...btnStyle, background: "#2563eb" }}>
              A is better
            </button>
            <button onClick={() => handleVote("tie")} disabled={voting} style={{ ...btnStyle, background: "#444" }}>
              Tie
            </button>
            <button onClick={() => handleVote("B")} disabled={voting} style={{ ...btnStyle, background: "#7c3aed" }}>
              B is better
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "0.6rem 1.5rem",
  border: "none",
  borderRadius: 6,
  color: "#fff",
  fontWeight: 600,
  fontSize: "0.95rem",
  cursor: "pointer",
  background: "#2563eb",
};
