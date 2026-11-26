/**
 * 创新博客 · 付费阅读 API
 *
 *   POST /api/pay/create       下单，返回支付宝二维码
 *   GET  /api/pay/status       轮询是否付款成功，成功后返回阅读令牌
 *   POST /api/pay/notify       支付宝异步通知（验签后自动标记已付）
 *   GET  /api/article?slug=    凭令牌取回付费正文
 *
 *   POST /api/unlock           兑换码换令牌（备用人工作业，如补发、赠送）
 *   POST /api/admin/codes      生成兑换码
 *   GET  /api/admin/codes      查看兑换码
 *   POST /api/admin/revoke     停用兑换码
 *   GET  /api/admin/orders     查看订单
 *   GET  /api/admin/genkey     生成一对 RSA2 密钥（没有密钥工具时用）
 *   GET  /api/health           健康检查
 */

import { notifyContent, precreate, queryTrade, rsa2Verify, type AlipayConfig } from './alipay';
import { randomCode, sha256Hex, signToken, verifyToken, type TokenPayload } from './crypto';

export interface Env {
  DB: D1Database;
  TOKEN_SECRET: string;
  ADMIN_TOKEN: string;
  ALLOWED_ORIGINS?: string;
  TOKEN_TTL_DAYS?: string;

  // 支付宝当面付
  ALIPAY_APP_ID?: string;
  ALIPAY_PRIVATE_KEY?: string;
  ALIPAY_PUBLIC_KEY?: string;
  ALIPAY_NOTIFY_URL?: string;
  ALIPAY_MOCK?: string;
  PAY_TIMEOUT_MINUTES?: string;
  MOCK_PAY_SECONDS?: string;
}

interface CodeRow {
  code: string;
  scope: string;
  slug: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  revoked: number;
}

interface OrderRow {
  out_trade_no: string;
  slug: string;
  amount: number;
  status: string;
  trade_no: string | null;
  token: string | null;
  created_at: string;
  paid_at: string | null;
  checked_at: string | null;
}

const MAX_FAILS = 10;
const FAIL_WINDOW_MINUTES = 10;
const MOCK_PAY_SECONDS = 15;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function clientIpHash(request: Request, env: Env): Promise<string> {
  const ip =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown';
  return (await sha256Hex(`${ip}::${env.TOKEN_SECRET}`)).slice(0, 32);
}

async function logAttempt(env: Env, ctx: ExecutionContext, ipHash: string, ok: boolean) {
  ctx.waitUntil(
    env.DB.prepare('INSERT INTO attempts (ip_hash, ok, created_at) VALUES (?1, ?2, ?3)')
      .bind(ipHash, ok ? 1 : 0, new Date().toISOString())
      .run()
      .catch(() => undefined),
  );
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!env.ADMIN_TOKEN || !(await safeEqual(token, env.ADMIN_TOKEN))) {
    return json({ ok: false, error: '管理口令无效' }, 401);
  }
  return null;
}

function alipayConfig(env: Env): AlipayConfig {
  return {
    appId: env.ALIPAY_APP_ID ?? '',
    privateKey: env.ALIPAY_PRIVATE_KEY ?? '',
    alipayPublicKey: env.ALIPAY_PUBLIC_KEY ?? '',
    notifyUrl: env.ALIPAY_NOTIFY_URL || undefined,
  };
}

function isMock(env: Env): boolean {
  return env.ALIPAY_MOCK === '1';
}

async function issueToken(env: Env, slug: string): Promise<string> {
  const ttlDays = Number(env.TOKEN_TTL_DAYS ?? '30') || 30;
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { s: [slug], i: now, e: now + ttlDays * 86400 };
  return signToken(payload, env.TOKEN_SECRET);
}

