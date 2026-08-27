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
// #스터디 #비공개 함께 쓰면 스터디도 비공개로 저장
function parseTags(rawText) {
  let lines = rawText.split('\n');
  let category = null;
  let forcePrivate = false;

  const first = (lines[0] || '').trim();
  const tokens = first.split(/\s+/).filter(Boolean);
  const isTagLine = tokens.length > 0 && tokens.every((t) => t.startsWith('#'));

  if (isTagLine) {
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
  // 스터디만 기본 공개, 나머지는 기본 비공개
  const isPrivate = category === '스터디' ? forcePrivate : true;

  // 남은 내용에서 첫 비어있지 않은 줄 = 제목, 나머지 = 본문
  while (lines.length && !lines[0].trim()) lines = lines.slice(1);
  const title = (lines[0] || '').trim() || '(제목 없음)';
  const body = lines.slice(1).join('\n').trim();

  return { category, isPrivate, title, body };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const update = req.body || {};
  const msg = update.message || update.edited_message;
  const isEdit = Boolean(update.edited_message);

  // 1:1 대화만 처리 (채널·그룹 무시)
  if (!msg || !msg.chat || msg.chat.type !== 'private') {
    return res.status(200).send('ok');
  }

  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  try {
    // 본인 계정 잠금: OWNER_CHAT_ID 미설정 시 chat_id만 안내하고 저장하지 않음
    const owner = (process.env.OWNER_CHAT_ID || '').trim();
    if (!owner) {
      await reply(
        chatId,
        `🦫 아직 주인 등록이 안 됐어요.\n\n당신의 chat_id는 ${chatId} 입니다.\n이 숫자를 Vercel 환경변수 OWNER_CHAT_ID에 넣고 Redeploy 하면, 그때부터 보내는 글이 비버의 저장소에 쌓입니다.`
      );
      return res.status(200).send('ok');
    }
    if (String(chatId) !== owner) {
      // 주인이 아니면 조용히 무시
      return res.status(200).send('ok');
    }

    if (!text.trim()) {
      await reply(chatId, '🦫 텍스트만 저장할 수 있어요. 글로 보내주세요.');
      return res.status(200).send('ok');
    }

    if (text.trim() === '/start') {
      await reply(
        chatId,
        `🦫 비버의 저장소입니다.\n\n그냥 글을 보내면 저장됩니다.\n첫 줄에 태그를 쓰면 분류돼요:\n\n#스터디 → 공개\n#일기 → 비공개 (태그 없어도 일기)\n#콜 → 비공개\n#스터디 #비공개 → 스터디지만 비공개\n\n태그 다음 줄이 제목, 그 아래가 본문입니다.\n보낸 글을 수정하면 사이트에도 반영됩니다.`
      );
      return res.status(200).send('ok');
    }

    const { category, isPrivate, title, body } = parseTags(text);
    const tgMsgId = `${chatId}:${msg.message_id}`;

    if (isEdit) {
      const rows = await sql`
        UPDATE journal_posts
        SET title = ${title}, body = ${body}, category = ${category},
            is_private = ${isPrivate}, updated_at = now()
        WHERE tg_msg_id = ${tgMsgId}
        RETURNING id`;
      if (rows.length) {
        await reply(chatId, `🦫 수정 반영 완료 · ${category} · ${isPrivate ? '비공개 🔒' : '공개'}`);
      }
      return res.status(200).send('ok');
    }

    await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, posted_at)
      VALUES (${tgMsgId}, ${title}, ${body}, ${category}, ${isPrivate}, to_timestamp(${msg.date}))
      ON CONFLICT (tg_msg_id) DO UPDATE
      SET title = EXCLUDED.title, body = EXCLUDED.body,
          category = EXCLUDED.category, is_private = EXCLUDED.is_private,
          updated_at = now()`;

    await reply(chatId, `🦫 저장 완료 · ${category} · ${isPrivate ? '비공개 🔒' : '공개'}`);
    return res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    try { await reply(chatId, '🦫 저장 중 오류가 났어요. 잠시 후 다시 보내주세요.'); } catch {}
    return res.status(200).send('ok');
  }
}
