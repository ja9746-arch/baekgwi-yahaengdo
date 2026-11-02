/* 저장소가 제대로 도는지 한 번에 확인합니다 — 관리자만 부를 수 있습니다
 * GET /api/selftest  → 쓰기·읽기·목록·지우기를 차례로 해보고 결과를 돌려줍니다
 */
import { isAdmin, SECRET } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (!SECRET()) { res.status(503).json({ error: "설정 전" }); return; }
  if (!isAdmin(req)) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

  const step = [];
  const path = "selftest/ping.json";
  try {
    const { put, get, list, del } = await import("@vercel/blob");
    const mark = Date.now();

    await put(path, JSON.stringify({ mark }), {
      access: "private", contentType: "application/json",
      addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
    });
    step.push("쓰기 성공");

    const got = await get(path, { access: "private", useCache: false });
    const back = got && got.statusCode === 200 ? JSON.parse(await new Response(got.stream).text()) : null;
    step.push(back && back.mark === mark ? "읽기 성공" : "읽기 실패");

    const { blobs } = await list({ prefix: "selftest/", limit: 5 });
    step.push(`목록 성공 (${blobs.length}건)`);

    await del(path);
    step.push("지우기 성공");

    res.status(200).json({ ok: true, step });
  } catch (e) {
    step.push("실패: " + (e?.name || "") + " " + (e?.message || ""));
    res.status(500).json({ ok: false, step });
  }
}
