/**
 * 用 GitHub API 建仓库。
 *
 * 为什么需要它：GitHub 的用户账号**不支持「push 自动建仓」**
 * （那是组织账号才有的功能），所以仓库得先通过 API 建出来。
 * 本机没有 gh CLI，token 从 git 的凭据助手（Windows 凭据管理器）里取。
 *
 * token 全程只在内存里，不打印、不写盘、不进命令行参数。
 *
 * 用法：
 *   npx tsx scripts/github-create-repo.ts <仓库名> "<描述>"
 */
import { spawn } from 'node:child_process';

const HOST = 'github.com';

/** 向 `git credential fill` 喂一份凭据请求，把 token 拿回来。 */
function getToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git credential fill 退出码 ${code}：${err.trim()}`));
        return;
      }
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^password=(.*)$/);
        if (m && m[1]) {
          resolve(m[1].trim());
          return;
        }
      }
      reject(new Error('凭据助手里没有 github.com 的 token'));
    });
    // 必须以 ASCII 字节喂：PowerShell 管道会用 UTF-16，
    // git 会读到一堆带 NUL 的字符，报「missing protocol field」。
    p.stdin.write(Buffer.from(`protocol=https\nhost=${HOST}\n\n`, 'ascii'));
    p.stdin.end();
  });
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claim-check-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} -> HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  return data;
}

async function main(): Promise<void> {
  const name = process.argv[2];
  const description = process.argv[3] ?? '';
  if (!name) throw new Error('用法: github-create-repo.ts <仓库名> "<描述>"');

  const token = await getToken();
  console.log('已从凭据助手取到 token（长度 ' + token.length + '，不显示内容）');

  const me = await api(token, 'GET', '/user');
  console.log('身份：' + me.login + ' <' + (me.email ?? '（未公开邮箱）') + '>');

  // 已经存在就直接用
  try {
    const repo = await api(token, 'GET', `/repos/${me.login}/${name}`);
    console.log(`仓库已存在：${repo.full_name}（private=${repo.private}）`);
    return;
  } catch {
    /* 不存在，继续建 */
  }

  const created = await api(token, 'POST', '/user/repos', {
    name,
    description,
    private: false,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    license_template: 'mit',
  });
  console.log('已创建公开仓库：' + created.full_name + '  ' + created.html_url);
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
