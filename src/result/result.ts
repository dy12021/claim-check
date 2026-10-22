import type { AnalysisRecord, Verdict } from '../shared/types';
import { buildPlainText, escapeHtml } from './plaintext';

/**
 * 结果页。
 *
 * 职责只有两个：把一条分析记录渲染出来；分析还在跑的时候轮询等它。
 * **不发起任何网络请求**——所有数据都来自 service worker 写好的 storage。
 */

const params = new URLSearchParams(location.search);
const recordId = params.get('id') ?? '';

let pollTimer: number | null = null;

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`缺少元素 #${id}`);
  return n as T;
}

function show(id: string, on: boolean): void {
  const n = document.getElementById(id);
  if (n) n.hidden = !on;
}

function text(v: string): void {
  el('quote').textContent = v;
}

/** 记录看起来是不是还在跑（占位记录：两个阶段都空、也没报错）。 */
function isPending(rec: AnalysisRecord): boolean {
  return !rec.error && !rec.pass1 && !rec.pass2;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  likely_true: '大概率成立',
  likely_false: '可能有误',
  uncertain: '证据不足，无法判定',
};
const VERDICT_CLASS: Record<Verdict, string> = {
  likely_true: 'true',
  likely_false: 'false',
  uncertain: 'uncertain',
};

function render(rec: AnalysisRecord): void {
  el('subtitle').textContent = rec.input.pageTitle ?? '正误分析';
  text(rec.input.text);
  el('quoteSrc').textContent = rec.input.pageUrl ?? '';

  // 状态
  const status = el('status');
  if (rec.error) {
    status.className = 'status-box err';
    status.textContent = rec.error;
    show('status', true);
  } else if (isPending(rec)) {
    status.className = 'status-box busy';
    status.textContent = '分析中…（解析结构 → 深度搜索 → 综合判断）';
    show('status', true);
  } else {
    show('status', false);
  }

  // 结论
  if (rec.pass2) {
    const v = rec.pass2.verdict;
    const label = el('verdictLabel');
    label.textContent = VERDICT_LABEL[v];
    label.className = `verdict-label ${VERDICT_CLASS[v]}`;
    el('verdictConf').textContent = `把握程度 ${(rec.pass2.confidence * 100).toFixed(0)}%`;
    el('verdictText').textContent = rec.pass2.verdictText;
    const meter = el('verdictMeter');
    meter.className = VERDICT_CLASS[v];
    meter.style.width = `${Math.max(2, rec.pass2.confidence * 100)}%`;
    show('verdictBox', true);
  }

  // 分析正文
  if (rec.pass2?.analysis) {
    el('analysis').textContent = rec.pass2.analysis;
    show('analysisBox', true);
  }

  // 主张
  const claims = rec.pass1?.claims ?? [];
  if (claims.length) {
    el('claims').innerHTML = claims
      .map(
        (c) =>
          `<li>${escapeHtml(c.text)}<span class="ev">（把握程度：${escapeHtml(c.confidence)}）</span></li>`,
      )
      .join('');
    show('claimsBox', true);
  }

  // 逻辑问题
  const issues = rec.pass1?.logicIssues ?? [];
  if (issues.length) {
    el('issues').innerHTML = issues
      .map(
        (i) =>
          `<li><span class="type">${escapeHtml(i.type)}</span>` +
          (i.quote ? `<span class="q">${escapeHtml(i.quote)}</span>` : '') +
          `${escapeHtml(i.explanation)}</li>`,
      )
      .join('');
    show('issuesBox', true);
  }

  // 前提 / 缺证据
  fillList('assumptions', rec.pass1?.assumptions ?? []);
  fillList('missing', rec.pass1?.missingEvidence ?? []);

  // 支撑 / 存疑
  fillPoints('supported', rec.pass2?.supported ?? []);
  fillPoints('challenged', rec.pass2?.challenged ?? []);
  fillList('notCovered', rec.pass2?.notCovered ?? []);
  fillList('followUps', rec.pass2?.followUps ?? []);

  // 资料出处
  const hits = rec.search.hits;
  if (hits.length) {
    el('sourcesMeta').textContent =
      `检索词：${rec.search.queries.join(' / ')}｜取到 ${hits.length} 条`;
    el('sources').innerHTML = hits
      .map(
        (h) =>
          `<li><a href="${escapeAttr(h.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(h.title)}</a>` +
          `<div class="snip">${escapeHtml(h.snippet)}</div>` +
          `<div class="q-from">来自检索词「${escapeHtml(h.query)}」</div></li>`,
      )
      .join('');
    show('sourcesBox', true);
  } else if (rec.search.error) {
    el('sourcesMeta').textContent = `深度搜索没成功：${rec.search.error}（结论仅基于原文）`;
    show('sourcesBox', true);
  }

  // 复制
  el('copyBtn').onclick = () => {
    void copyText(buildPlainText(rec));
  };
}

