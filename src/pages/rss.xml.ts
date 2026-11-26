import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getAllPosts, postPath, postSummary } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getAllPosts();

  return rss({
    title: '创新博客',
    description: '记录技术、产品与创作的长文。',
    site: context.site ?? 'https://blog.example.com',
    items: posts.map((post) => ({
      title: post.data.title,
      description: postSummary(post, 160),
      pubDate: post.data.date,
      link: `/posts/${postPath(post)}/`,
      categories: [post.data.category, ...post.data.tags],
    })),
    customData: '<language>zh-cn</language>',
  });
};
