import type { LlmClient } from './llm/client';
import { parseJsonResponse } from './llm/client';
import { searchAll } from './search';
import { MAX_INPUT_CHARS, MAX_SEARCH_QUERIES } from '../shared/constants';
import type {
  AnalysisInput,
  AnalysisRecord,
  CoreClaim,
  LogicIssue,
  Pass1Result,
  Pass2Result,
  SearchHit,
  Settings,
  StatementKind,
  Verdict,
} from '../shared/types';

/**
 * 两阶段分析。
 *
 * ① **结构解析**：这段话在论证什么？有哪些可能的逻辑问题？还需要哪些证据？
 *    同时产出 2-3 个**短的**检索词。
 * ② **深度搜索 + 最终判断**：拿检索到的资料回来，让模型给出公正客观的结论。
 *
 * 分两段的原因是：第一段只需要「这段话本身」，第二段需要「这段话 + 外部资料」，
 * 混在一起模型会顾此失彼（要么忽略原文，要么忽略资料）。
 */

/** 第一阶段的 system prompt。 */
export const PASS1_SYSTEM = [
  '你是一个严谨的论证分析器。输入是用户在网页上划选的一段文字。',
  '',
  '你的任务**不是判断谁对谁错**，而是讲清楚这段话的结构与可能存在的问题。',
  '',
  '【硬性要求】',
  '1. **不预设立场**：不要因为说法来自某个立场、某个群体就否定它。只看论证本身。',
  '2. **只根据原文**：不要引用原文里没有的信息。',
  '3. **不硬凑**：找不到明显逻辑问题就直说「没发现明显逻辑问题」，不要为了凑数编造。',
  '4. **具体**：每条问题都要指出是**哪一句话**出的问题。',
  '5. **区分确定性**：结论超出证据、缺少前提、因果不成立等，要单独列出来。',
  '6. **归类准确**：如果这段话不是论证（如感叹、提问、广告、情绪表达），如实归类，不要硬当论证分析。',
  '',
  '【常见逻辑问题类型】（举例，不是清单限制）',
  '滑坡谬误、稻草人、诉诸权威、诉诸情感、因果倒置、幸存者偏差、以偏概全、循环论证、',
  '偷换概念、不可比性比较、虚假两难、归因谬误、样本偏差、定义混淆、偷换论题…',
  '',
  '【检索词】',
  '给出 2-3 个用于**深度搜索**的检索词，用来找能验证或反驳这段话的资料。',
  '每个检索词是 2-4 个词、**用空格隔开**（例如「人工智能 取代 工作」「AI 就业 统计」）。',
  '检索词要短：过长的中文串在搜索接口上会被截断，搜出来的东西完全跑题。',
  '',
  '【输出格式】严格 JSON，不要任何解释文字：',
  '{',
  '  "kind": "argument|claim|question|opinion|ad|emotion|other",',
  '  "summary": "这段话在说什么（一句话，不超过 40 字）",',
  '  "claims": [{"text": "被主张的核心说法（原文摘）", "confidence": "高|中|低"}],',
  '  "logicIssues": [{"quote": "出问题的原文片段", "type": "逻辑问题类型", "explanation": "为什么这是问题"}],',
  '  "assumptions": ["默认成立但没说出口的前提"],',
  '  "missingEvidence": ["要判断真伪还缺什么证据"],',
  '  "queries": ["检索词1", "检索词2"]',
  '}',
].join('\n');

