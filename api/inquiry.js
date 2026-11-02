/* 손님 문의 받기
 *
 * POST /api/inquiry {name, phone, email, birth, body, website}
 *   전화번호는 반드시 받습니다. 이메일은 있으면 받습니다.
 *   website 는 사람 눈에 안 보이는 덫입니다. 기계가 채우면 버립니다.
 *
 * 받은 문의는 관리 화면의 '문의함'에 결제 기록과 나란히 쌓입니다.
 * 보관 3년 — 소비자 불만·분쟁처리 기록 기간입니다.
 */
import crypto from "node:crypto";
import { kakaoSend, listInquiries, putInquiry, SECRET } from "./_lib.js";

const LIMITS = { name: 40, phone: 24, email: 120, birth: 20, body: 2000 };
const clean = (v, n) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, n);

/* 전화번호를 숫자만 남겨 봅니다. 모양이 아니면 빈 글자를 돌려줍니다 */
function normPhone(v) {
  let t = String(v ?? "").trim().replace(/[^\d+]/g, "");
  if (/^\+82/.test(t)) t = "0" + t.slice(3).replace(/^0/, "");
  const intl = /^\+/.test(t), d = t.replace(/\D/g, "");
  if (intl) return (d.length >= 8 && d.length <= 15) ? "+" + d : "";
  return /^0\d{8,10}$/.test(d) ? d : "";
}
/* 보기 좋게 사이에 금을 긋습니다 */
function prettyPhone(d) {
  if (/^\+/.test(d)) return d;
  if (/^02\d{7,8}$/.test(d)) return d.replace(/^(\d{2})(\d{3,4})(\d{4})$/, "$1-$2-$3");
  if (/^0\d{9,10}$/.test(d)) return d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
  return d;
}
const okMail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

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
  const rawPhone = clean(b.phone ?? b.contact, LIMITS.phone);   // contact 는 옛 모양
  const email = clean(b.email, LIMITS.email);
  const birth = clean(b.birth, LIMITS.birth).replace(/[^0-9.\-\/ ]/g, "");
  const body = clean(b.body, LIMITS.body);

  if (!name) { res.status(400).json({ error: "이름을 적어 주세요" }); return; }
  if (!rawPhone) { res.status(400).json({ error: "전화번호를 적어 주세요" }); return; }
  const digits = normPhone(rawPhone);
  if (!digits) { res.status(400).json({ error: "전화번호를 다시 확인해 주세요" }); return; }
  if (email && !okMail(email)) { res.status(400).json({ error: "이메일을 다시 확인해 주세요" }); return; }
  if (body.length < 5) { res.status(400).json({ error: "문의 내용을 조금 더 적어 주세요" }); return; }

  const phone = prettyPhone(digits);

  const who = crypto.createHash("sha256")
    .update((req.headers["x-forwarded-for"] || "") + "|" + digits).digest("hex").slice(0, 16);

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
    await putInquiry({
      id, at: Date.now(), who, name,
      phone, email, contact: phone,   // contact 는 옛 기록과 나란히 보이라고 함께 둡니다
      birth, body, done: false, memo: "",
    });
    res.status(200).json({ ok: true, id });

    /* 손님을 기다리게 하지 않고 뒤에서 알립니다 */
    kakaoSend(
      `[백귀야행도] 문의 1건\n${name} · ${phone}${birth ? " · " + birth : ""}`
      + (email ? `\n${email.slice(0, 40)}` : "")
      + `\n${body.replace(/\s+/g, " ").slice(0, 70)}`,
      "https://baekgwi-yahaengdo.vercel.app/admin.html",
    ).catch(() => {});
  } catch (e) {
    console.error("inquiry save fail", e?.message, e?.name);
    res.status(500).json({ error: "접수하지 못했습니다. 전화나 메일로 알려 주세요" });
  }
}
