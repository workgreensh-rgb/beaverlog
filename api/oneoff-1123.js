import { neon } from '@neondatabase/serverless';

// 1회용 정리 (2026-11-23). 실행 후 삭제 예정
const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;
const NOTICE = "[비버의 저장소 · 태그 안내]\n\n#스터디 → 강의·책·공부 정리\n#시황 → 모닝브리프, 시장리뷰, 뉴스\n#생각 → 시장관, 부동산 관점, 투자 생각\n#매매 → 매매 기록, 반성 (비공개)\n#AI → AI 활용·자동화 기록\n#콜 → 콜 아이디어 (비공개)\n\n#비공개 를 함께 붙이면 그 글만 비공개\n체결 알림에 답장하면 매매 사유가 기록됨";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  try {
    const r = {};
    const del = await sql`DELETE FROM journal_posts WHERE category = '매매일지' AND title LIKE '[모의]%' AND tg_msg_id LIKE 'trade:%' RETURNING id, tg_msg_id`;
    r.모의삭제 = del.map((x) => x.id);
    for (const d of del) { try { await sql`DELETE FROM trade_links WHERE post_key = ${d.tg_msg_id}`; } catch {} }
    r.p75 = (await sql`UPDATE journal_posts SET title = '나의 투자 인사이트 운영 구조', category = 'AI', updated_at = now() WHERE id = 75 AND COALESCE(body, '') = '' RETURNING id, title, category`)[0] || null;
    r.p5 = (await sql`UPDATE journal_posts SET title = '매매 리뷰 원칙', updated_at = now() WHERE id = 5 AND title = '26/8/8' RETURNING id, title, category`)[0] || null;
    const owner = (process.env.OWNER_CHAT_ID || '').trim();
    if (owner && process.env.TG_TOKEN && req.query.notice === '1') {
      const s = await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: owner, text: NOTICE }) }).then((x) => x.json());
      r.공지전송 = Boolean(s.ok);
      if (s.ok) {
        const p = await fetch(`${TG}/pinChatMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: owner, message_id: s.result.message_id, disable_notification: true }) }).then((x) => x.json());
        r.공지고정 = Boolean(p.ok); if (!p.ok) r.고정오류 = p.description;
      } else r.전송오류 = s.description;
    }
    r.분류별 = await sql`SELECT category, COUNT(*)::int AS n FROM journal_posts GROUP BY category ORDER BY category`;
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
