// free-model-aggregator-02 — one server, two API wires, fourteen live free models.
//
// The best live free-model aggregator: a client points any OpenAI or
// Anthropic client at this server and every completion comes from a real
// free OpenRouter model, dialled through the grader's gateway on the
// Chat Completions route only. Routing is quality-first: for each request
// the best-rated free model that meets the request's exact requirement
// class (json / tools / vision / plain) serves it; a model that refuses
// twice in a row is demoted until it serves again; refusals fail over to
// the next-best eligible model. Recovered refusals are reported on the
// response header x-makefun-upstream-failures so the failover column
// can see them.
//
// Node 22, standard library only. Deterministic: every choice derives
// from the brief (MAKEFUN_PROMPT_FILE), the requests and the gateway's
// answers; ids and timestamps derive from MAKEFUN_TRIAL_SEED /
// MAKEFUN_TRIAL_NOW, never from the wall clock or unseeded randomness.

import http from "node:http";
import fs from "node:fs";

type ModelRow = {
  id: string;
  rating: number;
  context: number;
  json: boolean;
  tools: boolean;
  vision: boolean;
};

// The fourteen dialable free ids, house ratings, from the brief.
// Used when MAKEFUN_PROMPT_FILE is absent or unparseable; the brief's
// own copy (when present) takes precedence and is validated against
// this list of ids.
const BUILTIN_MODELS: ModelRow[] = [
  { id: "openrouter/thinkingmachines/inkling-2-small:free", rating: 1475, context: 1048576, json: false, tools: true, vision: true },
  { id: "openrouter/nvidia/nemotron-3.5-super-vl:free", rating: 1303, context: 1000000, json: true, tools: true, vision: true },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", rating: 1285, context: 1000000, json: false, tools: true, vision: false },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free", rating: 1221, context: 1000000, json: false, tools: true, vision: false },
  { id: "openrouter/google/gemma-4-31b-it:free", rating: 1210, context: 262144, json: true, tools: true, vision: true },
  { id: "openrouter/cohere/north-mini-code:free", rating: 1200, context: 256000, json: false, tools: true, vision: false },
  { id: "openrouter/baidu/ernie-5.5-flash-preview:free", rating: 1150, context: 1024000, json: true, tools: true, vision: false },
  { id: "openrouter/dots-studio/dots-3-note-preview:free", rating: 1150, context: 512000, json: true, tools: true, vision: true },
  { id: "openrouter/google/gemma-4-26b-a4b-it:free", rating: 1150, context: 262144, json: true, tools: true, vision: true },
  { id: "openrouter/inclusionai/ling-3.2-flash:free", rating: 1150, context: 1048576, json: true, tools: true, vision: true },
  { id: "openrouter/liquid/lfm-3-1.7b:free", rating: 1150, context: 262144, json: true, tools: true, vision: false },
  { id: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", rating: 1150, context: 256000, json: false, tools: true, vision: true },
  { id: "openrouter/particle-ai/particle-1:free", rating: 1150, context: 1048576, json: true, tools: true, vision: true },
  { id: "openrouter/recursive/flint-v1.0:free", rating: 1150, context: 262144, json: true, tools: true, vision: false },
];

const POLICY = {
  mode: "greedy",
  demoteAfter: 2,
  maxAttempts: 6,
  retrySame: 0,
  spreadTop: 1,
};

const SEED_RAW = process.env.MAKEFUN_TRIAL_SEED || "noseed";
const SEED = SEED_RAW.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "noseed";
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW || "";
const CREATED = TRIAL_NOW ? Math.floor(Date.parse(TRIAL_NOW) / 1000) || 0 : 0;
const ENV_URL = (process.env.MAKEFUN_ENV_URL || "").replace(/\/+$/, "");
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

