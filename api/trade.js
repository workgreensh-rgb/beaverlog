import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import { parseFill } from './_parse.js';

// 체결 문자 → 텔레그램 알림 + 비버로그 매매일지 (v2)
// 아이폰 단축어가 '체결' 포함 문자를 받으면 이 주소로 보냄
//   POST /api/trade   JSON { "key": "<TRADE_KEY>", "text": "<문자 원문>" }
//   (테스트용) GET  /api/trade?key=<TRADE_KEY>&text=<문자 원문>&test=1
// v2 변경
//   - 국내 종목명·ETF·종목코드 해석 (해석기는 _parse.js)
//   - 인증번호·보안 문자는 저장·전송하지 않음
//   - 미체결·거부·취소 문자는 일지에 남기지 않음
//   - 중복 판단: 같은 원문이 60초 안에 다시 오면 중복. 60초 뒤 같은 문구는 별개 체결(분할체결)로 기록
//   - test=1 이거나 문자 본문에 '모의테스트'가 있으면 제목과 알림에 [모의] 표시

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;
const DUP_WINDOW_SEC = 60;

async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS trade_links (
    bot_msg_id bigint PRIMARY KEY,
    post_key   text NOT NULL,
    created_at timestamptz DEFAULT now()
  )`;
}

function readInput(req) {
  const q = { ...(req.query || {}) };
  let b = req.body || {};
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = { text: b }; }
  }
  return {
    key: String(b.key || q.key || req.headers['x-trade-key'] || ''),
    text: String(b.text || q.text || ''),
    test: String(b.test || q.test || '') === '1',
  };
}

function seoulStamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
}

const fmt = (n, cur) => (n == null ? '?' : cur === 'USD' ? `$${n}` : `${Number(n).toLocaleString('ko-KR')}원`);

async function sendTelegram(chatId, text) {
  const r = await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await r.json().catch(() => ({}));
  return j && j.ok ? j.result.message_id : null;
}

export default async function handler(req, res) {
  const { key, text, test: testFlag } = readInput(req);
  const expected = String(process.env.TRADE_KEY || '').trim();
  if (!expected || key.trim() !== expected) { // 앞뒤 공백·줄바꿈 무시
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const raw = text.trim();
  const test = testFlag || /모의\s*테스트|\[모의\]/.test(raw); // 문자 본문에 '모의테스트'가 있으면 모의로 표시
  if (!raw) return res.status(400).json({ ok: false, error: 'empty text' });

  const f = parseFill(raw);
  if (f.kind === 'security') return res.status(200).json({ ok: true, ignored: 'security' });
  if (f.kind === 'not_fill') return res.status(200).json({ ok: true, ignored: 'not_fill' });

  const owner = (process.env.OWNER_CHAT_ID || '').trim();
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const postKey = `trade:${hash}:${Date.now()}`;
  const tag = test ? '[모의] ' : '';

  try {
    await ensureTable();

    const dup = await sql`
      SELECT 1 FROM journal_posts
      WHERE tg_msg_id LIKE ${'trade:' + hash + ':%'}
        AND posted_at > now() - make_interval(secs => ${DUP_WINDOW_SEC})`;
    if (dup.length) return res.status(200).json({ ok: true, duplicate: true });

    const when = seoulStamp();
    const head = f.ok ? `${f.side} ${f.symbol} ${f.qty}주 @${f.price}` : null;
    const title = tag + (head || `체결 기록 (자동 해석 실패 · ${when})`);

    // 매도면 같은 종목의 직전 매수 기록과 연결 (직전 1건 기준, 평균단가 아님)
    let link = '';
    let prevReason = '';
    if (f.ok && f.side === '매도') {
      const prev = await sql`
        SELECT title, body, posted_at FROM journal_posts
        WHERE category = '매매일지' AND title LIKE ${tag + '매수 ' + f.symbol + ' %'}
        ORDER BY posted_at DESC LIMIT 1`;
      if (prev.length) {
        const pm = prev[0].title.match(/@([\d.]+)/);
        const buyPx = pm ? Number(pm[1]) : null;
        const days = Math.round((Date.now() - new Date(prev[0].posted_at).getTime()) / 86400000);
        const ret = buyPx ? ((f.price / buyPx - 1) * 100).toFixed(1) : null;
        link = `[매도 연결] 직전 매수 ${fmt(buyPx, f.currency)} → 수익률 ${ret != null ? (ret > 0 ? '+' : '') + ret + '%' : '?'} · 보유 ${days}일 (수수료·세금 제외, 직전 1건 기준)`;
        const rm = (prev[0].body || '').match(/\[사유\]\s*([\s\S]*?)(?:\n---|\n\[|$)/);
        if (rm && rm[1].trim() && !rm[1].includes('답장 대기')) prevReason = `[직전 매수 사유] ${rm[1].trim()}`;
      }
    }

    const body = [
      f.ok
        ? `[체결] ${f.side} · ${f.symbol}${f.code ? ' (' + f.code + ')' : ''} · ${f.qty}주 · ${fmt(f.price, f.currency)}${f.amount ? ' · 금액 ' + fmt(f.amount, f.currency) : ''}`
        : '[체결] 자동 해석 실패 — 아래 원문 참고',
      `[기록시각] ${when} KST`,
      test ? '[구분] 모의 테스트' : '',
      link,
      prevReason,
      '[사유] (답장 대기)',
      '---',
      `[원문] ${raw}`,
    ].filter(Boolean).join('\n');

    await sql`
      INSERT INTO journal_posts (tg_msg_id, title, body, category, is_private, attachments, posted_at)
      VALUES (${postKey}, ${title}, ${body}, '매매일지', true, '[]'::jsonb, now())
      ON CONFLICT (tg_msg_id) DO NOTHING`;

    let notified = false;
    if (owner && process.env.TG_TOKEN) {
      const lines = [
        f.ok
          ? `🔔 ${tag}${f.side} 체결 · ${f.symbol} ${f.qty}주 @${fmt(f.price, f.currency)}`
          : `🔔 ${tag}체결 문자가 들어왔는데 자동 해석에 실패했어요`,
        link,
        prevReason,
        f.ok ? '' : `원문: ${raw.slice(0, 300)}`,
        '',
        `👉 이 메시지에 "답장"으로 ${f.side ? f.side + ' ' : '매매 '}사유를 적어주세요.`,
        '예) 논리 / 목표가 / 손절 조건',
      ].filter((l) => l !== undefined && l !== null && l !== false);
      const mid = await sendTelegram(owner, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
      if (mid) {
        await sql`INSERT INTO trade_links (bot_msg_id, post_key) VALUES (${mid}, ${postKey}) ON CONFLICT DO NOTHING`;
        notified = true;
      }
    }

    return res.status(200).json({ ok: true, parsed: f, notified, test });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
