import { createLlmClient } from './llm/client';
import {
  getLlmConfig,
  getSettings,
  saveSettings,
  pushHistory,
  getRecord,
  getHistory,
  clearHistory,
} from './storage';
import { runAnalysis } from './analyze';
import { runPolish } from './polish';
import { MAX_INPUT_CHARS } from '../shared/constants';
import type { AnalysisInput, AnalysisRecord } from '../shared/types';

/**
 * Service worker 入口。
 *
 * 只做三件事：装右键菜单、响应菜单点击、跑分析。
 *
 * **权限极小**：`storage` + `contextMenus` + 一个搜索引擎 host。
 * 没有 content script、没有 activeTab、没有 scripting——
 * 划选文本由 `contextMenus` 的 `selectionText` 直接给，
 * 所以插件**不读任何网页内容**，除非用户自己划选。
 */

const MENU_ID = 'claim-check-analyze';
/** 「美化表达」菜单项。与正误分析共用「划选即触发」的路子。 */
const MENU_ID_POLISH = 'claim-check-polish';

/** 装右键菜单。service worker 每次被唤醒都会重跑这段，所以要先删再建。 */
function installMenu(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: '分析正误：%s',
        contexts: ['selection'],
      });
      // 美化：去情绪化 + 还原实际含义。
      // 标题不带 %s——选中的内容通常很长，菜单里塞不下。
      chrome.contextMenus.create({
        id: MENU_ID_POLISH,
        title: '美化表达',
        contexts: ['selection'],
      });
    });
  } catch (e) {
    console.warn('[claim-check] 右键菜单创建失败：', e);
  }
}

chrome.runtime.onInstalled.addListener(() => installMenu());
chrome.runtime.onStartup?.addListener(() => installMenu());
// service worker 可能被反复唤醒，菜单 id 重复会抛错，所以每次都重装。
installMenu();

