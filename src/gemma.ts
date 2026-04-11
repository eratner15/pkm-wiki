const MODEL = '@cf/google/gemma-4-26b-a4b-it';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runGemma(
  ai: any,
  system: string,
  user: string,
  maxTokens = 4000
): Promise<string> {
  const MAX_RETRIES = 4;
  const BACKOFF = [5000, 15000, 30000, 45000];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await ai.run(MODEL, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      });

      // Gemma 4 26B returns OpenAI-compatible format
      const response =
        result?.choices?.[0]?.message?.content ||
        result?.response ||
        result?.result?.response ||
        '';

      return response;
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Rate limit (3050) or overloaded — retry with backoff
      if ((msg.includes('3050') || msg.includes('rate') || msg.includes('retry') || msg.includes('overloaded')) && attempt < MAX_RETRIES - 1) {
        console.log(`GEMMA_RATE_LIMIT: attempt ${attempt + 1}, waiting ${BACKOFF[attempt]}ms`);
        await sleep(BACKOFF[attempt]);
        continue;
      }
      throw err;
    }
  }
  return '';
}

function extractJSON(raw: string): string {
  let cleaned = raw.trim();

  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Try to find JSON object/array boundaries
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

  // Find matching close by counting depth
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
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  // Handle truncated JSON — close open structures
  let truncated = cleaned.slice(start);
  truncated = truncated.replace(/,\s*"[^"]*"?\s*$/, '');
  truncated = truncated.replace(/,\s*$/, '');

  while (depth > 0) {
    truncated += closeChar;
    depth--;
  }

  return truncated;
}

export async function runGemmaJSON<T>(
  ai: any,
  system: string,
  user: string,
  maxTokens = 4000
): Promise<T> {
  const raw = await runGemma(
    ai,
    system + '\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no commentary before or after the JSON. Start your response with { and end with }.',
    user,
    maxTokens
  );

  if (!raw || raw.trim().length === 0) {
    throw new Error('Gemma returned empty response');
  }

  try {
    const jsonStr = extractJSON(raw);
    return JSON.parse(jsonStr) as T;
  } catch (parseErr) {
    console.log('GEMMA_RAW_RESPONSE:', raw.slice(0, 500));
    throw new Error(`Failed to parse Gemma JSON: ${(parseErr as Error).message}. Raw: ${raw.slice(0, 300)}`);
  }
}
