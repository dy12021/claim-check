/**
 * 首次使用路径的真机验证：**还没配 API Key 就划词**。
 *
 * 为什么单独验：这是新用户的第一分钟。
 * 装了扩展 → 在网页上划一段话 → 右键「分析正误」，
 * 这时候 Key 还没填。如果这时候报错含糊（比如空白页、或者一句
 * "undefined"），用户根本不知道该去哪儿配 Key，扩展就等于废了。
 *
 * 验什么：
 *   1. 面板在「没有 Key」时显示的状态是明确的
 *   2. 面板的「测试连通性」在没 Key 时给出可操作的提示
 *   3. 没 Key 就划词 → 结果页如实说清缺什么，而不是白屏或静默失败
 *
 * 与 e2e.ts / e2e-ui.ts 的区别：那两个都**先注入配置**，
 * 所以「没配 Key」这条路径此前一次都没被验过。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, listTargets, browserWsUrl, sleep, waitFor, httpJson } from './cdp-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const PORT = Number(process.env.CDP_PORT ?? 9348);
const BROWSER = process.env.BROWSER ?? 'chrome';

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
  const profile = join(tmpdir(), 'claim-check-firstrun-' + Date.now());
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
  console.log(`启动 ${BROWSER}（CDP ${PORT}），全新 profile —— 不注入任何配置`);
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
  if (!t) throw new Error('新开的标签页找不到');
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable', {}, 10000);
  return cdp;
}

async function main(): Promise<void> {
  console.log('=== claim-check 首次使用路径真机验证 ===\n');

  // 当前步骤：挂在哪就报哪，别让人猜
  let step = '启动';
  const watchdog = setTimeout(() => {
    console.error(`看门狗：超时未结束，卡在【${step}】`);
    process.exit(2);
  }, 8 * 60 * 1000);

  console.log('[1/4] 启动浏览器（全新 profile，无任何配置）+ 装扩展');
  step = '启动浏览器';
  await launchBrowser();
  step = '装扩展';
  await loadExtension();

  // 确认 storage 确实是空的（别被上一次残留骗了）
  const swTargets = await listTargets();
  const sw = swTargets.find(
    (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${EXT_ID}/`),
  );
  if (!sw) throw new Error('找不到扩展 SW');
  const swCdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  let empty = false;
  try {
    empty = await swCdp.eval(`(async () => {
      const b = await chrome.storage.local.get(['settings']);
      return !b.settings || !b.settings.llm || !b.settings.llm.apiKey;
    })()`);
  } finally {
    swCdp.close();
  }
  check(empty === true, 'storage 里确实没有 API Key（走的是真正的首次使用）');

  console.log('\n[2/4] 面板在「没有 Key」时的状态');
  step = '打开面板';
  const popup = await openTab(`chrome-extension://${EXT_ID}/src/popup/index.html`);
  await sleep(1500);
  const pstate = await popup.eval(`(() => {
    const t = (id) => (document.getElementById(id) || {}).textContent || '';
    return {
      keyState: t('keyState'),
      apiKey: (document.getElementById('apiKey') || {}).value || '',
      model: (document.getElementById('model') || {}).value || '',
      status: t('status'),
    };
  })()`);
  console.log('  面板状态：', JSON.stringify(pstate));
  check(String(pstate.keyState).includes('尚未保存'), '面板明确说「尚未保存 Key」', pstate.keyState);
  check(pstate.apiKey === '', 'Key 输入框为空');
  check(String(pstate.model).length > 0, '但其它默认值仍回填了（模型名等）', String(pstate.model));

  console.log('\n[3/4] 没配 Key 就点「测试连通性」');
  step = '点测试连通性';
  const before = String(await popup.eval(`(document.getElementById('status')||{}).textContent || ''`));
  await popup.eval(`(() => { document.getElementById('testBtn').click(); return true; })()`);
  const got = await waitFor(async () => {
    const s = String(await popup.eval(`(document.getElementById('status')||{}).textContent || ''`));
    if (!s || s === before) return null;
    if (/测试中/.test(s)) return null;
    return s;
  }, 30000, 800);
  const msg = got ?? '(超时没变)';
  console.log('  提示：', msg);
  check(msg.includes('API Key') || msg.includes('Key'), '「测试连通性」明确指出缺 Key', msg);
  check(!/undefined|null/i.test(msg), '提示里没有 undefined/null 这种脏输出', msg);

  console.log('\n[4/4] 没配 Key 就划词 → 结果页');
  step = '派发菜单点击';
  // 直接派发右键菜单点击（和真点菜单项同一个处理函数）
  const sw2 = (await listTargets()).find(
    (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${EXT_ID}/`),
  );
  if (!sw2) throw new Error('SW 不在了');
  const swCdp2 = await Cdp.connect(sw2.webSocketDebuggerUrl);
  try {
    const out = await swCdp2.eval(`(() => {
      chrome.contextMenus.onClicked.dispatch({
        menuItemId: 'claim-check-analyze',
        selectionText: '这是一段没有配置 API Key 就被分析的文字',
        pageUrl: 'https://example.com/x'
      });
      return 'DISPATCHED';
    })()`);
    console.log('  菜单点击派发：', out);
    check(out === 'DISPATCHED', '派发了右键菜单点击');
  } finally {
    swCdp2.close();
  }

  step = '等结果页打开';
  const found = await waitFor(async () => {
    const targets = await listTargets();
    return targets.some(
      (t) => t.type === 'page' && t.url.includes(`chrome-extension://${EXT_ID}/`) && t.url.includes('result'),
    );
  }, 30000, 500);
  check(found === true, '结果页照常打开了（而不是什么都不发生）');

  const targets2 = await listTargets();
  const tab = targets2.find(
    (t) => t.type === 'page' && t.url.includes(`chrome-extension://${EXT_ID}/`) && t.url.includes('result'),
  )!;
  step = '连结果页';
  const result = await Cdp.connect(tab.webSocketDebuggerUrl);
  await result.send('Runtime.enable', {}, 10000);
  await sleep(2000);
  const rstate = await result.eval(`(() => {
    const t = (id) => (document.getElementById(id) || {}).textContent || '';
    const vis = (id) => { const n = document.getElementById(id); return !!(n && !n.hidden); };
    return {
      quote: t('quote'),
      status: t('status'),
      statusVisible: vis('status'),
      verdictVisible: vis('verdictBox'),
    };
  })()`);
  console.log('  结果页状态：', JSON.stringify(rstate));
  check(String(rstate.quote).length > 0, '结果页回显了划选原文（用户知道自己选了什么）');
  check(rstate.statusVisible === true, '状态框是显示的（不是悄悄失败）');
  check(
    /API Key|配置|还没/.test(String(rstate.status)),
    '明确告诉用户缺 API Key、让他去配置',
    String(rstate.status),
  );
  check(rstate.verdictVisible === false, '没有 Key 时不会伪造一个结论出来');

  clearTimeout(watchdog);
  console.log('\n=== 汇总 ===');
  if (problems.length) {
    console.error('失败 ' + problems.length + ' 项：');
    for (const p of problems) console.error('  x ' + p);
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
