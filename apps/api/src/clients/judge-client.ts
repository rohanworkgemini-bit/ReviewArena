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

export class JudgeClient {
  private readonly apiKey: string;

  constructor(private readonly baseUrl: string, apiKey: string = "") {
    this.apiKey = apiKey;
  }

  async judge(reviewText: string, paperText: string, model = "gpt-4o-mini"): Promise<JudgeResult> {
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
