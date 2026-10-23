import type { LlmClient } from './llm/client';
import { parseJsonResponse } from './llm/client';
import { MAX_INPUT_CHARS } from '../shared/constants';
import type { AnalysisInput, PolishResult } from '../shared/types';

/**
 * 「美化」：去掉情绪化的表达方式，还原这段话实际想说的内容。
 *
 * ## 为什么单独一条链路
 *
 * 「分析正误」要回答「这是不是真的」，「美化」要回答「这话到底在说什么」。
 * 目标不同，流程也不同：
 * - 正误分析要**搜索**、要三档结论、要指出逻辑问题；
 * - 美化**不搜索**（这段话不需要外部证据），只要一次 LLM 调用给出
 *   「情绪基调 / 情绪化用词 / 实际含义 / 改写版本」。
 *
 * ## 最重要的一条：不改立场
 *
 * 去掉「恶心」不等于去掉「批评」，去掉「垃圾」不等于去掉「反对」。
 * 美化只改**说法**，不改**态度**——否则「美化」就变成了「帮人说好话」，
 * 用户拿自己的草稿去用时会被改得面目全非，这个功能也就废了。
 */

/** 美化的 system prompt。 */
export const POLISH_SYSTEM = [
  '你是一个表达润色器。输入是用户划选的一段文字——它可能来自网页上的某条评论，',
  '也可能是用户自己正在写的评论草稿。',
  '',
  '你的任务**不是判断对错**，而是：**去掉情绪化的表达方式，还原这段话实际想说的内容**。',
  '',
  '【什么算情绪化表达】',
  '- 情绪词、骂人话、贬义词（"离谱""恶心""垃圾""一坨屎""滚"）',
  '- 感叹与反问（"这也太过分了！""凭什么啊？"）',
  '- 群体标签与地图炮（"某群体的人都是……"）',
  '- 嘲讽、阴阳怪气、玩梗',
  '- 夸张与重复（"垃圾垃圾垃圾"）',
  '',
  '【什么不算情绪化】',
  '- 事实陈述、数据、具体事实、举例',
  '- 正常的语气词与限定词（"我觉得""可能""其实""感觉"）',
  '- 已经中性的表达、专业的批评（专业批评不是情绪化）',
  '',
  '【硬性要求】',
  '1. **不改原意**：改写前后主张必须一致。不许加内容，也不许删掉信息量。',
  '2. **不软化立场**：原文在批评就保留批评——去掉"恶心"不等于去掉"批评"，',
  '   去掉"垃圾"不等于去掉"反对"。要改的是**说法**，不是**态度**。',
  '3. **不改变强度方向**：原文是反对，就不能改成中立或支持。',
  '4. **不许补出原文没有的内容**：改写只能删掉情绪词、换说法，',
  '   **不能替原文编出理由、事实或动机**。',
  '   例如原文只说"别出来恶心人"，改写不能变成"你这样会影响他人"——"影响他人"是编的。',
  '5. **保持指向不变**：原文针对谁，改写还针对谁。',
  '   不要把"某群体的人""某些人"换成"相关人员"这种泛指——指向被换掉了。',
  '6. **保持语言与长度**：改写版用同一种语言，长度和原文相当，不要扩写成一段话。',
  '   **保持与原文相同的字形**：原文是简体就用简体，原文是繁体就用繁体——',
  '   不要把简体转成繁体（或反过来）。这一条实测踩过：',
  '   简体草稿被改写成繁体，用户没法直接粘回去。',
  '7. **本来就中性就如实说**：没有明显情绪化表达时，emotional 给空数组，',
  '   rewritten 给原文（最多做极小的润色），不要为了有产出而硬改。',
  '8. **rewritten 要真的改**：emotional 里列出的每一处情绪化表达，',
  '   都必须在 rewritten 里被换成中性的说法。',
  '   把「一坨屎」列进情绪用词、却把原文原样抄回 rewritten，是错的。',
  '9. **反讽不能被改成褒义**：「属实是大聪明」这类反讽，改写要保留它**在批评**这件事，',
  '   把玩梗的**形式**去掉（表情标记、夸张的梗词），但批评本身必须留着。',
  '   不要把反讽的字面褒义当成意思——把「大聪明」改成「很聪明」，是把批评写成了表扬。',
  '10. **不确定就保守**：拿不准某个词算不算情绪化，就不算。',
  '',
  '【输出格式】严格 JSON，不要任何解释文字：',
  '{',
  '  "tone": "一句话说明原文的情绪基调",',
  '  "emotional": [{"word": "原文里的情绪化片段（原文照抄）", "why": "为什么算情绪化"}],',
  '  "meaning": "去掉情绪后，这段话实际在主张什么（直接说主张，',
  '    不要写"他想表达…"这种绕的说法）",',
  '  "rewritten": "去掉情绪化表达后的版本（可以直接拿去用）"',
  '}',
].join('\n');

