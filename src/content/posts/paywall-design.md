---
title: 纯静态博客怎么做出「付费阅读」：三种方案的取舍与实现
description: 静态站没有后端，付费墙怎么防住？对比前端隐藏、内容加密、服务端取回三种方案，并给出我在这个博客上实际采用的一套完整实现。
date: 2026-11-23
category: 技术实践
categorySlug: practice
tags: [付费墙, Cloudflare Workers, D1]
cover: /images/cover-paywall.jpg
paid: true
price: 9.9
---

付费阅读是静态博客最别扭的需求：你希望网站没有后端，又希望内容能被「锁住」。这两个愿望天然冲突，因为静态站的本质就是把所有内容一次性发给所有人。

我见过太多博客用一种很脆的方式做付费墙——正文完整地写进 HTML，然后用 CSS 把后半段遮住，或者靠 JavaScript 判断登录态再决定是否显示。这两种做法在技术上等于没锁：打开浏览器的开发者工具，按一下 Ctrl+F 搜正文里的某个词，锁就不存在了。

<!--more-->

## 三种方案的取舍

先说清楚有哪些路可以走，再说我为什么选第三种。

### 方案一：前端遮罩

把全文渲染进页面，用一个遮罩层盖住付费部分，输入兑换码后 `display: none` 解开。

优点是零成本、实现最快。缺点是**内容根本没有保护**。HTML 就在那里，任何人不需要技术背景，右键查看源代码就能拿到全文。对定价几十块的深度文章来说，这等于白送。适合的场景只有一种：你并不真的在意被白嫖，付费只是一种「支持作者」的仪式感。

### 方案二：整页加密

构建时用 AES 把付费正文加密后塞进页面，读者输入密码后在前端解密。

这个方案的强度取决于密码怎么发。如果所有买家用同一个密码，密码一旦泄露就全站失效；如果一人一密，那密码本身就成了兑换码，你还是需要一个地方去校验它——又绕回后端了。另外密码学实现的细节很容易出错，比如密钥派生用了弱哈希、密文和 IV 放在一起又被缓存。

结论：除非你确定要做一个「共享密码 + 定期更换」的小圈子，否则不推荐。

### 方案三：付费内容不进站点，验证后再取回

这是我现在用的方案，核心思路一句话：**付费正文根本不存在于静态页面里**。

静态站点只渲染免费预览部分，付费部分单独存放在 Cloudflare D1 里；读者输入兑换码，前端把码发给 Worker 校验，通过后 Worker 签发一张短期令牌，前端带着令牌去取正文。

这样一来，未付费的人拿到的 HTML 里确实没有后半段内容，开发者工具里也搜不到。攻击面从「随便右键」变成了「必须猜兑换码」，而兑换码可以被限制次数、有效期和绑定文章。

代价是你必须维护一个小后端。但 Cloudflare Workers + D1 让这个代价低到可以接受：没有服务器要运维，没有数据库要备份，免费额度对个人博客绰绰有余。

## 数据表怎么设计

三张表就够了：

```sql
CREATE TABLE articles (
  slug TEXT PRIMARY KEY,      -- 与站点文章路由一致
  title TEXT NOT NULL,
  html TEXT NOT NULL,         -- 付费部分渲染后的 HTML
  updated_at TEXT NOT NULL
);

CREATE TABLE codes (
  code TEXT PRIMARY KEY,      -- 统一大写
  scope TEXT NOT NULL,        -- article / all
  slug TEXT,                  -- scope=article 时限定文章
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER DEFAULT 0
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  ok INTEGER,
  created_at TEXT NOT NULL
);
```

几个设计上的小心思：

- **`codes` 用 `scope` 区分单篇和全站通兑**，这样送朋友一张「全站年卡」和卖一篇单篇，用同一套表。
- **`attempts` 记录的是 IP 哈希而不是原文**，用途只有一个：限制爆破频率。不记录兑换码明文，日志泄露也不会连带泄露凭证。
- **不做「一次绑定一台设备」**。技术上可以做，但读者换手机就来找你，客服成本高于防盗收益。用令牌有效期控制即可。

## 令牌怎么签发

不要自己发明签名算法，用 WebCrypto 的 HMAC-SHA256 就够了：

```ts
async function sign(payload: object, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const body = base64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, keyMaterial(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}
```

令牌里放三样东西：能访问哪些文章、过期时间、签发时间。验证时先验签名再读内容——**顺序很重要**，先解析 JSON 再验签等于把攻击者构造的任意数据当事实。

默认给 30 天的有效期。太短读者烦，太长兑换码一旦外流就长期有效。30 天是个经验和妥协。

## 一次完整的请求流程

读者在付费文章页面输入兑换码，发生的事是这样的：

1. 前端 `POST /api/unlock`，带上兑换码和当前文章 slug。
2. Worker 先把码规范化（去空格、转大写），查 `attempts` 判断这个 IP 十分钟内失败次数是否超限。
3. 查 `codes`：是否存在、是否被吊销、是否过期、`used_count` 是否已达 `max_uses`、`scope=article` 时 slug 是否匹配。
4. 全部通过后 `used_count + 1`，签发令牌，返回给前端。
5. 前端把令牌存进 `localStorage`，立刻用它请求 `GET /api/article?slug=...`。
6. Worker 验签通过，从 `articles` 表取出 HTML 返回。
7. 前端把 HTML 注入到占位容器里，遮罩消失。

之后读者再打开同一篇文章，第 1、4 步会跳过——`localStorage` 里有令牌，直接走第 5 步。

## 几个容易踩的坑

**不要把付费 HTML 缓存到公开 CDN 上。** Worker 返回的是按令牌鉴权的内容，必须带 `Cache-Control: private, no-store`。一旦被 Cloudflare 的边缘缓存住，A 读者解的锁 B 读者也能拿到。

**CORS 白名单要写死域名。** `Access-Control-Allow-Origin: *` 配上一个返回内容的接口，等于给任何人开放了一个跨站抓取入口。

**兑换码要能撤销。** 卖出去了才发现对方在群里分发，你需要一个 `revoked` 字段一键失效，而不是等令牌过期。

**同步脚本要比站点构建可靠。** 付费正文在 D1 里，站点在 Pages 里，两边是分开部署的。我的做法是每次发布前跑一次 `npm run sync:paid`，把 `src/content/posts` 里标记为付费的文章渲染出付费部分，生成 SQL 导入 D1。听起来土，但它把「内容」和「授权」解耦了——改站点样式不需要动数据库，改兑换码也不需要重新构建页面。

## 值不值得

如果你只是想给文章加个「赞赏」按钮，别做付费墙，直接挂个收款码。付费墙真正解决的问题是「内容有价值且需要筛选读者」，它带来的是运维成本和读者的摩擦。

但如果你确实写的是那种值得单独定价的长文，这套方案的强度是够的：它挡住了 99% 的随手复制，而剩下的 1%——真正的盗版分发——任何方案都挡不住。想清楚这一点，再决定要不要给内容定价。
