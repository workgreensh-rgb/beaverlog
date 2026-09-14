import { neon } from '@neondatabase/serverless';

// 모닝브리프 릴레이 (조각 전송 지원)
// 단일:  GET /b/<VIEW_KEY>/<base64url 본문>
// 조각:  GET /b/<VIEW_KEY>/<묶음ID>/<번호>/<총개수>/<base64url 조각>
//        같은 묶음ID로 총개수만큼 도착하면 합쳐서 발송·저장
// - 본문을 beaverlog_bot 명의로 OWNER_CHAT_ID에 텔레그램 DM 발송
// - journal_posts에 category '모닝브리프'로 저장 (같은 날 재실행 시 덮어씀, 기본 비공개)

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

function readQuery(req) {
  const q = { ...(req.query || {}) };
  try {
    const u = new URL(req.url || '', 'http://local');
    for (const [k, v] of u.searchParams.entries()) if (!(k in q)) q[k] = v;
  } catch {}
  return q;
}

function b64urlDecode(s) {
  let t = String(s).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64').toString('utf8');
}

function seoulDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
}

async function sendTelegram(chatId, text) {
  const chunks = [];
  let rest = text;
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf('\n', 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  chunks.push(rest);
  const results = [];
  for (const chunk of chunks) {
    const r = await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    results.push(Boolean(j.ok));
  }
  return results.every(Boolean);
}

async function publish(text, isPrivate) {
  const out = { ok: true, telegram: false, saved: false, chars: text.length };
  const owner = (process.env.OWNER_CHAT_ID || '').trim();
  try {
    if (owner && process.env.TG_TOKEN) out.telegram = await sendTelegram(owner, text);
  } catch (e) { console.error('telegram error', e); }
  try {
    const lines = text.split('\n');
    const first = (lines[0] || '').replace(/#모닝브리프/g, '').trim();
    const title = first ? `모닝브리프 ${first}` : `모닝브리프 ${seoulDate()}`;
    const body = lines.slice(1).join('\n').trim();
    const tgMsgId = `brief:${seoulDate()}`;
    await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
      VALUES (${tgMsgId}, ${title}, ${body}, ${'모닝브리프'}, ${isPrivate}, ${'[]'}::jsonb, now())
      ON CONFLICT (tg_msg_id) DO UPDATE
      SET title = EXCLUDED.title, body = EXCLUDED.body,
          is_private = EXCLUDED.is_private, updated_at = now()`;
    out.saved = true;
  } catch (e) { console.error('db error', e); }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const q = readQuery(req);
  if (!process.env.VIEW_KEY || String(q.key || '') !== process.env.VIEW_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const isPrivate = String(q.p || '1') !== '0';

  // ── 조각 모드 ──
  if (q.id && q.n && q.total) {
    const id = String(q.id).slice(0, 64);
    const n = parseInt(q.n, 10);
    const total = parseInt(q.total, 10);
    const chunk = String(q.t || '');
    if (!n || !total || n < 1 || n > total || total > 40 || !chunk) {
      return res.status(200).json({ ok: false, error: 'bad chunk params', id, n, total, chunk_length: chunk.length });
    }
    try {
      await sql`CREATE TABLE IF NOT EXISTS brief_chunks (
        id text NOT NULL, n int NOT NULL, total int NOT NULL, chunk text NOT NULL,
        created_at timestamptz DEFAULT now(), PRIMARY KEY (id, n))`;
      await sql`INSERT INTO brief_chunks (id, n, total, chunk) VALUES (${id}, ${n}, ${total}, ${chunk})
                ON CONFLICT (id, n) DO UPDATE SET chunk = EXCLUDED.chunk, total = EXCLUDED.total`;
      const rows = await sql`SELECT n, chunk FROM brief_chunks WHERE id = ${id} ORDER BY n`;
      if (rows.length < total) {
        return res.status(200).json({ ok: true, stored: n, have: rows.length, total });
      }
      const text = b64urlDecode(rows.map((r) => r.chunk).join('')).trim();
      await sql`DELETE FROM brief_chunks WHERE id = ${id}`;
      await sql`DELETE FROM brief_chunks WHERE created_at < now() - interval '2 days'`;
      if (!text) return res.status(200).json({ ok: false, error: 'empty after join', id });
      const out = await publish(text, isPrivate);
      return res.status(200).json({ ...out, assembled: total });
    } catch (e) {
      console.error('chunk error', e);
      return res.status(200).json({ ok: false, error: 'chunk db error' });
    }
  }

  // ── 단일 모드 ──
  const text = (q.t ? b64urlDecode(q.t) : String(q.text || '')).trim();
  if (!text) {
    return res.status(200).json({
      ok: false, error: 'empty text',
      received_params: Object.keys(q), t_length: q.t ? String(q.t).length : 0,
    });
  }
  return res.status(200).json(await publish(text, isPrivate));
}