/** 生成订单号：B + 时间 + 随机，≤ 64 位 */
function newOutTradeNo(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `B${stamp}${String(random[0] % 1000000).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 下单                                                                */
/* ------------------------------------------------------------------ */

async function handlePayCreate(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_SECRET) return json({ ok: false, error: '服务端未配置 TOKEN_SECRET' }, 500);

  const body = (await request.json().catch(() => null)) as { slug?: string } | null;
  const slug = (body?.slug ?? '').trim();
  if (!slug) return json({ ok: false, error: '缺少文章 slug' }, 400);

  const article = await env.DB.prepare('SELECT slug, title, price FROM articles WHERE slug = ?1')
    .bind(slug)
    .first<{ slug: string; title: string; price: number }>();

  if (!article) {
    return json({ ok: false, error: '文章不存在或尚未同步付费内容，请联系作者' }, 404);
  }

  const amount = Number(article.price ?? 0);
  if (!(amount > 0)) return json({ ok: false, error: '这篇文章没有设置价格' }, 400);

  const outTradeNo = newOutTradeNo();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO orders (out_trade_no, slug, amount, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(outTradeNo, slug, amount, 'pending', now)
    .run();

  const timeout = Number(env.PAY_TIMEOUT_MINUTES ?? '15') || 15;

  if (isMock(env)) {
    return json({
      ok: true,
      mock: true,
      outTradeNo,
      amount: amount.toFixed(2),
      qrCode: `https://qr.alipay.com/mock-${outTradeNo}`,
      timeoutMinutes: timeout,
    });
  }

  const result = await precreate(alipayConfig(env), {
    outTradeNo,
    amount: amount.toFixed(2),
    subject: article.title.slice(0, 120),
    timeoutMinutes: timeout,
  });

  if (!result.ok) {
    await env.DB.prepare('UPDATE orders SET status = ?2 WHERE out_trade_no = ?1')
      .bind(outTradeNo, 'failed')
      .run();
    return json(
      {
        ok: false,
        error: result.error ?? '下单失败',
        hint: '请检查 ALIPAY_APP_ID、ALIPAY_PRIVATE_KEY 是否正确，以及应用是否已签约「当面付」。',
      },
      502,
    );
  }

  const qrCode = String(result.data.qr_code ?? '');
  if (!qrCode) return json({ ok: false, error: '支付宝未返回二维码' }, 502);

  return json({
    ok: true,
    outTradeNo,
    amount: amount.toFixed(2),
    qrCode,
    timeoutMinutes: timeout,
  });
}

/* ------------------------------------------------------------------ */
/* 查单                                                                */
/* ------------------------------------------------------------------ */

async function handlePayStatus(url: URL, env: Env): Promise<Response> {
  if (!env.TOKEN_SECRET) return json({ ok: false, error: '服务端未配置 TOKEN_SECRET' }, 500);

  const outTradeNo = (url.searchParams.get('outTradeNo') ?? '').trim();
  if (!outTradeNo) return json({ ok: false, error: '缺少 outTradeNo' }, 400);

  const order = await env.DB.prepare(
    'SELECT out_trade_no, slug, amount, status, trade_no, token, created_at, paid_at, checked_at FROM orders WHERE out_trade_no = ?1',
  )
    .bind(outTradeNo)
    .first<OrderRow>();

  if (!order) return json({ ok: false, error: '订单不存在' }, 404);

  if (order.status === 'paid') {
    const token = order.token ?? (await issueToken(env, order.slug));
    if (!order.token) {
      await env.DB.prepare('UPDATE orders SET token = ?2 WHERE out_trade_no = ?1').bind(outTradeNo, token).run();
    }
    return json({ ok: true, paid: true, token, paidAt: order.paid_at });
  }

  if (order.status === 'closed' || order.status === 'failed') {
    return json({ ok: true, paid: false, status: order.status });
  }

  // 3 秒内重复查询直接返回缓存状态，避免把支付宝接口打爆
  const checkedAt = order.checked_at ? new Date(order.checked_at).getTime() : 0;
  if (checkedAt && Date.now() - checkedAt < 3000) {
    return json({ ok: true, paid: false, status: 'pending', cached: true });
  }
  await env.DB.prepare('UPDATE orders SET checked_at = ?2 WHERE out_trade_no = ?1')
    .bind(outTradeNo, new Date().toISOString())
    .run();

  let paid = false;
  let tradeNo: string | null = null;
  let closed = false;

  if (isMock(env)) {
    const mockSeconds = Number(env.MOCK_PAY_SECONDS ?? MOCK_PAY_SECONDS) || MOCK_PAY_SECONDS;
    paid = Date.now() - new Date(order.created_at).getTime() > mockSeconds * 1000;
    tradeNo = paid ? `mock-${outTradeNo}` : null;
  } else {
    const result = await queryTrade(alipayConfig(env), outTradeNo);
    if (result.ok) {
      const status = String(result.data.trade_status ?? '');
      const paidAmount = Number(result.data.total_amount ?? 0);
      if ((status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') && paidAmount + 0.001 >= order.amount) {
        paid = true;
        tradeNo = String(result.data.trade_no ?? '');
      } else if (status === 'TRADE_CLOSED') {
        closed = true;
      }
    } else {
      // 用户还没扫码时支付宝会返回交易不存在（40004），属于正常状态，不阻断轮询
      const code = String(result.data.code ?? '');
      if (code !== '40004' && !String(result.error ?? '').includes('TRADE_NOT_EXIST')) {
        console.warn('trade.query', result.error);
      }
    }
  }

  if (!paid && !closed) return json({ ok: true, paid: false, status: 'pending' });

  if (closed) {
    await env.DB.prepare('UPDATE orders SET status = ?2 WHERE out_trade_no = ?1').bind(outTradeNo, 'closed').run();
    return json({ ok: true, paid: false, status: 'closed' });
  }

  const token = await issueToken(env, order.slug);
  const paidAt = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE orders SET status = ?2, trade_no = COALESCE(?3, trade_no), token = ?4, paid_at = ?5 WHERE out_trade_no = ?1',
  )
    .bind(outTradeNo, 'paid', tradeNo, token, paidAt)
    .run();

  return json({ ok: true, paid: true, token, paidAt });
}

