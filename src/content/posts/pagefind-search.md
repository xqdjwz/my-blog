---
title: 给静态博客加中文搜索：为什么选 Pagefind
description: 客户端搜索的三条路线对比，以及 Pagefind 在中文分词、分类筛选和构建集成上的实际表现。
date: 2026-11-24
category: 前端工程
categorySlug: frontend
tags: [Pagefind, 搜索, 中文分词]
cover: /images/cover-search.jpg
---

静态博客没有数据库，搜索这件事就成了要单独解决的问题。常见的路线有三条，各自的代价差别很大。

## 三条路线

**一、Google 站内搜索**。最省事，挂个表单就行。但结果是搜索结果页跳转到外站，样式完全不受控，而且国内用户不一定能访问。

**二、自建索引 + Fuse.js**。构建时把所有文章导出成 JSON，前端加载后本地模糊匹配。问题出在中文：Fuse.js 默认按空格切词，中文没有空格，整句变成一个 token，搜「付费墙」几乎不可能命中。要处理就得自己接分词库，包体积会明显上涨。

**三、Pagefind**。构建完成后再扫一遍产物，生成分片索引，浏览器按需加载。它内置了对中日韩文本的分词支持，索引体积小，还能直接做分类筛选。

我选了第三条。

## 它到底怎么工作

Pagefind 不读你的源码，它读的是构建产物 HTML。所以你不需要维护一份独立的文章清单——`astro build` 产出的页面就是它的输入，`pagefind --site dist` 扫完之后索引就生成在 `dist/pagefind/` 目录里。

这也意味着一个细节：**只有带 `data-pagefind-body` 标记的区域会被索引**。我在文章详情页的正文容器上加了这一个属性，于是导航栏、页脚、相邻文章推荐都不会污染搜索结果。

## 中文分词与筛选

中文搜索的难点是查询词和文档之间没有天然的边界。Pagefind 的处理方式是对中文按字和词组做多粒度切分，结果是「付费墙」能命中「付费」和「墙」，同时完整词组命中时排序更高。实测下来比 Fuse.js 的默认行为好得多，也比自己接 jieba 省事。

分类筛选用的是 meta 标签：

```html
<meta data-pagefind-filter="category" content="前端工程" />
```

构建时把每篇文章的 `category` 写进这个标签，Pagefind 会自动聚合成筛选维度，前端拿到 `pagefind.filters()` 后渲染成按钮组，搜索时把选中值传进 `search(query, { filters })`。

## 前端那一小段代码

页面本身不需要任何框架，一段原生脚本就够：

```js
const pagefind = await import('/pagefind/pagefind.js');
await pagefind.init();

const result = await pagefind.search('付费墙', {
  filters: { category: ['技术实践'] },
});
const items = await Promise.all(result.results.slice(0, 20).map((r) => r.data()));
```

`data()` 返回的是摘要片段和元信息，不是全文——这是索引小的原因，也是它快的原因。

## 两个注意点

**开发模式下搜不到东西。** `pagefind` 只处理构建产物，`astro dev` 里没有 `dist` 目录，索引自然不存在。我的做法是在搜索页捕获 `import` 失败，提示用户先构建再用 `preview` 预览，而不是让页面白屏。

**搜索索引要跟着构建一起更新。** 把 `pagefind --site dist` 串在 `build` 脚本后面，Cloudflare Pages 每次构建都会重新生成。如果手工上传索引，很容易出现文章更新了但搜索结果还是旧的。

## 结果是怎样

目前这个博客五十来篇文章，索引体积不到 300KB，分片加载后单次搜索的首屏请求不到 50KB。搜索响应基本是即时的，输入停顿 220 毫秒后触发查询，没有感知到延迟。

对比之前用 Fuse.js 的版本，最大的改善不是速度，而是「搜得到」——中文关键词终于不用猜着写了。
