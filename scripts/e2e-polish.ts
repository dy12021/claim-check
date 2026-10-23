/**
 * 真机验证：「美化表达」这条链路。
 *
 * 验证的是**用户真的会走的路径**，不是单测能覆盖的接线：
 *   1. 装扩展（CDP Extensions.loadUnpacked）
 *   2. 注入 LLM 配置（Key 只写进去，不打印）
 *   3. 打开测试页，**用真实鼠标事件划词**（JS 设的 selection 右键菜单拿不到）
 *   4. 验「美化表达」菜单项注册成功
 *   5. 派发 contextMenus.onClicked（和真点菜单项走同一个处理函数）
 *   6. 结果页开出来，读它的 DOM 逐项断言
 *
 * 两个场景：
 *   A. 划选页面上别人写的情绪化评论
 *   B. **在输入框（textarea）里划选自己写的草稿**——这是「发表评论之前美化自己说的内容」
 *
 * 用法：
 *   $env:CLAIM_CHECK_LLM_CONFIG = '<path to config.toml>'
 *   npx tsx scripts/e2e-polish.ts
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, listTargets, browserWsUrl, sleep, waitFor, httpJson, PORT } from './cdp-lib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
/** 端口从 cdp-lib 取——**必须一致**：它内部的 httpJson/listTargets 也用这个端口。 */
const BROWSER = process.env.BROWSER ?? 'chrome';
const LLM_CONFIG = process.env.CLAIM_CHECK_LLM_CONFIG ?? '';

const SHOT_DIR = join(tmpdir(), 'claim-check-e2e-polish');

const problems: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  if (!ok) problems.push(label + (detail ? '  — ' + detail : ''));
}

/** 页面上别人写的情绪化评论。 */
const EMOTIONAL = '这也太离谱了吧！某群体的人真的别出来恶心人了，滚出去！';

/** 用户自己正在写的草稿（放进 textarea，模拟评论区输入框）。 */
const DRAFT = '这作者真的一坨屎，完全没考虑过实际情况，纯属浪费时间';

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>美化测试页</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 0; padding: 60px; background: #fff; color: #222; }
  #emotional { font-size: 18px; white-space: nowrap; }
  #draft { width: 640px; height: 90px; font-size: 16px; font-family: inherit; margin-top: 40px; }
</style></head>
<body>
  <div id="emotional">${EMOTIONAL}</div>
  <textarea id="draft">${DRAFT}</textarea>
</body></html>`;

function startPageServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
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
  const profile = join(tmpdir(), 'claim-check-e2e-polish-' + Date.now());
  mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ];
  console.log(`启动 ${BROWSER}（CDP ${PORT}），全新 profile：${profile}`);
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

let EXT_ID = '';

async function loadExtension(): Promise<void> {
  const cdp = await Cdp.connect(await browserWsUrl());
  try {
    const res = await cdp.send('Extensions.loadUnpacked', { path: DIST });
    EXT_ID = String(res?.id ?? '');
    if (!EXT_ID) throw new Error('拿不到扩展 id');
    console.log('扩展已装载：', EXT_ID);
  } finally {
    cdp.close();
  }
  await sleep(1500);
}

async function findSw(): Promise<string | null> {
  const targets = await listTargets();
  const sw = targets.find(
    (t) => t.type === 'service_worker' && EXT_ID && t.url.includes(`chrome-extension://${EXT_ID}/`),
  );
  return sw?.webSocketDebuggerUrl ?? null;
}

