import { describe, it, expect, vi } from 'vitest';
import { normalizeQuery, parseRss, searchAll, searchOne } from '../../src/bg/search';
import { MAX_SEARCH_HITS, MAX_QUERY_CHARS } from '../../src/shared/constants';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>搜索结果</title>
<item>
  <title>标题一</title>
  <link>https://example.com/a?x=1</link>
  <description>摘要一 &amp; 更多</description>
</item>
<item>
  <title><![CDATA[标题 <b>二</b>]]></title>
  <link>https://example.com/b</link>
  <description><![CDATA[摘要二]]></description>
</item>
<item>
  <title>没有链接的条目</title>
  <description>无 link</description>
</item>
</channel></rss>`;

describe('检索词规范化', () => {
  it('合并多余空白', () => {
    expect(normalizeQuery('  AI   就业   统计 ')).toBe('AI 就业 统计');
  });

  it('超长截断', () => {
    const q = '人'.repeat(MAX_QUERY_CHARS + 10);
    expect(normalizeQuery(q).length).toBe(MAX_QUERY_CHARS);
  });

  it('空串还是空串', () => {
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('RSS 解析', () => {
  it('取出标题/链接/摘要', () => {
    const hits = parseRss(RSS, 'q1');
    expect(hits.length).toBe(2);
    expect(hits[0]!.title).toBe('标题一');
    expect(hits[0]!.url).toBe('https://example.com/a?x=1');
    expect(hits[0]!.snippet).toContain('摘要一');
    expect(hits[0]!.query).toBe('q1');
  });

  it('反转义 XML 实体', () => {
    const hits = parseRss(RSS, 'q1');
    expect(hits[0]!.snippet).toContain('&');
    expect(hits[0]!.snippet).not.toContain('&amp;');
  });

  it('处理 CDATA 并剥掉残留标签', () => {
    const hits = parseRss(RSS, 'q1');
    expect(hits[1]!.title).toBe('标题 二');
    expect(hits[1]!.snippet).toBe('摘要二');
  });

  it('缺少链接的条目被丢掉', () => {
    const hits = parseRss(RSS, 'q1');
    expect(hits.some((h) => h.title === '没有链接的条目')).toBe(false);
  });

  it('条数不超过上限', () => {
    const many = `<rss><channel>${Array.from(
      { length: 50 },
      (_, i) => `<item><title>t${i}</title><link>https://e.com/${i}</link><description>d</description></item>`,
    ).join('')}</channel></rss>`;
    expect(parseRss(many, 'q').length).toBe(MAX_SEARCH_HITS);
  });

  it('非 RSS 文本返回空数组，不抛', () => {
    expect(parseRss('<html>not rss</html>', 'q')).toEqual([]);
  });
});

describe('搜索', () => {
  it('请求带 format=rss 与编码后的检索词', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(RSS, { status: 200 }),
    );
    await searchOne('AI 就业');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('bing.com/search');
    expect(url).toContain('format=rss');
    expect(url).toContain(encodeURIComponent('AI 就业'));
  });

  it('HTTP 失败返回空数组，不抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }));
    await expect(searchOne('q')).resolves.toEqual([]);
  });

  it('网络异常返回空数组，不抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('offline');
    });
    await expect(searchOne('q')).resolves.toEqual([]);
  });

  it('多条检索词的结果按 URL 去重', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(RSS, { status: 200 }));
    const res = await searchAll(['q1', 'q2']);
    // 两条检索词返回同样两条内容，去重后仍是 2 条
    expect(res.hits.length).toBe(2);
    expect(res.error).toBeUndefined();
  });

  it('URL 的 query/fragment 不同也算重复', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        '<rss><channel><item><title>a</title><link>https://e.com/x?p=1</link><description>d</description></item></channel></rss>',
        { status: 200 },
      ),
    );
    const res = await searchAll(['q1', 'q2']);
    expect(res.hits.length).toBe(1);
  });

  it('全部检索失败时报错，不装作搜过', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }));
    const res = await searchAll(['q1', 'q2']);
    expect(res.hits).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('部分失败时保留成功的结果且不报整体错误', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(RSS, { status: 200 });
      return new Response('', { status: 500 });
    });
    const res = await searchAll(['q1', 'q2']);
    expect(res.hits.length).toBe(2);
    expect(res.error).toBeUndefined();
  });

  it('检索词为空时直接返回空', async () => {
    const res = await searchAll([]);
    expect(res.hits).toEqual([]);
    expect(res.error).toBeUndefined();
  });
});
