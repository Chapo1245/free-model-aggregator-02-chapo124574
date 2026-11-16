# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/Chapo1245/free-model-aggregator-02-chapo124574/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/Chapo1245/free-model-aggregator-02-chapo124574/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

The best live free-model aggregator — one server, two API wires, fourteen
free OpenRouter models. Point any OpenAI or Anthropic client at it and
every answer is a real completion from a live free model, dialled through
the gateway on the entrant's OpenRouter key.

Built for the [free-model-aggregator-02 bounty on make.fun](https://make.fun/bounty/free-model-aggregator-02).

- `POST /v1/chat/completions` — OpenAI wire, JSON + SSE
- `POST /v1/messages` — Anthropic wire, JSON + SSE
- `GET /v1/models` — OpenAI shape for `Authorization: Bearer`,
  Anthropic shape for `x-api-key`
- `node main.ts --list` — prints the catalog document it registers

Routing is quality-first: each request is served by the best-rated free
model meeting its exact requirement class (JSON mode, tools, vision,
plain). A model that refuses twice in a row is demoted until it serves
again; refusals fail over to the next-best eligible model, and recovered
refusals are reported on the `x-makefun-upstream-failures` response
header. Every model is dialled only on the gateway's Chat Completions
route (`POST $OPENAI_BASE_URL/chat/completions`).

Node 22, standard library only. No install step: `node main.ts`.

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