function extractJsonObject(text: string, start: number): unknown | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function loadModels(): ModelRow[] {
  const file = process.env.MAKEFUN_PROMPT_FILE || "";
  if (file) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const marker = '"schema":"free-model-aggregator-02/models/v1"';
      const at = text.indexOf(marker);
      if (at >= 0) {
        const open = text.lastIndexOf("{", at);
        const doc = extractJsonObject(text, open) as { models?: unknown[] } | null;
        if (doc && Array.isArray(doc.models) && doc.models.length === 14) {
          const rows: ModelRow[] = [];
          const ids = new Set(BUILTIN_MODELS.map((m) => m.id));
          for (const m of doc.models as Record<string, unknown>[]) {
            if (typeof m.id !== "string" || !ids.has(m.id)) return BUILTIN_MODELS;
            rows.push({
              id: m.id,
              rating: typeof m.rating_milli === "number" ? m.rating_milli : 1150,
              context: typeof m.context_length === "number" ? m.context_length : 0,
              json: m.json === true,
              tools: m.tools === true,
              vision: m.vision === true,
            });
          }
          return rows;
        }
      }
    } catch { /* fall through to the built-in table */ }
  }
  return BUILTIN_MODELS;
}

const MODELS = loadModels();
const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

function catalogDocument(): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: MODELS.map((m) => ({ id: m.id, free: true, context_length: m.context })),
      },
    ],
  };
}

function catalogJson(): string {
  return JSON.stringify(catalogDocument());
}

// ---- routing state (derived from requests + gateway answers only) ----
const consecRefusals = new Map<string, number>();
const servedCalls = new Map<string, number>();
let promptCounter = 0;

type Need = { json: boolean; tools: boolean; vision: boolean };

function rankCandidates(need: Need): string[] {
  const eligible = MODELS.filter(
    (m) => (!need.json || m.json) && (!need.tools || m.tools) && (!need.vision || m.vision),
  );
  const pool = eligible.length > 0 ? eligible : MODELS;
  const scored = pool.map((m, idx) => {
    const demoted = (consecRefusals.get(m.id) || 0) >= POLICY.demoteAfter;
    return { m, idx, demoted, calls: servedCalls.get(m.id) || 0 };
  });
  scored.sort((a, b) => {
    if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
    if (b.m.rating !== a.m.rating) return b.m.rating - a.m.rating;
    if (a.calls !== b.calls) return a.calls - b.calls;
    if (b.m.context !== a.m.context) return b.m.context - a.m.context;
    return a.idx - b.idx;
  });
  const ordered = scored.map((s) => s.m.id);
  if (POLICY.spreadTop > 1) {
    const top = ordered.slice(0, POLICY.spreadTop);
    const rest = ordered.slice(POLICY.spreadTop);
    const pick = top[promptCounter % top.length];
    return [pick, ...top.filter((id) => id !== pick), ...rest];
  }
  return ordered;
}

function recordSuccess(model: string): void {
  consecRefusals.set(model, 0);
  servedCalls.set(model, (servedCalls.get(model) || 0) + 1);
}

function recordRefusal(model: string): void {
  consecRefusals.set(model, (consecRefusals.get(model) || 0) + 1);
}

// ---- upstream dial ----
type UpstreamOk = {
  ok: true;
  status: number;
  text: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};
type UpstreamFail = { ok: false; status: number; code: string; terminal: boolean };
type UpstreamResult = UpstreamOk | UpstreamFail;

function errorCode(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown } };
    const e = parsed.error;
    if (e && typeof e.code === "string" && e.code) return e.code;
    if (e && typeof e.type === "string" && e.type) return e.type;
  } catch { /* not JSON */ }
  if (status === 429) return "rate_limited";
  if (status === 402) return "payment_required";
  if (status >= 500) return "upstream_error";
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  return "upstream_error";
}

