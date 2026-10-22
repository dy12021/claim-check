/**
 * 构建产物闸门：manifest 引用的每个路径都要在 dist 里真实存在，
 * 并且权限面不能超出设计意图。
 *
 * 为什么需要它：单测全绿也救不了「manifest 忘了声明某个权限」
 * 「manifest 引用的图标没打进去」这种**接线错误**——
 * 模块单测测的是孤立函数，测不到扩展装上去以后还能不能用。
 *
 * 权限面在这里是**硬红线**：这个扩展的整个隐私承诺建立在
 * 「不读网页内容」上。多一个 `tabs` 或 `scripting` 权限，
 * 承诺就不成立了，所以宁可让构建失败。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const problems: string[] = [];

function readManifest(): any {
  const p = join(DIST, 'manifest.json');
  if (!existsSync(p)) {
    console.error('dist/manifest.json 不存在——先跑 npm run build');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 递归收集 dist 下的所有文件。 */
function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

const m = readManifest();

console.log('=== manifest 关键字段 ===');
console.log('manifest_version:', m.manifest_version);
console.log('name           :', m.name);
console.log('version        :', m.version);
console.log('permissions    :', JSON.stringify(m.permissions ?? []));
console.log('host_permissions:', JSON.stringify(m.host_permissions ?? []));

if (m.manifest_version !== 3) problems.push('manifest_version 必须是 3');

// ── 权限红线 ────────────────────────────────────────────────
const ALLOWED_PERMISSIONS = ['storage', 'contextMenus'];
for (const p of m.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.includes(p)) {
    problems.push(`manifest 多余权限：${p}（只允许 ${ALLOWED_PERMISSIONS.join(' / ')}）`);
  }
}
for (const p of ['tabs', 'activeTab', 'scripting', 'webRequest', 'cookies', 'history', 'bookmarks']) {
  if ((m.permissions ?? []).includes(p)) {
    problems.push(`manifest 含高危权限 ${p}——这个扩展承诺「不读网页内容」`);
  }
}

// ── 没有 content script（划词靠 contextMenus 的 selectionText）──
if (Array.isArray(m.content_scripts) && m.content_scripts.length > 0) {
  problems.push('manifest 不该有 content_scripts——划词只用 contextMenus 的 selectionText');
}

// ── host 权限只能是搜索引擎 ────────────────────────────────
const hosts: string[] = m.host_permissions ?? [];
if (!hosts.some((h) => h.includes('bing.com'))) {
  problems.push('host_permissions 里没有搜索引擎——深度搜索会失败');
}
for (const h of hosts) {
  if (!/bing\.com/.test(h)) {
    problems.push(`host_permissions 里有非搜索引擎的域名：${h}`);
  }
}

// ── 引用路径必须在 dist 里存在 ──────────────────────────────
const refs: string[] = [];
if (m.background?.service_worker) refs.push(m.background.service_worker);
if (m.action?.default_popup) refs.push(m.action.default_popup);
for (const k of Object.keys(m.icons ?? {})) refs.push(m.icons[k]);

console.log('\n=== 引用路径检查 ===');
for (const r of refs) {
  const p = join(DIST, r);
  const ok = existsSync(p);
  console.log((ok ? 'OK   ' : 'MISS ') + r);
  if (!ok) problems.push('manifest 引用的文件不存在：' + r);
}

// ── service worker 不能是 .ts 源码路径 ───────────────────────
if (m.background?.service_worker?.endsWith('.ts')) {
  problems.push('background.service_worker 指向 .ts 源码（CRXJS 应重写成 assets/*.js）');
}

// ── 结果页必须在（右键菜单的落地页）─────────────────────────
const resultHtml = listFiles(DIST).filter((f) => f.endsWith('.html'));
const hasResult = resultHtml.some((f) => relative(DIST, f).includes('result'));
if (!hasResult) problems.push('dist 里找不到结果页 HTML——右键后无处可去');

// ── MV3：不能有远程代码 ────────────────────────────────────
const manifestText = readFileSync(join(DIST, 'manifest.json'), 'utf8');
if (/content_security_policy/.test(manifestText)) {
  problems.push('MV3 不允许自定义宽松 CSP，删掉 content_security_policy');
}

console.log('\n=== 产物内容检查 ===');
const jsFiles = listFiles(DIST).filter((f) => f.endsWith('.js'));
console.log('dist 里的 js 文件：', jsFiles.length);
for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(DIST, f);
  if (/\beval\s*\(/.test(src)) problems.push(`${rel} 里出现 eval()`);
  if (/new\s+Function\s*\(/.test(src)) problems.push(`${rel} 里出现 new Function()`);
  if (/https?:\/\/[^\s"']*\/[^\s"']*\.js\b/.test(src) && /importScripts/.test(src)) {
    problems.push(`${rel} 疑似远程 importScripts`);
  }
}

console.log('\n=== 结果 ===');
if (problems.length) {
  console.error('发现 ' + problems.length + ' 个问题:');
  for (const p of problems) console.error('  x ' + p);
  process.exit(1);
}
console.log('全部通过 ✓');
