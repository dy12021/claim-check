/**
 * 端到端真机验证：划选 → 右键 → 出结论。
 *
 * 验证的是**用户真的会走的那条路**，不是单测能覆盖的接线：
 *
 *   1. 装扩展（CDP Extensions.loadUnpacked）
 *   2. 注入 LLM 配置（从环境变量指定的 toml 读，Key 不打印、不入库）
 *   3. 打开一个本地测试页，用**真实鼠标事件**划选文字
 *   4. 真实右键（原生菜单本身用 API 验，见 verifyMenu）
 *   5. 在 service worker 里派发 contextMenus.onClicked，
 *      走的是和真点菜单项**完全同一个**处理函数
 *   6. 等结果页开出来，读它的 DOM，逐项断言
 *
 * 用法：
 *   # 先把 LLM 配置路径放进环境变量（脚本里不写死任何本机路径）
 *   $env:CLAIM_CHECK_LLM_CONFIG = '<path to config.toml>'
 *   npx tsx scripts/e2e.ts
 *
 * 浏览器：默认 Chrome，可用 BROWSER=edge 换 Edge。
 * 端口：默认 9345，可用 CDP_PORT 换。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, listTargets, browserWsUrl, sleep, waitFor, httpJson } from './cdp-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const PORT = Number(process.env.CDP_PORT ?? 9345);
const BROWSER = process.env.BROWSER ?? 'chrome';
const LLM_CONFIG = process.env.CLAIM_CHECK_LLM_CONFIG ?? '';

const SHOT_DIR = join(tmpdir(), 'claim-check-e2e');
const SHOT_RESULT = join(SHOT_DIR, 'result.png');

const problems: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  if (!ok) problems.push(label + (detail ? ' — ' + detail : ''));
}

/**
 * 测试页面上的那段话。
 *
 * 故意放了三类典型问题：相关当因果、诉诸权威（"研究显示"）、
 * 以及从观察直接跳到因果干预的建议。
 */
const TEST_CLAIM =
  '研究表明，每天喝咖啡的人比不喝咖啡的人平均寿命长 15 年，' +
  '所以喝咖啡能让人长寿。这项研究覆盖了 10 万人，数据非常可靠。';

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>测试页面</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 0; padding: 60px; background: #fff; color: #222; }
  /* 单行不换行：拖选是一条直线，文字一换行，拖选路径就会跨到
     行间空隙上，选区会是空的。 */
  #claim { font-size: 18px; white-space: nowrap; }
</style></head>
<body>
  <span id="claim">${TEST_CLAIM}</span>
</body></html>`;

/** 起一个本地 HTTP 服务当测试页。 */
function startPageServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => server.close(),
      });
    });
  });
}

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
  const profile = join(tmpdir(), 'claim-check-e2e-' + Date.now());
  mkdirSync(profile, { recursive: true });

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    // Chrome 142+ 删掉了 --load-extension 开关，只能走 CDP 的 Extensions 域
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ];
  console.log(`启动 ${BROWSER}（CDP ${PORT}），全新 profile：${profile}`);
  // 用 spawn 而不是 execFileSync：浏览器是常驻进程，
  // execFileSync 会**同步等它退出**，整个脚本就卡在这一行不动了。
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

/** 扩展 id（Extensions.loadUnpacked 返回的）。 */
let EXT_ID = '';

async function loadExtension(): Promise<void> {
  const cdp = await Cdp.connect(await browserWsUrl());
  try {
    const res = await cdp.send('Extensions.loadUnpacked', { path: DIST });
    EXT_ID = String(res?.id ?? '');
    console.log('扩展已装载：', JSON.stringify(res));
    if (!EXT_ID) throw new Error('拿不到扩展 id');
  } finally {
    cdp.close();
  }
  await sleep(1500);
}

/**
 * 找扩展自己的 service worker。
 *
 * **不能只看 type === 'service_worker'**——Chrome 自带好几个内置扩展
 * （automation、component extension 之类）也有 SW 目标，
 * 抓到它们的话 `chrome.storage` / `chrome.contextMenus` 全是 undefined。
 * 所以按扩展 id 精确匹配。
 */
async function findSw(): Promise<string | null> {
  const targets = await listTargets();
  const sw = targets.find(
    (t) => t.type === 'service_worker' && EXT_ID && t.url.includes(`chrome-extension://${EXT_ID}/`),
  );
  return sw?.webSocketDebuggerUrl ?? null;
}