/** 第二阶段的 system prompt——「公正客观」的铁律写在这里。 */
export const PASS2_SYSTEM = [
  '你是一个公正客观的论证分析器。输入是：① 用户划选的原文；② 深度搜索到的资料（标题 + 摘要）。',
  '',
  '请给出最终分析。',
  '',
  '【铁律】',
  '1. **不站队**：不要因为原文的立场就偏向任何一方。你的任务是评估这段话本身站不站得住。',
  '2. **只依据给出的证据**：检索摘要里没提到的事实，不许当成已知。',
  '3. **区分事实与观点**：资料里作者的**主张**也只是主张，不是事实，要标明。',
  '4. **允许「无法判定」**：证据不足就明说，并写清还缺什么。宁可不确定，不要硬下结论。',
  '5. **不预判**：不要因为「这话说得很有气势」就认为它对，也不要因为「这话说得不像专家」就认为它错。',
  '6. **指出出处**：每条支撑或质疑都要指明来自哪条资料（用资料标题指认）。',
  '7. **承认不确定**：如果原文本身就在提问、或者根本没有可证伪的主张，就直说。',
  '',
  '【结论只能三选一】',
  '- likely_true：证据支持这段话的主要主张',
  '- likely_false：证据与之矛盾',
  '- uncertain：证据不足以判断',
  '',
  '【输出格式】严格 JSON：',
  '{',
  '  "verdict": "likely_true|likely_false|uncertain",',
  '  "confidence": 0.0,',
  '  "verdictText": "一句话结论（不超过 40 字，含把握程度）",',
  '  "analysis": "两三段话：这段话的结构、哪些部分站得住、哪些部分有问题、结论为什么是这个",',
  '  "supported": [{"point": "有支撑的部分", "evidence": "来自哪条资料（标题）"}],',
  '  "challenged": [{"point": "存疑或被反驳的部分", "evidence": "来自哪条资料（标题）；没有资料支撑就写「（无资料支撑）」"}],',
  '  "notCovered": ["证据没覆盖、无法判断的点"],',
  '  "followUps": ["值得继续查的问题"]',
  '}',
].join('\n');

/** 第一阶段的 user prompt。 */
export function buildPass1User(input: AnalysisInput): string {
  const where = input.pageUrl
    ? `（来自 ${input.pageTitle ?? '网页'}：${input.pageUrl}）`
    : '';
  return [
    '【划选的原文】',
    input.text.slice(0, MAX_INPUT_CHARS),
    '',
    `【出处页面】${where || '（未知）'}`,
    '（出处只作背景，不要把它当证据）',
  ].join('\n');
}

