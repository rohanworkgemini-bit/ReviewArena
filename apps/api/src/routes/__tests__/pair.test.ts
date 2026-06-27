import { describe, it, expect } from "vitest";
import { signPairToken, verifyPairToken } from "../pair.js";

describe("pairToken", () => {
  const SECRET = "test-secret-do-not-use-in-prod";
  const payload = {
    paperId: "pap_123456789012345678",
    reviewAId: "rev_aaaaaaaaaaaaaaaaaa",
    reviewBId: "rev_bbbbbbbbbbbbbbbbbb",
    sessionId: "sess_xxxxxxxxxxxxxx",
  };

  it("round-trips a signed payload", () => {
    const token = signPairToken(payload, SECRET);
    const verified = verifyPairToken(token, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPairToken(payload, SECRET);
    expect(verifyPairToken(token, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signPairToken(payload, SECRET);
    const [b64, mac] = token.split(".");
    const tampered = `${b64}AAAA.${mac}`;
    expect(verifyPairToken(tampered, SECRET)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyPairToken("", SECRET)).toBeNull();
    expect(verifyPairToken("nodot", SECRET)).toBeNull();
    expect(verifyPairToken("a.b", SECRET)).toBeNull();
  });
});
