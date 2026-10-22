import type { Settings } from '../shared/types';

/**
 * 设置面板。
 *
 * 面板只做两件事：读写设置、测连通性。
 * API Key 存在 `chrome.storage.local`，**面板永远不回显明文**——
 * 读回来时是 `***`，输入框留空表示「沿用已存的」。
 */

let reqSeq = 0;

function call<T = unknown>(
  type: string,
  payload?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const id = `popup-${++reqSeq}`;
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, id, payload }, (resp: unknown) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        const r = resp as { ok?: boolean; data?: T; error?: string } | undefined;
        resolve({ ok: r?.ok === true, data: r?.data, error: r?.error });
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`缺少元素 #${id}`);
  return n as T;
}

function setStatus(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const s = el('status');
  s.textContent = text;
  s.className = `status ${kind === 'info' ? '' : kind}`;
}

/** 把设置填进表单。 */
function fill(s: Settings): void {
  el<HTMLSelectElement>('provider').value = s.llm.provider;
  el<HTMLInputElement>('baseUrl').value = s.llm.baseUrl;
  el<HTMLInputElement>('model').value = s.llm.model;
  el<HTMLInputElement>('maxTokens').value = String(s.llm.maxTokens ?? 8192);
  el<HTMLSelectElement>('reasoningEffort').value = s.llm.reasoningEffort ?? 'low';
  el<HTMLInputElement>('apiKey').value = '';
  el('keyState').textContent = s.llm.apiKey
    ? '已保存 Key（不显示明文）。留空表示沿用。'
    : '尚未保存 Key。';
  el<HTMLInputElement>('enableSearch').checked = s.enableSearch !== false;
}

/** 读表单。 */
function collect(): Partial<Settings> {
  const effort = el<HTMLSelectElement>('reasoningEffort').value;
  return {
    llm: {
      provider: el<HTMLSelectElement>('provider').value as 'openai' | 'anthropic',
      baseUrl: el<HTMLInputElement>('baseUrl').value.trim(),
      model: el<HTMLInputElement>('model').value.trim(),
      apiKey: el<HTMLInputElement>('apiKey').value.trim(),
      timeoutMs: 120000,
      maxTokens: Number(el<HTMLInputElement>('maxTokens').value) || 8192,
      ...(effort ? { reasoningEffort: effort as 'low' | 'medium' | 'high' } : {}),
    },
    enableSearch: el<HTMLInputElement>('enableSearch').checked,
  };
}

async function main(): Promise<void> {
  const r = await call<Settings>('GET_SETTINGS');
  if (r.ok && r.data) fill(r.data);
  else setStatus('读取设置失败', 'err');

  el('saveBtn').addEventListener('click', () => {
    void (async () => {
      setStatus('保存中…');
      const res = await call('SAVE_SETTINGS', { settings: collect() });
      if (!res.ok) {
        setStatus(res.error ?? '保存失败', 'err');
        return;
      }
      setStatus('已保存 ✓', 'ok');
      const again = await call<Settings>('GET_SETTINGS');
      if (again.ok && again.data) fill(again.data);
    })();
  });

  el('testBtn').addEventListener('click', () => {
    void (async () => {
      setStatus('测试中…（推理模型可能要几十秒）');
      // 把表单里的配置带上去：用户可能刚换了模型或 Base URL。
      // Key 留空时后台会沿用已存的那个。
      const res = await call('TEST_LLM', { llm: collect().llm });
      if (!res.ok) {
        setStatus(res.error ?? '测试失败', 'err');
        return;
      }
      setStatus('连通正常 ✓', 'ok');
    })();
  });

  el('clearHistoryBtn').addEventListener('click', () => {
    void (async () => {
      const res = await call('CLEAR_HISTORY');
      setStatus(res.ok ? '历史已清空' : (res.error ?? '清空失败'), res.ok ? 'ok' : 'err');
    })();
  });
}

void main();