/** 美化的 user prompt。 */
export function buildPolishUser(input: AnalysisInput, feedback = ''): string {
  const where = input.pageUrl
    ? `（来自 ${input.pageTitle ?? '网页'}）`
    : '（来源未知，多半是用户自己写的草稿）';
  const lines = [
    '【划选的原文】',
    input.text.slice(0, MAX_INPUT_CHARS),
    '',
    `【来源】${where}`,
    '（来源只作背景，不要当成分析对象）',
  ];
  if (feedback) {
    lines.push('', feedback.trim());
  }
  return lines.join('\n');
}

/** 解析模型输出。任何字段缺失都用保守默认值，不抛。 */
export function parsePolish(raw: string): PolishResult | null {
  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const emotional = Array.isArray(parsed['emotional'])
    ? parsed['emotional']
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x) => ({
          word: str(x['word']),
          why: str(x['why']),
        }))
        .filter((x) => x.word.length > 0)
        .slice(0, 12)
    : [];

  const meaning = str(parsed['meaning']);
  const rewritten = str(parsed['rewritten']);
  const tone = str(parsed['tone']);

  // 三个核心字段全空 = 模型没按格式输出，当失败处理。
  if (!meaning && !rewritten && !tone) return null;

  return { tone, emotional, meaning, rewritten };
}

/**
 * 剥掉语气词与程度词，只留内容的核心。
 *
 * 为什么：模型会把「太离谱了吧」改成「太离谱了」——
 * 整串匹配就漏掉了，但核心词「离谱」还在。
 * 只看核心才能发现「它其实没改掉」。
 */
export function coreOf(word: string): string {
  let w = word.trim().replace(/^[「『“"'（(【\[…\s]+|[」』”"'）)】\]…\s，。！？!?、]+$/g, '');
  for (let i = 0; i < 3; i++) {
    const before = w;
    w = w.replace(/(了|吧|啊|呀|呢|哦|嘛|么)$/u, '');
    w = w.replace(/^(太|真是|真的|完全|简直|非常|十分|特别|超级|真|好|很)/u, '');
    if (w === before) break;
  }
  return w;
}

/**
 * 找出「改写版里还留着、但模型自己标记成情绪化」的片段。
 *
 * **这是可以本地确定性地查出来的**：模型在 `emotional` 里列了「恶心人」，
 * 改写版里就不该再有「恶心人」。模型偶尔会自相矛盾
 * （一边标出来、一边原样留着），这时候要的不是相信模型，而是**查出来并让它重写**。
 *
 * 判定用**核心词**（见 coreOf）：模型把「太离谱了吧」改成「太离谱了」时，
 * 整串匹配会漏掉，核心词「离谱」才抓得住。
 *
 * 两种情况不查：
 * - 核心太长的（模型有时把整个短句都标成情绪化，没法做子串判定，硬查会误报）；
 * - 指代类的（「某群体的人」这种**指向**不是辱骂，保留指向是被允许的——
 *   prompt 明确要求「保持指向不变」）。
 */
export function findLeftoverEmotional(result: PolishResult): string[] {
  const out: string[] = [];
  for (const e of result.emotional) {
    const core = coreOf(e.word);
    if (core.length < 2 || core.length > 6) continue;
    if (/(群体|人们|某些人|这些人|他们|这种人|方面|问题|情况)/.test(core)) continue;
    if (result.rewritten.includes(core)) out.push(core);
  }
  return out;
}

/**
 * 跑一次美化。
 *
 * 任何一步失败都**不抛**：把失败原因带回去，结果页如实显示。
 * 静默失败最伤信任——用户会以为「美化就是这个结果」。
 *
 * **会重试**：模型自相矛盾时（标了情绪词却原样留在改写版里），
 * 带着漏改的词再问一次。这比让用户自己发现「说好的去情绪化呢」靠谱。
 */
export async function runPolish(
  input: AnalysisInput,
  client: LlmClient,
  opts: { maxAttempts?: number } = {},
): Promise<{ result: PolishResult | null; error?: string }> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let last: PolishResult | null = null;
  let feedback = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await client.complete(buildPolishUser(input, feedback), {
        system: POLISH_SYSTEM,
        maxTokens: 2000,
      });
    } catch (e) {
      return { result: null, error: `美化失败：${e instanceof Error ? e.message : String(e)}` };
    }

    const result = parsePolish(raw);
    if (!result) {
      // 输出不是 JSON：第一次可以重来一次，再不行就如实报错。
      if (attempt === 0) {
        feedback = '\n【上一次输出格式不对】请只输出 JSON，不要任何解释文字。';
        continue;
      }
      return { result: null, error: '美化失败：模型输出不是预期的 JSON' };
    }

    last = result;
    const leftover = findLeftoverEmotional(result);
    if (leftover.length === 0) {
      return { result };
    }

    // 漏改了：明确告诉模型哪几处没换掉，让它重写。
    feedback =
      `\n【上一次你漏改了】以下情绪化表达还留在改写版里：${leftover.join('、')}。` +
      '\n请确保 rewritten 里不再出现它们（保持原意与指向不变的前提下换说法）。';
  }

  // 试完还是没改掉：如实标出来，别装作改干净了。
  if (last) {
    const leftover = findLeftoverEmotional(last);
    return { result: leftover.length ? { ...last, leftover } : last };
  }
  return { result: null, error: '美化失败：模型没有给出结果' };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
