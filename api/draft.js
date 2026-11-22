// 초안 접수: 예약 작업(모닝브리프·데일리뉴스)이 호출
//   POST /api/draft   JSON { "kind": "brief" | "news", "text": "<전문>" }
// 초안은 주인이 텔레그램에서 [발행]을 눌러야 공개되므로 별도 키 없이 받되,
// 하루 접수 건수와 길이를 제한한다.
//   GET  /api/draft?check=1  → 봇 웹훅이 버튼(callback_query)을 받는지 점검
import { sql, ensureDraftTables, sendPreview, tg, KINDS } from './_draft.js';

const DAILY_LIMIT = 12;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const owner = (process.env.OWNER_CHAT_ID || '').trim();

  if (req.method === 'GET' && req.query && req.query.check === '1') {
    const j = await tg('getWebhookInfo', {});
    const r = j.result || {};
    return res.status(200).json({
      ok: Boolean(j.ok),
      allowed_updates: r.allowed_updates || '(기본값: 전체)',
      pending_update_count: r.pending_update_count,
      last_error_message: r.last_error_message || null,
    });
  }
  // 웹훅이 버튼(callback_query)도 받도록 설정 보강 (기존 URL·비밀 헤더 유지, 같은 결과로 여러 번 실행 가능)
  if (req.method === 'GET' && req.query && req.query.fix === '1') {
    const info = await tg('getWebhookInfo', {});
    const r = info.result || {};
    if (!r.url) return res.status(200).json({ ok: false, error: 'webhook url not set' });
    const cur = Array.isArray(r.allowed_updates) && r.allowed_updates.length ? r.allowed_updates : ['message', 'edited_message'];
    const want = Array.from(new Set([...cur, 'callback_query']));
    const payload = { url: r.url, allowed_updates: want };
    if (process.env.TG_SECRET) payload.secret_token = process.env.TG_SECRET;
    const s = await tg('setWebhook', payload);
    return res.status(200).json({ ok: Boolean(s.ok), allowed_updates: want, description: s.description || null });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!owner || !process.env.TG_TOKEN) return res.status(500).json({ ok: false, error: 'bot not configured' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const kind = String(b.kind || '');
  const text = String(b.text || '').replace(/\r/g, '').trim();
  if (!KINDS[kind]) return res.status(400).json({ ok: false, error: 'kind must be brief or news' });
  if (text.length < 20 || text.length > 12000) return res.status(400).json({ ok: false, error: 'text length 20~12000' });

  try {
    await ensureDraftTables();
    const today = await sql`SELECT COUNT(*)::int AS n FROM drafts WHERE created_at > now() - interval '24 hours'`;
    if (today[0].n >= DAILY_LIMIT) return res.status(429).json({ ok: false, error: 'daily limit' });

    // 같은 종류의 대기 중 초안은 새 초안으로 대체 (버튼 제거)
    const old = await sql`UPDATE drafts SET status = 'replaced', updated_at = now()
                          WHERE kind = ${kind} AND status = 'pending' RETURNING id`;
    for (const o of old) {
      const rows = await sql`SELECT bot_msg_id FROM draft_msgs WHERE draft_id = ${o.id} AND has_buttons = true`;
      for (const r of rows) await tg('editMessageReplyMarkup', { chat_id: owner, message_id: Number(r.bot_msg_id), reply_markup: { inline_keyboard: [] } });
      await sql`UPDATE draft_msgs SET has_buttons = false WHERE draft_id = ${o.id}`;
    }

    const ins = await sql`INSERT INTO drafts (kind, text) VALUES (${kind}, ${text}) RETURNING id, kind, text, status`;
    const ids = await sendPreview(owner, ins[0]);
    return res.status(200).json({ ok: true, id: ins[0].id, sent: ids.length, replaced: old.map((o) => o.id) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
