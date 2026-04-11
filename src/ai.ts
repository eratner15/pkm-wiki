/**
 * Multi-model AI layer for PKM Wiki
 * Routes tasks to the best Workers AI model for the job:
 *
 * - INGEST (entity extraction): GPT-OSS-120B — best reasoning per dollar, strong JSON
 * - IDEAS (creative connections): Kimi K2.5 — 256K context, frontier reasoning
 * - SPARK (planning): GPT-OSS-120B — structured output, good reasoning
 * - CODE (building): Qwen2.5-Coder-32B — purpose-built for code generation
 * - QUICK (classification): Gemma 4 26B — fast MoE, good for simple tasks
 * - QUERY (Q&A synthesis): GPT-OSS-120B — strong reasoning, good at synthesis
 */

const MODELS = {
  ingest: '@cf/nvidia/nemotron-3-120b-a12b',    // 120B, 256K ctx, agentic, $0.50/M in
  ideas: '@cf/moonshotai/kimi-k2.5',             // 256K ctx, frontier reasoning, creative
  spark: '@cf/google/gemma-4-26b-a4b-it',         // Fast MoE, structured JSON, free tier
  research: '@cf/nvidia/nemotron-3-120b-a12b',   // 120B, combined ingest+synthesis, needs strong reasoning
  code: '@cf/qwen/qwen2.5-coder-32b-instruct',  // Purpose-built for code generation
  quick: '@cf/google/gemma-4-26b-a4b-it',        // Fast MoE, simple tasks, free tier
  query: '@cf/nvidia/nemotron-3-120b-a12b',      // 120B, best reasoning for synthesis
} as const;

type TaskType = keyof typeof MODELS;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractResponse(result: any): string {
  return (
    result?.choices?.[0]?.message?.content ||
    result?.response ||
    result?.result?.response ||
    ''
  );
}

export async function runAI(
  ai: any,
  task: TaskType,
  system: string,
  user: string,
  maxTokens = 4000
): Promise<string> {
  const model = MODELS[task];
  const MAX_RETRIES = 4;
  const BACKOFF = [5000, 15000, 30000, 45000];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`AI_CALL: ${task} → ${model} (attempt ${attempt + 1})`);

      const result = await ai.run(model, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: task === 'ideas' ? 0.7 : task === 'code' ? 0.1 : 0.3,
      });

      const response = extractResponse(result);

      if (!response && attempt < MAX_RETRIES - 1) {
        console.log(`AI_EMPTY: ${task} → ${model}, retrying`);
        await sleep(BACKOFF[attempt]);
        continue;
      }

      return response;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if ((msg.includes('3050') || msg.includes('rate') || msg.includes('retry') || msg.includes('overloaded')) && attempt < MAX_RETRIES - 1) {
        console.log(`AI_RATE_LIMIT: ${task} → ${model}, attempt ${attempt + 1}, waiting ${BACKOFF[attempt]}ms`);
        await sleep(BACKOFF[attempt]);
        continue;
      }
      // If primary model fails, fall back to Gemma
      if (model !== MODELS.quick && attempt === MAX_RETRIES - 1) {
        console.log(`AI_FALLBACK: ${task} → ${model} failed, trying Gemma`);
        try {
          const fallback = await ai.run(MODELS.quick, {
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
            temperature: 0.3,
          });
          return extractResponse(fallback);
        } catch {
          // Both failed
        }
      }
      throw err;
    }
  }
  return '';
}

function extractJSON(raw: string): string {
  let cleaned = raw.trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error(`No JSON found in response: ${cleaned.slice(0, 200)}`);
  }

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)) {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  } else {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }

  // Handle truncated JSON — close any unterminated string first
  let truncated = cleaned.slice(start);
  if (inString) {
    // Cut back to the last clean key-value boundary if possible
    const lastQuote = truncated.lastIndexOf('"', truncated.length - 2);
    const lastColon = truncated.lastIndexOf(':', lastQuote);
    const lastComma = truncated.lastIndexOf(',', lastColon);
    if (lastComma > 0) {
      // Drop the incomplete key-value pair
      truncated = truncated.slice(0, lastComma);
    } else {
      // Just close the string
      truncated += '"';
    }
  }
  truncated = truncated.replace(/,\s*"[^"]*"?\s*$/, '');
  truncated = truncated.replace(/,\s*$/, '');
  // Recount depth on the cleaned truncated string
  depth = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < truncated.length; i++) {
    const ch = truncated[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
  }
  while (depth > 0) { truncated += closeChar; depth--; }
  return truncated;
}

export async function runAIJSON<T>(
  ai: any,
  task: TaskType,
  system: string,
  user: string,
  maxTokens = 4000
): Promise<T> {
  const raw = await runAI(
    ai,
    task,
    system + '\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no commentary. Start with { and end with }.',
    user,
    maxTokens
  );

  if (!raw || raw.trim().length === 0) {
    throw new Error(`AI returned empty response for task: ${task}`);
  }

  try {
    const jsonStr = extractJSON(raw);
    return JSON.parse(jsonStr) as T;
  } catch (parseErr) {
    console.log(`AI_PARSE_ERROR (${task}):`, raw.slice(0, 500));
    throw new Error(`Failed to parse AI JSON (${task}): ${(parseErr as Error).message}`);
  }
}

// Backward compatibility — keep old function names working
export const runGemma = (ai: any, system: string, user: string, maxTokens?: number) =>
  runAI(ai, 'quick', system, user, maxTokens);

export const runGemmaJSON = <T>(ai: any, system: string, user: string, maxTokens?: number) =>
  runAIJSON<T>(ai, 'quick', system, user, maxTokens);
