/**
 * 站点级配置。
 * PUBLIC_BLOG_API 必须指向部署好的 Worker 地址，否则付费文章无法解锁：
 *   本地开发 → .env 里写 http://localhost:8787
 *   线上部署 → Cloudflare Pages 的构建环境变量里写 https://api.你的域名
 */
export const BLOG_API =
  import.meta.env.PUBLIC_BLOG_API || (import.meta.env.DEV ? 'http://localhost:8787' : '');