function fillList(id: string, items: string[]): void {
  if (!items.length) return;
  el(id).innerHTML = items.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  show(`${id}Box`, true);
}

function fillPoints(id: string, items: { point: string; evidence: string }[]): void {
  if (!items.length) return;
  el(id).innerHTML = items
    .map(
      (p) =>
        `<li>${escapeHtml(p.point)}` +
        (p.evidence ? `<div class="ev">依据：${escapeHtml(p.evidence)}</div>` : '') +
        `</li>`,
    )
    .join('');
  show(`${id}Box`, true);
}

/** 拼一份纯文本结论，方便用户复制走。 */
export { buildPlainText };

async function copyText(t: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t);
    const btn = el('copyBtn');
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = '复制结论'; }, 1600);
  } catch {
    el('copyBtn').textContent = '复制失败';
  }
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** 从 background 读记录。读不到就是没有。 */
async function loadRecord(id: string): Promise<AnalysisRecord | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_RECORD', id, payload: { id } }, (resp: unknown) => {
      void chrome.runtime.lastError;
      const r = resp as { ok?: boolean; data?: AnalysisRecord | null } | undefined;
      resolve(r?.ok ? (r.data ?? null) : null);
    });
  });
}

/** 历史列表。 */
async function loadHistory(): Promise<void> {
  const resp = await new Promise<unknown>((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (r: unknown) => {
      void chrome.runtime.lastError;
      resolve(r);
    });
  });
  const list = (resp as { data?: { id: string; createdAt: string; input: { text: string } }[] })
    ?.data ?? [];
  if (!list.length) {
    el('history').innerHTML = '<li class="ev">还没有历史记录</li>';
  } else {
    el('history').innerHTML = list
      .map(
        (r) =>
          `<li><a href="?id=${encodeURIComponent(r.id)}">${escapeHtml(
            r.input.text.slice(0, 60),
          )}${r.input.text.length > 60 ? '…' : ''}</a>` +
          `<span class="when">${fmtWhen(r.createdAt)}</span></li>`,
      )
      .join('');
  }
  show('historyBox', true);
}

async function main(): Promise<void> {
  el('historyBtn').onclick = () => { void loadHistory(); };

  if (!recordId) {
    el('status').className = 'status-box err';
    el('status').textContent = '缺少分析记录 id（正常使用时不会出现）';
    show('status', true);
    await loadHistory();
    return;
  }

  const tick = async (): Promise<void> => {
    const rec = await loadRecord(recordId);
    if (!rec) {
      el('status').className = 'status-box err';
      el('status').textContent = '找不到这条分析记录（可能已被清理）';
      show('status', true);
      return;
    }
    render(rec);
    if (isPending(rec)) {
      pollTimer = window.setTimeout(() => { void tick(); }, 1500);
    }
  };
  await tick();
}

void main();

window.addEventListener('unload', () => {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
});
