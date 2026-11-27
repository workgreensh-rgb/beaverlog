// 모닝브리프·데일리뉴스 초안 → 텔레그램 승인 → 발행 (공용 함수)
// 흐름: 예약 작업이 /api/draft 로 초안 전송 → 봇이 주인에게 [발행][폐기] 버튼과 함께 보냄
//       초안 메시지에 '답장'으로 고친 전문을 보내면 수정본으로 교체
//       [발행] → 최종본을 봇 DM으로 다시 보내고 비버로그 '시황'에 저장
import { neon } from '@neondatabase/serverless';
import { MANAGER_KINDS } from './_manager.js';

export const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

export const KINDS = { brief: '모닝브리프', news: '데일리뉴스', ...MANAGER_KINDS };

export async function ensureDraftTables() {
  await sql`CREATE TABLE IF NOT EXISTS drafts (
    id serial PRIMARY KEY,
    kind text NOT NULL,
    text text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS draft_msgs (
    bot_msg_id bigint PRIMARY KEY,
    draft_id int NOT NULL,
    has_buttons boolean DEFAULT false
  )`;
}

export async function tg(method, payload) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false }));
}

export function seoulDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
}

export function splitText(text, max = 3900) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < 1000) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  out.push(rest);
  return out;
}

// 초안 미리보기 전송 (마지막 조각에 버튼)
export async function sendPreview(owner, draft, note) {
  const head = `📝 [초안] ${KINDS[draft.kind] || draft.kind} #${draft.id}${note ? ' · ' + note : ''}\n수정하려면 이 메시지에 고친 전문을 답장하세요.\n────────\n`;
  const parts = splitText(head + draft.text);
  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const payload = { chat_id: owner, text: parts[i], disable_web_page_preview: true };
    if (last) {
      payload.reply_markup = {
        inline_keyboard: [[
          { text: '✅ 발행', callback_data: `dpub:${draft.id}` },
          { text: '🗑 폐기', callback_data: `ddel:${draft.id}` },
        ]],
      };
    }
    const j = await tg('sendMessage', payload);
    if (j.ok) {
      ids.push(j.result.message_id);
      await sql`INSERT INTO draft_msgs (bot_msg_id, draft_id, has_buttons) VALUES (${j.result.message_id}, ${draft.id}, ${last})
                ON CONFLICT (bot_msg_id) DO NOTHING`;
    }
  }
  return ids;
}

// 이전 미리보기의 버튼 제거
export async function clearButtons(owner, draftId) {
  const rows = await sql`SELECT bot_msg_id FROM draft_msgs WHERE draft_id = ${draftId} AND has_buttons = true`;
  for (const r of rows) {
    await tg('editMessageReplyMarkup', { chat_id: owner, message_id: Number(r.bot_msg_id), reply_markup: { inline_keyboard: [] } });
  }
  await sql`UPDATE draft_msgs SET has_buttons = false WHERE draft_id = ${draftId}`;
}

