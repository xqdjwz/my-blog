/**
 * 支付宝当面付（F2F 扫码支付）在 Cloudflare Worker 里的实现。
 *
 * 只用到两个接口：
 *   alipay.trade.precreate  下单，返回一个二维码字符串
 *   alipay.trade.query      查单，判断用户是否已付款
 *
 * 签名算法 RSA2（SHA256withRSA）。私钥、支付宝公钥都通过环境变量注入。
 * 支持两种常见格式：带 PEM 头的，以及密钥工具里直接复制的裸 base64。
 */

const GATEWAY = 'https://openapi.alipay.com/gateway.do';
const encoder = new TextEncoder();

export interface AlipayConfig {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway?: string;
  notifyUrl?: string;
}

/* ----------------------------- base64 / DER ----------------------------- */

function toBytes(input: string): Uint8Array<ArrayBuffer> {
  let binary = '';
  for (let i = 0; i < input.length; i += 1) binary += String.fromCharCode(input.charCodeAt(i));
  const raw = atob(binary);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function fromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 去掉 PEM 头尾与换行，拿到裸 DER 的 base64 */
function pemToBase64(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
}

function derLength(length: number): Uint8Array<ArrayBuffer> {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(type: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = derLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = type;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const RSA_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
const ALGORITHM_ID = der(0x30, concat(der(0x06, RSA_OID), der(0x05, new Uint8Array(0))));

/** PKCS#1 私钥 → PKCS#8（支付宝密钥工具导出的就是 PKCS#1） */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  return der(
    0x30,
    concat(der(0x02, new Uint8Array([0x00])), ALGORITHM_ID, der(0x04, pkcs1)),
  );
}

/** PKCS#1 公钥 → SubjectPublicKeyInfo */
function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  return der(0x30, concat(ALGORITHM_ID, der(0x03, concat(new Uint8Array([0x00]), pkcs1))));
}

/* ----------------------------- 密钥导入 ----------------------------- */

const keyCache = new Map<string, Promise<CryptoKey>>();

const RSA_ALGO = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(`pri:${pem}`);
  if (cached) return cached;

  const promise = (async () => {
    const derBytes = toBytes(pemToBase64(pem));
    try {
      return await crypto.subtle.importKey('pkcs8', derBytes, RSA_ALGO, false, ['sign']);
    } catch {
      // 不是 PKCS#8，按 PKCS#1 再包装一次
      const wrapped = pkcs1ToPkcs8(derBytes);
      return crypto.subtle.importKey('pkcs8', wrapped, RSA_ALGO, false, ['sign']);
    }
  })();

  keyCache.set(`pri:${pem}`, promise);
  return promise;
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(`pub:${pem}`);
  if (cached) return cached;

  const promise = (async () => {
    const derBytes = toBytes(pemToBase64(pem));
    try {
      return await crypto.subtle.importKey('spki', derBytes, RSA_ALGO, false, ['verify']);
    } catch {
      const wrapped = pkcs1ToSpki(derBytes);
      return crypto.subtle.importKey('spki', wrapped, RSA_ALGO, false, ['verify']);
    }
  })();

  keyCache.set(`pub:${pem}`, promise);
  return promise;
}

export async function rsa2Sign(content: string, pem: string): Promise<string> {
  const key = await importPrivateKey(pem);
  const signature = await crypto.subtle.sign(RSA_ALGO, key, encoder.encode(content));
  return fromBytes(new Uint8Array(signature));
}

export async function rsa2Verify(content: string, signature: string, pem: string): Promise<boolean> {
  try {
    const key = await importPublicKey(pem);
    return await crypto.subtle.verify(RSA_ALGO, key, toBytes(signature), encoder.encode(content));
  } catch {
    return false;
  }
}

/* ----------------------------- 签名与调用 ----------------------------- */

/** 支付宝要求的时间戳是 GMT+8 的 yyyy-MM-dd HH:mm:ss */
function alipayTimestamp(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
  );
}

/** 请求签名：剔除 sign、剔除空值，键名 ASCII 升序，k=v 用 & 连接（sign_type 参与签名） */
export function signContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** 异步通知验签：剔除 sign 与 sign_type，其余全部参与 */
export function notifyContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** 从响应原文里精确取出 `"xxx_response":{...}` 的原始 JSON 片段（验签必须用它，不能用重新序列化的结果） */
export function extractNode(raw: string, nodeKey: string): string | null {
  const token = `"${nodeKey}":`;
  const index = raw.indexOf(token);
  if (index === -1) return null;

  let start = index + token.length;
  while (start < raw.length && /\s/.test(raw[start])) start += 1;
  if (raw[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export interface AlipayResult {
  ok: boolean;
  data: Record<string, unknown>;
  error?: string;
  raw?: string;
}

/** 统一的网关调用：组参数 → 签名 → POST → 验签 → 取业务节点 */
export async function callAlipay(
  method: string,
  bizContent: Record<string, unknown>,
  config: AlipayConfig,
): Promise<AlipayResult> {
  if (!config.appId || !config.privateKey) {
    return { ok: false, data: {}, error: '未配置 ALIPAY_APP_ID 或 ALIPAY_PRIVATE_KEY' };
  }

  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (config.notifyUrl) params.notify_url = config.notifyUrl;

  const sign = await rsa2Sign(signContent(params), config.privateKey);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) form.append(key, value);
  form.append('sign', sign);

  let response: Response;
  try {
    response = await fetch(config.gateway ?? GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form.toString(),
    });
  } catch (error) {
    return { ok: false, data: {}, error: `网络异常：${String(error)}` };
  }

  const raw = await response.text();
  const nodeKey = `${method.replace(/\./g, '_')}_response`;
  const node = extractNode(raw, nodeKey);

  if (!node) {
    return { ok: false, data: {}, error: `响应格式异常：${raw.slice(0, 200)}`, raw };
  }

  // 同步返回验签（配了公钥才验，避免本地 mock 时被卡住）
  if (config.alipayPublicKey) {
    const signMatch = raw.match(/"sign"\s*:\s*"([^"]+)"/);
    if (signMatch) {
      const valid = await rsa2Verify(node, signMatch[1], config.alipayPublicKey);
      if (!valid) return { ok: false, data: {}, error: '支付宝响应验签失败', raw };
    }
  }

  try {
    const data = JSON.parse(node) as Record<string, unknown>;
    const code = String(data.code ?? '');
    const ok = code === '10000';
    return {
      ok,
      data,
      error: ok ? undefined : `${code} ${String(data.sub_msg ?? data.msg ?? '')}`.trim(),
      raw,
    };
  } catch {
    return { ok: false, data: {}, error: '响应解析失败', raw };
  }
}

/* ----------------------------- 业务封装 ----------------------------- */

export async function precreate(
  config: AlipayConfig,
  input: { outTradeNo: string; amount: string; subject: string; timeoutMinutes: number },
): Promise<AlipayResult> {
  return callAlipay(
    'alipay.trade.precreate',
    {
      out_trade_no: input.outTradeNo,
      total_amount: input.amount,
      subject: input.subject,
      timeout_express: `${input.timeoutMinutes}m`,
    },
    config,
  );
}

export async function queryTrade(
  config: AlipayConfig,
  outTradeNo: string,
): Promise<AlipayResult> {
  return callAlipay('alipay.trade.query', { out_trade_no: outTradeNo }, config);
}
