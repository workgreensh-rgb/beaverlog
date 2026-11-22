// 체결 문자 해석기 v2 (국내·해외 공용)
// 원칙: 문자에 없는 값은 만들지 않는다. 못 찾으면 null.

const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

// 걸러낼 문자: 인증·보안, 미체결·거부·취소
const SECURITY_RE = /인증번호|인증 번호|OTP|비밀번호|보안코드|로그인|본인확인|타기기|접속\s*알림/;
const NOT_FILL_RE = /미체결|체결\s*취소|주문\s*거부|거부|취소\s*확인|취소체결|정정\s*확인/;

const NOT_TICKER = new Set(['USD', 'KRW', 'KRX', 'NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'SMS', 'LMS', 'MTS', 'HTS',
  'NXT', 'ETF', 'ETN', 'ADR', 'POP', 'WEB', 'KST', 'EST', 'AM', 'PM', 'KODEX', 'TIGER', 'ACE', 'SOL', 'RISE',
  'KOSEF', 'HANARO', 'ARIRANG', 'PLUS', 'KIWOOM', 'TIMEFOLIO', 'WON', 'OTP', 'MPOP']);

// 종목명 후보에서 지울 말
const STOP_WORDS = ['모의테스트', '모의 테스트', '[모의]', '삼성증권', '[Web발신]', 'Web발신', '국내주식', '해외주식', '주식', '매수체결', '매도체결',
  '매수', '매도', '체결안내', '체결', '안내', '통보', '알림', '고객님', '고객', '계좌', '종목명', '종목',
  '현금', '신용', '정규장', '시간외', '장전', '장후', 'NXT', 'KRX', '대체거래소', '정상', '완료', '전량', '일부', '부분'];

function cleanName(s) {
  let t = ' ' + s + ' ';
  t = t.replace(/\[[^\]]*증권[^\]]*\]/g, ' ');
  t = t.replace(/\d{2,}[-*]\S*/g, ' ');            // 계좌번호(마스킹 포함)
  t = t.replace(/\*+\S*/g, ' ');
  t = t.replace(/\d{1,4}[./-]\d{1,2}([./-]\d{1,2})?/g, ' '); // 날짜
  t = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');   // 시각
  t = t.replace(/\(\d{6}\)|\bA?\d{6}\b/g, ' ');    // 종목코드
  for (const w of STOP_WORDS) t = t.split(w).join(' ');
  t = t.replace(/[\[\]:：,|·•\/]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

export function parseFill(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  if (SECURITY_RE.test(t)) return { kind: 'security', ok: false };
  if (NOT_FILL_RE.test(t)) return { kind: 'not_fill', ok: false };

  // 매수/매도: 먼저 나온 쪽
  const sm = t.match(/매수|매도|\bBUY\b|\bSELL\b/i);
  const side = sm ? (/매도|SELL/i.test(sm[0]) ? '매도' : '매수') : null;

  const isUS = /USD|\$|달러|NASDAQ|NYSE|AMEX/i.test(t);

  // 수량
  const qtyM = t.match(/(?:체결)?수량\s*[:：]?\s*([\d,]+)/) || t.match(/([\d,]+)\s*주(?![가-힣])/);
  const qty = qtyM ? num(qtyM[1]) : null;

  // 체결가: 라벨 우선 → $ → "N주 X원" → "@X"
  const priceM =
    t.match(/(?:체결가|체결단가|단가|평균가|가격)\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)/) ||
    t.match(/\$\s*([\d,]+(?:\.\d+)?)/) ||
    t.match(/([\d,]+\.\d+)\s*(?:USD|달러)/i) ||
    t.match(/[\d,]+\s*주\s*[@x×]?\s*([\d,]+(?:\.\d+)?)\s*원/) ||
    t.match(/@\s*([\d,]+(?:\.\d+)?)/);
  const price = priceM ? num(priceM[1]) : null;

  // 체결금액 (있을 때만)
  const amtM = t.match(/(?:체결금액|약정금액|금액)\s*[:：]?\s*([\d,]+(?:\.\d+)?)/);
  const amount = amtM ? num(amtM[1]) : null;

  // 종목
  let symbol = null;
  const codeM = t.match(/\(?A?(\d{6})\)?/);
  const code = codeM && /\(A?\d{6}\)|A\d{6}|종목코드/.test(t) ? codeM[1] : null;

  if (isUS) {
    const tickers = (t.match(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) || []).filter((w) => !NOT_TICKER.has(w));
    if (tickers.length) symbol = tickers[0];
  }
  if (!symbol) {
    const lab = t.match(/종목명?\s*[:：]\s*([^\n,]+)/);
    if (lab) symbol = cleanName(lab[1]) || null;
  }
  if (!symbol && qtyM) {
    // 수량 바로 앞 → 없으면 그 앞 줄들
    const idx = t.indexOf(qtyM[0]);
    const before = t.slice(0, idx);
    const lineBefore = before.split('\n').pop();
    symbol = cleanName(lineBefore.replace(/(?:체결)?수량\s*[:：]?\s*$/, '')) || null;
    if (!symbol) {
      const prev = before.split('\n').slice(0, -1).reverse();
      for (const l of prev) { const c = cleanName(l); if (c && !/^[\d,.\s원주]+$/.test(c)) { symbol = c; break; } }
    }
  }
  if (!symbol) {
    for (const l of lines) { const c = cleanName(l); if (c && !/[\d,.]+\s*(주|원)/.test(c) && !/^[\d,.\s]+$/.test(c)) { symbol = c; break; } }
  }
  if (symbol) symbol = symbol.replace(/\s*(?:[\d,]+\s*주|[\d,]+\s*원).*$/, '').trim().slice(0, 30) || null;

  return {
    kind: 'fill',
    side, symbol, code, qty, price, amount,
    currency: isUS ? 'USD' : 'KRW',
    ok: Boolean(side && symbol && qty && price),
  };
}
