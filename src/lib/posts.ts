import { getCollection, type CollectionEntry } from 'astro:content';
import { pinyin } from 'pinyin-pro';
import { extractText, splitBody } from './markdown.mjs';

export type Post = CollectionEntry<'posts'>;

function asciiSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 分类名 → 路由 slug。中文自动转拼音：前端技术 → qian-duan-ji-shu */
export function categorySlug(name: string, override?: string) {
  if (override) return asciiSlug(override);
  const direct = asciiSlug(name);
  if (direct) return direct;
  const py = pinyin(name, { toneType: 'none', type: 'array', nonZh: 'removed' });
  return asciiSlug(py.join('-')) || 'category';
}

/** 文章路由 = 文件路径去掉扩展名 */
export function postPath(entry: Post) {
  return entry.id.replace(/\.md$/, '');
}

export async function getAllPosts() {
  const posts = await getCollection('posts');
  return posts
    .filter((post) => import.meta.env.DEV || !post.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function getCategories(posts: Post[]) {
  const map = new Map<string, { name: string; slug: string; count: number }>();
  for (const post of posts) {
    const name = post.data.category;
    const slug = categorySlug(name, post.data.categorySlug);
    const item = map.get(name) ?? { name, slug, count: 0 };
    item.count += 1;
    map.set(name, item);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 列表页摘要：优先用 frontmatter description，否则取正文纯文本 */
export function postSummary(post: Post, maxLength = 120) {
  const { description } = post.data;
  if (description) return description;
  const { preview } = splitBody(post.body ?? '');
  return extractText(preview, maxLength);
}

/** 阅读时长（中文按 400 字/分钟，英文按 200 词/分钟估算） */
export function readingTime(text = '') {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = text.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(cjk / 400 + words / 200));
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}
