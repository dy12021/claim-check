import type { AnalysisRecord } from '../shared/types';

/**
 * 把一条分析记录拼成纯文本，方便用户复制走。
 *
 * 单独成模块是为了能测——`result.ts` 一导入就会摸 DOM，
 * 在 node 环境下没法直接测。
 */
export function buildPlainText(rec: AnalysisRecord): string {
  const lines: string[] = [];
  lines.push('【划选的原文】');
  lines.push(rec.input.text);
  if (rec.input.pageUrl) lines.push(`（${rec.input.pageUrl}）`);
  lines.push('');
  if (rec.pass2) {
    lines.push('【结论】');
    lines.push(
      `${rec.pass2.verdictText}（把握程度 ${(rec.pass2.confidence * 100).toFixed(0)}%）`,
    );
    lines.push('');
    lines.push(rec.pass2.analysis);
  }
  if (rec.pass1?.logicIssues.length) {
    lines.push('');
    lines.push('【可能的逻辑问题】');
    for (const i of rec.pass1.logicIssues) {
      lines.push(`· ${i.type}：${i.explanation}${i.quote ? `（原文：「${i.quote}」）` : ''}`);
    }
  }
  if (rec.pass1?.assumptions.length) {
    lines.push('');
    lines.push('【没说出口的前提】');
    for (const a of rec.pass1.assumptions) lines.push(`· ${a}`);
  }
  if (rec.pass2?.notCovered.length) {
    lines.push('');
    lines.push('【证据没覆盖、无法判断】');
    for (const n of rec.pass2.notCovered) lines.push(`· ${n}`);
  }
  if (rec.search.hits.length) {
    lines.push('');
    lines.push('【检索到的资料】');
    for (const h of rec.search.hits) lines.push(`· ${h.title} —— ${h.url}`);
  }
  lines.push('');
  lines.push('（由「正误分析」扩展生成，仅供参考，不构成专业意见）');
  return lines.join('\n');
}

/** HTML 转义。模型输出是不可信文本，拼 innerHTML 前必须过这一道。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