/** 第二阶段的 user prompt。 */
export function buildPass2User(input: AnalysisInput, hits: SearchHit[]): string {
  const lines: string[] = ['【原文】', input.text.slice(0, MAX_INPUT_CHARS), ''];
  if (hits.length === 0) {
    lines.push(
      '【深度搜索到的资料】',
      '（未获取到资料）',
      '',
      '没有资料时请只根据原文做**结构**层面的分析，',
      '并把 verdict 倾向 uncertain、在 notCovered 里写清缺哪些证据。',
    );
    return lines.join('\n');
  }
  lines.push(`【深度搜索到的资料】（${hits.length} 条）`);
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.title}`);
    lines.push(`   ${h.snippet}`);
    lines.push(`   ${h.url}`);
  });
  return lines.join('\n');
}

const KINDS: StatementKind[] = [
  'argument', 'claim', 'question', 'opinion', 'ad', 'emotion', 'other',
];

/** 解析第一阶段的输出。任何字段缺失都用保守默认值，不抛。 */
export function parsePass1(raw: string): Pass1Result | null {
  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const kind = KINDS.includes(parsed['kind'] as StatementKind)
    ? (parsed['kind'] as StatementKind)
    : 'other';

  const claims: CoreClaim[] = objArray(parsed['claims'])
    .map((c) => ({
      text: str(c['text']),
      confidence: pickConfidence(c['confidence']),
    }))
    .filter((c) => c.text.length > 0)
    .slice(0, 8);

  const logicIssues: LogicIssue[] = objArray(parsed['logicIssues'])
    .map((c) => ({
      quote: str(c['quote']),
      type: str(c['type']) || '逻辑问题',
      explanation: str(c['explanation']),
    }))
    .filter((c) => c.quote.length > 0 || c.explanation.length > 0)
    .slice(0, 10);

  const queries = strArray(parsed['queries'], MAX_SEARCH_QUERIES);

  return {
    kind,
    summary: str(parsed['summary']),
    claims,
    logicIssues,
    assumptions: strArray(parsed['assumptions'], 8),
    missingEvidence: strArray(parsed['missingEvidence'], 8),
    queries,
  };
}

const VERDICTS: Verdict[] = ['likely_true', 'likely_false', 'uncertain'];

/** 解析第二阶段的输出。 */
export function parsePass2(raw: string): Pass2Result | null {
  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const verdict = VERDICTS.includes(parsed['verdict'] as Verdict)
    ? (parsed['verdict'] as Verdict)
    : 'uncertain';

  const conf = typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5;

  return {
    verdict,
    confidence: Math.max(0, Math.min(1, conf)),
    verdictText: str(parsed['verdictText']),
    analysis: str(parsed['analysis']),
    supported: points(parsed['supported']),
    challenged: points(parsed['challenged']),
    notCovered: strArray(parsed['notCovered'], 8),
    followUps: strArray(parsed['followUps'], 8),
  };
}

function points(v: unknown): { point: string; evidence: string }[] {
  return objArray(v)
    .map((x) => ({ point: str(x['point']), evidence: str(x['evidence']) }))
    .filter((p) => p.point.length > 0)
    .slice(0, 8);
}

/**
 * 把「不知道是什么」的值收成一组对象数组。
 *
 * 模型返回的字段全是 `unknown`，直接链式 `.filter().map()` 会在
 * `unknown` 上炸类型。用这个函数收口，后面的代码就只面对
 * `Record<string, unknown>`，读起来也直白。
 */
function objArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

const CONFIDENCES: CoreClaim['confidence'][] = ['高', '中', '低'];

/** 把握程度只认「高/中/低」，别的（英文、数字、空）一律按「中」处理。 */
function pickConfidence(v: unknown): CoreClaim['confidence'] {
  const s = str(v);
  return CONFIDENCES.includes(s as CoreClaim['confidence'])
    ? (s as CoreClaim['confidence'])
    : '中';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter((s) => s.length > 0).slice(0, max);
}

/**
 * 跑一次完整分析。
 *
 * 任何一步失败都**不抛**：把失败原因记进 record 里返回，
 * 结果页如实显示「哪一步失败了、为什么」。静默失败最伤信任。
 */
export async function runAnalysis(
  id: string,
  input: AnalysisInput,
  settings: Settings,
  client: LlmClient,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalysisRecord> {
  const record: AnalysisRecord = {
    id,
    createdAt: new Date().toISOString(),
    input,
    pass1: null,
    search: { hits: [], queries: [] },
    pass2: null,
  };

  // ① 结构解析
  let pass1Raw = '';
  try {
    pass1Raw = await client.complete(buildPass1User(input), {
      system: PASS1_SYSTEM,
      maxTokens: 3000,
    });
  } catch (e) {
    record.error = `结构解析失败：${e instanceof Error ? e.message : String(e)}`;
    return record;
  }
  const pass1 = parsePass1(pass1Raw);
  if (!pass1) {
    record.error = '结构解析失败：模型输出不是预期的 JSON';
    return record;
  }
  record.pass1 = pass1;

  // ② 深度搜索
  if (settings.enableSearch && pass1.queries.length > 0) {
    record.search.queries = pass1.queries;
    const res = await searchAll(pass1.queries, fetchImpl);
    record.search.hits = res.hits;
    if (res.error) record.search.error = res.error;
  }

  // ③ 结合资料的最终判断
  try {
    const raw = await client.complete(buildPass2User(input, record.search.hits), {
      system: PASS2_SYSTEM,
      maxTokens: 4000,
    });
    const pass2 = parsePass2(raw);
    if (pass2) record.pass2 = pass2;
    else record.error = '最终分析失败：模型输出不是预期的 JSON';
  } catch (e) {
    record.error = `最终分析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  return record;
}