function parseSseText(sse: string): { text: string; toolCalls: UpstreamOk["toolCalls"]; finishReason: string; usage: UpstreamOk["usage"] | null } {
  let text = "";
  const toolCalls: UpstreamOk["toolCalls"] = [];
  let finishReason = "stop";
  let usage: UpstreamOk["usage"] | null = null;
  for (const line of sse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]" || payload === "") continue;
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
    if (chunk.usage && typeof chunk.usage === "object") {
      const u = chunk.usage as Record<string, number>;
      usage = {
        prompt_tokens: Math.max(0, Math.floor(u.prompt_tokens || 0)),
        completion_tokens: Math.max(0, Math.floor(u.completion_tokens || 0)),
        total_tokens: Math.max(0, Math.floor(u.total_tokens || 0)),
      };
    }
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;
    const choice = choices[0];
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === "string") text += delta.content;
      const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = (tc.function || {}) as Record<string, unknown>;
          toolCalls.push({
            id: typeof tc.id === "string" ? tc.id : "",
            name: typeof fn.name === "string" ? fn.name : "",
            args: typeof fn.arguments === "string" ? fn.arguments : "",
          });
        }
      }
    }
  }
  return { text, toolCalls, finishReason, usage };
}

function fallbackUsage(text: string): UpstreamOk["usage"] {
  const out = Math.max(1, Math.ceil(text.length / 4));
  return { prompt_tokens: 0, completion_tokens: out, total_tokens: out };
}

