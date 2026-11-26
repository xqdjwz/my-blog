---
title: 用 GitHub + Cloudflare Pages 部署静态博客的完整流程
description: 从推送仓库到自定义域名上线，记录一次真实部署里踩过的坑：构建命令、Node 版本、缓存与回滚。
date: 2026-11-21
category: 云原生
categorySlug: cloud
tags: [Cloudflare Pages, GitHub, 部署]
cover: /images/cover-cloudflare.jpg
featured: true
---

Cloudflare Pages 的接入体验是我用过最顺的：连上 GitHub 仓库，选一个分支，填两条命令，剩下的它全包。但「能跑起来」和「跑得稳」之间还有一段距离，这篇记录我实际踩到的几个点。

## 连接仓库

在 Cloudflare 控制台进入 Workers & Pages，选择 Create，然后连接到 Git。授权 GitHub 后选中仓库，配置大概是这三项：

- **生产分支**：`main`。每次推送到这个分支都会触发一次生产部署。
- **构建命令**：`npm run build`。
- **输出目录**：`dist`。

还有一个容易漏的：**环境变量 `NODE_VERSION`**。Cloudflare 的默认 Node 版本可能低于你本地使用的，构建脚本里如果有较新的语法就会在云端报错。显式写 `22` 比事后排查省事得多。

## 预览部署是白送的

推送任何非生产分支，Cloudflare 都会生成一个独立的预览域名，例如 `abc123.your-project.pages.dev`。对写博客来说，这意味着可以先在预览地址看排版，确认没问题再合并到 `main`。

我把文章写作流程改成了：本地写好 → 推到一个 `draft/xxx` 分支 → 看预览 → 合并。比在本地起服务截图给朋友看方便。

## 缓存要注意的两个地方

Pages 的 CDN 缓存默认很激进，这对静态文章是好事，但有两点会坑人：

1. **同名文件更新后可能仍命中原缓存**。部署新版本时 Cloudflare 会整体切换部署 ID，正常情况下不会串，但如果你手动往 `dist` 里塞了文件又用同一个构建号，就会拿到旧内容。
2. **搜索索引的更新**。Pagefind 生成的索引文件是每次构建重新产出的，文件名带哈希，所以不会命中旧缓存——这点设计得不错，但前提是你把索引生成放在构建命令里，而不是另外手工上传。

## 回滚

Cloudflare Pages 保留历史部署，控制台里可以直接把某个旧版本「Rollback to this deployment」。这比回滚 Git 提交再等一次构建快得多，线上出问题时先用它止血，再慢慢修代码。

## 一个实际的时间线

从建仓库到域名能访问，我花了大概二十分钟，其中十五分钟在等 DNS 生效。剩下五分钟在处理 `NODE_VERSION` 和一次构建缓存导致的奇怪现象。

如果你的构建命令里还带了额外的步骤（比如本文这个博客要跑 `pagefind` 生成索引），记得把整条链路写进 `package.json` 的 `build` 脚本里，别指望在 Cloudflare 后台叠加多条命令——它只接受一条。
