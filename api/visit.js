import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

async function readCounts() {
  const rows = await sql`
    SELECT
      COALESCE((SELECT count FROM journal_visits
                WHERE day = (now() AT TIME ZONE 'Asia/Seoul')::date), 0) AS today,
      COALESCE((SELECT SUM(count) FROM journal_visits), 0) AS total`;
  return { today: Number(rows[0].today), total: Number(rows[0].total) };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      await sql`
        INSERT INTO journal_visits (day, count)
        VALUES ((now() AT TIME ZONE 'Asia/Seoul')::date, 1)
        ON CONFLICT (day) DO UPDATE SET count = journal_visits.count + 1`;
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await readCounts());
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'db error' });
  }
}