async function dialUpstream(body: Record<string, unknown>, stream: boolean): Promise<UpstreamResult> {
  const url = `${OPENAI_BASE}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({ ...body, stream }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    return { ok: false, status: 0, code: "unreachable", terminal: false };
  }
  const raw = await res.text();
  if (!res.ok) {
    const code = errorCode(res.status, raw);
    const terminal = res.status === 401;
    return { ok: false, status: res.status, code, terminal };
  }
  if (stream) {
    const parsed = parseSseText(raw);
    return {
      ok: true,
      status: res.status,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason,
      usage: parsed.usage || fallbackUsage(parsed.text),
    };
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {
    return { ok: false, status: 502, code: "bad_upstream_body", terminal: false };
  }
  const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices && choices.length > 0 ? choices[0] : {};
  const message = (choice.message || {}) as Record<string, unknown>;
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls: UpstreamOk["toolCalls"] = [];
  const tcs = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      const fn = (tc.function || {}) as Record<string, unknown>;
      toolCalls.push({
        id: typeof tc.id === "string" ? tc.id : "",
        name: typeof fn.name === "string" ? fn.name : "",
        args: typeof fn.arguments === "string" ? fn.arguments : "",
      });
    }
  }
  const u = (parsed.usage || {}) as Record<string, number>;
  const usage: UpstreamOk["usage"] = {
    prompt_tokens: Math.max(0, Math.floor(u.prompt_tokens || 0)),
    completion_tokens: Math.max(0, Math.floor(u.completion_tokens || 0)),
    total_tokens: Math.max(0, Math.floor(u.total_tokens || 0)),
  };
  if (usage.completion_tokens < 1) {
    const fb = fallbackUsage(text);
    usage.completion_tokens = fb.completion_tokens;
    usage.total_tokens = usage.prompt_tokens + fb.completion_tokens;
  }
  return {
    ok: true,
    status: res.status,
    text,
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" && choice.finish_reason ? choice.finish_reason : "stop",
    usage,
  };
}

type ServeOutcome = {
  result: UpstreamOk | null;
  model: string | null;
  failures: Array<{ status: number; code: string; model: string | null }>;
};

async function serve(body: Record<string, unknown>, need: Need, stream: boolean): Promise<ServeOutcome> {
  const failures: ServeOutcome["failures"] = [];
  const ranked = rankCandidates(need);
  let attempts = 0;
  for (const model of ranked) {
    if (attempts >= POLICY.maxAttempts) break;
    let tries = 0;
    for (;;) {
      attempts++;
      tries++;
      const upstreamBody = { ...body, model };
      const res = await dialUpstream(upstreamBody, stream);
      if (res.ok) {
        recordSuccess(model);
        return { result: res, model, failures };
      }
      failures.push({ status: res.status, code: res.code, model });
      if (res.status === 401) return { result: null, model: null, failures };
      // 402/403/429/5xx/unreachable count as refusals (demote the model);
      // 400 does not demote but still fails over to the next candidate.
      if (res.status === 402 || res.status === 403 || res.status === 429 || res.status >= 500 || res.status === 0) {
        recordRefusal(model);
      }
      if (tries <= POLICY.retrySame && attempts < POLICY.maxAttempts) continue;
      break;
    }
  }
  return { result: null, model: null, failures };
}

// ---- wire helpers ----
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function failuresHeader(failures: ServeOutcome["failures"]): string | undefined {
  if (failures.length === 0) return undefined;
  const rows = failures.slice(0, 8);
  const json = JSON.stringify(rows);
  if (json.length > 8000) return undefined;
  return json;
}

function openaiFinish(reason: string): string {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

function anthropicStop(reason: string): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  // Anthropic's legal stop reasons are end_turn / max_tokens /
  // stop_sequence / tool_use / refusal / pause_turn — never "stop".
  return "end_turn";
}

function detectVision(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages as Array<Record<string, unknown>>) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "image_url" || part.type === "image") return true;
      }
    }
    if (typeof content === "string" && content.includes("image_url")) return true;
  }
  return false;
}

function chatBodyToNeed(body: Record<string, unknown>): Need {
  const rf = body.response_format as Record<string, unknown> | undefined;
  return {
    json: !!(rf && rf.type === "json_object"),
    tools: Array.isArray(body.tools) && (body.tools as unknown[]).length > 0,
    vision: detectVision(body.messages),
  };
}

function capTokens(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 1024;
  return Math.min(Math.max(n, 1), 8192);
}

// Anthropic -> Chat Completions translation.
function anthropicToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = (body.system as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  for (const m of rawMessages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      const images: Array<Record<string, unknown>> = [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
        else if (part.type === "image" && part.source && typeof part.source === "object") {
          const src = part.source as Record<string, unknown>;
          if (src.type === "url" && typeof src.url === "string") {
            images.push({ type: "image_url", image_url: { url: src.url } });
          } else if (src.type === "base64" && typeof src.data === "string") {
            images.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } });
          }
        } else if (part.type === "tool_result") {
          texts.push(`[tool result: ${JSON.stringify(part.content ?? "")}]`);
        }
      }
      if (images.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (texts.length > 0) parts.push({ type: "text", text: texts.join("\n") });
        for (const img of images) parts.push(img);
        messages.push({ role, content: parts });
      } else {
        messages.push({ role, content: texts.join("\n") });
      }
    }
  }
  const out: Record<string, unknown> = { messages };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = (body.tools as Array<Record<string, unknown>>).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        parameters: (t.input_schema || { type: "object", properties: {} }) as Record<string, unknown>,
      },
    }));
  }
  return out;
}

function declaredToolNames(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(body.tools)) {
    for (const t of body.tools as Array<Record<string, unknown>>) {
      if (typeof t.name === "string") names.add(t.name);
    }
  }
  return names;
}

// ---- response builders ----
function openaiJsonResponse(model: string, id: string, result: UpstreamOk, declared: Set<string>): Record<string, unknown> {
  const toolCalls = result.toolCalls.filter((tc) => declared.size === 0 || declared.has(tc.name));
  const message: Record<string, unknown> = { role: "assistant", content: result.text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id || `call_${SEED}_${promptCounter}`,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created: CREATED,
    model,
    choices: [{ index: 0, message, finish_reason: openaiFinish(toolCalls.length > 0 ? "tool_calls" : result.finishReason) }],
    usage: result.usage,
  };
}

function anthropicJsonResponse(model: string, id: string, result: UpstreamOk, declared: Set<string>): Record<string, unknown> {
  const toolCalls = result.toolCalls.filter((tc) => declared.size === 0 || declared.has(tc.name));
  const content: Array<Record<string, unknown>> = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const tc of toolCalls) {
    let input: unknown = {};
    try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = {}; }
    content.push({ type: "tool_use", id: tc.id || `toolu_${SEED}_${promptCounter}`, name: tc.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: anthropicStop(toolCalls.length > 0 ? "tool_calls" : result.finishReason),
    stop_sequence: null,
    usage: { input_tokens: result.usage.prompt_tokens, output_tokens: Math.max(1, result.usage.completion_tokens) },
  };
}

function splitText(text: string): string[] {
  if (text.length === 0) return [];
  const parts: string[] = [];
  const n = Math.min(3, Math.max(1, Math.ceil(text.length / 24)));
  const size = Math.ceil(text.length / n);
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

function openaiStreamBody(model: string, id: string, result: UpstreamOk, declared: Set<string>): string {
  const lines: string[] = [];
  const toolCalls = result.toolCalls.filter((tc) => declared.size === 0 || declared.has(tc.name));
  const finish = openaiFinish(toolCalls.length > 0 ? "tool_calls" : result.finishReason);
  const head: Record<string, unknown> = {
    id, object: "chat.completion.chunk", created: CREATED, model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };
  lines.push(`data: ${JSON.stringify(head)}`);
  for (const part of splitText(result.text)) {
    lines.push(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created: CREATED, model,
      choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
    })}`);
  }
  if (toolCalls.length > 0) {
    const deltas = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id || `call_${SEED}_${promptCounter}`,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
    lines.push(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created: CREATED, model,
      choices: [{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }],
    })}`);
  }
  lines.push(`data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: CREATED, model,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  })}`);
  lines.push(`data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: CREATED, model,
    choices: [], usage: result.usage,
  })}`);
  lines.push("data: [DONE]");
  return lines.join("\n\n") + "\n\n";
}

function anthropicStreamBody(model: string, id: string, result: UpstreamOk, declared: Set<string>): string {
  const lines: string[] = [];
  const toolCalls = result.toolCalls.filter((tc) => declared.size === 0 || declared.has(tc.name));
  const stop = anthropicStop(toolCalls.length > 0 ? "tool_calls" : result.finishReason);
  const ev = (type: string, payload: Record<string, unknown>): void => {
    lines.push(`event: ${type}\ndata: ${JSON.stringify(payload)}`);
  };
  ev("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", content: [], model,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: result.usage.prompt_tokens, output_tokens: 0 },
    },
  });
  let index = 0;
  if (result.text) {
    ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const part of splitText(result.text)) {
      ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
    }
    ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  for (const tc of toolCalls) {
    let input: unknown = {};
    try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = {}; }
    ev("content_block_start", {
      type: "content_block_start", index,
      content_block: { type: "tool_use", id: tc.id || `toolu_${SEED}_${promptCounter}`, name: tc.name, input: {} },
    });
    ev("content_block_delta", {
      type: "content_block_delta", index,
      delta: { type: "input_json_delta", partial_json: tc.args || "{}" },
    });
    ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  if (index === 0) {
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: Math.max(1, result.usage.completion_tokens) },
  });
  ev("message_stop", { type: "message_stop" });
  return lines.join("\n\n") + "\n\n";
}

// ---- HTTP server ----
async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  promptCounter++;
  const n = promptCounter;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid_json", type: "invalid_request_error" } }));
    return;
  }
  const stream = body.stream === true;
  const need = chatBodyToNeed(body);
  const upstreamBody: Record<string, unknown> = { messages: body.messages || [] };
  if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
  if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
  if (body.response_format !== undefined) upstreamBody.response_format = body.response_format;
  if (Array.isArray(body.tools)) upstreamBody.tools = body.tools;
  if (body.tool_choice !== undefined) upstreamBody.tool_choice = body.tool_choice;
  if (typeof body.stop === "string" || Array.isArray(body.stop)) upstreamBody.stop = body.stop;
  upstreamBody.max_tokens = capTokens(body.max_tokens ?? body.max_completion_tokens);
  if (stream) upstreamBody.stream_options = { include_usage: true };
  const declared = declaredToolNames(body);
  const outcome = await serve(upstreamBody, need, stream);
  const header = failuresHeader(outcome.failures);
  const id = `chatcmpl-${SEED}-${n}`;
  if (!outcome.result || !outcome.model) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (header) headers["x-makefun-upstream-failures"] = header;
    res.writeHead(502, headers);
    res.end(JSON.stringify({ error: { message: "upstream_failed", type: "upstream_error", code: "upstream_failed" } }));
    return;
  }
  if (stream) {
    const headers: Record<string, string> = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
    if (header) headers["x-makefun-upstream-failures"] = header;
    res.writeHead(200, headers);
    res.end(openaiStreamBody(outcome.model, id, outcome.result, declared));
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header) headers["x-makefun-upstream-failures"] = header;
  res.writeHead(200, headers);
  res.end(JSON.stringify(openaiJsonResponse(outcome.model, id, outcome.result, declared)));
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  promptCounter++;
  const n = promptCounter;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid_json" } }));
    return;
  }
  const stream = body.stream === true;
  const chat = anthropicToChat(body);
  const need: Need = {
    json: false,
    tools: Array.isArray(body.tools) && (body.tools as unknown[]).length > 0,
    vision: detectVision(body.messages),
  };
  const upstreamBody: Record<string, unknown> = { ...chat };
  upstreamBody.max_tokens = capTokens(body.max_tokens);
  if (stream) upstreamBody.stream_options = { include_usage: true };
  const declared = declaredToolNames(body);
  const outcome = await serve(upstreamBody, need, stream);
  const header = failuresHeader(outcome.failures);
  const id = `msg-${SEED}-${n}`;
  if (!outcome.result || !outcome.model) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (header) headers["x-makefun-upstream-failures"] = header;
    res.writeHead(502, headers);
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream_failed" } }));
    return;
  }
  if (stream) {
    const headers: Record<string, string> = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
    if (header) headers["x-makefun-upstream-failures"] = header;
    res.writeHead(200, headers);
    res.end(anthropicStreamBody(outcome.model, id, outcome.result, declared));
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header) headers["x-makefun-upstream-failures"] = header;
  res.writeHead(200, headers);
  res.end(JSON.stringify(anthropicJsonResponse(outcome.model, id, outcome.result, declared)));
}

function handleModels(req: http.IncomingMessage, res: http.ServerResponse): void {
  const anthropic = req.headers["x-api-key"] !== undefined;
  res.writeHead(200, { "Content-Type": "application/json" });
  if (anthropic) {
    res.end(JSON.stringify({
      data: MODELS.map((m) => ({
        type: "model",
        id: m.id,
        display_name: m.id.replace("openrouter/", "").replace(":free", " (free)"),
        created_at: TRIAL_NOW || "2026-11-15T03:30:00Z",
      })),
      has_more: false,
      first_id: MODELS[0].id,
      last_id: MODELS[MODELS.length - 1].id,
    }));
    return;
  }
  res.end(JSON.stringify({
    object: "list",
    data: MODELS.map((m) => ({ id: m.id, object: "model", created: CREATED, owned_by: "openrouter" })),
  }));
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  const path = url.split("?")[0];
  if (req.method === "POST" && path === "/v1/chat/completions") {
    handleChatCompletions(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: "internal", type: "server_error" } }));
    });
    return;
  }
  if (req.method === "POST" && path === "/v1/messages") {
    handleMessages(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal" } }));
    });
    return;
  }
  if (req.method === "GET" && path === "/v1/models") {
    handleModels(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not_found", type: "invalid_request_error" } }));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<boolean> {
  if (!ENV_URL) return true;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog: catalogDocument() }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  return false;
}

async function pollWork(): Promise<void> {
  if (!ENV_URL) return;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch { /* keep polling */ }
    await sleep(400);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    process.stdout.write(catalogJson() + "\n");
    return;
  }
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const shuttingDown = (): void => {
    try { server.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on("SIGTERM", shuttingDown);
  process.on("SIGINT", shuttingDown);
  await register(port);
  await pollWork();
  try { server.close(); } catch { /* already closed */ }
}

main().catch(() => process.exit(1));
