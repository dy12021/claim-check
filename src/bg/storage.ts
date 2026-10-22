import { STORAGE_KEYS, MAX_HISTORY } from '../shared/constants';
import type { AnalysisRecord, LlmConfig, Settings } from '../shared/types';

/**
 * chrome.storage.local 的 Promise 包装。
 *
 * 只用 local 不用 sync：sync 会把数据同步到 Google 账号，
 * 与「Key 和历史只存在本机」的承诺冲突。
 */

function promisify<T>(fn: (cb: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => fn(resolve));
}

/** 读一个键。读不到（undefined）或存的是 null 时返回 fallback。 */
export async function getJson<T>(key: string, fallback: T): Promise<T> {
  const res = await promisify<Record<string, unknown>>((cb) =>
    chrome.storage.local.get([key], cb),
  );
  const v = res[key];
  return v === undefined || v === null ? fallback : (v as T);
}

/** 写一个键。 */
export async function setJson(key: string, value: unknown): Promise<void> {
  await promisify<boolean>((cb) =>
    chrome.storage.local.set({ [key]: value }, () => cb(true)),
  );
}

/** 删一个键。 */
export async function removeKey(key: string): Promise<void> {
  await promisify<boolean>((cb) =>
    chrome.storage.local.remove([key], () => cb(true)),
  );
}

/** 默认设置。Key 是空的——用户必须自己填。 */
export function defaultSettings(): Settings {
  return {
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.minimax.cn/v1',
      apiKey: '',
      model: 'MiniMax-M3.1-Flash',
      timeoutMs: 120000,
      maxTokens: 8192,
      reasoningEffort: 'low',
    },
    enableSearch: true,
    maxSearchResults: 8,
    historyLimit: MAX_HISTORY,
  };
}

/** 读设置。存量可能只有部分字段，所以和默认值合并。 */
export async function getSettings(): Promise<Settings> {
  const saved = await getJson<Partial<Settings>>(STORAGE_KEYS.settings, {});
  const base = defaultSettings();
  return {
    ...base,
    ...saved,
    llm: { ...base.llm, ...(saved.llm ?? {}) },
  };
}

/** 存设置（整体覆盖）。 */
export async function saveSettings(settings: Settings): Promise<void> {
  await setJson(STORAGE_KEYS.settings, settings);
}

/** 只拿 LLM 配置（内部用，不给 popup —— popup 拿到明文 Key 也没必要）。 */
export async function getLlmConfig(): Promise<LlmConfig | null> {
  const s = await getSettings();
  return s.llm.apiKey ? s.llm : null;
}

/** 分析历史（新的在前）。 */
export async function getHistory(): Promise<AnalysisRecord[]> {
  return getJson<AnalysisRecord[]>(STORAGE_KEYS.history, []);
}

/** 存一条分析记录。超出上限就丢最旧的。 */
export async function pushHistory(record: AnalysisRecord): Promise<void> {
  const history = await getHistory();
  const next = [record, ...history.filter((r) => r.id !== record.id)].slice(0, MAX_HISTORY);
  await setJson(STORAGE_KEYS.history, next);
}

/** 按 id 取一条分析。 */
export async function getRecord(id: string): Promise<AnalysisRecord | null> {
  const history = await getHistory();
  return history.find((r) => r.id === id) ?? null;
}

/** 清空历史（不动设置与 Key）。 */
export async function clearHistory(): Promise<void> {
  await removeKey(STORAGE_KEYS.history);
}
