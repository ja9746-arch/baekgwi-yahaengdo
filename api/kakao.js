/* 카카오 연결 — 한 번만 하면 됩니다
 *
 * GET /api/kakao?go=1   관리자가 누르면 카카오 동의 화면으로 보냅니다
 * GET /api/kakao?code=  카카오가 돌려보내는 자리. refresh token 을 받아 둡니다
 *
 * 돌아올 때는 다른 사이트에서 넘어오는 길이라 관리자 쿠키가 따라오지 않습니다.
 * 그래서 보낼 때 서명한 쪽지(state)를 들려 보내고, 돌아오면 그 서명을 봅니다.
 */
import { KAKAO_REDIRECT, isAdmin, putKakao, sign, verify, SECRET } from "./_lib.js";

const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#150a09;color:#e8dcc4;font-family:serif;text-align:center;padding:28px;line-height:1.9}
a{display:inline-block;margin-top:20px;padding:12px 22px;border:1px solid rgba(214,166,80,.6);
border-radius:10px;color:#f0cf86;text-decoration:none}b{color:#f0cf86}</style></head>
<body><div>${body}<br><a href="/admin.html">관리 화면으로</a></div></body></html>`;

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const key = process.env.KAKAO_REST_KEY || "";
  if (!SECRET() || !key) { res.status(503).send(page("준비 전", "카카오 설정이 아직 안 되어 있습니다.")); return; }

  const q = req.query || {};

  /* 1) 보내기 — 관리자만 */
  if (q.go) {
    if (!isAdmin(req)) { res.status(401).send(page("권한 없음", "관리자로 로그인하신 뒤에 눌러 주십시오.")); return; }
    const u = new URL("https://kauth.kakao.com/oauth/authorize");
    u.searchParams.set("client_id", key);
    u.searchParams.set("redirect_uri", KAKAO_REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "talk_message");
    u.searchParams.set("state", sign({ t: "kakao" }, 600));
    res.redirect(302, u.toString());
    return;
  }

  /* 2) 돌아오는 자리 */
  if (q.error) {
    res.status(200).send(page("연결 안 됨", `카카오에서 <b>${String(q.error).slice(0,60)}</b> 라고 돌려보냈습니다.<br>동의를 누르지 않으셨을 수 있습니다.`));
    return;
  }
  const code = String(q.code || "");
  const st = verify(String(q.state || ""));
  if (!code || !st || st.t !== "kakao") {
    res.status(400).send(page("연결 안 됨", "열쇠가 맞지 않거나 시간이 지났습니다.<br>관리 화면에서 다시 눌러 주십시오."));
    return;
  }

  try {
    const r = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: key, redirect_uri: KAKAO_REDIRECT, code }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      console.error("kakao token fail", r.status, j?.error, j?.error_description);
      res.status(200).send(page("연결 안 됨", `카카오가 열쇠를 주지 않았습니다.<br><b>${String(j?.error_description || j?.error || r.status).slice(0,80)}</b>`));
      return;
    }
    await putKakao({ refresh: j.refresh_token, at: Date.now(), broken: false, reason: null });
    res.status(200).send(page("연결됨", "카카오톡 알림이 <b>연결되었습니다</b>.<br>이제 문의가 들어오면 사장님 카톡으로 갑니다."));
  } catch (e) {
    console.error("kakao cb", e?.message);
    res.status(500).send(page("연결 안 됨", "연결하다 막혔습니다. 다시 눌러 주십시오."));
  }
}