/** 叫醒睡着的 service worker（打开扩展自己的 popup 页即可）。 */
async function wakeSw(): Promise<string | null> {
  let sw = await findSw();
  if (sw) return sw;
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
  if (!LLM_CONFIG) throw new Error('要设 CLAIM_CHECK_LLM_CONFIG 指向 llm 配置');
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
      return JSON.stringify({ saved: !!back.settings, model: back.settings?.llm?.model });
    })()`);
    console.log('LLM 配置注入：', out);
  } finally {
    cdp.close();
  }
}

/**
 * 验「美化表达」菜单项注册成功。
 *
 * `chrome.contextMenus.update(id, ...)` 在 id 不存在时会回
 * "Cannot find menu item"——这是唯一能证明「菜单项真的注册了」的办法
 * （Chrome 没有列举菜单项的 API）。
 */
async function verifyMenu(): Promise<void> {
  const ws = await wakeSw();
  if (!ws) throw new Error('找不到扩展的 service worker');
  const cdp = await Cdp.connect(ws);
  try {
    const out = await cdp.eval(`new Promise((resolve) => {
      const id = 'claim-check-polish';
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
    check(!info.error, '「美化表达」菜单项注册成功（update 没报「找不到菜单」）', String(info.error));
    check(info.hasClickListener === true, 'onClicked 监听器已注册');
  } finally {
    cdp.close();
  }

  const src = readFileSync(join(REPO, 'src', 'bg', 'index.ts'), 'utf8');
  check(src.includes("title: '美化表达'"), '菜单标题是「美化表达」');
  check(src.includes("contexts: ['selection']"), '菜单上下文是 selection（只在划选时出现）');
}

