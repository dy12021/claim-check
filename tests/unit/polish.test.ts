import { describe, it, expect, vi } from 'vitest';
import {
  parsePolish, buildPolishUser, runPolish, findLeftoverEmotional, POLISH_SYSTEM,
} from '../../src/bg/polish';
import { buildPlainText } from '../../src/result/plaintext';
import type { LlmClient } from '../../src/bg/llm/client';
import type { AnalysisInput, AnalysisRecord } from '../../src/shared/types';

const input: AnalysisInput = { text: '这也太离谱了吧！某群体的人真的别出来恶心人了，滚！' };

const OK = JSON.stringify({
  tone: '愤怒的批评',
  emotional: [
    { word: '离谱', why: '情绪词' },
    { word: '恶心人', why: '贬义词' },
  ],
  meaning: '认为某些群体的行为让人无法接受，希望他们不要参与讨论。',
  rewritten: '某些群体的行为让人无法接受，希望他们不要参与讨论。',
});

function client(text: string): LlmClient {
  return { complete: vi.fn(async () => text) };
}

describe('美化的解析', () => {
  it('解析出全部字段', () => {
    const p = parsePolish(OK);
    expect(p).not.toBeNull();
    expect(p!.tone).toBe('愤怒的批评');
    expect(p!.meaning).toContain('无法接受');
    expect(p!.rewritten).toContain('某些群体');
    expect(p!.emotional).toHaveLength(2);
  });

  it('模型输出带废话也能解析出来', () => {
    const p = parsePolish('好的：' + OK + ' 希望对你有帮助');
    expect(p).not.toBeNull();
    expect(p!.rewritten.length).toBeGreaterThan(0);
  });

  it('不是 JSON 时返回 null（不抛）', () => {
    expect(parsePolish('完全不是 JSON')).toBeNull();
  });

  it('缺字段时用空值兜底，不丢整条结果', () => {
    const p = parsePolish(JSON.stringify({ meaning: '只有含义' }));
    expect(p).not.toBeNull();
    expect(p!.meaning).toBe('只有含义');
    expect(p!.rewritten).toBe('');
    expect(p!.emotional).toEqual([]);
  });

  it('三个核心字段全空时判为失败', () => {
    expect(parsePolish(JSON.stringify({ tone: '' }))).toBeNull();
  });

  it('情绪用词表里没有 word 的条目会被丢掉', () => {
    const p = parsePolish(JSON.stringify({
      meaning: 'm',
      emotional: [{ why: '没有原文片段' }, { word: '离谱', why: '情绪词' }],
    }));
    expect(p!.emotional).toHaveLength(1);
    expect(p!.emotional[0]!.word).toBe('离谱');
  });
});

/**
 * 回归防护：美化**只改说法，不改立场**。
 *
 * 这是这个功能最容易做坏的地方——一旦变成「帮人说好话」，
 * 用户拿自己的草稿去用就会发现意思被改了，功能就废了。
 */
describe('美化的 prompt 契约', () => {
  it('写明不改原意、不软化立场', () => {
    expect(POLISH_SYSTEM).toContain('不改原意');
    expect(POLISH_SYSTEM).toContain('不软化立场');
    expect(POLISH_SYSTEM).toContain('不改变强度方向');
  });

  it('写明保持与原文相同的字形（简繁一致）', () => {
    // 真机验证踩过：简体草稿被改写成繁体，用户没法直接粘回去。
    expect(POLISH_SYSTEM).toContain('保持与原文相同的字形');
  });

  it('写明「专业批评不算情绪化」', () => {
    expect(POLISH_SYSTEM).toContain('专业的批评（专业批评不是情绪化）');
  });

  it('把玩梗/阴阳怪气算进情绪化', () => {
    expect(POLISH_SYSTEM).toContain('嘲讽、阴阳怪气、玩梗');
  });

  it('原文本来就中性时不硬改', () => {
    expect(POLISH_SYSTEM).toContain('本来就中性就如实说');
  });

  it('user prompt 带原文', () => {
    const u = buildPolishUser(input);
    expect(u).toContain(input.text);
  });
});

