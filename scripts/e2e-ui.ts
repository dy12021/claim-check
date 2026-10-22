/**
 * 界面真机验证：设置面板 + 结果页的交互按钮。
 *
 * 为什么要单独验：`e2e.ts` 是**直接往 storage 注入配置**绕过面板的，
 * 所以面板本身坏没坏、按钮点得动不动，那一轮完全测不到。
 * 而面板是用户配置扩展的**唯一入口**——它坏了，扩展等于没装。
 *
 * 验什么：
 *   1. 面板能打开，表单回填默认值
 *   2. **API Key 不回显**：输入框是空的，只显示「已保存 Key」
 *   3. 「测试连通性」按钮能真的打通 LLM
 *   4. 「保存」按钮能写回 storage，且空 Key 表示「沿用已存的」
 *   5. 「清空历史」按钮能清
 *   6. 结果页的「历史」按钮能列出历史、「复制结论」能复制
 *
 * 用法：
 *   $env:CLAIM_CHECK_LLM_CONFIG = '<path to config.toml>'
 *   npx tsx scripts/e2e-ui.ts
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, listTargets, browserWsUrl, sleep, waitFor, httpJson } from './cdp-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const PORT = Number(process.env.CDP_PORT ?? 9347);
const BROWSER = process.env.BROWSER ?? 'chrome';
const LLM_CONFIG = process.env.CLAIM_CHECK_LLM_CONFIG ?? '';

const SHOT_DIR = join(tmpdir(), 'claim-check-e2e');
const SHOT_POPUP = join(SHOT_DIR, 'popup.png');

const problems: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  if (!ok) problems.push(label + (detail ? ' — ' + detail : ''));
}

let EXT_ID = '';

function browserExe(): string {
  if (BROWSER === 'edge') {
    const cands = [
      process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const c of cands) if (c && existsSync(c)) return c;
    throw new Error('找不到 Edge');
  }
  const c = process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe';
  if (!existsSync(c)) throw new Error('找不到 Chrome: ' + c);
  return c;
}

async function launchBrowser(): Promise<void> {
  const exe = browserExe();
  const profile = join(tmpdir(), 'claim-check-ui-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    'about:blank',
  ];
  console.log(`启动 ${BROWSER}（CDP ${PORT}），全新 profile`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const ok = await waitFor(async () => {
    try {
      await httpJson('/json/version');
      return true;
    } catch {
      return false;
    }
  }, 20000, 500);
  if (!ok) throw new Error('CDP 没起来');
  console.log('CDP 就绪');
}

async function loadExtension(): Promise<void> {
  const cdp = await Cdp.connect(await browserWsUrl());
  try {
    const res = await cdp.send('Extensions.loadUnpacked', { path: DIST });
    EXT_ID = String(res?.id ?? '');
    console.log('扩展已装载：' + EXT_ID);
  } finally {
    cdp.close();
  }
  await sleep(1500);
}

/** 开一个标签页并连上它。 */
async function openTab(url: string): Promise<Cdp> {
  const browser = await Cdp.connect(await browserWsUrl());
  let targetId = '';
  try {
    const r = await browser.send('Target.createTarget', { url });
    targetId = String(r?.targetId ?? '');
  } finally {
    browser.close();
  }
  await sleep(1500);
  const targets = await listTargets();
  const t = targets.find((x) => x.type === 'page' && x.id === targetId);
  if (!t) {
    throw new Error(
      '新开的标签页找不到：targetId=' +
        targetId +
        '，现有=' +
        targets.filter((x) => x.type === 'page').map((x) => x.id).join(','),
    );
  }
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  // Runtime.enable 必须成功；Page.enable 只在需要 Page 域事件时才发，
  // 发不出去也不该把整条验证链卡死。
  await cdp.send('Runtime.enable', {}, 10000);
  try {
    await cdp.send('Page.enable', {}, 5000);
  } catch {
    /* 不影响 eval */
  }
  return cdp;
}

