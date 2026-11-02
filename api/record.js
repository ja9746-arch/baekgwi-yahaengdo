/* 결제 기록 남기기 — 세 서비스가 여기로 알려줍니다
 *
 * POST /api/record
 *   {sig, id, service, amount, event}
 *     sig     : ADMIN_SECRET 으로 만든 서명 (아무나 못 쓰게)
 *     id      : 결제번호
 *     service : "사주" | "타로" | "관상"
 *     amount  : 금액
 *     event   : "paid"(결제됨) | "opened"(풀이를 열어봄) | "error"(오류)
 *
 * 포트원이 결제 원본이고, 여기는 포트원이 모르는 것만 둡니다 —
 * 열어봤는지, 오류가 났는지. 환불 판단에 쓰는 자리입니다.
 */
import crypto from "node:crypto";
import { getRecord, putRecord, SECRET } from "./_lib.js";

const EVENTS = ["paid", "opened", "error"];
const SERVICES = ["사주", "타로", "관상"];

export function recordSig(id, event) {
  return crypto.createHmac("sha256", process.env.ADMIN_SECRET || "")
    .update(`${id}|${event}`).digest("hex").slice(0, 32);
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  if (!SECRET()) { res.status(503).json({ error: "설정 전" }); return; }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const id = String(b.id || "").slice(0, 80);
  const event = String(b.event || "");
  const service = String(b.service || "");
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id) || !EVENTS.includes(event) || !SERVICES.includes(service)) {
    res.status(400).json({ error: "값이 올바르지 않습니다" }); return;
  }
  /* 글자 수가 아니라 바이트 수로 견줍니다. 한글이 섞여 오면 길이가 달라져 터집니다 */
  const want = Buffer.from(recordSig(id, event));
  const got = Buffer.from(String(b.sig || ""));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    res.status(401).json({ error: "서명이 맞지 않습니다" }); return;
  }

  try {
    const now = Date.now();
    const prev = await getRecord(id) || { id, service, at: now };
    const rec = { ...prev, service, at: prev.at || now };
    if (event === "paid")   { rec.amount = Number(b.amount) || prev.amount || 0; rec.paidAt = now; }
    if (event === "opened") { rec.openedAt = rec.openedAt || now; }
    if (event === "error")  { rec.error = String(b.note || "오류").slice(0, 200); rec.errorAt = now; }
    await putRecord(rec);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("record fail", e?.message);
    res.status(500).json({ error: "기록 실패" });
  }
}
