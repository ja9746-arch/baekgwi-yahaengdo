/* 관리자 공통 — 서명, 쿠키, 기록 저장
 *
 * 환경변수 (버셀 설정에만 둡니다. 코드에 적지 않습니다)
 *   ADMIN_ID      관리자 아이디
 *   ADMIN_PW      관리자 비밀번호
 *   ADMIN_SECRET  서명용 비밀값. 세 서비스가 같은 값을 써야 무료 열쇠가 통합니다
 */
import crypto from "node:crypto";

export const SECRET = () => process.env.ADMIN_SECRET || "";

/* 값 + 만료시각에 서명을 붙여 한 줄로 만든다 */
export function sign(payload, ttlSec) {
  const exp = Date.now() + ttlSec * 1000;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/* 서명을 확인하고 값을 꺼낸다. 위조·만료면 null */
export function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!v.exp || Date.now() > v.exp) return null;
    return v;
  } catch { return null; }
}

/* 글자 수가 달라도 같은 시간이 걸리게 견준다 */
export function same(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setCookie(res, name, value, maxAge) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Strict", `Max-Age=${maxAge}`];
  const prev = res.getHeader("set-cookie");
  const all = prev ? [].concat(prev, bits.join("; ")) : [bits.join("; ")];
  res.setHeader("set-cookie", all);
}

export const ADMIN_COOKIE = "bg_admin";

/* 관리자로 로그인된 요청인가 */
export function isAdmin(req) {
  if (!SECRET()) return false;
  const v = verify(readCookie(req, ADMIN_COOKIE));
  return !!(v && v.t === "admin");
}

/* 결제 기록 — 결제 한 건이 파일 하나. 동시에 써도 서로 덮지 않습니다 */
export async function putRecord(rec) {
  const { put } = await import("@vercel/blob");
  await put(`pay/${rec.id}.json`, JSON.stringify(rec), {
    access: "public", contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
  });
}

export async function getRecord(id) {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: `pay/${id}.json`, limit: 1 });
  if (!blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

export async function listRecords(limit = 200) {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: "pay/", limit });
  const out = await Promise.all(blobs.map(async b => {
    try { const r = await fetch(b.url, { cache: "no-store" }); return r.ok ? await r.json() : null; }
    catch { return null; }
  }));
  return out.filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
}
