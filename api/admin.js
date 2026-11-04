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
  getKakao, putKakao, kakaoSend,
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

  /* ── 전체 내려받기 (백업) ──────────────
   * 법정 5년 보관 자료가 버셀 한 군데에만 있으면 안 됩니다.
   * 통째로 받아 다른 곳에 한 벌 더 두십시오.
   * ────────────────────────────────────── */
  if (act === "export") {
    try {
      const [pay, inq, stat, cfg] = await Promise.all([
        listRecords(2000), listInquiries(2000), listStats(400), getConfig(),
      ]);
      const stamp = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace("T", "_").replace(":", "");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="baekgwi-backup-${stamp}.json"`);
      res.status(200).send(JSON.stringify({
        받은때: new Date().toISOString(), 상호: "온미라이프",
        결제: pay, 문의: inq, 방문: stat, 설정: cfg,
      }, null, 2));
    } catch (e) { console.error("export fail", e?.message); res.status(500).json({ error: "내려받지 못했습니다" }); }
    return;
  }

  /* 매출 표를 엑셀로 */
  if (act === "csv") {
    try {
      const rows = await listRecords(2000);
      const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const d = ms => { if (!ms) return ""; const k = new Date(ms + 9 * 3600000);
        return k.toISOString().slice(0, 19).replace("T", " "); };
      const head = ["결제번호", "서비스", "금액", "결제시각", "열람시각", "환불", "오류"];
      const body = rows.map(r => [
        r.id, r.service ? "백귀" + r.service : "", r.amount || 0,
        d(r.paidAt || r.at), d(r.openedAt), r.refunded ? "환불함" : "", r.error || "",
      ].map(esc).join(","));
      const stamp = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="baekgwi-maechul-${stamp}.csv"`);
      res.status(200).send("\uFEFF" + [head.map(esc).join(","), ...body].join("\r\n"));
    } catch (e) { console.error("csv fail", e?.message); res.status(500).json({ error: "만들지 못했습니다" }); }
    return;
  }

  /* ── 카카오 알림 ───────────────────── */
  if (act === "kakao") {
    const k = await getKakao();
    res.status(200).json({
      ok: true,
      연결됨: !!(k && k.refresh && !k.broken),
      끊김: !!(k && k.broken),
      사유: k?.reason || null,
      연결한때: k?.at || null,
      열쇠있음: !!process.env.KAKAO_REST_KEY,
    });
    return;
  }
  if (req.method === "POST" && act === "kakaotest") {
    const sent = await kakaoSend(
      "[백귀야행도] 시험 알림입니다. 이 글이 보이면 연결이 잘 된 것입니다.",
      "https://100gwi.com/admin.html",
    );
    res.status(200).json(sent ? { ok: true } : { ok: false, error: "보내지 못했습니다. 다시 연결해 주십시오" });
    return;
  }
  if (req.method === "POST" && act === "kakaooff") {
    await putKakao({ refresh: null, at: null, broken: false, reason: null });
    res.status(200).json({ ok: true });
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
