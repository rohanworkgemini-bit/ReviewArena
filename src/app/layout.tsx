import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Review Arena",
  description: "Blind LLM comparison platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ background: "#0a0a0a", color: "#eee", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <nav style={{ borderBottom: "1px solid #222", padding: "0.75rem 1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href="/" style={{ fontWeight: 700, fontSize: "1.1rem", color: "#fff", textDecoration: "none" }}>
            ReviewArena
          </a>
          <div style={{ display: "flex", gap: "1.25rem" }}>
            <a href="/" style={{ color: "#aaa", textDecoration: "none", fontSize: "0.9rem" }}>Arena</a>
            <a href="/leaderboard" style={{ color: "#aaa", textDecoration: "none", fontSize: "0.9rem" }}>Leaderboard</a>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