describe('美化的运行', () => {
  it('一次调用就出结果', async () => {
    const c = client(OK);
    const { result, error } = await runPolish(input, c);
    expect(error).toBeUndefined();
    expect(result!.rewritten.length).toBeGreaterThan(0);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('LLM 抛错时不抛，把原因带回去', async () => {
    const c: LlmClient = {
      complete: vi.fn(async () => { throw new Error('挂了'); }),
    };
    const { result, error } = await runPolish(input, c);
    expect(result).toBeNull();
    expect(error).toContain('挂了');
  });
});

/**
 * 回归防护：模型不能一边把词标成情绪化、一边把它原样留在改写版里。
 *
 * 这是**自相矛盾**，而且可以本地确定性地查出来——所以不靠「相信模型」，
 * 而是查出来、带着这个词让它重写一次。
 */
describe('漏改的情绪词会被查出来并重写', () => {
  const bad = JSON.stringify({
    tone: '愤怒',
    emotional: [{ word: '恶心人', why: '贬义' }],
    meaning: 'm',
    rewritten: '这些人不要出来恶心人，离开。',
  });
  const good = JSON.stringify({
    tone: '愤怒',
    emotional: [{ word: '恶心人', why: '贬义' }],
    meaning: 'm',
    rewritten: '这些人不要再出现了，请离开。',
  });

  it('能查出改写版里还留着的情绪词', () => {
    const p = parsePolish(bad)!;
    expect(findLeftoverEmotional(p)).toEqual(['恶心人']);
  });

  it('改干净了就查不出', () => {
    const p = parsePolish(good)!;
    expect(findLeftoverEmotional(p)).toEqual([]);
  });

  it('指代类不算漏改（保留指向是被允许的）', () => {
    const p = parsePolish(JSON.stringify({
      emotional: [{ word: '某群体的人', why: '群体标签' }],
      meaning: 'm',
      rewritten: '某群体的人不要再出现了。',
    }))!;
    expect(findLeftoverEmotional(p)).toEqual([]);
  });

  it('模型只是改了语气词，也算漏改（核心词还在）', () => {
    // 实测：模型把「太离谱了吧」改成「太离谱了」，整串匹配会漏掉
    const p = parsePolish(JSON.stringify({
      emotional: [{ word: '太离谱了吧', why: '情绪词' }],
      meaning: 'm',
      rewritten: '这也太离谱了。',
    }))!;
    expect(findLeftoverEmotional(p)).toEqual(['离谱']);
  });

  it('第一次没改干净时会重试一次', async () => {
    let n = 0;
    const c: LlmClient = {
      complete: vi.fn(async () => {
        n++;
        return n === 1 ? bad : good;
      }),
    };
    const { result } = await runPolish(input, c);
    expect(n).toBe(2);
    expect(result!.rewritten).toContain('请离开');
  });

  it('重试时把漏改的词明确告诉模型', async () => {
    const seen: string[] = [];
    let n = 0;
    const c: LlmClient = {
      complete: vi.fn(async (prompt: string) => {
        seen.push(prompt);
        n++;
        return n === 1 ? bad : good;
      }),
    };
    await runPolish(input, c);
    expect(seen[1]).toContain('恶心人');
  });

  it('试完还是没改掉，如实标出来', async () => {
    const c: LlmClient = { complete: vi.fn(async () => bad) };
    const { result } = await runPolish(input, c);
    expect(result!.leftover).toEqual(['恶心人']);
  });
});

describe('美化档的纯文本导出', () => {
  const rec: AnalysisRecord = {
    id: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'polish',
    input: { text: '原文在这里' },
    pass1: null,
    search: { hits: [], queries: [] },
    pass2: null,
    polish: {
      tone: '愤怒的批评',
      emotional: [{ word: '离谱', why: '情绪词' }],
      meaning: '实际含义',
      rewritten: '改写后的版本',
    },
  };

  it('包含原文、实际含义、改写版本、情绪用词', () => {
    const t = buildPlainText(rec);
    expect(t).toContain('原文在这里');
    expect(t).toContain('实际含义');
    expect(t).toContain('改写后的版本');
    expect(t).toContain('离谱');
  });

  it('没有 kind 的老记录仍按正误分析导出', () => {
    const old: AnalysisRecord = {
      ...rec,
      kind: undefined,
      polish: null,
      pass2: {
        verdict: 'uncertain',
        confidence: 0.5,
        verdictText: '证据不足，无法判定',
        analysis: '分析正文',
        supported: [],
        challenged: [],
        notCovered: [],
        followUps: [],
      },
    };
    expect(buildPlainText(old)).toContain('证据不足，无法判定');
  });
});
