/**
 * 真机验证用的 CDP 小工具。
 *
 * 为什么不用 chrome-devtools-mcp：它要 MCP server 带 --categoryExtensions 启动，
 * 本机没有。Node 自带全局 WebSocket，直接说 CDP 协议一样能驱动真浏览器。
 */

export const HOST = process.env.CDP_HOST ?? '127.0.0.1';
export const PORT = process.env.CDP_PORT ?? '9345';

export interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export async function httpJson(path: string): Promise<any> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

export async function listTargets(): Promise<Target[]> {
  return (await httpJson('/json/list')) as Target[];
}

/**
 * 找出**某个扩展自己的** service worker。
 *
 * 不能只按 `type === 'service_worker'` 过滤：Chrome 自带好几个内置扩展
 * （automation、component extension 之类）也有 SW 目标，
 * 抓到它们的话 `chrome.storage` / `chrome.contextMenus` 全是 undefined，
 * 报错还长得像「扩展没装」。
 */
export function pickExtensionSw(targets: Target[], extensionId: string): Target | undefined {
  return targets.find(
    (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${extensionId}/`),
  );
}

/** 浏览器级 CDP 连接（Extensions 域要走这个）。 */
export async function browserWsUrl(): Promise<string> {
  const v = await httpJson('/json/version');
  if (!v?.webSocketDebuggerUrl) throw new Error('拿不到 browser websocket url');
  return v.webSocketDebuggerUrl;
}

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  consoleEvents: any[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.consoleEvents.push(msg.params);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleEvents.push({ source: 'exception', ...msg.params.exceptionDetails });
      } else if (msg.method === 'Log.entryAdded') {
        this.consoleEvents.push({ source: 'log', ...msg.params.entry });
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    }
    return r.result?.value;
  }

  drainConsole(): any[] {
    const out = this.consoleEvents;
    this.consoleEvents = [];
    return out;
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 等某个条件成立（轮询）。
 *
 * **返回回调的值**，不是布尔值——早期版本返回 `true`，
 * 结果「等到了什么内容」被丢掉了，只剩一个 true，
 * 看起来像成功，其实什么都没验到。
 * 超时返回 null（与「回调返回了空字符串」区分得开）。
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20000,
  everyMs = 400,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await sleep(everyMs);
  }
  return null;
}
