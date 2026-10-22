import { describe, it, expect, vi } from 'vitest';
import {
  parsePass1,
  parsePass2,
  buildPass1User,
  buildPass2User,
  runAnalysis,
  PASS1_SYSTEM,
  PASS2_SYSTEM,
} from '../../src/bg/analyze';
import type { LlmClient } from '../../src/bg/llm/client';
import type { AnalysisInput, Settings } from '../../src/shared/types';
import { MAX_INPUT_CHARS } from '../../src/shared/constants';

function makeSettings(enableSearch = true): Settings {
  return {
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'm1',
      timeoutMs: 5000,
    },
    enableSearch,
    maxSearchResults: 8,
    historyLimit: 30,
  };
}

function fakeClient(responses: string[]): LlmClient {
  let i = 0;
  return {
    complete: async () => {
      const r = responses[i];
      i++;
      if (r === undefined) throw new Error('测试没给够响应');
      return r;
    },
  };
}

const RSS = `<rss><channel>
<item><title>资料标题</title><link>https://example.com/x</link><description>资料摘要</description></item>
</channel></rss>`;

function rssFetch(): typeof fetch {
  return (async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
}

const PASS1_OK = JSON.stringify({
  kind: 'argument',
  summary: '某人在论证某个因果关系',
  claims: [
    { text: 'A 导致 B', confidence: '高' },
    { text: 'C 一定成立', confidence: '低' },
  ],
  logicIssues: [
    { quote: 'A 导致 B', type: '因果倒置', explanation: '可能其实是 B 导致 A' },
  ],
  assumptions: ['前提一'],
  missingEvidence: ['缺证据一'],
  queries: ['检索 词', '第二 词'],
});

const PASS2_OK = JSON.stringify({
  verdict: 'uncertain',
  confidence: 0.42,
  verdictText: '证据不足，无法判定',
  analysis: '这段话结构是……',
  supported: [{ point: '部分站得住', evidence: '资料标题' }],
  challenged: [{ point: '部分存疑', evidence: '（无资料支撑）' }],
  notCovered: ['某点没被覆盖'],
  followUps: ['值得继续查的'],
});

describe('第一阶段解析', () => {
  it('正常 JSON 全部字段都读出来', () => {
    const r = parsePass1(PASS1_OK);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('argument');
    expect(r!.summary).toBe('某人在论证某个因果关系');
    expect(r!.claims).toEqual([
      { text: 'A 导致 B', confidence: '高' },
      { text: 'C 一定成立', confidence: '低' },
    ]);
    expect(r!.logicIssues).toHaveLength(1);
    expect(r!.logicIssues[0]!.type).toBe('因果倒置');
    expect(r!.assumptions).toEqual(['前提一']);
    expect(r!.missingEvidence).toEqual(['缺证据一']);
    expect(r!.queries).toEqual(['检索 词', '第二 词']);
  });

  it('带 ```json 包裹也能解析', () => {
    expect(parsePass1('```json\n' + PASS1_OK + '\n```')).not.toBeNull();
  });

  it('不是 JSON 返回 null', () => {
    expect(parsePass1('完全不是 JSON')).toBeNull();
  });

  it('字段类型不对时退回保守值，不抛', () => {
    const r = parsePass1('{"kind":123,"claims":"不是数组","logicIssues":{},"queries":7}');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('other');
    expect(r!.claims).toEqual([]);
    expect(r!.logicIssues).toEqual([]);
    expect(r!.queries).toEqual([]);
  });

  it('未知 kind 归到 other', () => {
    expect(parsePass1('{"kind":"胡说"}')!.kind).toBe('other');
  });

  it('数组里的非对象元素被丢掉', () => {
    const r = parsePass1('{"claims":[null, 3, "x", {"text":"ok"}]}');
    expect(r!.claims).toEqual([{ text: 'ok', confidence: '中' }]);
  });

  it('空 text 的主张被丢掉', () => {
    const r = parsePass1('{"claims":[{"text":"  "},{"text":"ok"}]}');
    expect(r!.claims).toHaveLength(1);
  });

  it('把握程度只认高/中/低，其它按中', () => {
    const r = parsePass1('{"claims":[{"text":"a","confidence":"very high"},{"text":"b","confidence":"低"}]}');
    expect(r!.claims[0]!.confidence).toBe('中');
    expect(r!.claims[1]!.confidence).toBe('低');
  });

  it('逻辑问题缺 type 时给默认名', () => {
    const r = parsePass1('{"logicIssues":[{"quote":"q","explanation":"e"}]}');
    expect(r!.logicIssues[0]!.type).toBe('逻辑问题');
  });
});

describe('第二阶段解析', () => {
  it('正常 JSON 都读出来', () => {
    const r = parsePass2(PASS2_OK);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('uncertain');
    expect(r!.confidence).toBeCloseTo(0.42);
    expect(r!.supported).toEqual([{ point: '部分站得住', evidence: '资料标题' }]);
    expect(r!.challenged).toHaveLength(1);
    expect(r!.notCovered).toEqual(['某点没被覆盖']);
    expect(r!.followUps).toEqual(['值得继续查的']);
  });

  it('非法 verdict 退回 uncertain，不硬猜', () => {
    expect(parsePass2('{"verdict":"definitely_true"}')!.verdict).toBe('uncertain');
  });

  it('confidence 越界被夹到 [0,1]', () => {
    expect(parsePass2('{"confidence":5}')!.confidence).toBe(1);
    expect(parsePass2('{"confidence":-2}')!.confidence).toBe(0);
    expect(parsePass2('{"confidence":"高"}')!.confidence).toBe(0.5);
  });

  it('不是 JSON 返回 null', () => {
    expect(parsePass2('nope')).toBeNull();
  });
});

describe('prompt 构造', () => {
  const input: AnalysisInput = { text: '原文内容', pageUrl: 'https://e.com/p', pageTitle: '页面标题' };

  it('第一阶段带上原文与出处', () => {
    const u = buildPass1User(input);
    expect(u).toContain('原文内容');
    expect(u).toContain('https://e.com/p');
    expect(u).toContain('不要把它当证据');
  });

  it('原文超长会被截断', () => {
    const long: AnalysisInput = { text: 'x'.repeat(MAX_INPUT_CHARS + 500) };
    expect(buildPass1User(long)).not.toContain('x'.repeat(MAX_INPUT_CHARS + 1));
  });

  it('没有资料时明确告诉模型「未获取到资料」', () => {
    const u = buildPass2User(input, []);
    expect(u).toContain('未获取到资料');
    expect(u).toContain('uncertain');
  });

  it('有资料时列出标题与摘要', () => {
    const u = buildPass2User(input, [
      { title: '资料标题', url: 'https://e.com/x', snippet: '资料摘要', query: 'q' },
    ]);
    expect(u).toContain('资料标题');
    expect(u).toContain('资料摘要');
    expect(u).toContain('https://e.com/x');
  });

  it('系统提示写死了「不站队」与「允许无法判定」', () => {
    expect(PASS1_SYSTEM).toContain('不预设立场');
    expect(PASS2_SYSTEM).toContain('不站队');
    expect(PASS2_SYSTEM).toContain('允许「无法判定」');
  });
});

describe('完整分析流程', () => {
  const input: AnalysisInput = { text: 'A 导致 B', pageUrl: 'https://e.com/p' };

  it('两阶段都跑通并留下检索资料', async () => {
    const rec = await runAnalysis(
      'id-1',
      input,
      makeSettings(true),
      fakeClient([PASS1_OK, PASS2_OK]),
      rssFetch(),
    );
    expect(rec.error).toBeUndefined();
    expect(rec.pass1).not.toBeNull();
    expect(rec.pass2).not.toBeNull();
    expect(rec.pass2!.verdict).toBe('uncertain');
    expect(rec.search.queries).toEqual(['检索 词', '第二 词']);
    expect(rec.search.hits).toHaveLength(1);
    expect(rec.search.hits[0]!.title).toBe('资料标题');
  });

  it('第一阶段不是 JSON 时如实报错，不抛', async () => {
    const rec = await runAnalysis('id-2', input, makeSettings(false), fakeClient(['垃圾输出']), rssFetch());
    expect(rec.error).toContain('结构解析失败');
    expect(rec.pass1).toBeNull();
    expect(rec.pass2).toBeNull();
  });

  it('第一阶段抛错时如实记录原因', async () => {
    const rec = await runAnalysis(
      'id-3',
      input,
      makeSettings(false),
      fakeClient([]),
      rssFetch(),
    );
    expect(rec.error).toContain('结构解析失败');
  });

  it('第二阶段失败时保留第一阶段结果', async () => {
    const rec = await runAnalysis(
      'id-4',
      input,
      makeSettings(false),
      fakeClient([PASS1_OK, '垃圾输出']),
      rssFetch(),
    );
    expect(rec.pass1).not.toBeNull();
    expect(rec.error).toContain('最终分析失败');
  });

  it('关掉深度搜索时完全不发搜索请求', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const rec = await runAnalysis(
      'id-5',
      input,
      makeSettings(false),
      fakeClient([PASS1_OK, PASS2_OK]),
      spy as unknown as typeof fetch,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(rec.search.hits).toEqual([]);
    expect(rec.search.queries).toEqual([]);
  });

  it('搜索失败时如实记录，但仍然给结论', async () => {
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const rec = await runAnalysis(
      'id-6',
      input,
      makeSettings(true),
      fakeClient([PASS1_OK, PASS2_OK]),
      failing,
    );
    expect(rec.search.error).toBeTruthy();
    expect(rec.pass2).not.toBeNull();
  });
});