/* ------------------------------------------------------------------ */
/* 异步通知                                                            */
/* ------------------------------------------------------------------ */

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;

  const config = alipayConfig(env);
  if (!config.alipayPublicKey) {
    console.error('notify: 未配置 ALIPAY_PUBLIC_KEY，无法验签');
    return text('fail');
  }

  const signature = params.sign ?? '';
  if (!signature) return text('fail');

  const valid = await rsa2Verify(notifyContent(params), signature, config.alipayPublicKey);
  if (!valid) {
    console.error('notify: 验签失败');
    return text('fail');
  }

  const outTradeNo = params.out_trade_no ?? '';
  const tradeStatus = params.trade_status ?? '';
  if (!outTradeNo) return text('fail');

  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') return text('success');

  const order = await env.DB.prepare(
    'SELECT out_trade_no, slug, amount, status, trade_no, token, created_at, paid_at, checked_at FROM orders WHERE out_trade_no = ?1',
  )
    .bind(outTradeNo)
    .first<OrderRow>();

  if (!order) {
    console.error('notify: 订单不存在', outTradeNo);
    return text('fail');
  }

  const paidAmount = Number(params.total_amount ?? 0);
  if (paidAmount + 0.001 < order.amount) {
    console.error('notify: 金额不符', outTradeNo, paidAmount, order.amount);
    return text('fail');
  }

  if (order.status !== 'paid') {
    const token = order.token ?? (await issueToken(env, order.slug));
    await env.DB.prepare(
      'UPDATE orders SET status = ?2, trade_no = ?3, token = ?4, paid_at = ?5 WHERE out_trade_no = ?1',
    )
      .bind(outTradeNo, 'paid', params.trade_no ?? null, token, new Date().toISOString())
      .run();
  }

  return text('success');
}

/* ------------------------------------------------------------------ */
/* 取回付费正文                                                        */
/* ------------------------------------------------------------------ */

async function handleArticle(url: URL, request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_SECRET) return json({ ok: false, error: '服务端未配置 TOKEN_SECRET' }, 500);

  const slug = (url.searchParams.get('slug') ?? '').trim();
  if (!slug) return json({ ok: false, error: '缺少 slug 参数' }, 400);

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return json({ ok: false, error: '缺少访问令牌' }, 401);

  const payload = await verifyToken(token, env.TOKEN_SECRET);
  if (!payload) return json({ ok: false, error: '令牌无效或已过期', code: 'TOKEN_INVALID' }, 401);

  if (!payload.s.includes('*') && !payload.s.includes(slug)) {
    return json({ ok: false, error: '当前令牌无权访问这篇文章', code: 'NO_ACCESS' }, 403);
  }

  const article = await env.DB.prepare(
    'SELECT slug, title, html, updated_at FROM articles WHERE slug = ?1',
  )
    .bind(slug)
    .first<{ slug: string; title: string; html: string; updated_at: string }>();

  if (!article) return json({ ok: false, error: '文章不存在，可能尚未同步' }, 404);

  // 必须 private + no-store：鉴权后的内容不能被边缘节点缓存
  return json(
    { ok: true, slug: article.slug, title: article.title, html: article.html, updatedAt: article.updated_at },
    200,
    { 'cache-control': 'private, no-store, max-age=0' },
  );
}

