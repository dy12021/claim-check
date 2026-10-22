import type { LlmConfig } from '../../shared/types';
import { openAiComplete } from './openai';
import { anthropicComplete } from './anthropic';

export interface LlmClient {
  /** 返回模型的纯文本输出。失败时抛 Error（消息里不得含 API Key）。 */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * 构造两种协议共用的消息数组。
 * system 为 undefined（或空串）时只留 user 一条。
 */
export function buildChatMessages(system: string | undefined, user: string): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push({ role: 'user', content: user });
  return msgs;
}

/**
 * 从 LLM 输出里抠 JSON。
 *
 * 真实模型经常在 JSON 前后加话，或用 ```json 包裹，所以不能直接 JSON.parse。
 * 抠不出来返回 null——调用方负责降级，不要抛。
 */
export function parseJsonResponse<T>(raw: string): T | null {
  const text = raw.trim();
  const candidates: string[] = [];

  // 1) ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence?.[1]?.trim();
  if (fenced) candidates.push(fenced);

  // 2) 废话里抠对象：取第一个 { 到最后一个 } 之间的片段
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }

  // 3) 废话里抠数组
  const bracketStart = text.indexOf('[');
  const bracketEnd = text.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    candidates.push(text.slice(bracketStart, bracketEnd + 1));
  }

  // 4) 整段就是 JSON
  candidates.push(text);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 按 provider 造一个客户端。两个协议对上层是同一个形状。 */
export function createLlmClient(config: LlmConfig): LlmClient {
  if (config.provider === 'anthropic') {
    return {
      complete: (prompt, opts) =>
        anthropicComplete(config, prompt, opts?.system, opts?.maxTokens),
    };
  }
  return {
    complete: (prompt, opts) =>
      openAiComplete(config, prompt, opts?.system, opts?.maxTokens),
  };
}
