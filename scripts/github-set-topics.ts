/**
 * 给仓库打 topics（GitHub 页面上的标签），方便被人搜到。
 * token 同样只从凭据助手取，不落盘。
 *
 * 用法：npx tsx scripts/github-set-topics.ts <仓库名> "topic1,topic2,..."
 */
import { spawn } from 'node:child_process';

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
        if (m && m[1]) { resolve(m[1].trim()); return; }
      }
      reject(new Error('凭据助手里没有 github.com 的 token'));
    });
    // 必须以 ASCII 字节喂：PowerShell 管道会用 UTF-16，git 会读到一堆 NUL
    p.stdin.write(Buffer.from('protocol=https\nhost=github.com\n\n', 'ascii'));
    p.stdin.end();
  });
}

async function main(): Promise<void> {
  const name = process.argv[2];
  const topics = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !topics.length) throw new Error('用法: github-set-topics.ts <仓库名> "t1,t2"');

  const token = await getToken();
  const res = await fetch(`https://api.github.com/repos/dy12021/${name}/topics`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'publisher',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ names: topics }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  console.log(`${name} topics = ${JSON.stringify(JSON.parse(text).names)}`);
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
