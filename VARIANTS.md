# Variants — free-model-aggregator-02

Three routing policies were built from the same server skeleton (quality-first
ranking by sealed rating for the request's exact requirement class, demote
after 2 consecutive refusals until the model serves again, failover to the
next-best eligible model, recovered refusals on
`x-makefun-upstream-failures`). They differ only in `POLICY` in `main.ts`.

## A — greedy (SHIPPED)

`{ mode: "greedy", demoteAfter: 2, maxAttempts: 6, retrySame: 0, spreadTop: 1 }`

Always serve with the best-rated eligible model; on refusal move straight to
the next-best. Fewest upstream calls in the ideal case (1 per prompt).

## B — greedy with same-model retry

`{ mode: "greedy-retry", demoteAfter: 2, maxAttempts: 8, retrySame: 1, spreadTop: 1 }`

As A, but retry the same model once before failing over — a transient 429
sometimes clears on an immediate retry, which saves the quality drop of a
failover at the cost of one extra call.

## C — spread across the top 3

`{ mode: "spread-top3", demoteAfter: 2, maxAttempts: 6, retrySame: 0, spreadTop: 3 }`

Rotate the first pick among the top 3 eligible models by prompt index, to
spread load and dodge per-model rate limits. Costs quality (the best model
serves only ~1/3 of prompts) for fewer refusals.

## Grade-local (practice trial-0, process driver)

The free OpenRouter key's 50-request daily cap was exhausted during local
grading setup on 15 Nov (two grade-local runs burned ~72 real upstream
calls while the local masq gateway's model-id rewriting was being fixed),
so only variant A could be graded on trial-0, and that run itself was
cap-starved:

| Variant | t0 | upstream_calls | notes |
| --- | --- | --- | --- |
| **A greedy (SHIPPED)** | **19** | **3 answered / 29 requests** | quality 10, served 16, wire 38, failover 16, catalog 100, working 1 — cap-starved, not representative |
| B greedy-retry | — | — | not graded yet — grade after the cap resets 00:00 UTC 16 Nov |
| C spread-top3 | — | — | not graded yet — grade after the cap resets 00:00 UTC 16 Nov |

Variant code is kept at `build/free-model-aggregator-02/variants/{B,C}/`
(outside this repo so the transcript gate counts no duplicated lines).

## Findings from the cap-starved A run (kept trial `01a1dd56-...`)

- Replay matched byte-for-byte; catalog 100; the entry exits 0.
- p01 served validly (ling-3.2-flash, all 6 checks pass) after super-vl and
  gemma-4-31b both 429'd.
- `thinkingmachines/inkling-2-small:free` (1475, the best plain/tools model)
  answers **403** on this free key: "only available on agentic harnesses".
  It is demoted after 2 consecutive 403s, so plain/tools prompts fall back
  to nemotron-3.5-super-vl (1303). Realistic quality ceiling with this key
  is therefore ~91, not 100.
- **Bug fixed after the run:** the Anthropic wire returned
  `stop_reason: "stop"`, which is not a legal Anthropic stop reason (the
  legal set is `end_turn` / `max_tokens` / `stop_sequence` / `tool_use` /
  `refusal` / `pause_turn`). p05/p06 were served with the token but failed
  the stop_reason check. Now returns `end_turn` (verified in structure
  tests; needs a live re-grade after the cap resets).
