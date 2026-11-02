/* 관리자 — 로그인, 무료 열쇠 발급, 결제 기록 보기
 *
 * POST /api/admin {do:"login", id, pw}   → 로그인. 성공하면 쿠키를 심습니다(12시간)
 * POST /api/admin {do:"logout"}          → 로그아웃
 * GET  /api/admin?do=me                  → 로그인 상태인지
 * GET  /api/admin?do=list                → 결제 기록 목록
 * POST /api/admin {do:"freekey", days}   → 무료 열쇠 발급(세 서비스 공용)
 */
import {
  ADMIN_COOKIE, isAdmin, KEEP_DAYS, KEEP_DAYS_INQ, keepUntil, keepUntilInq,
  listRecords, listInquiries, getInquiry, putInquiry,
  getConfig, putConfig, getRecord, putRecord, listStats,
  same, setCookie, sign, SECRET,
} from "./_lib.js";

const wait = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-robots-tag", "noindex, nofollow");

  const q = req.query || {};
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const act = String(q.do || body.do || "");

  if (!SECRET()) { res.status(503).json({ error: "관리자 설정이 아직 안 되어 있습니다" }); return; }

  /* ── 로그인 ───────────────────────────── */
  if (req.method === "POST" && act === "login") {
    await wait(400 + Math.floor(Math.random() * 300));   // 비밀번호 찍어보기를 느리게
    const id = String(body.id || ""), pw = String(body.pw || "");
    const ok = same(id, process.env.ADMIN_ID || "\u0000") && same(pw, process.env.ADMIN_PW || "\u0000");
    if (!ok) { res.status(401).json({ error: "아이디나 비밀번호가 틀립니다" }); return; }
    setCookie(res, ADMIN_COOKIE, sign({ t: "admin" }, 12 * 3600), 12 * 3600);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === "POST" && act === "logout") {
    setCookie(res, ADMIN_COOKIE, "", 0);
    res.status(200).json({ ok: true });
    return;
  }

  /* ── 여기서부터는 로그인한 사람만 ───────── */
  if (!isAdmin(req)) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

  if (act === "me") { res.status(200).json({ ok: true }); return; }

  if (act === "list") {
    try {
      const rows = (await listRecords(1000)).map(r => ({ ...r, keepUntil: keepUntil(r.paidAt || r.at) }));
      res.status(200).json({ ok: true, rows, keepDays: KEEP_DAYS });
    } catch (e) {
      console.error("list fail", e?.message);
      res.status(200).json({ ok: true, rows: [], keepDays: KEEP_DAYS, note: "아직 기록이 없습니다" });
    }
    return;
  }

  /* ── 문의함 ─────────────────────────── */
  if (act === "inq") {
    try {
      const rows = (await listInquiries(400)).map(q => ({ ...q, keepUntil: keepUntilInq(q.at) }));
      res.status(200).json({ ok: true, rows, keepDays: KEEP_DAYS_INQ });
    } catch (e) { console.error("inq fail", e?.message); res.status(200).json({ ok: true, rows: [] }); }
    return;
  }

  if (req.method === "POST" && act === "inqsave") {
    try {
      const cur = await getInquiry(String(body.id || ""));
      if (!cur) { res.status(404).json({ error: "그 문의가 없습니다" }); return; }
      cur.done = !!body.done;
      cur.memo = String(body.memo ?? cur.memo ?? "").slice(0, 1000);
      await putInquiry(cur);
      res.status(200).json({ ok: true });
    } catch (e) { console.error("inqsave fail", e?.message); res.status(500).json({ error: "저장하지 못했습니다" }); }
    return;
  }

  /* ── 환불 표시 — 포트원에서 환불한 뒤 여기에 적어 두면 매출이 맞습니다 ── */
  if (req.method === "POST" && act === "refund") {
    try {
      const cur = await getRecord(String(body.id || ""));
      if (!cur) { res.status(404).json({ error: "그 결제가 없습니다" }); return; }
      cur.refunded = !!body.refunded;
      cur.refundedAt = cur.refunded ? (cur.refundedAt || Date.now()) : null;
      await putRecord(cur);
      res.status(200).json({ ok: true });
    } catch (e) { console.error("refund fail", e?.message); res.status(500).json({ error: "저장하지 못했습니다" }); }
    return;
  }

  /* ── 방문 통계 ──────────────────────── */
  if (act === "stat") {
    try { res.status(200).json({ ok: true, rows: await listStats(30) }); }
    catch (e) { console.error("stat fail", e?.message); res.status(200).json({ ok: true, rows: [] }); }
    return;
  }

  /* ── 설정 ───────────────────────────── */
  if (act === "cfg") { res.status(200).json({ ok: true, cfg: await getConfig() }); return; }
  if (req.method === "POST" && act === "cfgsave") {
    try { res.status(200).json({ ok: true, cfg: await putConfig(body.cfg || {}) }); }
    catch (e) { console.error("cfgsave fail", e?.message); res.status(500).json({ error: "저장하지 못했습니다" }); }
    return;
  }

  /* 무료 열쇠 — 세 서비스가 같은 ADMIN_SECRET 으로 확인합니다 */
  if (req.method === "POST" && act === "freekey") {
    const days = Math.min(90, Math.max(1, Number(body.days) || 7));
    res.status(200).json({ ok: true, key: sign({ t: "free" }, days * 86400), days });
    return;
  }

  res.status(400).json({ error: "알 수 없는 요청" });
}
