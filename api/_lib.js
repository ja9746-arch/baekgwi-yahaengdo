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

/* ── 보관 기간 ─────────────────────────────
 * 전자상거래법 제6조와 같은 법 시행령 제6조가 정한 기간입니다.
 *   대금결제 및 재화 등의 공급에 관한 기록 ...... 5년
 *   계약 또는 청약철회 등에 관한 기록 ............ 5년
 *   소비자 불만 또는 분쟁처리에 관한 기록 ........ 3년
 * 저희 기록은 결제·열람(청약철회 판단) 자료이므로 5년으로 둡니다.
 * 기간이 지나면 api/cron-purge 가 날마다 돌며 지웁니다.
 * ────────────────────────────────────────── */
export const KEEP_DAYS = 365 * 5;        // 결제 기록
export const KEEP_DAYS_INQ = 365 * 3;    // 문의 — 소비자 불만·분쟁처리 기록 3년
export const keepUntil = at => (at || Date.now()) + KEEP_DAYS * 86400000;
export const keepUntilInq = at => (at || Date.now()) + KEEP_DAYS_INQ * 86400000;
export const isExpired = rec => Date.now() > keepUntil(rec.paidAt || rec.at);
export const isExpiredInq = rec => Date.now() > keepUntilInq(rec.at);

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

export async function delRecord(id) {
  const { del, list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: `pay/${id}.json`, limit: 1 });
  if (blobs.length) await del(blobs[0].url);
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

/* ── 문의 ─────────────────────────────────
 * 손님이 남긴 문의. 결제 기록과 같은 자리에서 보도록 둡니다.
 * 보관은 3년(소비자 불만·분쟁처리 기록).
 * ────────────────────────────────────────── */
export async function putInquiry(inq) {
  const { put } = await import("@vercel/blob");
  await put(`inq/${inq.id}.json`, JSON.stringify(inq), {
    access: "public", contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
  });
}

export async function getInquiry(id) {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: `inq/${id}.json`, limit: 1 });
  if (!blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

export async function delInquiry(id) {
  const { del, list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: `inq/${id}.json`, limit: 1 });
  if (blobs.length) await del(blobs[0].url);
}

export async function listInquiries(limit = 300) {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: "inq/", limit });
  const out = await Promise.all(blobs.map(async b => {
    try { const r = await fetch(b.url, { cache: "no-store" }); return r.ok ? await r.json() : null; }
    catch { return null; }
  }));
  return out.filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* ── 설정 ─────────────────────────────────
 * 결제 수수료율처럼 사장님이 바꾸는 값. 기기가 바뀌어도 남도록 한곳에 둡니다.
 * ────────────────────────────────────────── */
const CFG_DEFAULT = {
  feeRate: 3.4,        // 카드 수수료율 (%) — 부가세 별도
  feeVat: true,        // 수수료에 부가세 10%가 붙는가
  yearlyFee: 110000,   // 연관리비 (원)
  vatRate: 10,         // 매출 부가가치세율 (%) — 간이과세자면 0 으로 두십시오
};

export async function getConfig() {
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: "cfg/main.json", limit: 1 });
    if (!blobs.length) return { ...CFG_DEFAULT };
    const r = await fetch(blobs[0].url, { cache: "no-store" });
    return r.ok ? { ...CFG_DEFAULT, ...(await r.json()) } : { ...CFG_DEFAULT };
  } catch { return { ...CFG_DEFAULT }; }
}

export async function putConfig(patch) {
  const { put } = await import("@vercel/blob");
  const next = { ...(await getConfig()), ...patch };
  next.feeRate = Math.min(20, Math.max(0, Number(next.feeRate) || 0));
  next.vatRate = Math.min(20, Math.max(0, Number(next.vatRate) || 0));
  next.yearlyFee = Math.min(10000000, Math.max(0, Number(next.yearlyFee) || 0));
  next.feeVat = !!next.feeVat;
  await put("cfg/main.json", JSON.stringify(next), {
    access: "public", contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
  });
  return next;
}
