/* 방문·클릭 세기
 *
 * POST /api/hit {t:"view"}            → 방문 한 번
 * POST /api/hit {t:"click", w:"saju"} → 어느 버튼을 눌렀는지
 *
 * 누가 왔는지는 보지 않습니다. 아이피도 쿠키도 남기지 않고 숫자만 올립니다.
 * 그래서 개인정보가 아니고, 쿠키 동의도 필요 없습니다.
 */
import { bumpStat, SECRET } from "./_lib.js";

const WHAT = new Set([
  "gwansang", "saju", "tarot",
  "terms", "privacy", "refund", "reviewForm",
  "inquiry", "faq",
]);

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!SECRET()) { res.status(204).end(); return; }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};

  const t = b.t === "click" ? "click" : "view";
  const w = String(b.w || "");
  if (t === "click" && !WHAT.has(w)) { res.status(204).end(); return; }

  try { await bumpStat(t, w); } catch (e) { console.error("hit", e?.message); }
  res.status(204).end();   // 손님 화면은 결과를 기다리지 않습니다
}