/* ------------------------------------------------------------------ */
/* 兑换码（备用）                                                      */
/* ------------------------------------------------------------------ */

async function handleUnlock(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.TOKEN_SECRET) return json({ ok: false, error: '服务端未配置 TOKEN_SECRET' }, 500);

  const body = (await request.json().catch(() => null)) as { code?: string; slug?: string } | null;
  const code = (body?.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const slug = (body?.slug ?? '').trim();

  if (!code || !slug) return json({ ok: false, error: '请提供兑换码与文章标识' }, 400);
  if (code.length > 64) return json({ ok: false, error: '兑换码格式不正确' }, 400);

  const ipHash = await clientIpHash(request, env);
  const since = new Date(Date.now() - FAIL_WINDOW_MINUTES * 60 * 1000).toISOString();

  const fails = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM attempts WHERE ip_hash = ?1 AND ok = 0 AND created_at > ?2',
  )
    .bind(ipHash, since)
    .first<{ n: number }>();

  if ((fails?.n ?? 0) >= MAX_FAILS) {
    return json({ ok: false, error: `尝试次数过多，请 ${FAIL_WINDOW_MINUTES} 分钟后再试` }, 429);
  }

  const row = await env.DB.prepare(
    'SELECT code, scope, slug, max_uses, used_count, expires_at, revoked FROM codes WHERE code = ?1',
  )
    .bind(code)
    .first<CodeRow>();

  const reject = async (message: string) => {
    await logAttempt(env, ctx, ipHash, false);
    return json({ ok: false, error: message }, 401);
  };

  if (!row) return reject('兑换码不存在或已失效');
  if (row.revoked) return reject('兑换码已被停用');
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return reject('兑换码已过期');
  }
  if (row.max_uses > 0 && row.used_count >= row.max_uses) {
    return reject('兑换码使用次数已用完');
  }
  if (row.scope !== 'all' && row.slug !== slug) {
    return reject('该兑换码不适用于这篇文章');
  }

  await env.DB.prepare('UPDATE codes SET used_count = used_count + 1 WHERE code = ?1').bind(code).run();
  await logAttempt(env, ctx, ipHash, true);

  const ttlDays = Number(env.TOKEN_TTL_DAYS ?? '30') || 30;
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    s: row.scope === 'all' ? ['*'] : [slug],
    i: now,
    e: now + ttlDays * 86400,
  };
  const token = await signToken(payload, env.TOKEN_SECRET);

  return json({ ok: true, token, expiresAt: payload.e, scope: row.scope });
}

/* ------------------------------------------------------------------ */
/* 管理接口                                                            */
/* ------------------------------------------------------------------ */

async function handleCreateCodes(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { scope?: string; slug?: string; count?: number; maxUses?: number; expiresAt?: string; note?: string; prefix?: string }
    | null;

  const scope = body?.scope === 'all' ? 'all' : 'article';
  const count = Math.min(Math.max(Number(body?.count ?? 1) || 1, 1), 200);
  const maxUses = Math.max(Number(body?.maxUses ?? 1) || 0, 0);
  const prefix = (body?.prefix ?? 'BLOG').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'BLOG';
  const slug = (body?.slug ?? '').trim() || null;
  const note = (body?.note ?? '').slice(0, 200) || null;
  const expiresAt = body?.expiresAt ? new Date(body.expiresAt).toISOString() : null;

  if (scope === 'article' && !slug) {
    return json({ ok: false, error: 'scope=article 时必须提供 slug' }, 400);
  }
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
    return json({ ok: false, error: 'expiresAt 不是合法日期' }, 400);
  }

  const createdAt = new Date().toISOString();
  const created: { code: string; scope: string; slug: string | null; maxUses: number; expiresAt: string | null }[] = [];

  for (let i = 0; i < count; i += 1) {
    let inserted = false;
    for (let retry = 0; retry < 5 && !inserted; retry += 1) {
      const code = randomCode(prefix);
      const result = await env.DB.prepare(
        `INSERT INTO codes (code, scope, slug, max_uses, used_count, expires_at, note, created_at, revoked)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, 0)
         ON CONFLICT(code) DO NOTHING`,
      )
        .bind(code, scope, slug, maxUses, expiresAt, note, createdAt)
        .run();
      if ((result.meta?.changes ?? 0) > 0) {
        inserted = true;
        created.push({ code, scope, slug, maxUses, expiresAt });
      }
    }
  }

  return json({ ok: true, count: created.length, codes: created });
}

