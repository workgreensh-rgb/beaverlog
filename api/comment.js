import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { post_id, nickname, body } = req.body || {};
      const id = parseInt(post_id, 10);
      const nick = (nickname || '').trim().slice(0, 20) || '익명';
      const text = (body || '').trim();
      if (!id || !text) return res.status(400).json({ error: 'bad request' });
      if (text.length > 1000) return res.status(400).json({ error: 'too long' });

      const post = await sql`SELECT id FROM journal_posts WHERE id = ${id}`;
      if (!post.length) return res.status(404).json({ error: 'not found' });

      const rows = await sql`
        INSERT INTO journal_comments (post_id, nickname, body)
        VALUES (${id}, ${nick}, ${text})
        RETURNING id, post_id, nickname, body, created_at`;
      return res.status(200).json({ ok: true, comment: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { comment_id, key } = req.body || {};
      if (!process.env.VIEW_KEY || key !== process.env.VIEW_KEY) {
        return res.status(403).json({ error: 'locked' });
      }
      const cid = parseInt(comment_id, 10);
      if (!cid) return res.status(400).json({ error: 'bad request' });
      await sql`DELETE FROM journal_comments WHERE id = ${cid}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db error' });
  }
}