/**
 * 把睡着的 service worker 叫醒。
 *
 * MV3 的 SW 空闲 30 秒就休眠。测试里两个 SW 操作之间隔了划词、
 * 截图这些步骤，容易超过 30 秒，SW 就没了。
 *
 * 唤醒办法：打开扩展自己的 popup 页——它一加载就会给后台发消息，
 * 后台因此被拉起来。（真实用户点右键时 Chrome 也会自动唤醒 SW，
 * 所以这是**测试侧**才需要处理的问题。）
 */
async function wakeSw(): Promise<string | null> {
  let sw = await findSw();
  if (sw) return sw;
  console.log('  SW 在睡，唤醒它…');

  const browser = await Cdp.connect(await browserWsUrl());
  let targetId = '';
  try {
    const r = await browser.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/src/popup/index.html`,
    });
    targetId = String(r?.targetId ?? '');
  } finally {
    browser.close();
  }
  await sleep(1500);
  sw = await findSw();
  if (targetId) {
    const b2 = await Cdp.connect(await browserWsUrl());
    try {
      await b2.send('Target.closeTarget', { targetId });
    } catch {
      /* 关不掉也不影响 */
    } finally {
      b2.close();
    }
  }
  return sw;
}

/** 往 storage 注入 LLM 配置。Key 只写进去，不打印。 */
async function injectConfig(): Promise<void> {
  if (!LLM_CONFIG) {
    throw new Error(
      '没给 CLAIM_CHECK_LLM_CONFIG 环境变量——没法注入 LLM 配置，后面的真机验证做不了',
    );
  }
  const text = readFileSync(LLM_CONFIG, 'utf8');
  const grab = (key: string): string => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1]! : '';
  };
  const baseUrl = grab('base_url');
  const apiKey = grab('api_key');
  const model = grab('model');
  if (!baseUrl || !apiKey || !model) throw new Error('配置里没读到 base_url / api_key / model');

  const ws = await wakeSw();
  if (!ws) throw new Error('找不到扩展的 service worker');
  const cdp = await Cdp.connect(ws);
  try {
    const out = await cdp.eval(`(async () => {
      await chrome.storage.local.set({ settings: {
        llm: {
          provider: 'openai',
          baseUrl: ${JSON.stringify(baseUrl)},
          apiKey: ${JSON.stringify(apiKey)},
          model: ${JSON.stringify(model)},
          timeoutMs: 120000,
          maxTokens: 8192,
          reasoningEffort: 'low'
        },
        enableSearch: true,
        maxSearchResults: 8,
        historyLimit: 30
      }});
      const back = await chrome.storage.local.get(['settings']);
      const s = back.settings;
      return JSON.stringify({ saved: !!s, model: s?.llm?.model, keyLen: s?.llm?.apiKey?.length ?? 0 });
    })()`);
    console.log('LLM 配置注入：', out);
  } finally {
    cdp.close();
  }
}

/**
 * 验右键菜单。
 *
 * 为什么要专门验这一步：这个扩展**没有 content script**，
 * 它的全部入口就是这一个右键菜单。菜单要是没注册成功，
 * 后面所有分析逻辑都无从谈起——而单测测不到菜单注册。
 *
 * 分两层验：
 *  1. **运行时**：`chrome.contextMenus.update(id, ...)`。
 *     id 不存在时 Chrome 会回 "Cannot find menu item"；存在则无错误。
 *     （顺带实测：Chrome 的 update 回调**不返回**菜单属性，
 *     传空对象或幂等属性都拿不到 title/contexts——所以属性只能从源码断言。）
 *  2. **源码层**：菜单的标题和上下文是静态声明的，直接断言源码。
 */
async function verifyMenu(): Promise<void> {
  const ws = await wakeSw();
  if (!ws) throw new Error('找不到扩展的 service worker');
  const cdp = await Cdp.connect(ws);
  try {
    const out = await cdp.eval(`new Promise((resolve) => {
      const id = 'claim-check-analyze';
      chrome.contextMenus.update(id, { visible: true }, () => {
        const err = chrome.runtime.lastError;
        resolve(JSON.stringify({
          error: err ? err.message : null,
          hasClickListener: chrome.contextMenus.onClicked.hasListeners(),
        }));
      });
    })`);
    const info = JSON.parse(String(out));
    console.log('右键菜单对象：', String(out));
    check(!info.error, '右键菜单项注册成功（update 没报「找不到菜单」）', String(info.error));
    check(info.hasClickListener === true, 'onClicked 监听器已注册');
  } finally {
    cdp.close();
  }

  // 菜单的标题与上下文是静态声明的，断言源码
  const src = readFileSync(join(REPO, 'src', 'bg', 'index.ts'), 'utf8');
  check(
    src.includes("title: '分析正误：%s'"),
    '菜单标题是「分析正误：<选中文字>」',
  );
  check(src.includes("contexts: ['selection']"), '菜单上下文是 selection（只在划选时出现）');
}

/**
 * 真实划词 + 右键。
 *
 * 用 Input.dispatchMouseEvent 模拟真实鼠标按下/移动/抬起，
 * 这样浏览器才会产生**真正的文本选区**——JS 设的 selection 在右键菜单里拿不到。
 */
async function selectAndRightClick(pageUrl: string): Promise<string> {
  const browser = await Cdp.connect(await browserWsUrl());
  let targetId = '';
  try {
    const r = await browser.send('Target.createTarget', { url: pageUrl });
    targetId = String(r?.targetId ?? '');
  } finally {
    browser.close();
  }
  await sleep(2000);

  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page' && t.id === targetId);
  if (!page) throw new Error('找不到测试页目标');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await sleep(500);

    // 取目标文字的坐标（span 的包围盒紧贴字形，不会落到行间空隙上）
    const rect = await cdp.eval(`(() => {
      const el = document.getElementById('claim');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    if (!rect) throw new Error('页面上找不到 #claim');

    const startX = rect.x + 2;
    const startY = rect.y + rect.h / 2;
    const endX = rect.x + rect.w - 2;
    const endY = startY;

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1,
    });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: startX + ((endX - startX) * i) / steps,
        y: startY,
        button: 'left',
        buttons: 1,
      });
      await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(400);

    const selected = await cdp.eval(`window.getSelection().toString()`);
    console.log('浏览器里的选区：', JSON.stringify(String(selected).slice(0, 90)));
    check(String(selected).length > 10, '真实鼠标划选产生了选区', `长度 ${String(selected).length}`);

    // 右键（原生菜单本身用 verifyMenu 验）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: endX, y: endY, button: 'right', buttons: 2, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: endX, y: endY, button: 'right', buttons: 0, clickCount: 1,
    });
    await sleep(800);
    return String(selected ?? '');
  } finally {
    cdp.close();
  }
}

