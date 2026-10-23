/**
 * 真模型探针：把「美化」prompt 直接打到真实 LLM 上，看它到底改了什么。
 *
 * 单测只能锁 prompt 文本，**锁不了模型行为**——
 * 这个功能最容易做坏的地方是「把话改软了」（立场被改掉），
 * 所以必须用真模型跑真实样本，看改写版本还站不站得住。
 *
 * 用法：
 *   npx tsx scripts/probe-polish.ts
 *
 * Key 从 llm-quant/config.toml 读，**不打印明文**。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPolish } from '../src/bg/polish';
import { createLlmClient } from '../src/bg/llm/client';
import type { LlmConfig } from '../src/shared/types';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = process.env.CLAIM_CHECK_LLM_CONFIG ?? join(REPO, '..', 'llm-quant', 'config.toml');

function readLlmConfig(): LlmConfig {
  const raw = readFileSync(CFG, 'utf8');
  const llmSection: string[] = [];
  let inLlm = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inLlm = /^\s*\[llm\]/.test(line); continue; }
    if (inLlm) llmSection.push(line);
  }
  const pick = (key: string): string => {
    for (const line of llmSection) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["'](.*)["']`));
      if (m) return m[1]!;
    }
    return '';
  };
  const apiKey = pick('api_key');
  const baseUrl = pick('base_url');
  const model = pick('model');
  if (!apiKey || !baseUrl || !model) throw new Error('config.toml 里读不到 llm 配置');
  return {
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    timeoutMs: 240000,
    maxTokens: Number(pick('max_completion_tokens') || 8192),
    reasoningEffort: (process.env.EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  };
}

interface Case {
  name: string;
  text: string;
  /** 期望被识别出的情绪化片段（至少命中一个） */
  expectEmotional?: string[];
  /** 改写版里不该再出现的词 */
  forbidInRewritten?: string[];
  /** 改写版里必须保留的信息（不能把信息删没了）——全部都要在 */
  keepInRewritten?: string[];
  /** 改写版里必须保留的信息——命中任意一个就算（用于「指向还在」这类检查） */
  keepAnyInRewritten?: string[];
  /** 改写版里必须匹配的正则（诉求/立场还在不在） */
  keepPattern?: RegExp;
  /** 期望原文就没情绪：情绪用词表应为空 */
  expectNoEmotional?: boolean;
}

const cases: Case[] = [
  {
    name: '情绪化攻击（别人的评论）',
    text: '这也太离谱了吧！某群体的人真的别出来恶心人了，滚出去！',
    expectEmotional: ['离谱', '恶心人'],
    // 「影响他人」是模型编出来的（原文没说），「离谱/恶心人/滚出去」是情绪词
    forbidInRewritten: ['离谱', '恶心人', '滚出去', '影响他人'],
    // 指向还在（群体标签可以去掉，但不能换成人和原文无关的泛指），
    // 诉求也还在（「别出来 / 请离开」）
    keepAnyInRewritten: ['这些人', '某些人', '某群体', '他们', '这种人'],
    keepPattern: /离开|出来|别再/,
  },
  {
    name: '用户自己的草稿（带情绪的观点）',
    text: '这作者真的一坨屎，完全没考虑过实际情况，纯属浪费时间',
    expectEmotional: ['一坨屎', '纯属'],
    forbidInRewritten: ['一坨屎'],
    keepInRewritten: ['实际情况'],
  },
  {
    name: '本来就中性',
    text: '这个方案的优点是实现简单，缺点是无法处理并发场景。',
    expectNoEmotional: true,
    keepInRewritten: ['并发'],
  },
  {
    name: '玩梗 + 表情梗',
    text: '这波操作属实是大聪明了[doge]，黑塔都不敢这么玩',
    expectEmotional: ['大聪明', 'doge'],
    // 「很聪明」= 把反讽改成了褒义，意思反了
    forbidInRewritten: ['[doge]', '很聪明'],
    keepInRewritten: ['黑塔'],
  },
  {
    name: '纯情绪宣泄（没观点）',
    text: '垃圾！垃圾！全都是垃圾！',
    expectEmotional: ['垃圾'],
    forbidInRewritten: ['垃圾'],
  },
];

async function main(): Promise<void> {
  const cfg = readLlmConfig();
  console.log('模型:', cfg.model, '（Key 不打印）');
  const client = createLlmClient(cfg);

  let fail = 0;

  for (const c of cases) {
    const { result, error } = await runPolish({ text: c.text }, client);
    if (!result) {
      console.log(`FAIL ${c.name}\n      ${error ?? '(没有结果)'}`);
      fail++;
      continue;
    }

    const problems: string[] = [];
    if (c.expectNoEmotional) {
      if (result.emotional.length > 0) {
        problems.push(`原文是中性的，却报出了情绪用词：${result.emotional.map((e) => e.word).join('、')}`);
      }
    } else if (c.expectEmotional) {
      const hit = c.expectEmotional.some((w) => result.emotional.some((e) => e.word.includes(w)));
      if (!hit) {
        problems.push(`情绪用词表里没有预期中的：${c.expectEmotional.join('/')}（实际：${result.emotional.map((e) => e.word).join('、') || '空'}）`);
      }
    }
    for (const w of c.forbidInRewritten ?? []) {
      if (result.rewritten.includes(w)) problems.push(`改写版里还留着「${w}」`);
    }
    for (const w of c.keepInRewritten ?? []) {
      if (!result.rewritten.includes(w)) problems.push(`改写版把「${w}」这个信息删没了`);
    }
    if (c.keepAnyInRewritten?.length) {
      const hit = c.keepAnyInRewritten.some((w) => result.rewritten.includes(w));
      if (!hit) {
        problems.push(`改写版把指向换掉了（应保留其一：${c.keepAnyInRewritten.join('/')}）`);
      }
    }
    if (c.keepPattern && !c.keepPattern.test(result.rewritten)) {
      problems.push(`改写版没保住诉求/立场（应匹配 ${c.keepPattern}）`);
    }
    if (!result.rewritten.trim()) problems.push('改写版是空的');
    if (!result.meaning.trim()) problems.push('没有给出实际含义');
    // 改写版不该比原文长太多——那是扩写，不是去情绪化
    if (result.rewritten.length > c.text.length * 1.8 + 20) {
      problems.push(`改写版明显变长了（${c.text.length} → ${result.rewritten.length} 字）`);
    }

    const ok = problems.length === 0;
    if (!ok) fail++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${c.name}\n` +
      `      原文：${c.text}\n` +
      `      含义：${result.meaning}\n` +
      `      改写：${result.rewritten}\n` +
      `      情绪用词：${result.emotional.map((e) => `${e.word}（${e.why}）`).join('、') || '（无）'}\n` +
      `      基调：${result.tone}` +
      (problems.length ? `\n      ✗ ${problems.join('；')}` : ''),
    );
  }

  console.log(`\n共 ${cases.length} 条，失败 ${fail} 条`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
