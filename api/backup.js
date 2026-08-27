import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('method not allowed');

  const key = (req.query.key || '').toString();
  if (!process.env.VIEW_KEY || key !== process.env.VIEW_KEY) {
    return res.status(403).send('locked');
  }

  try {
    const rows = await sql`
      SELECT id, tg_msg_id, title, body, category, is_private, attachments, posted_at, updated_at
      FROM journal_posts
      ORDER BY posted_at ASC`;

    const payload = {
      site: 'beaverlog',
      exported_at: new Date().toISOString(),
      post_count: rows.length,
      note: '이 파일 하나로 전체 복원이 가능합니다. attachments의 file_id는 텔레그램 창고 보관증입니다.',
      posts: rows,
    };

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="beaverlog-backup-${stamp}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error(e);
    return res.status(500).send('backup failed');
  }
}