/** 派发右键菜单点击（和真点菜单项走同一个处理函数）。 */
async function dispatchMenuClick(selectionText: string, pageUrl: string): Promise<void> {
  const ws = await wakeSw();
  if (!ws) throw new Error('找不到扩展的 service worker');
  const cdp = await Cdp.connect(ws);
  try {
    const out = await cdp.eval(`(() => {
      const evt = chrome.contextMenus.onClicked;
      if (typeof evt.dispatch !== 'function') return 'NO_DISPATCH';
      evt.dispatch({
        menuItemId: 'claim-check-analyze',
        selectionText: ${JSON.stringify(selectionText)},
        pageUrl: ${JSON.stringify(pageUrl)}
      });
      return 'DISPATCHED';
    })()`);
    console.log('菜单点击派发：', out);
    check(out === 'DISPATCHED', '能在 SW 里派发 contextMenus.onClicked', String(out));
  } finally {
    cdp.close();
  }
}

/** 等结果页开出来并读完内容。 */
async function readResultPage(): Promise<any> {
  const found = await waitFor(async () => {
    const targets = await listTargets();
    return targets.some(
      (t) => t.type === 'page' && t.url.includes(`chrome-extension://${EXT_ID}/`) && t.url.includes('result'),
    );
  }, 40000, 500);
  if (!found) return null;

  const targets = await listTargets();
  const tab = targets.find(
    (t) => t.type === 'page' && t.url.includes(`chrome-extension://${EXT_ID}/`) && t.url.includes('result'),
  )!;
  console.log('结果页：', tab.url);

  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    // 分析要跑一会儿，轮询到结论出现为止
    const ready = await waitFor(async () => {
      const done = await cdp.eval(
        `(() => { const b = document.getElementById('verdictBox'); return !!(b && !b.hidden); })()`,
      );
      return !!done;
    }, 240000, 2000);
    check(ready, '结果页在 4 分钟内给出了结论');

    const info = await cdp.eval(`(() => {
      const t = (id) => (document.getElementById(id) || {}).textContent || '';
      const vis = (id) => { const n = document.getElementById(id); return !!(n && !n.hidden); };
      return {
        url: location.href,
        quote: t('quote'),
        quoteSrc: t('quoteSrc'),
        status: t('status'),
        statusVisible: vis('status'),
        verdict: t('verdictLabel'),
        verdictConf: t('verdictConf'),
        verdictText: t('verdictText'),
        analysis: t('analysis'),
        claims: Array.from(document.querySelectorAll('#claims li')).map((n) => n.textContent),
        issues: Array.from(document.querySelectorAll('#issues li')).map((n) => n.textContent),
        sources: Array.from(document.querySelectorAll('#sources li a')).map((n) => ({
          text: n.textContent, href: n.getAttribute('href')
        })),
        sourcesMeta: t('sourcesMeta'),
        notCovered: Array.from(document.querySelectorAll('#notCovered li')).map((n) => n.textContent),
        supported: Array.from(document.querySelectorAll('#supported li')).map((n) => n.textContent),
        challenged: Array.from(document.querySelectorAll('#challenged li')).map((n) => n.textContent),
      };
    })()`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFileSync } = await import('node:fs');
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(SHOT_RESULT, Buffer.from(shot.data, 'base64'));
    console.log('结果页截图：', SHOT_RESULT);
    return info;
  } finally {
    cdp.close();
  }
}

