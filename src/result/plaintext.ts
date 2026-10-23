import type { AnalysisRecord } from '../shared/types';

/**
 * 把一条分析记录拼成纯文本，方便用户复制走。
 *
 * 单独成模块是为了能测——`result.ts` 一导入就会摸 DOM，
 * 在 node 环境下没法直接测。
 */
export function buildPlainText(rec: AnalysisRecord): string {
  // 美化档的结构完全不同，单独拼。
  if (rec.kind === 'polish') return buildPolishText(rec);

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

/**
 * 美化档的纯文本导出。
 *
 * 顺序跟页面一致：先说实际含义，再给可直接用的改写版。
 */
function buildPolishText(rec: AnalysisRecord): string {
  const p = rec.polish;
  const lines: string[] = [];
  lines.push('【划选的原文】');
  lines.push(rec.input.text);
  lines.push('');
  if (p?.meaning) {
    lines.push('【这段话实际在说什么】');
    lines.push(p.meaning);
    lines.push('');
  }
  if (p?.rewritten) {
    lines.push('【去掉情绪化表达后】');
    lines.push(p.rewritten);
    lines.push('');
  }
  if (p?.emotional.length) {
    lines.push('【情绪化用词】');
    for (const e of p.emotional) lines.push(`· ${e.word}：${e.why}`);
    lines.push('');
  }
  if (p?.tone) {
    lines.push('【原文的情绪基调】');
    lines.push(p.tone);
    lines.push('');
  }
  lines.push('（由「正误分析」扩展生成，仅供参考，不构成专业意见）');
  return lines.join('\n');
}

/** HTML 转义。模型输出是不可信文本，拼 innerHTML 前必须过这一道。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
