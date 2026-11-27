import { neon } from '@neondatabase/serverless';
import { handleDraftCallback, handleDraftReply, ensureDraftTables, sendPreview } from './_draft.js';
import { ownerCallTemplate } from './_manager.js';

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

async function reply(chatId, text) {
  if (!process.env.TG_TOKEN) return;
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// 글 전체에서 태그 탐지: #스터디 / #시황 / #생각(#일지·#일기도 인식) / #매매(비공개) / #AI / #콜(비공개) / #비공개
// #모닝브리프·#시장리뷰·#뉴스 는 지우지 않고 시황으로 분류
// "26/8/27 #콜", "…샀음 #콜," 처럼 어디에 어떤 형태로 붙어 있어도 인식하고,
// 태그는 지운 뒤 남는 첫 줄을 제목, 나머지를 본문으로 쓴다
function parseTags(rawText) {
  const TAG_RE = /#(스터디|study|시황|생각|일지|일기|diary|매매일지|매매|AI|콜|call|비공개|private)(?![가-힣a-zA-Z0-9])/gi;
  let category = null;
  let forcePrivate = false;

  const found = (rawText || '').match(TAG_RE) || [];
  const hadTagLine = found.length > 0;
  for (const t of found) {
    const tag = t.toLowerCase();
    if (tag === '#비공개' || tag === '#private') { forcePrivate = true; continue; }
    if (category) continue; // 카테고리는 먼저 나온 태그 우선
    if (tag === '#스터디' || tag === '#study') category = '스터디';
    else if (tag === '#시황') category = '시황';
    else if (tag === '#생각' || tag === '#일지' || tag === '#일기' || tag === '#diary') category = '생각';
    else if (tag === '#매매' || tag === '#매매일지') category = '매매일지';
    else if (tag === '#ai') category = 'AI';
    else if (tag === '#콜' || tag === '#call') category = '콜';
  }

  if (!category && /#(모닝브리프|시장리뷰|뉴스)/.test(rawText || '')) category = '시황';
  if (!category) category = '생각';
  // 콜만 기본 비공개, 스터디·일지는 기본 공개 (#비공개 태그로 개별 잠금 가능)
  const isPrivate = category === '콜' || category === '매매일지' ? true : forcePrivate;

  let lines = (rawText || '').replace(TAG_RE, '').split('\n').map((l) => l.trim());
  while (lines.length && !lines[0]) lines = lines.slice(1);
  const title = (lines[0] || '').trim();
  const body = lines.slice(1).join('\n').trim();

  return { category, isPrivate, title, body, hadTagLine };
}

// 메시지에서 첨부 추출 (사진은 가장 큰 해상도 하나만)
function extractAttachment(msg) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: 'photo', file_id: best.file_id };
  }
  if (msg.document) {
    return {
      type: 'document',
      file_id: msg.document.file_id,
      file_name: msg.document.file_name || '파일',
      mime: msg.document.mime_type || '',
      size: msg.document.file_size || 0,
    };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const update = req.body || {};

  // ── 모닝브리프·데일리뉴스 초안의 [발행]/[폐기] 버튼 ──
  if (update.callback_query) {
    try { await handleDraftCallback(update, (process.env.OWNER_CHAT_ID || '').trim()); } catch (e) { console.error('draft callback', e); }
    return res.status(200).send('ok');
  }
  const msg = update.message || update.edited_message;
  const isEdit = Boolean(update.edited_message);

  if (!msg || !msg.chat || msg.chat.type !== 'private') {
    return res.status(200).send('ok');
  }

  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';
  const attachment = extractAttachment(msg);

  try {
    const owner = (process.env.OWNER_CHAT_ID || '').trim();
    if (!owner) {
      await reply(
        chatId,
        `🦫 아직 주인 등록이 안 됐어요.\n\n당신의 chat_id는 ${chatId} 입니다.\n이 숫자를 Vercel 환경변수 OWNER_CHAT_ID에 넣고 Redeploy 하면, 그때부터 보내는 글이 비버의 저장소에 쌓입니다.`
      );
      return res.status(200).send('ok');
    }
    if (String(chatId) !== owner) return res.status(200).send('ok');

    // 주인이 텔레그램에서 직접 작성하는 콜도 기존 초안 승인 흐름으로 보냄.
    if (!isEdit) {
      const template = ownerCallTemplate(text);
      if (template) {
        await ensureDraftTables();
        const drafts = await sql`INSERT INTO drafts (kind, text) VALUES (${template.kind}, ${template.text}) RETURNING id, kind, text, status`;
        await sendPreview(owner, drafts[0]);
        return res.status(200).send('ok');
      }
    }

    // ── 초안 메시지에 "답장"하면 수정본으로 교체 ──
    if (msg.reply_to_message && !isEdit && (await handleDraftReply(msg, owner))) return res.status(200).send('ok');

    // ── 체결 알림(trade.js)에 "답장"하면 그 매매일지의 사유 칸을 채움 ──
    if (msg.reply_to_message && text.trim() && !isEdit) {
      let link = [];
      try {
        link = await sql`SELECT post_key FROM trade_links WHERE bot_msg_id = ${msg.reply_to_message.message_id}`;
      } catch { link = []; } // 아직 trade_links 테이블이 없으면 일반 저장으로 진행
      if (link.length) {
        const key = link[0].post_key;
        const rows = await sql`SELECT body FROM journal_posts WHERE tg_msg_id = ${key}`;
        if (rows.length) {
          const reason = text.trim();
          const old = rows[0].body || '';
          const next = old.includes('[사유] (답장 대기)')
            ? old.replace('[사유] (답장 대기)', `[사유] ${reason}`)
            : old.replace(/\n---\n/, `\n[추가 메모] ${reason}\n---\n`);
          await sql`UPDATE journal_posts SET body = ${next}, updated_at = now() WHERE tg_msg_id = ${key}`;
          await reply(chatId, '🦫 매매일지에 사유 기록 완료 · 비공개 🔒');
          return res.status(200).send('ok');
        }
      }
    }

    if (text.trim() === '/start') {
      await reply(
        chatId,
        `🦫 비버의 아카이브\nhttps://beaverlog-gamma.vercel.app/\n\n비버의 저장소입니다.\n\n[바로 저장하는 태그]\n#스터디 → 스터디 · 공개\n#시황 / #모닝브리프 / #시장리뷰 / #뉴스 → 시황 · 공개\n#생각 → 생각 · 공개 (태그 없어도 생각 · 공개)\n#매매 / #매매일지 → 매매일지 · 비공개\n#AI → AI · 공개\n#콜 → 콜 · 비공개 (승인 없이 바로 저장)\n#비공개 → 선택한 분류를 비공개로 저장\n\n[수정·승인 후 저장하는 콜 초안]\n#비중콜초안 업종명\n#종목콜초안 종목명\n#주가콜초안 종목명\n초안 메시지에 고친 전문을 답장하고 ✅ 발행을 누르세요. 작성 필요 항목이 남아 있으면 발행되지 않습니다. 발행 후 본인 DM과 비버로그 콜에 비공개로 남으며 매니저에게 자동 전송되지 않습니다.\n\n바로 저장하는 글은 태그 다음 줄이 제목, 그 아래가 본문입니다. 사진 여러 장을 보내면 한 글로 묶입니다. 보낸 글을 수정하면 사이트에도 반영됩니다.`
      );
      return res.status(200).send('ok');
    }

    if (!text.trim() && !attachment) {
      await reply(chatId, '🦫 글, 사진, 파일만 저장할 수 있어요.');
      return res.status(200).send('ok');
    }

    const { category, isPrivate, title, body, hadTagLine } = parseTags(text);
    const attJson = JSON.stringify(attachment ? [attachment] : []);

    // ── 앨범(사진 여러 장): media_group_id 로 한 글에 묶기 ──
    if (msg.media_group_id) {
      const groupKey = `grp:${chatId}:${msg.media_group_id}`;
      const existing = await sql`SELECT id, title, body FROM journal_posts WHERE tg_msg_id = ${groupKey}`;

      if (existing.length) {
        // 이미 만들어진 앨범 글에 사진만 추가. 캡션이 이 조각에 붙어 왔으면 제목/본문/분류도 채움
        const hasCaption = Boolean(text.trim());
        const needTitle = hasCaption && (!existing[0].title || existing[0].title === '(제목 없음)');
        if (needTitle) {
          await sql`
            UPDATE journal_posts
            SET attachments = attachments || ${attJson}::jsonb,
                title = ${title || '(제목 없음)'}, body = ${body},
                category = ${hadTagLine ? category : '생각'},
                is_private = ${hadTagLine ? isPrivate : false},
                updated_at = now()
            WHERE tg_msg_id = ${groupKey}`;
        } else {
          await sql`
            UPDATE journal_posts
            SET attachments = attachments || ${attJson}::jsonb, updated_at = now()
            WHERE tg_msg_id = ${groupKey}`;
        }
      } else {
        await sql`
          INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
          VALUES (${groupKey}, ${title || '(제목 없음)'}, ${body}, ${category}, ${isPrivate}, ${attJson}::jsonb, to_timestamp(${msg.date}))
          ON CONFLICT (tg_msg_id) DO UPDATE
          SET attachments = journal_posts.attachments || EXCLUDED.attachments, updated_at = now()`;
        await reply(chatId, `🦫 앨범 저장 중 · ${category} · ${isPrivate ? '비공개 🔒' : '공개'}\n(사진이 차례로 추가됩니다)`);
      }
      return res.status(200).send('ok');
    }

    // ── 단일 메시지 ──
    const tgMsgId = `${chatId}:${msg.message_id}`;

    if (isEdit) {
      const rows = await sql`
        UPDATE journal_posts
        SET title = ${title || '(제목 없음)'}, body = ${body}, category = ${category},
            is_private = ${isPrivate}, updated_at = now()
        WHERE tg_msg_id = ${tgMsgId}
        RETURNING id`;
      if (rows.length) {
        await reply(chatId, `🦫 수정 반영 완료 · ${category} · ${isPrivate ? '비공개 🔒' : '공개'}`);
      }
      return res.status(200).send('ok');
    }

    await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
      VALUES (${tgMsgId}, ${title || '(제목 없음)'}, ${body}, ${category}, ${isPrivate}, ${attJson}::jsonb, to_timestamp(${msg.date}))
      ON CONFLICT (tg_msg_id) DO UPDATE
      SET title = EXCLUDED.title, body = EXCLUDED.body,
          category = EXCLUDED.category, is_private = EXCLUDED.is_private,
          updated_at = now()`;

    const attNote = attachment ? (attachment.type === 'photo' ? ' · 📷' : ` · 📎${attachment.file_name}`) : '';
    await reply(chatId, `🦫 저장 완료 · ${category} · ${isPrivate ? '비공개 🔒' : '공개'}${attNote}`);
    return res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    try { await reply(chatId, '🦫 저장 중 오류가 났어요. 잠시 후 다시 보내주세요.'); } catch {}
    return res.status(200).send('ok');
  }
}