async function main(): Promise<void> {
  console.log('=== claim-check 端到端真机验证 ===\n');

  console.log('[1/6] 启动浏览器');
  await launchBrowser();

  console.log('\n[2/6] 装载扩展');
  await loadExtension();

  console.log('\n[3/6] 注入 LLM 配置');
  await injectConfig();

  console.log('\n[4/6] 真实划词 + 右键');
  const server = await startPageServer();
  console.log('  测试页：', server.url);
  const selected = await selectAndRightClick(server.url);

  console.log('\n[5/6] 验右键菜单项 + 触发分析');
  // 菜单验证和派发连着做，中间不留空档——SW 空闲 30 秒就会睡
  await verifyMenu();
  await dispatchMenuClick(selected, server.url);

  console.log('\n[6/6] 读结果页');
  const info = await readResultPage();
  server.close();

  console.log('\n=== 结果页内容 ===');
  if (!info) {
    problems.push('结果页没开出来');
  } else {
    console.log('原文回显：', String(info.quote).slice(0, 60));
    console.log('出处：', String(info.quoteSrc).slice(0, 80));
    console.log('结论：', info.verdict, '|', info.verdictText);
    console.log('把握：', info.verdictConf);
    console.log('主张条数：', info.claims.length, '逻辑问题条数：', info.issues.length);
    console.log('资料条数：', info.sources.length);
    console.log('资料来源说明：', info.sourcesMeta);
    console.log('分析正文：', String(info.analysis).slice(0, 400));

    check(String(info.quote).length > 10, '结果页回显了划选原文');
    check(
      ['大概率成立', '可能有误', '证据不足，无法判定'].includes(String(info.verdict).trim()),
      '结论是三档之一',
      String(info.verdict),
    );
    check(String(info.verdictText).length > 0, '结论有人话说明');
    check(String(info.analysis).length > 30, '有分析正文');
    check(info.issues.length > 0, '列出了可能的逻辑问题');
    check(info.sources.length > 0, '深度搜索取到了资料', String(info.sources.length) + ' 条');
    check(
      info.sources.every((s: any) => /^https?:\/\//.test(s.href ?? '')),
      '资料链接都是 http(s)',
    );
    check(
      info.sources.every((s: any) => !/^https?:\/\/.*(minimax|api\.|\/v1\/)/.test(s.href ?? '')),
      '资料链接不指向 LLM 接口',
    );
  }

  console.log('\n=== 汇总 ===');
  if (problems.length) {
    console.error('失败 ' + problems.length + ' 项：');
    for (const p of problems) console.error('  x ' + p);
    process.exit(1);
  }
  console.log('全部通过 ✓');
  console.log('结果页截图：' + SHOT_RESULT);
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