/** 生成一个记录 id。 */
function newId(): string {
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 打开结果页。 */
async function openResult(id: string): Promise<void> {
  const url = chrome.runtime.getURL(`src/result/index.html?id=${encodeURIComponent(id)}`);
  try {
    await chrome.tabs.create({ url });
  } catch (e) {
    console.warn('[claim-check] 结果页打开失败：', e);
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  const text = (info.selectionText ?? '').trim();
  if (!text) return;
  if (info.menuItemId === MENU_ID) {
    void handleAnalyze(text, info.pageUrl);
    return;
  }
  if (info.menuItemId === MENU_ID_POLISH) {
    void handlePolish(text, info.pageUrl);
  }
});

/**
 * 结果页要读记录。
 *
 * 消息体统一是 `{ type, id, payload }`：
 * `id` 是**请求 id**（用来配对响应），`payload.id` 是**记录 id**——
 * 两个「id」含义不同，早先混淆过一次，这里分开写。
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { type?: string; id?: string; payload?: { id?: string } };
  if (m?.type === 'GET_RECORD') {
    const rid = m.payload?.id ?? '';
    void getRecord(rid).then((rec) => {
      sendResponse({ id: m.id, ok: true, data: rec });
    });
    return true;
  }
  if (m?.type === 'GET_HISTORY') {
    void getHistory().then((list) => {
      sendResponse({
        id: m.id,
        ok: true,
        data: list.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          kind: r.kind ?? 'verify',
          input: { text: r.input.text },
        })),
      });
    });
    return true;
  }
  if (m?.type === 'GET_SETTINGS') {
    void getSettings().then((s) => {
      // **不回传 API Key**：结果页/历史都不需要它。
      sendResponse({
        id: m.id,
        ok: true,
        data: { ...s, llm: { ...s.llm, apiKey: s.llm.apiKey ? '***' : '' } },
      });
    });
    return true;
  }
  if (m?.type === 'SAVE_SETTINGS') {
    const p = m.payload as { settings?: unknown } | undefined;
    void getSettings().then(async (cur) => {
      const patch = (p?.settings ?? {}) as Record<string, unknown>;
      // Key 传空串表示「沿用已存的」，不是「清空」
      const llm = { ...cur.llm, ...(patch['llm'] as Record<string, unknown> | undefined) };
      if (typeof llm['apiKey'] === 'string' && llm['apiKey'] === '') {
        llm['apiKey'] = cur.llm.apiKey;
      }
      const next = { ...cur, ...patch, llm } as typeof cur;
      await saveSettings(next);
      sendResponse({ id: m.id, ok: true, data: { saved: true } });
    });
    return true;
  }
  if (m?.type === 'CLEAR_HISTORY') {
    void clearHistory().then(() => {
      sendResponse({ id: m.id, ok: true, data: { cleared: true } });
    });
    return true;
  }
  if (m?.type === 'TEST_LLM') {
    void (async () => {
      const cur = await getSettings();
      const p = m.payload as { llm?: Record<string, unknown> } | undefined;
      const llm = { ...cur.llm, ...(p?.llm ?? {}) } as typeof cur.llm;
      // Key 传空串表示「沿用已存的」
      if (!llm.apiKey) llm.apiKey = cur.llm.apiKey;
      if (!llm.apiKey) {
        sendResponse({ id: m.id, ok: false, error: '还没填 API Key' });
        return;
      }
      try {
        const client = createLlmClient(llm);
        const out = await client.complete('回复「ok」两个字即可。', { maxTokens: 2000 });
        sendResponse({ id: m.id, ok: true, data: { output: out } });
      } catch (e) {
        sendResponse({
          id: m.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return true;
  }
  return false;
});

/**
 * 跑一次分析并开结果页。
 *
 * 先把「正在分析」的占位记录写进历史，这样结果页一打开就有东西显示，
 * 不用等 LLM 跑完才有反馈。
 */
async function handleAnalyze(text: string, pageUrl?: string): Promise<void> {
  const id = newId();
  const input: AnalysisInput = {
    text: text.slice(0, MAX_INPUT_CHARS),
    ...(pageUrl ? { pageUrl } : {}),
  };

  const settings = await getSettings();
  const cfg = await getLlmConfig();
  if (!cfg) {
    await pushHistory({
      id,
      createdAt: new Date().toISOString(),
      input,
      pass1: null,
      search: { hits: [], queries: [] },
      pass2: null,
      error: '还没配置 LLM：点扩展图标填入 API Key 后再试。',
    });
    await openResult(id);
    return;
  }

  // 占位记录：结果页先显示「分析中」
  await pushHistory({
    id,
    createdAt: new Date().toISOString(),
    input,
    pass1: null,
    search: { hits: [], queries: [] },
    pass2: null,
  });
  await openResult(id);

  const client = createLlmClient(cfg);
  const record = await runAnalysis(id, input, settings, client);
  await pushHistory(record);
}

/**
 * 「美化表达」：去情绪化 + 还原实际含义。
 *
 * 跟正误分析走同一套结果页与历史，只是记录类型不同（kind='polish'）、
 * 而且**不做深度搜索**——这段话不需要外部证据。
 *
 * 典型用法：在 B 站评论区里写完一段评论，划选自己写的草稿 → 右键「美化表达」
 * → 复制改写后的版本 → 粘回输入框。
 */
async function handlePolish(text: string, pageUrl?: string): Promise<void> {
  const id = newId();
  const input: AnalysisInput = {
    text: text.slice(0, MAX_INPUT_CHARS),
    ...(pageUrl ? { pageUrl } : {}),
  };

  const cfg = await getLlmConfig();
  const base: AnalysisRecord = {
    id,
    createdAt: new Date().toISOString(),
    kind: 'polish',
    input,
    pass1: null,
    search: { hits: [], queries: [] },
    pass2: null,
    polish: null,
  };

  if (!cfg) {
    await pushHistory({
      ...base,
      error: '还没配置 LLM：点扩展图标填入 API Key 后再试。',
    });
    await openResult(id);
    return;
  }

  // 占位记录：结果页先显示「美化中…」
  await pushHistory(base);
  await openResult(id);

  const client = createLlmClient(cfg);
  const { result, error } = await runPolish(input, client);
  await pushHistory({ ...base, polish: result, error });
}
