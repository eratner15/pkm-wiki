// KV Cache — Fast reads for hot pages and search results

const PAGE_TTL = 3600; // 1 hour for page content
const SEARCH_TTL = 300; // 5 minutes for search results
const BRIEFING_TTL = 1800; // 30 minutes for briefing data

export async function cacheGet(env: any, key: string): Promise<string | null> {
  if (!env.CACHE) return null;
  try {
    return await env.CACHE.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(env: any, key: string, value: string, ttl?: number): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
  } catch {
    // KV write failures are non-critical
  }
}

export async function cacheDelete(env: any, key: string): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.delete(key);
  } catch {
    // Ignore
  }
}

// Cache keys
export function pageKey(slug: string): string {
  return `page:${slug}`;
}

export function searchKey(query: string): string {
  return `search:${query.toLowerCase().trim()}`;
}

export function briefingKey(id: string): string {
  return `briefing:${id}`;
}

// Invalidate page cache on edit
export async function invalidatePage(env: any, slug: string): Promise<void> {
  await cacheDelete(env, pageKey(slug));
}

// Helper: get page content with caching
export async function getCachedPage(env: any, slug: string): Promise<string | null> {
  const cached = await cacheGet(env, pageKey(slug));
  if (cached !== null) return cached;

  const obj = await env.STORAGE.get(`wiki/${slug}.md`);
  if (!obj) return null;

  const content = await obj.text();
  await cacheSet(env, pageKey(slug), content, PAGE_TTL);
  return content;
}

// Helper: get search results with caching
export async function getCachedSearch(env: any, query: string): Promise<any | null> {
  const cached = await cacheGet(env, searchKey(query));
  if (cached !== null) {
    try { return JSON.parse(cached); } catch { return null; }
  }
  return null;
}

export async function setCachedSearch(env: any, query: string, results: any): Promise<void> {
  await cacheSet(env, searchKey(query), JSON.stringify(results), SEARCH_TTL);
}
