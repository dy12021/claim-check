import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultSettings,
  getSettings,
  saveSettings,
  pushHistory,
  getHistory,
  getRecord,
  clearHistory,
  getLlmConfig,
} from '../../src/bg/storage';
import { MAX_HISTORY, STORAGE_KEYS } from '../../src/shared/constants';
import type { AnalysisRecord } from '../../src/shared/types';

type Store = Record<string, unknown>;
let store: Store = {};

function installChromeMock(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get(keys: string[], cb: (r: Store) => void): void {
          const out: Store = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          cb(out);
        },
        set(items: Store, cb?: (ok: boolean) => void): void {
          Object.assign(store, items);
          cb?.(true);
        },
        remove(keys: string[], cb?: (ok: boolean) => void): void {
          for (const k of keys) delete store[k];
          cb?.(true);
        },
      },
    },
  };
}

function rec(id: string, text = '原文 ' + id): AnalysisRecord {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    input: { text },
    pass1: null,
    search: { hits: [], queries: [] },
    pass2: null,
  };
}

beforeEach(() => {
  store = {};
  installChromeMock();
});

describe('默认设置', () => {
  it('API Key 默认为空——用户必须自己填', () => {
    expect(defaultSettings().llm.apiKey).toBe('');
  });

  it('深度搜索默认开', () => {
    expect(defaultSettings().enableSearch).toBe(true);
  });
});

describe('读设置', () => {
  it('没存过就是默认值', async () => {
    const s = await getSettings();
    expect(s.llm.model).toBe(defaultSettings().llm.model);
    expect(s.llm.apiKey).toBe('');
  });

  it('存了部分字段时与默认值合并，不丢默认', async () => {
    store[STORAGE_KEYS.settings] = { llm: { model: 'my-model' } };
    const s = await getSettings();
    expect(s.llm.model).toBe('my-model');
    expect(s.llm.baseUrl).toBe(defaultSettings().llm.baseUrl);
    expect(s.llm.provider).toBe(defaultSettings().llm.provider);
  });

  it('已存的 API Key 能读出来', async () => {
    store[STORAGE_KEYS.settings] = { llm: { apiKey: 'sk-abc' } };
    expect((await getSettings()).llm.apiKey).toBe('sk-abc');
    expect((await getLlmConfig())?.apiKey).toBe('sk-abc');
  });

  it('没有 Key 时 getLlmConfig 返回 null', async () => {
    expect(await getLlmConfig()).toBeNull();
  });

  it('存设置后能读回来', async () => {
    const s = defaultSettings();
    s.llm.apiKey = 'sk-new';
    s.enableSearch = false;
    await saveSettings(s);
    const back = await getSettings();
    expect(back.llm.apiKey).toBe('sk-new');
    expect(back.enableSearch).toBe(false);
  });
});

describe('分析历史', () => {
  it('新的排在最前', async () => {
    await pushHistory(rec('a'));
    await pushHistory(rec('b'));
    const list = await getHistory();
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('同一个 id 再次存入是替换而不是追加', async () => {
    await pushHistory(rec('a'));
    await pushHistory(rec('a'));
    const list = await getHistory();
    expect(list).toHaveLength(1);
  });

  it('超过上限时丢最旧的', async () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      await pushHistory(rec('id' + i));
    }
    const list = await getHistory();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0]!.id).toBe('id' + (MAX_HISTORY + 4));
  });

  it('按 id 能取到记录', async () => {
    await pushHistory(rec('a'));
    expect((await getRecord('a'))?.id).toBe('a');
    expect(await getRecord('nope')).toBeNull();
  });

  it('清空历史不动设置', async () => {
    const s = defaultSettings();
    s.llm.apiKey = 'sk-keep';
    await saveSettings(s);
    await pushHistory(rec('a'));
    await clearHistory();
    expect(await getHistory()).toEqual([]);
    expect((await getSettings()).llm.apiKey).toBe('sk-keep');
  });
});
