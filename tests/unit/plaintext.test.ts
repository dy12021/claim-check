import { describe, it, expect } from 'vitest';
import { buildPlainText, escapeHtml } from '../../src/result/plaintext';
import type { AnalysisRecord } from '../../src/shared/types';

const full: AnalysisRecord = {
  id: 'r1',
  createdAt: '2026-01-01T00:00:00.000Z',
  input: { text: 'A 导致 B', pageUrl: 'https://e.com/p' },
  pass1: {
    kind: 'argument',
    summary: 's',
    claims: [{ text: 'A 导致 B', confidence: '高' }],
    logicIssues: [{ quote: 'A 导致 B', type: '因果倒置', explanation: '可能反了' }],
    assumptions: ['前提一'],
    missingEvidence: ['缺证据一'],
    queries: ['q'],
  },
  search: {
    hits: [{ title: '资料标题', url: 'https://e.com/x', snippet: '摘要', query: 'q' }],
    queries: ['q'],
  },
  pass2: {
    verdict: 'uncertain',
    confidence: 0.42,
    verdictText: '证据不足，无法判定',
    analysis: '分析正文',
    supported: [{ point: 'p1', evidence: '资料标题' }],
    challenged: [{ point: 'p2', evidence: '（无资料支撑）' }],
    notCovered: ['没覆盖的点'],
    followUps: ['跟进'],
  },
};

describe('纯文本结论', () => {
  it('包含原文、出处、结论、正文', () => {
    const t = buildPlainText(full);
    expect(t).toContain('A 导致 B');
    expect(t).toContain('https://e.com/p');
    expect(t).toContain('证据不足，无法判定');
    expect(t).toContain('42%');
    expect(t).toContain('分析正文');
  });

  it('包含逻辑问题、前提、无法判断的点与检索资料', () => {
    const t = buildPlainText(full);
    expect(t).toContain('因果倒置');
    expect(t).toContain('可能反了');
    expect(t).toContain('前提一');
    expect(t).toContain('没覆盖的点');
    expect(t).toContain('资料标题');
    expect(t).toContain('https://e.com/x');
  });

  it('结尾带免责说明', () => {
    expect(buildPlainText(full)).toContain('仅供参考，不构成专业意见');
  });

  it('只有原文时也能出文本，不空', () => {
    const bare: AnalysisRecord = {
      id: 'r2',
      createdAt: '2026-01-01T00:00:00.000Z',
      input: { text: '只有一句话' },
      pass1: null,
      search: { hits: [], queries: [] },
      pass2: null,
    };
    const t = buildPlainText(bare);
    expect(t).toContain('只有一句话');
    expect(t.length).toBeGreaterThan(10);
  });
});

describe('HTML 转义', () => {
  it('五个危险字符都转掉', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });

  it('普通文本不受影响', () => {
    expect(escapeHtml('普通文字 123')).toBe('普通文字 123');
  });
});
