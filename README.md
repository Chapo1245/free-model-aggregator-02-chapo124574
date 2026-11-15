# free-model-aggregator-02

The best live free-model aggregator — one server, two API wires, fourteen
free OpenRouter models. Point any OpenAI or Anthropic client at it and
every answer is a real completion from a live free model, dialled through
the gateway on the entrant's OpenRouter key.

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