/** 在 SW 里执行（先把睡着的 SW 叫醒）。 */
async function swEval(expr: string): Promise<any> {
  let targets = await listTargets();
  let sw = targets.find(
    (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${EXT_ID}/`),
  );
  if (!sw) {
    const browser = await Cdp.connect(await browserWsUrl());
    try {
      await browser.send('Target.createTarget', {
        url: `chrome-extension://${EXT_ID}/src/popup/index.html`,
      });
    } finally {
      browser.close();
    }
    await sleep(1500);
    targets = await listTargets();
    sw = targets.find(
      (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${EXT_ID}/`),
    );
  }
  if (!sw) throw new Error('找不到扩展的 service worker');
  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  try {
    return await cdp.eval(expr);
  } finally {
    cdp.close();
  }
}

async function main(): Promise<void> {
  console.log('=== claim-check 界面真机验证 ===\n');

  // 看门狗：LLM 调用可能很慢，但不该无限期挂着。
  // 卡住时带着「跑到哪一步了」退出，比无声挂起好排查。
  const WATCHDOG_MS = 10 * 60 * 1000;
  const watchdog = setTimeout(() => {
    console.error('看门狗：超过 ' + WATCHDOG_MS / 1000 + 's 仍未结束，强制退出');
    process.exit(2);
  }, WATCHDOG_MS);

  console.log('[1/5] 启动浏览器 + 装扩展');
  await launchBrowser();
  await loadExtension();

  console.log('\n[2/5] 注入一份 LLM 配置（绕开面板，先把前置条件备齐）');
  if (!LLM_CONFIG) throw new Error('没给 CLAIM_CHECK_LLM_CONFIG');
  const text = readFileSync(LLM_CONFIG, 'utf8');
  const grab = (k: string): string => {
    const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1]! : '';
  };
  const cfg = { baseUrl: grab('base_url'), apiKey: grab('api_key'), model: grab('model') };
  await swEval(`(async () => {
    await chrome.storage.local.set({ settings: {
      llm: { provider: 'openai', baseUrl: ${JSON.stringify(cfg.baseUrl)},
             apiKey: ${JSON.stringify(cfg.apiKey)}, model: ${JSON.stringify(cfg.model)},
             timeoutMs: 120000, maxTokens: 8192, reasoningEffort: 'low' },
      enableSearch: true, maxSearchResults: 8, historyLimit: 30 } });
    return 'ok';
  })()`);
  console.log('  已注入');

  console.log('\n[3/5] 打开设置面板');
  const popup = await openTab(`chrome-extension://${EXT_ID}/src/popup/index.html`);
  await sleep(1500);

  const initial = await popup.eval(`(() => {
    const v = (id) => { const n = document.getElementById(id); return n ? n.value : null; };
    return {
      provider: v('provider'), baseUrl: v('baseUrl'), model: v('model'),
      maxTokens: v('maxTokens'), reasoningEffort: v('reasoningEffort'),
      apiKey: v('apiKey'), enableSearch: document.getElementById('enableSearch')?.checked,
      keyState: (document.getElementById('keyState')||{}).textContent || '',
      status: (document.getElementById('status')||{}).textContent || '',
    };
  })()`);
  console.log('  面板回填：', JSON.stringify(initial));
  check(initial.provider === 'openai', '面板回填 provider');
  check(String(initial.model).length > 0, '面板回填模型名', String(initial.model));
  check(Number(initial.maxTokens) === 8192, '面板回填 maxTokens', String(initial.maxTokens));
  check(initial.reasoningEffort === 'low', '面板回填推理强度', String(initial.reasoningEffort));
  check(initial.enableSearch === true, '面板回填深度搜索开关');
  check(initial.apiKey === '', 'API Key 输入框是空的（不回显明文）', JSON.stringify(initial.apiKey));
  check(initial.keyState.includes('已保存'), '面板显示「已保存 Key」', initial.keyState);

  console.log('\n[4/5] 面板按钮：测试连通性 / 保存 / 清空历史');
  // 先塞一条历史，用来验「清空历史」
  await swEval(`(async () => {
    await chrome.storage.local.set({ history: [{
      id: 'probe-1', createdAt: new Date().toISOString(),
      input: { text: '这是一条用于验证历史列表的记录' },
      pass1: null, search: { hits: [], queries: [] }, pass2: null }] });
    return 'ok';
  })()`);

  /** 读面板状态栏。 */
  const readStatus = async (): Promise<string> =>
    String(await popup.eval(`(document.getElementById('status')||{}).textContent || ''`));

  /** 等状态栏变成一个**与点击前不同**的终态（跳过「测试中…」「保存中…」这类中间态）。 */
  const waitStatusChange = async (before: string, timeoutMs: number): Promise<string> => {
    const got = await waitFor(async () => {
      const s = await readStatus();
      if (!s || s === before) return null;
      if (/测试中|保存中|清空中/.test(s)) return null;
      return s;
    }, timeoutMs, 1000);
    return got ?? '(超时没变)';
  };

  // ④-1 测试连通性（会真调一次 LLM）
  const beforeTest = await readStatus();
  await popup.eval(`(() => { document.getElementById('testBtn').click(); return true; })()`);
  const tested = await waitStatusChange(beforeTest, 180000);
  console.log('  测试连通性结果：', tested);
  check(
    tested.includes('连通正常'),
    '「测试连通性」按钮打通了 LLM',
    tested,
  );

  // ④-2 保存（空 Key 表示沿用已存的）
  const beforeSave = await readStatus();
  await popup.eval(`(() => { document.getElementById('saveBtn').click(); return true; })()`);
  const saved = await waitStatusChange(beforeSave, 30000);
  console.log('  保存结果：', saved);
  check(saved.includes('已保存'), '「保存」按钮写回成功', saved);

  const afterSave = await swEval(`(async () => {
    const b = await chrome.storage.local.get(['settings']);
    const s = b.settings;
    return JSON.stringify({ model: s?.llm?.model, keyLen: s?.llm?.apiKey?.length ?? 0,
                            search: s?.enableSearch });
  })()`);
  console.log('  存回 storage：', afterSave);
  const st = JSON.parse(String(afterSave));
  check(st.keyLen === cfg.apiKey.length, '空 Key 输入没有把已存的 Key 冲掉', `keyLen=${st.keyLen}`);
  check(st.model === cfg.model, '模型名写回正确', String(st.model));

  // 面板读回来的设置里，Key 必须已经被遮成 ***
  // **必须在扩展页里发这条消息**：service worker 收不到自己发的 runtime 消息，
  // 在 SW 里 sendMessage 给自己的 onMessage 监听器是不通的。
  const masked = await popup.eval(`new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS', id: 'probe' }, (back) => {
      resolve(JSON.stringify({ apiKey: back && back.data && back.data.llm && back.data.llm.apiKey }));
    });
  })`);
  console.log('  GET_SETTINGS 返回的 Key：', masked);
  check(
    String(masked).includes('***') && !String(masked).includes(cfg.apiKey),
    'GET_SETTINGS 把 Key 遮成 ***（不回传明文）',
    String(masked),
  );

  // ④-3 清空历史
  const beforeClear = await readStatus();
  await popup.eval(`(() => { document.getElementById('clearHistoryBtn').click(); return true; })()`);
  const cleared = await waitStatusChange(beforeClear, 20000);
  await sleep(800);
  const histAfter = await swEval(`(async () => {
    const b = await chrome.storage.local.get(['history']);
    return JSON.stringify((b.history || []).length);
  })()`);
  console.log('  清空历史结果：', cleared, '｜剩余历史条数：', histAfter);
  check(String(histAfter) === '0', '「清空历史」真的清空了', '剩余 ' + histAfter);

  const shot = await popup.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const { writeFileSync } = await import('node:fs');
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(SHOT_POPUP, Buffer.from(shot.data, 'base64'));
  console.log('  面板截图：' + SHOT_POPUP);

  console.log('\n[5/5] 结果页的交互按钮：历史 / 复制结论');
  // 造一条完整的记录，让结果页有东西可显示
  await swEval(`(async () => {
    await chrome.storage.local.set({ history: [{
      id: 'ui-1', createdAt: new Date().toISOString(),
      input: { text: '这是一条用于验证结果页按钮的记录', pageUrl: 'https://example.com/x' },
      pass1: { kind: 'claim', summary: 's',
        claims: [{ text: '主张一', confidence: '中' }],
        logicIssues: [{ quote: '主张一', type: '诉诸权威', explanation: '因为是权威说的' }],
        assumptions: ['前提一'], missingEvidence: ['缺证据一'], queries: ['q'] },
      search: { hits: [{ title: '资料标题', url: 'https://example.com/y', snippet: '摘要', query: 'q' }],
                queries: ['q'] },
      pass2: { verdict: 'uncertain', confidence: 0.5, verdictText: '证据不足，无法判定',
        analysis: '分析正文', supported: [], challenged: [], notCovered: ['没覆盖的点'],
        followUps: ['跟进问题'] } }] });
    return 'ok';
  })()`);

  const result = await openTab(`chrome-extension://${EXT_ID}/src/result/index.html?id=ui-1`);
  await sleep(2000);
  // 让页面获得焦点，否则剪贴板写入会被拒
  await result.send('Page.bringToFront');
  await sleep(400);

  const rendered = await result.eval(`(() => {
    const vis = (id) => { const n = document.getElementById(id); return !!(n && !n.hidden); };
    return {
      verdict: (document.getElementById('verdictLabel')||{}).textContent || '',
      quote: (document.getElementById('quote')||{}).textContent || '',
      issues: document.querySelectorAll('#issues li').length,
      sources: document.querySelectorAll('#sources li').length,
    };
  })()`);
  console.log('  结果页渲染：', JSON.stringify(rendered));
  check(String(rendered.verdict).includes('无法判定'), '结果页渲染出结论', String(rendered.verdict));
  check(rendered.issues > 0, '结果页渲染出逻辑问题');
  check(rendered.sources > 0, '结果页渲染出资料出处');

  // 历史按钮
  await result.eval(`(() => { document.getElementById('historyBtn').click(); return true; })()`);
  await sleep(1500);
  const hist = await result.eval(`(() => {
    const li = document.querySelectorAll('#history li');
    return { count: li.length, text: li.length ? li[0].textContent : '' };
  })()`);
  console.log('  历史列表：', JSON.stringify(hist));
  check(hist.count > 0, '「历史」按钮列出了历史记录', String(hist.count));

  // 复制按钮
  await result.send('Page.bringToFront');
  await result.eval(`(() => { document.getElementById('copyBtn').click(); return true; })()`);
  await sleep(1200);
  const copied = await result.eval(
    `(document.getElementById('copyBtn')||{}).textContent || ''`,
  );
  console.log('  复制按钮反馈：', copied);
  check(
    String(copied).includes('已复制') || String(copied).includes('复制失败'),
    '「复制结论」按钮有明确反馈（成功或失败都算有响应）',
    String(copied),
  );

  // 记录被清掉后再打开结果页：必须如实说「找不到」，不能白屏或假装还在
  const gone = await openTab(`chrome-extension://${EXT_ID}/src/result/index.html?id=not-exist`);
  await sleep(2000);
  const goneStatus = String(
    await gone.eval(`(document.getElementById('status')||{}).textContent || ''`),
  );
  console.log('  记录不存在时的提示：', goneStatus);
  check(
    goneStatus.includes('找不到') || goneStatus.includes('缺少分析记录'),
    '记录不存在时结果页如实报错',
    goneStatus,
  );

  console.log('\n=== 汇总 ===');
  clearTimeout(watchdog);
  if (problems.length) {
    console.error('失败 ' + problems.length + ' 项：');
    for (const p of problems) console.error('  x ' + p);
    process.exit(1);
  }
  console.log('全部通过 ✓');
  console.log('面板截图：' + SHOT_POPUP);
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
