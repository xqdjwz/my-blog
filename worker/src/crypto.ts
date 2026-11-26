/** 令牌相关的加密工具：base64url、HMAC-SHA256 签名与校验、IP 哈希 */

const encoder = new TextEncoder();

export type TokenPayload = {
  /** 可访问的文章 slug；["*"] 表示全部 */
  s: string[];
  /** 过期时间（epoch 秒） */
  e: number;
  /** 签发时间（epoch 秒） */
  i: number;
};

export function toBase64Url(input: Uint8Array): string {
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 签发 `header.payload.signature` 形式的令牌 */
export async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 先验签名，再解析内容——顺序不能反 */
export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    fromBase64Url(signature),
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as TokenPayload;
    if (typeof payload.e !== 'number' || !Array.isArray(payload.s)) return null;
    if (payload.e * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 生成可读性好的随机兑换码，去掉容易看错的 I/O/0/1 */
export function randomCode(prefix = 'BLOG', groups = 2, groupSize = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(groups * groupSize);
  crypto.getRandomValues(bytes);
  const chunks: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let chunk = '';
    for (let i = 0; i < groupSize; i += 1) {
      chunk += alphabet[bytes[g * groupSize + i] % alphabet.length];
    }
    chunks.push(chunk);
  }
  return [prefix, ...chunks].join('-');
}