async function handleListCodes(url: URL, env: Env): Promise<Response> {
  const slug = url.searchParams.get('slug');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);

  const statement = slug
    ? env.DB.prepare(
        'SELECT code, scope, slug, max_uses, used_count, expires_at, revoked, note, created_at FROM codes WHERE slug = ?1 ORDER BY created_at DESC LIMIT ?2',
      ).bind(slug, limit)
    : env.DB.prepare(
        'SELECT code, scope, slug, max_uses, used_count, expires_at, revoked, note, created_at FROM codes ORDER BY created_at DESC LIMIT ?1',
      ).bind(limit);

  const result = await statement.all();
  return json({ ok: true, codes: result.results ?? [] });
}

async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { code?: string; revoked?: boolean } | null;
  const code = (body?.code ?? '').trim().toUpperCase();
  if (!code) return json({ ok: false, error: '缺少兑换码' }, 400);

  const revoked = body?.revoked === false ? 0 : 1;
  const result = await env.DB.prepare('UPDATE codes SET revoked = ?2 WHERE code = ?1').bind(code, revoked).run();
  return json({ ok: true, code, revoked, changes: result.meta?.changes ?? 0 });
}

async function handleListOrders(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const result = await env.DB.prepare(
    `SELECT out_trade_no, slug, amount, status, trade_no, created_at, paid_at
     FROM orders ORDER BY created_at DESC LIMIT ?1`,
  )
    .bind(limit)
    .all();
  return json({ ok: true, orders: result.results ?? [] });
}

async function handleGenKey(): Promise<Response> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));

  let privateBinary = '';
  for (const byte of pkcs8) privateBinary += String.fromCharCode(byte);
  let publicBinary = '';
  for (const byte of spki) publicBinary += String.fromCharCode(byte);

  return json({
    ok: true,
    appPublicKey: btoa(publicBinary),
    privateKey: btoa(privateBinary),
    note: '把 appPublicKey 填到支付宝开放平台的「应用公钥」，privateKey 存进 Worker 的 ALIPAY_PRIVATE_KEY。只生成一次，丢了只能重新生成并重新上传公钥。',
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;
    try {
      const path = url.pathname;

      if (request.method === 'GET' && path === '/api/health') {
        response = json({
          ok: true,
          service: 'innovate-blog-api',
          time: new Date().toISOString(),
          mock: isMock(env),
          alipayConfigured: Boolean(env.ALIPAY_APP_ID && env.ALIPAY_PRIVATE_KEY),
        });
      } else if (request.method === 'POST' && path === '/api/pay/create') {
        response = await handlePayCreate(request, env);
      } else if (request.method === 'GET' && path === '/api/pay/status') {
        response = await handlePayStatus(url, env);
      } else if (request.method === 'POST' && path === '/api/pay/notify') {
        response = await handleNotify(request, env);
      } else if (request.method === 'GET' && path === '/api/article') {
        response = await handleArticle(url, request, env);
      } else if (request.method === 'POST' && path === '/api/unlock') {
        response = await handleUnlock(request, env, ctx);
      } else if (path === '/api/admin/codes' && request.method === 'POST') {
        const denied = await requireAdmin(request, env);
        response = denied ?? (await handleCreateCodes(request, env));
      } else if (path === '/api/admin/codes' && request.method === 'GET') {
        const denied = await requireAdmin(request, env);
        response = denied ?? (await handleListCodes(url, env));
      } else if (request.method === 'POST' && path === '/api/admin/revoke') {
        const denied = await requireAdmin(request, env);
        response = denied ?? (await handleRevoke(request, env));
      } else if (request.method === 'GET' && path === '/api/admin/orders') {
        const denied = await requireAdmin(request, env);
        response = denied ?? (await handleListOrders(url, env));
      } else if (request.method === 'GET' && path === '/api/admin/genkey') {
        const denied = await requireAdmin(request, env);
        response = denied ?? (await handleGenKey());
      } else {
        response = json({ ok: false, error: '接口不存在' }, 404);
      }
    } catch (error) {
      console.error('unhandled', error);
      response = json({ ok: false, error: '服务异常，请稍后重试' }, 500);
    }

    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) merged.set(key, value);
    return new Response(response.body, { status: response.status, headers: merged });
  },
};
