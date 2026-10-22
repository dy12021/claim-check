/**
 * 敏感数据 / 本机路径扫描。
 *
 * **用途**：开源前把仓库里不该出现的东西挑出来——
 * 本机绝对路径、API Key、个人邮箱、私钥块、以及截图里的个性化内容。
 *
 * **为什么单独写一个脚本而不是靠人肉 grep**：
 * 规则一旦写在代码里，就每次提交都能自动跑；
 * 而「本机绝对路径」这种恰恰是最容易在脚本里手滑写进去的东西
 * （当时只是图省事写死一个绝对路径，开源就成了泄露）。
 *
 * 用法：
 *   npx tsx scripts/scan-sensitive.ts
 *   npx tsx scripts/scan-sensitive.ts --root=<另一个仓库路径>
 *
 * 退出码：0 = 干净；1 = 有发现。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** 解析 --root= 参数。 */
function argRoot(): string {
  const arg = process.argv.find((a) => a.startsWith('--root='));
  if (!arg) return REPO;
  const v = arg.slice('--root='.length);
  return v.endsWith('"') ? v.slice(1, -1) : v;
}

const ROOT = argRoot();

/** 跳过这些目录：依赖、构建产物、版本库内部。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.vite', '.turbo', 'out',
]);

/** 文本类扩展名。只有这些才做正则扫描。 */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.markdown',
  '.txt', '.yml', '.yaml', '.toml', '.html', '.css', '.scss', '.xml', '.py',
  '.sh', '.cmd', '.ps1', '.bat', '.env', '.gitignore', '.editorconfig',
]);

/** 图片文件：不扫内容，但要列出来提醒人工过目。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

/**
 * 规则表。每条规则一个名字 + 一个正则。
 *
 * 正则都尽量「窄」——宁可漏掉一点，也不要满屏误报把真问题淹掉。
 */
const RULES: { name: string; re: RegExp; note: string; ignore?: RegExp; skipFiles?: RegExp }[] = [
  {
    name: 'windows-abs-path',
    re: /[A-Za-z]:(?:\\{1,2})[A-Za-z0-9_$]/g,
    note: '本机绝对路径（开源会暴露本机目录结构与用户名）',
  },
  {
    name: 'unc-path',
    // 主机名至少两个字符，避免把源码里的正则转义（\\s\\S）当成 UNC 路径
    re: /\\\\[A-Za-z0-9][A-Za-z0-9_.-]{1,}\\[A-Za-z0-9_.-]+\\/g,
    note: 'UNC 网络路径',
  },
  {
    name: 'posix-home-path',
    re: /(?:^|[\s"'`(=:])\/(?:home|Users|root)\/[A-Za-z0-9_.-]+/gm,
    note: 'POSIX 用户目录路径',
  },
  {
    name: 'openai-style-key',
    re: /\bsk-[A-Za-z0-9_-]{20,}/g,
    note: 'OpenAI 风格 API Key',
  },
  {
    name: 'anthropic-style-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    note: 'Anthropic 风格 API Key',
  },
  {
    name: 'jwt-token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    note: 'JWT 令牌（很多服务商的 API Key 就是这个形状）',
  },
  {
    name: 'aws-access-key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    note: 'AWS Access Key',
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    note: '私钥文件内容',
  },
  {
    name: 'bearer-literal',
    re: /\bBearer\s+[A-Za-z0-9._-]{24,}/g,
    note: '硬编码的 Bearer 令牌',
  },
  {
    name: 'email-address',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    note: '邮箱地址（可能是个人邮箱）',
  },
  {
    name: 'long-opaque-secret',
    re: /(?<![A-Za-z0-9])[A-Za-z0-9_+/-]{56,}={0,2}(?![A-Za-z0-9])/g,
    note: '很长的不透明字符串（可能是被写死的凭据）',
    // npm 的完整性哈希长得就像密钥，但它不是
    ignore: /^(?:sha(?:1|224|256|384|512)-)/,
    // 锁文件里全是长 URL 和哈希，这条规则在它身上只会刷屏。
    // 锁文件里若真藏了 Key，上面那几条针对性规则照样能抓到。
    skipFiles: /(^|[\\/])package-lock\.json$/,
  },
];

/** 允许出现某些字面量的文件（每行一条，按子串匹配）。 */
function loadAllowlist(): string[] {
  const p = join(ROOT, 'scripts', 'sensitive-allow.txt');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

const ALLOW = loadAllowlist();

/** 递归收集要扫的文件。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  note: string;
  sample: string;
}

const findings: Finding[] = [];
const images: string[] = [];
const scanned: string[] = [];

for (const file of collect(ROOT)) {
  const rel = relative(ROOT, file);
  const ext = extname(file).toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    images.push(rel);
    continue;
  }
  if (!TEXT_EXT.has(ext) && !['.gitignore', '.editorconfig', 'LICENSE'].includes(ext)) {
    continue;
  }
  // 单文件超过 2 MB 不扫（多半是生成的产物）
  if (statSync(file).size > 2 * 1024 * 1024) continue;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned.push(rel);

  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.skipFiles?.test(rel)) continue;
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const sample = m[0].trim();
        if (!sample) continue;
        if (rule.ignore?.test(sample)) continue;
        if (ALLOW.some((a) => sample.includes(a) || line.includes(a))) continue;
        findings.push({
          file: rel,
          line: i + 1,
          rule: rule.name,
          note: rule.note,
          sample: sample.length > 90 ? sample.slice(0, 90) + '...' : sample,
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  });
}

console.log('扫描根目录：' + ROOT);
console.log('已扫描文本文件：' + scanned.length + ' 个');

if (images.length) {
  console.log('\n=== 图片文件（不自动扫描内容，需人工确认无个人信息）===');
  for (const i of images.sort()) console.log('  ? ' + i);
}

console.log('\n=== 命中 ===');
if (!findings.length) {
  console.log('没有发现敏感数据或本机路径 ✓');
} else {
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.note}`);
    console.log(`      ${f.sample}`);
  }
  console.log(`\n共 ${findings.length} 处需要处理。`);
  console.log('确实是误报的，写进 scripts/sensitive-allow.txt（每行一条字面量）。');
  process.exit(1);
}
