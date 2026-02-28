"use client";

import { useEffect, useState } from "react";

type LeaderboardEntry = {
    model: string;
    votes: number;
};

export default function LeaderboardPage() {
    const [data, setData] = useState<LeaderboardEntry[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/leaderboard")
            .then((res) => res.json())
            .then(setData)
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return <div style={{ textAlign: "center", padding: "4rem" }}>Loading...</div>;
    }

    return (
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 1rem" }}>
            <h1 style={{ textAlign: "center", marginBottom: "0.5rem" }}>🏆 Leaderboard</h1>
            <p style={{ textAlign: "center", color: "#888", marginBottom: "2rem" }}>
                Ranked by community votes.
            </p>

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                    <tr style={{ borderBottom: "2px solid #333", textAlign: "left" }}>
                        <th style={{ padding: "0.75rem 1rem" }}>Rank</th>
                        <th style={{ padding: "0.75rem 1rem" }}>Model</th>
                        <th style={{ padding: "0.75rem 1rem", textAlign: "right" }}>Votes</th>
                    </tr>
                </thead>
                <tbody>
                    {data.length === 0 ? (
                        <tr>
                            <td colSpan={3} style={{ textAlign: "center", padding: "2rem", color: "#888" }}>
                                No votes yet.
                            </td>
                        </tr>
                    ) : (
                        data.map((entry, i) => (
                            <tr key={entry.model} style={{ borderBottom: "1px solid #222" }}>
                                <td style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>{i + 1}</td>
                                <td style={{ padding: "0.75rem 1rem" }}>{entry.model}</td>
                                <td style={{ padding: "0.75rem 1rem", textAlign: "right", fontFamily: "monospace" }}>
                                    {Number(entry.votes) % 1 === 0 ? Number(entry.votes) : Number(entry.votes).toFixed(1)}
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}
