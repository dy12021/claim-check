import type { LlmConfig } from '../../shared/types';
import { buildChatMessages } from './client';
import type { ChatMessage } from './client';

/**
 * 响应体是外部内容，理论上可能把 Key 原样回显。
 * 错误信息里绝对不能出现 Key，所以兜底遮一遍。
 */
function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

interface BodyOptions {
  /** 用 max_completion_tokens 而不是 max_tokens */
  completionTokens: boolean;
  /** 是否带 reasoning_effort */
  effort: boolean;
}

/**
 * 组装请求体。
 *
 * `max_tokens` / `max_completion_tokens` / `reasoning_effort` 这三个字段
 * **各服务商的接受程度不一样**：有的只认 max_completion_tokens，
 * 有的（强制 thinking 的）传 reasoning_effort=none 直接 400。
 * 所以它们都做成「可摘掉」的：真被拒了就在 {@link openAiComplete} 里
 * 自动摘掉重试一次，而不是让用户自己猜该填什么。
 */
function buildBody(
  config: LlmConfig,
  messages: ChatMessage[],
  budget: number,
  opts: BodyOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };
  if (opts.completionTokens) body['max_completion_tokens'] = budget;
  else body['max_tokens'] = budget;
  if (opts.effort && config.reasoningEffort) body['reasoning_effort'] = config.reasoningEffort;
  return body;
}

/** 发一次请求。 */
async function post(
  base: string,
  config: LlmConfig,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<{ status: number; ok: boolean; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e), config.apiKey);
    console.error(
      `[claim-check] LLM 请求失败（${Date.now() - startedAt}ms）：${msg}；url=${redact(base, config.apiKey)}/chat/completions`,
    );
    throw new Error(`LLM 请求失败：${msg}`);
  }
  console.info(`[claim-check] LLM 响应 ${res.status}（${Date.now() - startedAt}ms）`);
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, text };
}

/** OpenAI 兼容协议（DeepSeek / MiniMax / Kimi / Qwen / 硅基流动…）。 */
export async function openAiComplete(
  config: LlmConfig,
  prompt: string,
  system?: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const messages = buildChatMessages(system, prompt);
  const budget = maxTokens ?? config.maxTokens ?? 8192;
  const startedAt = Date.now();

  let opts: BodyOptions = {
    completionTokens: config.useMaxCompletionTokens === true,
    effort: config.reasoningEffort !== undefined,
  };

  let result = await post(base, config, buildBody(config, messages, budget, opts), startedAt);

  // **自愈重试**：400 多半是某个可选字段这个服务商不认。
  // 摘掉那个字段再试一次——比让用户自己猜「该填 max_tokens 还是
  // max_completion_tokens」「该不该传 reasoning_effort」友好得多。
  if (!result.ok && result.status === 400) {
    if (opts.effort && /reasoning_effort/i.test(result.text)) {
      console.warn('[claim-check] 服务商不接受 reasoning_effort，摘掉后重试');
      opts = { ...opts, effort: false };
    } else if (!opts.completionTokens && /max_completion_tokens/i.test(result.text)) {
      console.warn('[claim-check] 服务商要求 max_completion_tokens，改用它重试');
      opts = { ...opts, completionTokens: true };
    } else if (opts.completionTokens && /max_tokens/i.test(result.text)) {
      console.warn('[claim-check] 服务商只认 max_tokens，改用它重试');
      opts = { ...opts, completionTokens: false };
    } else {
      const detail = redact(result.text.slice(0, 200), config.apiKey);
      throw new Error(`LLM 返回 HTTP 400：${detail}`);
    }
    result = await post(base, config, buildBody(config, messages, budget, opts), startedAt);
  }

  if (!result.ok) {
    const detail = redact(result.text.slice(0, 200), config.apiKey);
    throw new Error(`LLM 返回 HTTP ${result.status}：${detail}`);
  }

  let data: {
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null };
      finish_reason?: string;
    }[];
  };
  try {
    data = JSON.parse(result.text) as typeof data;
  } catch {
    throw new Error('LLM 响应不是合法 JSON');
  }

  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content !== 'string' || content.trim() === '') {
    // 推理模型把预算烧在思考上、最终答案没输出——最常见的一种失败，
    // 必须说清楚，否则上层只能静默降级，用户只看到「插件没反应」。
    const reasoning = message?.reasoning_content ?? '';
    if (reasoning.length > 0) {
      throw new Error(
        'LLM 只返回了思考过程、没有最终答案——token 预算不够。' +
          '请调大 maxTokens（推理模型需要给思考留空间）或换用非推理模型。',
      );
    }
    throw new Error(
      'LLM 响应格式异常：缺少 choices[0].message.content' +
        (data.choices?.[0]?.finish_reason ? `（finish_reason=${data.choices[0].finish_reason}）` : ''),
    );
  }

  return content;
}
