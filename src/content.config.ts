import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    /** 分类名，中文可直接写，路由 slug 自动转拼音 */
    category: z.string().default('未分类'),
    /** 需要自定义分类 URL 时填，例如 "frontend" */
    categorySlug: z.string().optional(),
    tags: z.array(z.string()).default([]),
    /** 封面图，放在 public/images/ 下，写 /images/xxx.jpg */
    cover: z.string().optional(),
    /** 是否付费文章（正文中用 <!--more--> 分割免费预览与付费部分） */
    paid: z.boolean().default(false),
    price: z.number().default(0),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
  }),
});

export const collections = { posts };
