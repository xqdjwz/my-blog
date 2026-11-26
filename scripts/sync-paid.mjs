/**
 * 把付费文章的「付费部分」同步到 Cloudflare D1。
 *
 * 用法：
 *   node scripts/sync-paid.mjs            # 只生成本地 SQL 文件，供检查
 *   node scripts/sync-paid.mjs --remote   # 生成并直接导入线上 D1
 *   node scripts/sync-paid.mjs --local    # 导入本地 wrangler dev 的 D1
 *
 * 站点只渲染 <!--more--> 之前的免费预览，这里的产物才是付费正文的唯一来源。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import { renderMarkdown, splitBody } from '../src/lib/markdown.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const postsDir = join(root, 'src/content/posts');
const workerDir = join(root, 'worker');
const sqlPath = join(workerDir, 'paid-articles.sql');
const jsonPath = join(workerDir, 'paid-articles.json');

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

/** slug 与站点路由保持一致：文件路径去掉 .md */
function toSlug(filePath) {
  return relative(postsDir, filePath)
    .split('\\')
    .join('/')
    .replace(/\.md$/, '');
}

const files = readdirSync(postsDir, { recursive: true })
  .filter((file) => typeof file === 'string' && file.endsWith('.md'))
  .map((file) => join(postsDir, file));

const rows = [];
const problems = [];

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const { data, content } = matter(raw);
  if (!data.paid) continue;

  const { preview, locked } = splitBody(content);
  if (!locked.trim()) {
    problems.push(`${relative(root, file)}：标记了 paid: true 但正文里没有 <!--more--> 分隔符`);
    continue;
  }
  if (!preview.trim()) {
    problems.push(`${relative(root, file)}：<!--more--> 之前没有任何免费预览内容`);
  }

  rows.push({
    slug: toSlug(file),
    title: data.title ?? toSlug(file),
    price: Number(data.price ?? 0),
    updatedAt: (data.updated ?? data.date ?? new Date()).toISOString?.() ?? String(data.date ?? ''),
    html: renderMarkdown(locked).trim(),
    // 只用于本地检查，不写入数据库
    previewLength: preview.length,
  });
}

if (problems.length > 0) {
  console.error('\n发现需要处理的问题：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exitCode = 1;
}

if (rows.length === 0) {
  console.log('没有找到付费文章（frontmatter 里 paid: true），跳过。');
  process.exit(process.exitCode ?? 0);
}

const statements = [
  '-- 由 scripts/sync-paid.mjs 自动生成，请勿手工编辑',
  `-- 生成时间：${new Date().toISOString()}`,
  '',
  ...rows.map(
    (row) => `INSERT INTO articles (slug, title, html, price, updated_at)
VALUES ('${escapeSql(row.slug)}', '${escapeSql(row.title)}', '${escapeSql(row.html)}', ${row.price}, '${escapeSql(row.updatedAt)}')
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  html = excluded.html,
  price = excluded.price,
  updated_at = excluded.updated_at;`,
  ),
  '',
];

writeFileSync(sqlPath, statements.join('\n'), 'utf8');
writeFileSync(
  jsonPath,
  JSON.stringify(rows.map(({ slug, title, price, updatedAt, previewLength }) => ({ slug, title, price, updatedAt, previewLength })), null, 2),
  'utf8',
);

console.log(`已生成 ${rows.length} 篇付费文章的 SQL：${relative(root, sqlPath)}`);
for (const row of rows) {
  console.log(`  · ${row.slug}（${row.title}）· 付费正文 ${row.html.length} 字符`);
}

if (remote || local) {
  const mode = remote ? '--remote' : '--local';
  console.log(`\n正在导入 ${mode} 模式的 D1…`);
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'innovate-blog', mode, `--file=${sqlPath}`],
    { cwd: workerDir, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    console.error('\n导入失败。请确认已完成 npm --prefix worker install，且已登录 wrangler。');
    process.exit(1);
  }
  console.log('\n导入完成。');
} else {
  console.log('\n下一步：npm run sync:paid:remote   （或先在 wrangler dev 本地环境用 --local 验证）');
}
