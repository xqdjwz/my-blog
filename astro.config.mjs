import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 部署后把 site 改成你的正式域名，RSS、sitemap、分享链接都依赖它
export default defineConfig({
  site: 'https://blog.example.com',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap()],
});
