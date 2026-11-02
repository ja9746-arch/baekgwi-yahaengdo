/* 손님 문의 받기
 *
 * POST /api/inquiry {name, contact, birth, body, website}
 *   website 는 사람 눈에 안 보이는 덫입니다. 기계가 채우면 버립니다.
 *
 * 받은 문의는 관리 화면의 '문의함'에 결제 기록과 나란히 쌓입니다.
 * 보관 3년 — 소비자 불만·분쟁처리 기록 기간입니다.
 */
import crypto from "node:crypto";
import { listInquiries, putInquiry, SECRET } from "./_lib.js";

const LIMITS = { name: 40, contact: 120, birth: 20, body: 2000 };
const clean = (v, n) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, n);

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  if (!SECRET()) { res.status(503).json({ error: "아직 준비 중입니다" }); return; }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  // 기계가 채우는 덫. 사람은 비워 둡니다
  if (clean(b.website, 20)) { res.status(200).json({ ok: true }); return; }

  const name = clean(b.name, LIMITS.name);
  const contact = clean(b.contact, LIMITS.contact);
  const birth = clean(b.birth, LIMITS.birth).replace(/[^0-9.\-\/ ]/g, "");
  const body = clean(b.body, LIMITS.body);

  if (!name) { res.status(400).json({ error: "이름을 적어 주세요" }); return; }
  if (!contact) { res.status(400).json({ error: "답을 받으실 연락처를 적어 주세요" }); return; }
  if (body.length < 5) { res.status(400).json({ error: "문의 내용을 조금 더 적어 주세요" }); return; }

  const who = crypto.createHash("sha256")
    .update((req.headers["x-forwarded-for"] || "") + "|" + contact).digest("hex").slice(0, 16);

  // 같은 사람이 5분 안에 또 보내면 막습니다. 목록을 못 읽어도 접수는 막지 않습니다
  try {
    const recent = (await listInquiries(50)).filter(x => x.who === who && Date.now() - x.at < 5 * 60000);
    if (recent.length >= 2) {
      res.status(429).json({ error: "조금 전에 보내신 문의가 있습니다. 잠시 뒤에 다시 보내 주세요" });
      return;
    }
  } catch (e) { console.error("inquiry ratelimit skip", e?.message); }

  try {
    const id = "q-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
    await putInquiry({ id, at: Date.now(), who, name, contact, birth, body, done: false, memo: "" });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("inquiry save fail", e?.message, e?.name);
    res.status(500).json({ error: "접수하지 못했습니다. 전화나 메일로 알려 주세요" });
  }
}
