import {
  MAX_SEARCH_HITS,
  MAX_QUERY_CHARS,
  MAX_HIT_SNIPPET_CHARS,
  SEARCH_ENDPOINT,
} from '../shared/constants';
import type { SearchHit } from '../shared/types';

/**
 * 深度搜索：Bing 的 RSS 出口。
 *
 * ## 为什么选它
 *
 * - **不需要任何 API Key**（用户只要配 LLM 的 Key 就能用）；
 * - 返回的是标准 RSS，标题/摘要/链接三样都有，够 LLM 做「有没有资料支持」的判断；
 * - 国内可访问（DuckDuckGo / Wikipedia 在国内网络下不通）。
 *
 * ## 已知限制：长中文查询会被截断
 *
 * 实测 Bing 的 RSS 对过长的中文串只匹配前几个字：
 * 「人工智能取代人类工作」（10 字）→ 结果全变成「人工」；
 * 「新能源汽车补贴政策」（9 字）→ 正常。
 * 所以检索词要短，**这一点写进了 prompt**（要求 2-4 个词用空格隔开），
 * 并且这里再做一次长度兜底。
 */

/** 检索词规范化：去掉空白、限长。 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

/** 从 RSS 的 XML 文本里抠出结果条目。 */
export function parseRss(xml: string, query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const title = decodeXml(tag(block, 'title'));
    const link = decodeXml(tag(block, 'link'));
    const desc = decodeXml(tag(block, 'description'));
    if (!title || !link) continue;
    hits.push({
      title,
      url: link,
      snippet: desc.slice(0, MAX_HIT_SNIPPET_CHARS),
      query,
    });
    if (hits.length >= MAX_SEARCH_HITS) break;
  }
  return hits;
}

/** 取某个标签的内容。 */
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m?.[1] ?? '';
}

/** XML 实体反转义 + 去掉残留标签。 */
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 搜索一条检索词。失败返回空数组（**不抛**）。 */
export async function searchOne(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  const q = normalizeQuery(query);
  if (!q) return [];
  const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}&format=rss`;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, q);
  } catch {
    return [];
  }
}

/**
 * 搜多条检索词，合并去重。
 *
 * 返回值里的 `error` 说明「搜过但没搜到」还是「根本没搜成」——
 * 前端要如实告诉用户，不能装作搜过了。
 */
export async function searchAll(
  queries: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ hits: SearchHit[]; error?: string }> {
  const list = queries.map(normalizeQuery).filter(Boolean);
  if (list.length === 0) return { hits: [] };

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  let okCount = 0;

  for (const q of list) {
    const got = await searchOne(q, fetchImpl);
    if (got.length > 0) okCount++;
    for (const h of got) {
      const key = h.url.replace(/[#?].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
      if (hits.length >= MAX_SEARCH_HITS) break;
    }
    if (hits.length >= MAX_SEARCH_HITS) break;
  }

  if (okCount === 0) {
    return { hits: [], error: '搜索请求没成功（网络受限或搜索引擎不可达）' };
  }
  return { hits };
}
