/* 보관 기간이 지난 결제 기록을 지웁니다 — 버셀이 날마다 부릅니다
 *
 * 개인정보처리방침에 "5년 뒤 파기"라고 적어 놓고 실제로 안 지우면
 * 거짓말이 됩니다. 그래서 날마다 돌며 실제로 지웁니다.
 *
 * 버셀 크론만 부를 수 있습니다(CRON_SECRET). 관리자도 손으로 부를 수 있습니다.
 */
import { delRecord, delInquiry, isExpired, isExpiredInq, listRecords, listInquiries, KEEP_DAYS, KEEP_DAYS_INQ, isAdmin } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.authorization || "";
  const byCron = secret && auth === `Bearer ${secret}`;
  if (!byCron && !isAdmin(req)) { res.status(401).json({ error: "권한이 없습니다" }); return; }

  try {
    const rows = await listRecords(1000);
    const old = rows.filter(isExpired);
    for (const r of old) await delRecord(r.id);

    const qs = await listInquiries(1000);
    const oldQ = qs.filter(isExpiredInq);
    for (const q of oldQ) await delInquiry(q.id);

    console.log(`purge: 결제 ${old.length}건(보관 ${KEEP_DAYS}일), 문의 ${oldQ.length}건(보관 ${KEEP_DAYS_INQ}일) 삭제`);
    res.status(200).json({
      ok: true, deleted: old.length + oldQ.length,
      pay: old.length, inq: oldQ.length,
      kept: (rows.length - old.length) + (qs.length - oldQ.length),
      keepDays: KEEP_DAYS, keepDaysInq: KEEP_DAYS_INQ,
    });
  } catch (e) {
    console.error("purge fail", e?.message);
    res.status(500).json({ error: "지우지 못했습니다" });
  }
}
