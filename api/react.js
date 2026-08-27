import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { post_id, action } = req.body || {};
  const id = parseInt(post_id, 10);
  if (!id || !['like', 'unlike'].includes(action)) return res.status(400).json({ error: 'bad request' });

  try {
    const delta = action === 'like' ? 1 : -1;
    const rows = await sql`
      UPDATE journal_posts
      SET likes = GREATEST(likes + ${delta}, 0)
      WHERE id = ${id}
      RETURNING likes`;
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ ok: true, likes: rows[0].likes });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db error' });
  }
}
