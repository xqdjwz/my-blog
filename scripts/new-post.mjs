/**
 * 新建一篇文章的骨架文件。
 *
 *   node scripts/new-post.mjs "文章标题" "分类名"
 *   node scripts/new-post.mjs "文章标题" "分类名" --paid
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const postsDir = join(root, 'src/content/posts');

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const [title, category = '未分类'] = args;
const paid = process.argv.includes('--paid');

if (!title) {
  console.error('用法：node scripts/new-post.mjs "文章标题" "分类名" [--paid]');
  process.exit(1);
}

const date = new Date();
const ymd = date.toISOString().slice(0, 10);

const asciiSlug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const slug = asciiSlug || `post-${ymd}`;
const filePath = join(postsDir, `${slug}.md`);

if (existsSync(filePath)) {
  console.error(`文件已存在：${filePath}`);
  process.exit(1);
}

mkdirSync(postsDir, { recursive: true });

const frontmatter = [
  '---',
  `title: ${title}`,
  'description: 一句话说明这篇文章讲什么，会出现在列表页和搜索结果里。',
  `date: ${ymd}`,
  `category: ${category}`,
  'tags: []',
  '---',
];

if (paid) {
  frontmatter.splice(frontmatter.length - 1, 0, 'paid: true', 'price: 9.9');
}

const body = [
  '',
  '开头两三段写在这里，这段会作为免费预览直接出现在页面上。',
  '',
  paid ? '<!--more-->' + '\n\n<!-- 上面是免费预览，下面是付费正文 -->' : '',
  '',
  '## 小标题',
  '',
  '正文内容。',
  '',
].join('\n');

writeFileSync(filePath, `${frontmatter.join('\n')}\n${body}`, 'utf8');

console.log(`已创建：${filePath}`);
if (paid) console.log('提示：付费文章写完后执行 npm run sync:paid 把付费正文同步到 D1。');
