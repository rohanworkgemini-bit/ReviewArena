import { request } from "undici";

export interface JudgeClaim {
  claim: string;
  verdict: "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED";
  evidence: string | null;
  judge_model: string;
}

export interface JudgeResult {
  overall_score: number;
  verifiability_score: number;
  dimension_scores: Record<string, number>;
  claims: JudgeClaim[];
}

// Keep in sync with DEFAULT_JUDGE_MODEL in services/review-gen/app/judge.py.
// Stored on every metric row's meta so the leaderboard / reveal page
// can surface which judge produced a given score.
export const DEFAULT_JUDGE_MODEL = "gemini-3.1-pro-preview";

export class JudgeClient {
  private readonly apiKey: string;

  constructor(private readonly baseUrl: string, apiKey: string = "") {
    this.apiKey = apiKey;
  }

  async judge(reviewText: string, paperText: string, model = DEFAULT_JUDGE_MODEL): Promise<JudgeResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const { statusCode, body } = await request(`${this.baseUrl}/judge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ review_text: reviewText, paper_text: paperText, model }),
    });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`judge ${statusCode}: ${text}`);
    return JSON.parse(text) as JudgeResult;
  }
}
