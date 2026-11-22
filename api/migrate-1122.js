import { neon } from '@neondatabase/serverless';

// 1회용 분류 재편 (2026-11-22). 실행 후 삭제 예정. 같은 내용을 다시 실행해도 결과 동일
const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  try {
    const ids = (rows) => rows.map((r) => r.id);
    const r = {};
    r.시황 = ids(await sql`UPDATE journal_posts SET category = '시황', updated_at = now() WHERE id IN (79, 72, 70, 69, 67, 66, 55, 51, 46, 29) OR category = '모닝브리프' RETURNING id`);
    r.매매일지 = ids(await sql`UPDATE journal_posts SET category = '매매일지', updated_at = now() WHERE id IN (68, 19) RETURNING id`);
    r.스터디 = ids(await sql`UPDATE journal_posts SET category = '스터디', updated_at = now() WHERE id = 8 AND category = '일지' RETURNING id`);
    r.생각 = ids(await sql`UPDATE journal_posts SET category = '생각', updated_at = now() WHERE category = '일지' RETURNING id`);
    r.삭제 = ids(await sql`DELETE FROM journal_posts WHERE id = 48 AND COALESCE(body, '') = '' AND COALESCE(attachments, '[]'::jsonb) = '[]'::jsonb RETURNING id`);
    r.분류별 = await sql`SELECT category, COUNT(*)::int AS n FROM journal_posts GROUP BY category ORDER BY category`;
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
