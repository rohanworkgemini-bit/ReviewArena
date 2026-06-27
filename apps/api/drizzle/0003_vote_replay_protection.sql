-- Replay-protection for /votes: one session can vote on the same pair
-- (paper + reviewA + reviewB) at most once. The pair sides are already
-- canonicalised at selection time, so this matches the logical pair.
--
-- If any duplicate rows already exist in production, this migration will
-- fail; dedup with the SELECT below before re-running.
--
--   SELECT session_id, paper_id, review_a_id, review_b_id, count(*)
--     FROM votes
--     GROUP BY 1,2,3,4
--     HAVING count(*) > 1;

CREATE UNIQUE INDEX "votes_session_pair_uk"
  ON "votes" ("session_id", "paper_id", "review_a_id", "review_b_id");
