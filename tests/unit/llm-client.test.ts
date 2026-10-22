import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createLlmClient,
  parseJsonResponse,
  buildChatMessages,
} from '../../src/bg/llm/client';
import { openAiComplete } from '../../src/bg/llm/openai';
import { anthropicComplete } from '../../src/bg/llm/anthropic';
import type { LlmConfig } from '../../src/shared/types';

const openAiConfig: LlmConfig = {
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret-value',
  model: 'm1',
  timeoutMs: 5000,
};

const anthropicConfig: LlmConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'ak-secret-value',
  model: 'm2',
  timeoutMs: 5000,
};

afterEach(() => vi.restoreAllMocks());

describe('从模型输出里抠 JSON', () => {
  it('整段就是 JSON', () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('```json 包裹', () => {
    expect(parseJsonResponse('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('前后有废话时取花括号之间的片段', () => {
    expect(parseJsonResponse('好的，结果如下：{"a":3} 希望有帮助')).toEqual({ a: 3 });
  });

  it('抠不出来返回 null，不抛', () => {
    expect(parseJsonResponse('完全不是 JSON')).toBeNull();
    expect(parseJsonResponse('')).toBeNull();
  });

  it('抠数组', () => {
    expect(parseJsonResponse('前缀 [1,2,3] 后缀')).toEqual([1, 2, 3]);
  });
});

describe('消息数组', () => {
  it('有 system 时 system 在前', () => {
    expect(buildChatMessages('sys', 'user')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
  });

  it('没有 system 时只有 user', () => {
    expect(buildChatMessages(undefined, 'user')).toEqual([{ role: 'user', content: 'user' }]);
    expect(buildChatMessages('', 'user')).toEqual([{ role: 'user', content: 'user' }]);
  });
});

describe('OpenAI 兼容协议', () => {
  it('打到 /chat/completions 且带 Authorization', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    const out = await createLlmClient(openAiConfig).complete('hello');
    expect(out).toBe('hi');

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-secret-value',
    });
  });

  it('请求体里有 model/messages，没有 Key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    await createLlmClient(openAiConfig).complete('hello', { system: 'sys', maxTokens: 128 });

    const init = spy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens?: number;
    };
    expect(body.model).toBe('m1');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.max_tokens).toBe(128);
    expect(String(init.body)).not.toContain('sk-secret-value');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('400 提到 reasoning_effort 时摘掉该字段重试一次', async () => {
    let call = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response('reasoning_effort is not supported', { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    });

    const cfg: LlmConfig = { ...openAiConfig, reasoningEffort: 'low' };
    const out = await openAiComplete(cfg, 'hi');
    expect(out).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((spy.mock.calls[1]![1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(second['reasoning_effort']).toBeUndefined();
  });

  it('400 提到 max_completion_tokens 时改用它重试', async () => {
    let call = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response('use max_completion_tokens instead', { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    });

    const out = await openAiComplete(openAiConfig, 'hi');
    expect(out).toBe('ok');
    const second = JSON.parse(String((spy.mock.calls[1]![1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(second['max_completion_tokens']).toBe(8192);
    expect(second['max_tokens']).toBeUndefined();
  });

  it('错误信息里不含 API Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('boom sk-secret-value oops', { status: 500 }),
    );
    await expect(openAiComplete(openAiConfig, 'hi')).rejects.toThrow(/^LLM 返回 HTTP 500/);
    await expect(openAiComplete(openAiConfig, 'hi')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sk-secret-value') }) as never,
    );
  });

  it('只返回思考过程没返回答案时给出可操作的提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: 'thinking...' } }],
        }),
        { status: 200 },
      ),
    );
    await expect(openAiComplete(openAiConfig, 'hi')).rejects.toThrow(/token 预算不够/);
  });

  it('网络异常时抛错且消息里不含 Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down sk-secret-value');
    });
    await expect(openAiComplete(openAiConfig, 'hi')).rejects.toThrow(/LLM 请求失败/);
  });
});

describe('Anthropic 原生协议', () => {
  it('打到 /v1/messages 且用 x-api-key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 }),
    );
    const out = await createLlmClient(anthropicConfig).complete('hello', { system: 'sys' });
    expect(out).toBe('hi');

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-secret-value');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String((init as RequestInit).body)) as {
      system?: string;
      messages: { role: string; content: string }[];
    };
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('错误信息里不含 API Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('oops ak-secret-value', { status: 401 }),
    );
    await expect(anthropicComplete(anthropicConfig, 'hi')).rejects.toThrow(
      /LLM 返回 HTTP 401/,
    );
    await expect(anthropicComplete(anthropicConfig, 'hi')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('ak-secret-value') }) as never,
    );
  });

  it('只返回 thinking 块时提示 token 预算不够', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: 'hmm' }] }), {
        status: 200,
      }),
    );
    await expect(anthropicComplete(anthropicConfig, 'hi')).rejects.toThrow(/token 预算不够/);
  });
});
