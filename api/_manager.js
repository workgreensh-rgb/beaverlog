// Manager calls use the existing private 콜 archive and owner-only draft approval.
export const MANAGER_KINDS = {
  manager_weight: '비중콜',
  manager_stock: '종목콜',
  manager_price: '주가콜',
};

const OWNER_COMMANDS = {
  '#비중콜초안': 'manager_weight',
  '#종목콜초안': 'manager_stock',
  '#주가콜초안': 'manager_price',
};

export function ownerCallTemplate(message) {
  const match = String(message || '').trim().match(/^(#비중콜초안|#종목콜초안|#주가콜초안)\s+([^\n]{1,80})$/);
  if (!match) return null;
  const kind = OWNER_COMMANDS[match[1]];
  const name = match[2].trim();
  if (!name) return null;
  const blank = '[작성 필요]';
  if (kind === 'manager_weight') return { kind, text: `#콜 비중콜 | ${name}\n업종 비중(OW/N/UW): ${blank}\n강도(1~5): ${blank}\n전주 변화: ${blank}\n\n[종목별 순위·비중·강도·근거·전주 변화·촉매]\n1. ${blank}\n\n[업종 촉매]\n${blank}` };
  if (kind === 'manager_stock') return { kind, text: `#콜 종목콜 | ${name}\nWhy Now: ${blank}\n\n[검증된 수치 · 기준일 · 출처]\n${blank}\n\n[시장과 다른 논리]\n${blank}\n\n[촉매]\n${blank}\n\n[리스크]\n${blank}` };
  return { kind, text: `#콜 주가콜 | ${name}\n기준 시각·시세 출처: ${blank}\n등락률·업종 대비·동시간 평균 거래량 배율: ${blank}\n\n[확인된 사실]\n${blank}\n\n[추정 원인 · 미확인]\n${blank}\n\n[대응 의견]\n${blank}` };
}

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
};
const number = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};
const stance = (value) => {
  if (!['OW', 'N', 'UW'].includes(value)) throw new Error('opinion must be OW, N or UW');
  return value;
};
const strength = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('strength must be 1~5');
  return value;
};
const signed = (value, unit = '%') => `${value > 0 ? '+' : ''}${value}${unit}`;

export function isWeeklyWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type)?.value;
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  return part('weekday') === 'Fri' && minutes >= 15 * 60 + 30;
}

export function priceSignals(data) {
  if (data.dataAuthorized !== true || data.intradayAvailable !== true) {
    return { available: false, reasons: [], message: '장중 데이터 권한·제공 여부 미확인' };
  }
  const change = number(data.changePct, 'changePct');
  const sector = number(data.sectorChangePct, 'sectorChangePct');
  const volume = number(data.volume, 'volume');
  const average = number(data.sameTimeAverageVolume, 'sameTimeAverageVolume');
  if (volume < 0 || average <= 0) throw new Error('volume values must be positive');
  const relative = change - sector;
  const multiple = volume / average;
  const reasons = [];
  if (Math.abs(change) >= 5) reasons.push('등락률 ±5%');
  if (Math.abs(relative) >= 3) reasons.push('업종 대비 ±3%p');
  if (multiple >= 2) reasons.push('동시간 평균 거래량 2배');
  return { available: true, reasons, relative, multiple };
}

export function formatManagerCall(kind, data, source = 'user') {
  if (!MANAGER_KINDS[kind]) throw new Error('unknown manager call kind');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('data object required');
  if (!['user', 'ai'].includes(source)) throw new Error('source must be user or ai');
  const origin = source === 'ai' ? 'AI 제안 · 사용자 검토 필요' : '사용자 입력 · 검토 필요';
  if (kind === 'manager_weight') {
    const sector = required(data.sector, 'sector');
    const opinion = stance(data.opinion);
    const level = strength(data.strength);
    const change = required(data.weeklyChange, 'weeklyChange');
    const catalyst = required(data.catalyst, 'catalyst');
    if (!Array.isArray(data.stocks) || !data.stocks.length) throw new Error('stocks required');
    const ranks = new Set();
    const stocks = data.stocks.map((stock) => {
      const rank = stock.rank;
      if (!Number.isInteger(rank) || rank < 1 || ranks.has(rank)) throw new Error('unique positive stock rank required');
      ranks.add(rank);
      return `${rank}. ${required(stock.name, 'stock name')} | ${stance(stock.opinion)} | 강도 ${strength(stock.strength)}/5 | 비중 ${required(stock.weight, 'stock weight')}\n   근거: ${required(stock.rationale, 'stock rationale')}\n   전주 변화: ${required(stock.weeklyChange, 'stock weeklyChange')}\n   촉매: ${required(stock.catalyst, 'stock catalyst')}`;
    });
    return `#콜 비중콜 | ${sector}\n[${origin}]\n업종: ${opinion} · 강도 ${level}/5\n전주 변화: ${change}\n\n[종목별 순위·비중]\n${stocks.join('\n')}\n\n[업종 촉매]\n${catalyst}`;
  }
  if (kind === 'manager_stock') {
    const name = required(data.name, 'name');
    if (!Array.isArray(data.verifiedNumbers) || !data.verifiedNumbers.length) throw new Error('verifiedNumbers required');
    const facts = data.verifiedNumbers.map((item) => {
      if (item.verified !== true) throw new Error('each number must be independently verified');
      return `- ${required(item.metric, 'metric')}: ${required(item.value, 'value')} (기준 ${required(item.asOf, 'asOf')}; 출처 ${required(item.source, 'number source')})`;
    });
    return `#콜 종목콜 | ${name}\n[${origin}]\nWhy Now: ${required(data.whyNow, 'whyNow')}\n\n[검증된 수치]\n${facts.join('\n')}\n\n[시장과 다른 논리]\n${required(data.differentiation, 'differentiation')}\n\n[촉매]\n${required(data.catalyst, 'catalyst')}\n\n[리스크]\n${required(data.risk, 'risk')}`;
  }
  const name = required(data.name, 'name');
  const signals = priceSignals(data);
  if (!signals.available) throw new Error(signals.message);
  if (!signals.reasons.length) throw new Error('price trigger not met');
  return `#콜 주가콜 | ${name}\n[${origin}]\n기준 시각: ${required(data.asOf, 'asOf')} · 출처: ${required(data.marketSource, 'marketSource')}\n등락률: ${signed(data.changePct)} · 업종 대비: ${signed(Number(signals.relative.toFixed(2)), '%p')} · 동시간 거래량: ${signals.multiple.toFixed(2)}배\n시험 조건: ${signals.reasons.join(', ')}\n\n[확인된 사실]\n${required(data.confirmedFacts, 'confirmedFacts')}\n\n[추정 원인 · 미확인]\n${required(data.inferredCause, 'inferredCause')}\n\n[대응 의견]\n${required(data.response, 'response')}`;
}