/** 真实鼠标划选 + 右键。返回选中的文字。 */
async function selectAndRightClick(
  pageUrl: string,
  selector: string,
): Promise<{ selected: string; textarea: boolean }> {
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

    const rect = await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    if (!rect) throw new Error('页面上找不到 ' + selector);

    const startX = rect.x + 3;
    const startY = rect.y + rect.h / 2;
    const endX = rect.x + rect.w - 3;
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

    // textarea 里的选区不在 document selection 里，得读 selectionStart/End
    const inTextarea = selector === '#draft';
    const selected = inTextarea
      ? await cdp.eval(`(() => {
          const t = document.getElementById('draft');
          return t.value.slice(t.selectionStart, t.selectionEnd);
        })()`)
      : await cdp.eval(`window.getSelection().toString()`);
    console.log('浏览器里的选区：', JSON.stringify(String(selected).slice(0, 90)));
    check(String(selected).length > 5, '真实鼠标划选产生了选区', `长度 ${String(selected).length}`);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: endX, y: endY, button: 'right', buttons: 2, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: endX, y: endY, button: 'right', buttons: 0, clickCount: 1,
    });
    await sleep(800);
    return { selected: String(selected ?? ''), textarea: inTextarea };
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
        menuItemId: 'claim-check-polish',
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
async function readResultPage(tag: string): Promise<any> {
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

  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    // 美化要跑一会儿，轮询到「改写后的版本」出现为止
    const ready = await waitFor(async () => {
      const done = await cdp.eval(
        `(() => { const b = document.getElementById('polishRewriteBox'); return !!(b && !b.hidden); })()`,
      );
      return done === true ? true : null;
    }, 240000, 2000);
    check(ready === true, `[${tag}] 结果页在 4 分钟内给出了改写版本`);

    const info = await cdp.eval(`(() => {
      const t = (id) => (document.getElementById(id) || {}).textContent || '';
      const vis = (id) => { const n = document.getElementById(id); return !!(n && !n.hidden); };
      return {
        quote: t('quote'),
        subtitle: t('subtitle'),
        status: t('status'),
        statusVisible: vis('status'),
        meaning: t('polishMeaning'),
        rewritten: t('polishRewritten'),
        tone: t('polishTone'),
        emotional: Array.from(document.querySelectorAll('#polishEmotional li')).map((n) => n.textContent),
        copyBtn: t('copyBtn'),
        copyRewritten: t('copyRewritten'),
        // 正误分析的区块在美化档里必须不显示
        verdictVisible: vis('verdictBox'),
        analysisVisible: vis('analysisBox'),
        sourcesVisible: vis('sourcesBox'),
      };
    })()`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = join(SHOT_DIR, `result-${tag}.png`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('结果页截图：', file);
    return info;
  } finally {
    cdp.close();
  }
}

async function main(): Promise<void> {
  console.log('=== claim-check「美化表达」端到端真机验证 ===\n');

  console.log('[1/6] 启动浏览器');
  await launchBrowser();

  console.log('\n[2/6] 装载扩展');
  await loadExtension();

  console.log('\n[3/6] 注入 LLM 配置');
  await injectConfig();

  console.log('\n[4/6] 真实划词 + 右键（页面上的评论）');
  const server = await startPageServer();
  console.log('  测试页：', server.url);
  const a = await selectAndRightClick(server.url, '#emotional');

  console.log('\n[5/6] 验菜单项 + 派发「美化表达」');
  await verifyMenu();
  await dispatchMenuClick(a.selected, server.url);

  console.log('\n[6/6] 读结果页');
  const infoA = await readResultPage('A');
  if (infoA) {
    check(infoA.quote.includes('离谱'), '结果页显示了划选的原文');
    check(infoA.meaning.length > 5, '给出了「这段话实际在说什么」', infoA.meaning);
    check(infoA.rewritten.length > 5, '给出了「去掉情绪化表达后」的版本', infoA.rewritten);
    check(!infoA.rewritten.includes('离谱'), '改写版里情绪词「离谱」没了', infoA.rewritten);
    check(!infoA.rewritten.includes('恶心人'), '改写版里情绪词「恶心人」没了');
    // 立场与指向都要保留：不能把针对某群体的批评换成无关的泛指
    check(
      infoA.rewritten.includes('群体') && !infoA.rewritten.includes('相关人员'),
      '改写版保留了原意（没有把立场改掉）',
      infoA.rewritten,
    );
    // 不许补出原文没有的理由（「影响他人」是编的）
    check(
      !infoA.rewritten.includes('影响他人'),
      '改写版没有编造原文没有的理由',
      infoA.rewritten,
    );
    // 字形必须与原文一致（简体不能被转成繁体）
    check(
      !/[這說國學會時實現問題應該個們來過對開點與區]/.test(infoA.rewritten),
      '改写版没有把简体转成繁体',
      infoA.rewritten,
    );
    check(infoA.emotional.length > 0, '列出了情绪化用词', `${infoA.emotional.length} 条`);
    check(infoA.tone.length > 0, '给出了原文的情绪基调', infoA.tone);
    check(infoA.copyBtn.includes('复制改写后文本'), '顶部按钮是「复制改写后文本」', infoA.copyBtn);
    check(
      infoA.verdictVisible === false && infoA.analysisVisible === false && infoA.sourcesVisible === false,
      '正误分析的区块在美化档里都不显示',
    );
  }

  console.log('\n[附加] 在输入框里划选自己写的草稿');
  const b = await selectAndRightClick(server.url, '#draft');
  check(b.textarea === true, '第二次走的是 textarea 里的选区');
  await dispatchMenuClick(b.selected, server.url);
  const infoB = await readResultPage('B');
  if (infoB) {
    check(infoB.quote.includes('一坨屎'), '结果页显示的是草稿原文');
    check(infoB.rewritten.length > 5, '草稿给出了改写版本', infoB.rewritten);
    check(!infoB.rewritten.includes('一坨屎'), '改写版里骂人的词没了');
    // 批评本身要留着（观点不能被改没了）
    check(
      /考虑|考慮/.test(infoB.rewritten) && /时间|時間|浪费|浪費/.test(infoB.rewritten),
      '改写版保留了草稿的观点（没把批评改没了）',
      infoB.rewritten,
    );
    check(
      !/[這說國學會時實現問題應該個們來過對開點與區]/.test(infoB.rewritten),
      '改写版没有把简体转成繁体',
      infoB.rewritten,
    );
  }

  server.close();

  console.log('\n=== 结果 ===');
  if (problems.length) {
    console.log(`FAIL ${problems.length} 项：`);
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
