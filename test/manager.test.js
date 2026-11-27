import test from 'node:test';
import assert from 'node:assert/strict';
import { formatManagerCall, isWeeklyWindow, ownerCallTemplate, priceSignals } from '../api/_manager.js';

test('weekly call retains every required stock field and labels an AI proposal', () => {
  const text = formatManagerCall('manager_weight', {
    sector: '건설', opinion: 'OW', strength: 4, weeklyChange: '강도 상향', catalyst: '공식 발표 확인',
    stocks: [{ rank: 1, name: '예시기업', opinion: 'OW', strength: 5, weight: '확대', rationale: '수주 확인', weeklyChange: '2위→1위', catalyst: '실적 발표' }],
  }, 'ai');
  for (const value of ['AI 제안', '강도 4/5', '1. 예시기업', '비중 확대', '수주 확인', '2위→1위', '실적 발표']) assert.match(text, new RegExp(value));
  assert.throws(() => formatManagerCall('manager_weight', { sector: '건설', opinion: 'OW', strength: 4, weeklyChange: '유지', catalyst: '확인', stocks: [{ rank: 1 }] }), /stock name/);
});

test('stock call requires verified figures with source and date', () => {
  const data = { name: '예시기업', whyNow: '새 발표', verifiedNumbers: [{ metric: '매출', value: '100억원', asOf: '2026-11-27', source: '공시', verified: true }], differentiation: '시장 예상과 차이', catalyst: '실적', risk: '지연' };
  assert.match(formatManagerCall('manager_stock', data), /출처 공시/);
  assert.throws(() => formatManagerCall('manager_stock', { ...data, verifiedNumbers: [{ ...data.verifiedNumbers[0], verified: false }] }), /independently verified/);
});

test('price trigger requires rights, intraday availability and one threshold', () => {
  const data = { dataAuthorized: true, intradayAvailable: true, changePct: 5, sectorChangePct: 1, volume: 200, sameTimeAverageVolume: 100 };
  assert.equal(priceSignals(data).reasons.length, 3);
  assert.equal(priceSignals({ ...data, dataAuthorized: false }).available, false);
  assert.equal(priceSignals({ ...data, changePct: 1, sectorChangePct: 0, volume: 100 }).reasons.length, 0);
  assert.throws(() => formatManagerCall('manager_price', { ...data, dataAuthorized: false, name: '예시기업' }), /권한/);
  const text = formatManagerCall('manager_price', { ...data, name: '예시기업', asOf: '2026-11-27 14:00 KST', marketSource: '허가된 공급원', confirmedFacts: '가격·거래량', inferredCause: '미확인', response: '추가 확인' });
  for (const heading of ['확인된 사실', '추정 원인 · 미확인', '대응 의견']) assert.match(text, new RegExp(heading));
});

test('automatic weekly window starts Friday 15:30 Seoul time', () => {
  assert.equal(isWeeklyWindow(new Date('2026-11-27T06:29:00Z')), false);
  assert.equal(isWeeklyWindow(new Date('2026-11-27T06:30:00Z')), true);
  assert.equal(isWeeklyWindow(new Date('2026-11-28T06:30:00Z')), false);
});

test('owner Telegram command creates an incomplete draft template', () => {
  for (const tag of ['#비중콜초안', '#종목콜초안', '#주가콜초안']) {
    const result = ownerCallTemplate(`${tag} 예시기업`);
    assert.ok(result);
    assert.match(result.text, /\[작성 필요\]/);
    assert.match(result.text, /#콜/);
  }
  assert.equal(ownerCallTemplate('#종목콜초안'), null);
});
