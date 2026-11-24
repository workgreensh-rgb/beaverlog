// 매매일지 → 공개 수익률 계산기
// 원칙
//   - 공개 결과에는 수량·금액·원문을 절대 넣지 않는다 (타점 단가·수익률·날짜·사유만)
//   - 세전·수수료 전 기준
//   - 단가는 이동평균법: 추가 매수 시 평균단가 갱신, 매도 시 평균단가 대비 수익률
//   - 누적 수익률은 금액 가중: Σ실현손익 ÷ Σ매도분 매입원가 (외화는 원화 환산 가중치만 사용)
import { detectCurrency } from './_parse.js';

const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

export const MARKET_BY_CUR = { KRW: 'KR', USD: 'US', JPY: 'JP', HKD: 'HK', CNY: 'CN' };

// 일지 1건 → 체결 이벤트 (해석 불가·모의·공개제외면 null)
export function parsePost(p) {
  const title = String(p.title || '');
  const body = String(p.body || '');
  if (/^\[모의\]/.test(title) || body.includes('[구분] 모의 테스트')) return null;
  if (body.includes('[공개제외]')) return null;

  const t = title.match(/^(매수|매도)\s+(.+?)\s+([\d,]+)주\s+@([\d,.]+)/);
  if (!t) return null;
  const side = t[1];
  const name = t[2].trim();
  const qty = num(t[3]);
  const price = num(t[4]);
  if (!(qty > 0) || !(price > 0)) return null;

  const fill = body.match(/^\[체결\][^\n]*\((\w{1,12})\)/m);
  const code = fill ? fill[1] : null;

  const cm = body.match(/^\[통화\]\s*([A-Z]{3})/m);
  const raw = (body.split('\n---\n')[1] || '').replace(/^\[원문\]\s*/, '');
  const override = body.match(/^\[통화수정\]\s*([A-Z]{3})/m); // 과거 기록 통화 정정용
  const explicit = override ? override[1] : cm ? cm[1] : null;
  const currency = explicit || detectCurrency(raw);

  const rm = body.match(/^\[사유\]\s*([\s\S]*?)(?=\n\[|\n---|$)/m);
  let reason = rm ? rm[1].trim() : '';
  if (!reason || reason.includes('답장 대기')) reason = '';

  return { id: p.id, side, name, code, qty, price, currency, explicitCurrency: Boolean(explicit), reason, at: new Date(p.posted_at) };
}

const dayKST = (d) => d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / 86400000));
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// fx(currency, dateStr) → 1단위당 원화 (가중치 계산용). 없으면 null
export function computePerformance(posts, fx = () => null) {
  const events = posts.map(parsePost).filter(Boolean).sort((a, b) => a.at - b.at || a.id - b.id);

  const pos = new Map(); // key → { qty, avg, openedAt, name, code, currency, buys: [] }
  const closed = [];     // 매도 1건 = 1행
  const markers = [];    // 차트용 타점
  let pnlKrw = 0, costKrw = 0, fxMissing = 0;

  for (const e of events) {
    const key = e.code || e.name;
    let p = pos.get(key);
    // 같은 종목인데 한쪽만 통화가 명시된 경우(과거 기록) 명시된 통화를 따른다
    if (p && p.qty > 0 && e.currency !== p.currency) {
      if (e.explicitCurrency && !p.explicitCurrency) {
        p.currency = e.currency; p.explicitCurrency = true;
        for (const m of p.marks) { m.currency = e.currency; m.market = MARKET_BY_CUR[e.currency]; }
      }
      else if (!e.explicitCurrency) e.currency = p.currency;
    }
    if (e.side === '매수') {
      if (!p || p.qty <= 0) {
        p = { qty: 0, avg: 0, openedAt: e.at, name: e.name, code: e.code, currency: e.currency, explicitCurrency: e.explicitCurrency, buys: [], marks: [] };
        pos.set(key, p);
      }
      p.avg = (p.avg * p.qty + e.price * e.qty) / (p.qty + e.qty);
      p.qty += e.qty;
      p.buys.push({ date: dayKST(e.at), price: e.price, reason: e.reason });
      const mk = { type: 'buy', name: e.name, code: e.code, market: MARKET_BY_CUR[p.currency], currency: p.currency, date: dayKST(e.at), price: e.price };
      p.marks.push(mk); markers.push(mk);
      continue;
    }
    // 매도
    if (!p || p.qty <= 0) continue; // 매수 기록 없는 매도는 수익률 계산 불가 → 제외
    const q = Math.min(e.qty, p.qty);
    const ret = e.price / p.avg - 1;
    const rate = fx(e.currency, dayKST(e.at));
    if (rate) { pnlKrw += (e.price - p.avg) * q * rate; costKrw += p.avg * q * rate; }
    else fxMissing++;
    closed.push({
      name: p.name, code: p.code, market: MARKET_BY_CUR[p.currency], currency: p.currency,
      buyDate: dayKST(p.openedAt), avgEntry: r2(p.avg), entries: p.buys.map((b) => ({ date: b.date, price: b.price })),
      sellDate: dayKST(e.at), sellPrice: e.price,
      returnPct: r2(ret * 100), holdDays: daysBetween(p.openedAt, e.at),
      buyReasons: p.buys.map((b) => b.reason).filter(Boolean), sellReason: e.reason,
      partial: e.qty < p.qty,
    });
    markers.push({ type: 'sell', name: p.name, code: p.code, market: MARKET_BY_CUR[p.currency], currency: p.currency, date: dayKST(e.at), price: e.price, returnPct: r2(ret * 100) });
    p.qty -= q;
    if (p.qty <= 0) pos.delete(key);
  }

  const open = [...pos.values()].filter((p) => p.qty > 0).map((p) => ({
    name: p.name, code: p.code, market: MARKET_BY_CUR[p.currency], currency: p.currency,
    buyDate: dayKST(p.openedAt), avgEntry: r2(p.avg), entries: p.buys.map((b) => ({ date: b.date, price: b.price })),
    reasons: p.buys.map((b) => b.reason).filter(Boolean),
  }));

  const n = closed.length;
  const wins = closed.filter((c) => c.returnPct > 0).length;
  const summary = {
    closedTrades: n,
    openPositions: open.length,
    cumulativeReturnPct: costKrw > 0 ? r2((pnlKrw / costKrw) * 100) : null,
    winRatePct: n ? r2((wins / n) * 100) : null,
    avgReturnPct: n ? r2(closed.reduce((s, c) => s + c.returnPct, 0) / n) : null,
    avgHoldDays: n ? r2(closed.reduce((s, c) => s + c.holdDays, 0) / n) : null,
    fxMissing,
  };

  return {
    basis: '실현 거래 기준 · 세전·수수료 전 · 이동평균 단가. 누적 수익률은 금액 가중(외화는 매도일 기준환율로 가중치만 원화 환산), 거래별 수익률은 현지통화 기준',
    summary,
    closed: closed.reverse(),
    open,
    markers,
  };
}
