import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// base64 파일을 텔레그램 창고(주인장 봇 대화방)에 업로드하고 보관증(file_id)을 받는다
async function uploadToTelegram(owner, f) {
  const buf = Buffer.from(f.data, 'base64');
  const isImage = (f.mime || '').startsWith('image/');
  const fd = new FormData();
  fd.append('chat_id', owner);
  fd.append('disable_notification', 'true');
  fd.append(isImage ? 'photo' : 'document', new Blob([buf], { type: f.mime || 'application/octet-stream' }), f.name || 'file');

  const r = await fetch(`${TG}/${isImage ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: fd }).then((x) => x.json());
  if (!r.ok) throw new Error('telegram upload failed: ' + JSON.stringify(r));

  if (isImage) {
    const best = r.result.photo[r.result.photo.length - 1];
    return { type: 'photo', file_id: best.file_id };
  }
  return {
    type: 'document',
    file_id: r.result.document.file_id,
    file_name: r.result.document.file_name || f.name || '파일',
    mime: r.result.document.mime_type || f.mime || '',
  };
}

export default async function handler(req, res) {
  const { key, title, body, category, isPrivate, files } = req.body || {};

  if (!process.env.VIEW_KEY || key !== process.env.VIEW_KEY) {
    return res.status(403).json({ error: 'wrong key' });
  }
  const owner = (process.env.OWNER_CHAT_ID || '').trim();
  if (!owner) return res.status(500).json({ error: 'OWNER_CHAT_ID not set' });

  // ── 글 삭제 (주인장만) ──
  if (req.method === 'DELETE') {
    const id = parseInt((req.body || {}).post_id, 10);
    if (!id) return res.status(400).json({ error: 'bad request' });
    try {
      await sql`DELETE FROM journal_posts WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'delete failed' });
    }
  }

  // ── 글 수정 (제목/본문/분류/공개 변경 + 새 첨부 추가, 주인장만) ──
  if (req.method === 'PUT') {
    const id = parseInt((req.body || {}).post_id, 10);
    const t2 = (title || '').trim();
    if (!id || !t2) return res.status(400).json({ error: 'bad request' });
    const cat2 = ['스터디', '일지', '콜'].includes(category) ? category : '일지';
    try {
      const newAtts = [];
      for (const f of (files || []).slice(0, 10)) {
        newAtts.push(await uploadToTelegram(owner, f));
      }
      const rows = await sql`
        UPDATE journal_posts
        SET title = ${t2}, body = ${(body || '').trim()}, category = ${cat2},
            is_private = ${Boolean(isPrivate)},
            attachments = attachments || ${JSON.stringify(newAtts)}::jsonb,
            updated_at = now()
        WHERE id = ${id}
        RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ ok: true, id });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'update failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const cat = ['스터디', '일지', '콜'].includes(category) ? category : '일지';
  const t = (title || '').trim();
  if (!t) return res.status(400).json({ error: 'title required' });

  try {
    const attachments = [];
    for (const f of (files || []).slice(0, 10)) {
      attachments.push(await uploadToTelegram(owner, f));
    }

    const rows = await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
      VALUES (${'web:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)},
              ${t}, ${(body || '').trim()}, ${cat}, ${Boolean(isPrivate)},
              ${JSON.stringify(attachments)}::jsonb, now())
      RETURNING id`;

    // 웹 발행 글의 전문을 텔레그램 기록으로도 남긴다 (무음)
    try {
      const digest = `🪵 웹 발행 · ${cat}${isPrivate ? ' 🔒' : ''}\n\n${t}\n\n${(body || '').trim()}`.slice(0, 3800);
      await fetch(`${TG}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: owner, text: digest, disable_notification: true }),
      });
    } catch {}

    return res.status(200).json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'write failed' });
  }
}
