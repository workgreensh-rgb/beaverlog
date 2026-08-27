import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}`;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('method not allowed');

  const fid = (req.query.fid || '').toString();
  if (!fid) return res.status(400).send('missing fid');

  try {
    // 이 file_id가 속한 글의 공개 여부 확인 (비공개 글 첨부는 VIEW_KEY 필요)
    const rows = await sql`
      SELECT p.is_private
      FROM journal_posts p, jsonb_array_elements(p.attachments) a
      WHERE a->>'file_id' = ${fid}
      LIMIT 1`;
    if (!rows.length) return res.status(404).send('not found');

    if (rows[0].is_private) {
      const key = (req.query.key || '').toString();
      const unlocked = Boolean(process.env.VIEW_KEY) && key === process.env.VIEW_KEY;
      if (!unlocked) return res.status(403).send('locked');
    }

    // 텔레그램에서 실제 파일 경로 조회 후 중계
    const info = await fetch(`${TG}/getFile?file_id=${encodeURIComponent(fid)}`).then((r) => r.json());
    if (!info.ok || !info.result?.file_path) return res.status(502).send('telegram file error');

    const fileRes = await fetch(`${TG_FILE}/${info.result.file_path}`);
    if (!fileRes.ok) return res.status(502).send('telegram fetch error');

    const buf = Buffer.from(await fileRes.arrayBuffer());
    const ct = fileRes.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const dl = (req.query.name || '').toString();
    if (dl) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`);
    }
    return res.status(200).send(buf);
  } catch (e) {
    console.error(e);
    return res.status(500).send('server error');
  }
}
