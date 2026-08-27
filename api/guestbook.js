import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, nickname, body, created_at
        FROM journal_guestbook
        ORDER BY created_at DESC
        LIMIT 100`;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ entries: rows });
    }

    if (req.method === 'POST') {
      const { nickname, body } = req.body || {};
      const nick = (nickname || '').trim();
      const text = (body || '').trim();

      if (!/^[가-힣a-zA-Z]{1,12}$/.test(nick)) {
        return res.status(400).json({ error: 'bad nickname' });
      }
      if (!text || text.length > 500) {
        return res.status(400).json({ error: 'bad body' });
      }

      const rows = await sql`
        INSERT INTO journal_guestbook (nickname, pin, body)
        VALUES (${nick}, ${''}, ${text})
        RETURNING id, nickname, body, created_at`;
      return res.status(200).json({ ok: true, entry: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { entry_id, pin } = req.body || {};
      const id = parseInt(entry_id, 10);
      if (!id || !pin) return res.status(400).json({ error: 'bad request' });

      // 삭제는 주인장만
      if (!process.env.VIEW_KEY || pin !== process.env.VIEW_KEY) {
        return res.status(403).json({ error: 'wrong pin' });
      }

      await sql`DELETE FROM journal_guestbook WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db error' });
  }
}
