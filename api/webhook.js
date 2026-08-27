import { neon } from '@neondatabase/serverless';

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

// 첫 줄 태그 해석: #스터디(공개) / #일기(비공개) / #콜(비공개) / 태그 없으면 일기
function parseTags(rawText) {
  let lines = (rawText || '').split('\n');
  let category = null;
  let forcePrivate = false;
  let hadTagLine = false;

  const first = (lines[0] || '').trim();
  const tokens = first.split(/\s+/).filter(Boolean);
  const isTagLine = tokens.length > 0 && tokens.every((t) => t.startsWith('#'));

  if (isTagLine) {
    hadTagLine = true;
    for (const t of tokens) {
      const tag = t.toLowerCase();
      if (tag === '#스터디' || tag === '#study') category = '스터디';
      else if (tag === '#일기' || tag === '#diary') category = '일기';
      else if (tag === '#콜' || tag === '#call') category = '콜';
      else if (tag === '#비공개' || tag === '#private') forcePrivate = true;
    }
    lines = lines.slice(1);
  }

  if (!category) category = '일기';
  // 콜만 기본 비공개, 스터디·일기는 기본 공개 (#비공개 태그로 개별 잠금 가능)
  const isPrivate = category === '콜' ? true : forcePrivate;

  while (lines.length && !lines[0].trim()) lines = lines.slice(1);
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

    if (text.trim() === '/start') {
      await reply(
        chatId,
        `🦫 비버의 저장소입니다.\n\n글·사진·파일을 보내면 저장됩니다.\n첫 줄 태그로 분류:\n\n#스터디 → 공개\n#일기 → 공개 (태그 없어도 일기)\n#콜 → 비공개\n#일기 #비공개 → 일기지만 비공개\n\n태그 다음 줄이 제목, 그 아래가 본문.\n사진 여러 장을 한 번에 보내면(앨범) 한 글로 묶입니다.\n보낸 글을 수정하면 사이트에도 반영됩니다.`
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
                category = ${hadTagLine ? category : '일기'},
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