// 첫 줄로 비버로그 제목 만들기
export function titleOf(kind, text) {
  if (MANAGER_KINDS[kind]) return (String(text).split('\n')[0] || '').replace(/^#콜\s*/, '').trim();
  const first = (String(text).split('\n')[0] || '').replace(/^#\s*/, '').trim();
  if (kind === 'brief') {
    const t = first.replace(/^모닝브리프\s*/, '').trim();
    return `모닝브리프 ${t || seoulDate()}`;
  }
  return first || `주요뉴스 ${seoulDate()}`;
}

// 발행: 최종본 DM + 비버로그 시황 저장 (같은 날 같은 종류는 덮어씀)
export async function publishDraft(owner, draft) {
  const out = { telegram: false, saved: false };
  let okAll = true;
  for (const part of splitText(draft.text)) {
    const j = await tg('sendMessage', { chat_id: owner, text: part, disable_web_page_preview: true });
    okAll = okAll && Boolean(j.ok);
  }
  out.telegram = okAll;
  const lines = String(draft.text).split('\n');
  const title = titleOf(draft.kind, draft.text);
  const body = lines.slice(1).join('\n').trim();
  const managerCall = Boolean(MANAGER_KINDS[draft.kind]);
  const key = managerCall ? `draft:${draft.kind}:${draft.id}` : `draft:${draft.kind}:${seoulDate()}`;
  await sql`
    INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
    VALUES (${key}, ${title}, ${body}, ${managerCall ? '콜' : '시황'}, ${managerCall}, '[]'::jsonb, now())
    ON CONFLICT (tg_msg_id) DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, category = EXCLUDED.category,
        is_private = EXCLUDED.is_private, updated_at = now()`;
  out.saved = true;
  await sql`UPDATE drafts SET status = 'published', updated_at = now() WHERE id = ${draft.id}`;
  return out;
}

// webhook.js에서 호출: 버튼 처리. 처리했으면 true
export async function handleDraftCallback(update, owner) {
  const cq = update.callback_query;
  if (!cq || !/^d(pub|del):\d+$/.test(cq.data || '')) return false;
  if (String(cq.from && cq.from.id) !== owner) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '권한 없음' });
    return true;
  }
  await ensureDraftTables();
  const [act, idStr] = cq.data.split(':');
  const id = parseInt(idStr, 10);
  const rows = await sql`SELECT id, kind, text, status FROM drafts WHERE id = ${id}`;
  if (!rows.length) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '초안을 찾을 수 없어요' });
    return true;
  }
  const d = rows[0];
  if (d.status !== 'pending') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: d.status === 'published' ? '이미 발행됨' : '이미 폐기됨' });
    await clearButtons(owner, id);
    return true;
  }
  if (act === 'dpub' && MANAGER_KINDS[d.kind] && d.text.includes('[작성 필요]')) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '작성 필요 항목을 모두 채운 뒤 답장해 주세요', show_alert: true });
    return true;
  }
  if (act === 'ddel') {
    await sql`UPDATE drafts SET status = 'discarded', updated_at = now() WHERE id = ${id}`;
    await clearButtons(owner, id);
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '폐기했어요' });
    await tg('sendMessage', { chat_id: owner, text: `🗑 ${KINDS[d.kind] || d.kind} 초안 #${id} 폐기` });
    return true;
  }
  await clearButtons(owner, id);
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '발행 중…' });
  const r = await publishDraft(owner, d);
  await tg('sendMessage', {
    chat_id: owner,
    text: `🦫 ${KINDS[d.kind] || d.kind} 발행 완료 · 비버로그 ${MANAGER_KINDS[d.kind] ? '콜 · 비공개 🔒' : '시황'}${r.telegram ? '' : ' (최종본 DM 일부 실패)'}`,
  });
  return true;
}

// webhook.js에서 호출: 초안 메시지에 대한 답장(수정본). 처리했으면 true
export async function handleDraftReply(msg, owner) {
  if (!msg.reply_to_message) return false;
  const text = (msg.text || '').trim();
  if (!text) return false;
  let link = [];
  try {
    link = await sql`SELECT draft_id FROM draft_msgs WHERE bot_msg_id = ${msg.reply_to_message.message_id}`;
  } catch { return false; } // 테이블 없음 → 일반 처리
  if (!link.length) return false;
  const id = link[0].draft_id;
  const rows = await sql`SELECT id, kind, text, status FROM drafts WHERE id = ${id}`;
  if (!rows.length) return false;
  if (rows[0].status !== 'pending') {
    await tg('sendMessage', { chat_id: owner, text: `이 초안(#${id})은 이미 ${rows[0].status === 'published' ? '발행' : '폐기'}되어 수정할 수 없어요.` });
    return true;
  }
  if (text.length < 20) {
    await tg('sendMessage', { chat_id: owner, text: '수정본이 너무 짧아요. 고친 전문을 통째로 답장해 주세요.' });
    return true;
  }
  await sql`UPDATE drafts SET text = ${text}, updated_at = now() WHERE id = ${id}`;
  await clearButtons(owner, id);
  await sendPreview(owner, { ...rows[0], text }, '수정본');
  return true;
}
