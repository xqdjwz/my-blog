import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

/**
 * 全站统一的 Markdown 渲染管线。
 * 站点构建（.astro 页面）与付费内容同步脚本（scripts/sync-paid.mjs）共用同一份，
 * 保证「免费预览」和「付费正文」渲染出来的样式完全一致。
 */

/** 免费预览与付费正文的分割标记 */
export const PAYWALL_MARKER = '<!--more-->';

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : '';
      if (language) return hljs.highlight(code, { language }).value;
      return hljs.highlightAuto(code).value;
    },
  }),
);

marked.setOptions({ gfm: true, breaks: false });

/** 把正文按 <!--more--> 切成免费预览 / 付费正文 */
export function splitBody(body = '') {
  const index = body.indexOf(PAYWALL_MARKER);
  if (index === -1) return { preview: body, locked: '' };
  return {
    preview: body.slice(0, index),
    locked: body.slice(index + PAYWALL_MARKER.length),
  };
}

export function renderMarkdown(markdown = '') {
  return marked.parse(markdown);
}

/** 从 markdown 里抽纯文本摘要，用于列表页和 meta description */
export function extractText(markdown = '', maxLength = 160) {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}
