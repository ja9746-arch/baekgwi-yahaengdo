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


/* ── 저장소 ────────────────────────────────
 * 버셀 블롭의 '비공개' 저장소를 씁니다. 주소를 알아도 열쇠 없이는 못 읽습니다.
 * 손님의 이름·연락처가 들어 있으니 공개 저장소를 쓰지 않습니다.
 * ────────────────────────────────────────── */
const PRIVATE = { access: "private" };

async function blobPut(path, obj) {
  const { put } = await import("@vercel/blob");
  return put(path, JSON.stringify(obj), {
    ...PRIVATE, contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
  });
}

async function blobGet(path) {
  const { get } = await import("@vercel/blob");
  try {
    const r = await get(path, { ...PRIVATE, useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch { return null; }
}

/* del 과 list 는 access 를 받지 않습니다. 열쇠(BLOB_READ_WRITE_TOKEN)만으로 닿습니다 */
async function blobDel(path) {
  const { del } = await import("@vercel/blob");
  try { await del(path); } catch (e) { console.error("blobDel", path, e?.message); }
}

async function blobAll(prefix, limit) {
  const { list } = await import("@vercel/blob");
  try {
    const { blobs } = await list({ prefix, limit });
    const out = await Promise.all(blobs.map(b => blobGet(b.pathname)));
    return out.filter(Boolean);
  } catch (e) { console.error("blobAll", prefix, e?.message); return []; }
}

/* 결제 기록 — 결제 한 건이 파일 하나. 동시에 써도 서로 덮지 않습니다 */
export const putRecord  = rec => blobPut(`pay/${rec.id}.json`, rec);
export const getRecord  = id  => blobGet(`pay/${id}.json`);
export const delRecord  = id  => blobDel(`pay/${id}.json`);
export async function listRecords(limit = 200) {
  const rows = await blobAll("pay/", limit);
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}


/* ── 문의 ─────────────────────────────────
 * 손님이 남긴 문의. 결제 기록과 같은 자리에서 보도록 둡니다.
 * 보관은 3년(소비자 불만·분쟁처리 기록).
 * ────────────────────────────────────────── */
export const putInquiry = inq => blobPut(`inq/${inq.id}.json`, inq);
export const getInquiry = id  => blobGet(`inq/${id}.json`);
export const delInquiry = id  => blobDel(`inq/${id}.json`);
export async function listInquiries(limit = 300) {
  const rows = await blobAll("inq/", limit);
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* ── 설정 ─────────────────────────────────
 * 결제 수수료율처럼 사장님이 바꾸는 값. 기기가 바뀌어도 남도록 한곳에 둡니다.
 * ────────────────────────────────────────── */
const CFG_DEFAULT = {
  feeRate: 3.4,        // 카드 수수료율 (%) — 부가세 별도
  feeVat: true,        // 수수료에 부가세 10%가 붙는가
  yearlyFee: 110000,   // 연관리비 (원)
  vatRate: 0,          // 매출 부가가치세율 (%) — 온미라이프는 간이과세자라 0 으로 둡니다
};

export async function getConfig() {
  return { ...CFG_DEFAULT, ...((await blobGet("cfg/main.json")) || {}) };
}

export async function putConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  next.feeRate = Math.min(20, Math.max(0, Number(next.feeRate) || 0));
  next.vatRate = Math.min(20, Math.max(0, Number(next.vatRate) || 0));
  next.yearlyFee = Math.min(10000000, Math.max(0, Number(next.yearlyFee) || 0));
  next.feeVat = !!next.feeVat;
  await blobPut("cfg/main.json", next);
  return next;
}

/* ── 방문 통계 ─────────────────────────────
 * 하루치를 한 파일에 모읍니다. 사람을 알아보지 않고 숫자만 셉니다.
 * 아이피도 쿠키도 남기지 않으므로 개인정보가 아닙니다.
 * ────────────────────────────────────────── */
export const statKey = (d = new Date()) => {
  const k = new Date(d.getTime() + 9 * 3600000);  // 한국 날짜 기준
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
};

export async function bumpStat(kind, what) {
  const day = statKey();
  const cur = (await blobGet(`stat/${day}.json`)) || { day, view: 0, click: {} };
  if (kind === "view") cur.view = (cur.view || 0) + 1;
  else { cur.click = cur.click || {}; cur.click[what] = (cur.click[what] || 0) + 1; }
  await blobPut(`stat/${day}.json`, cur);
}

export async function listStats(days = 30) {
  const rows = await blobAll("stat/", days + 10);
  return rows.sort((a, b) => String(b.day).localeCompare(String(a.day))).slice(0, days);
}
