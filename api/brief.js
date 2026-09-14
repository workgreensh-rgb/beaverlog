import { neon } from '@neondatabase/serverless';

// 모닝브리프 릴레이
// GET /api/brief?key=<VIEW_KEY>&t=<base64url(UTF-8 본문)>
// - 본문을 beaverlog_bot 명의로 OWNER_CHAT_ID에 텔레그램 DM 발송
// - journal_posts에 category '모닝브리프'로 저장 (같은 날 재실행 시 덮어씀)
// 선택 인자: &p=0 → 공개 저장 (기본은 비공개)

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

// req.query가 비어 있어도 원본 URL에서 직접 파싱 (도구별 쿼리 처리 차이 대비)
function readQuery(req) {
  const q = { ...(req.query || {}) };
  try {
    const u = new URL(req.url || '', 'http://local');
    for (const [k, v] of u.searchParams.entries()) if (!(k in q)) q[k] = v;
  } catch {}
  return q;
}

function decodeText(q) {
  if (q.t) {
    let s = String(q.t).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
  }
  if (q.text) return String(q.text);
  return '';
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const q = readQuery(req);
  const key = String(q.key || '');
  if (!process.env.VIEW_KEY || key !== process.env.VIEW_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const text = decodeText(q).trim();
  if (!text) {
    // 진단용: 무엇이 도착했는지 그대로 알려준다 (200으로 응답해 도구가 본문을 읽게 함)
    return res.status(200).json({
      ok: false,
      error: 'empty text',
      received_params: Object.keys(q),
      t_length: q.t ? String(q.t).length : 0,
      url_length: (req.url || '').length,
    });
  }

  const owner = (process.env.OWNER_CHAT_ID || '').trim();
  const out = { ok: true, telegram: false, saved: false, chars: text.length };

  try {
    if (owner && process.env.TG_TOKEN) {
      out.telegram = await sendTelegram(owner, text);
    }
  } catch (e) {
    console.error('telegram error', e);
  }

  try {
    const lines = text.split('\n');
    const first = (lines[0] || '').replace(/#모닝브리프/g, '').trim();
    const title = first ? `모닝브리프 ${first}` : `모닝브리프 ${seoulDate()}`;
    const body = lines.slice(1).join('\n').trim();
    const isPrivate = String(q.p || '1') !== '0';
    const tgMsgId = `brief:${seoulDate()}`;

    await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
      VALUES (${tgMsgId}, ${title}, ${body}, ${'모닝브리프'}, ${isPrivate}, ${'[]'}::jsonb, now())
      ON CONFLICT (tg_msg_id) DO UPDATE
      SET title = EXCLUDED.title, body = EXCLUDED.body,
          is_private = EXCLUDED.is_private, updated_at = now()`;
    out.saved = true;
  } catch (e) {
    console.error('db error', e);
  }

  return res.status(200).json(out);
}
