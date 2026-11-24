import { neon } from '@neondatabase/serverless';
import perfHandler from './_perfhandler.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  // 공개 수익률: /api/performance → /api/posts?view=performance (Vercel Hobby 함수 12개 제한 때문에 합침)
  if ((req.query.view || '') === 'performance') return perfHandler(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = (req.query.key || '').toString();
  const unlocked = Boolean(process.env.VIEW_KEY) && key === process.env.VIEW_KEY;

  try {
    const rows = await sql`
      SELECT id, title, body, category, is_private, attachments, likes, posted_at, updated_at
      FROM journal_posts
      ORDER BY posted_at DESC
      LIMIT 300`;

    const ids = rows.map((r) => r.id);
    let commentMap = {};
    if (ids.length) {
      const cs = await sql`
        SELECT id, post_id, nickname, body, created_at
        FROM journal_comments
        WHERE post_id = ANY(${ids})
        ORDER BY created_at ASC`;
      for (const c of cs) {
        (commentMap[c.post_id] = commentMap[c.post_id] || []).push(c);
      }
    }

    const posts = rows.map((r) => {
      if (r.is_private && !unlocked) {
        return {
          id: r.id,
          category: r.category,
          is_private: true,
          locked: true,
          posted_at: r.posted_at,
        };
      }
      return {
        id: r.id,
        title: r.title,
        body: r.body,
        category: r.category,
        is_private: r.is_private,
        locked: false,
        attachments: r.attachments || [],
        likes: r.likes || 0,
        comments: commentMap[r.id] || [],
        posted_at: r.posted_at,
        updated_at: r.updated_at,
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ unlocked, posts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db error' });
  }
}
