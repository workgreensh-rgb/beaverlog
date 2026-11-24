import { neon } from '@neondatabase/serverless';
import { computePerformance } from './_perf.js';

// 공개 수익률 API (비버모투 포트폴리오 페이지용)
//   GET /api/performance
// 매매일지(비공개)를 읽어 수익률만 계산해서 내보낸다.
// 수량·금액·원문은 응답에 포함되지 않는다. 사유는 공개 (사용자 결정 2026-11-24).
// 일지 본문에 [공개제외] 줄이 있으면 그 체결은 공개 계산에서 빠진다.

const sql = neon(process.env.DATABASE_URL);

// 외화 → 원화 기준환율 (ECB, frankfurter). 누적 수익률의 금액 가중치에만 쓴다.
async function loadFx(needs) {
  const out = new Map();
  await Promise.all([...needs].map(async (k) => {
    const [cur, date] = k.split('|');
    try {
      const r = await fetch(`https://api.frankfurter.app/${date}?from=${cur}&to=KRW`);
      const j = await r.json();
      const v = j && j.rates && Number(j.rates.KRW);
      if (v > 0) out.set(k, v);
    } catch { /* 환율 실패 → 해당 거래는 누적 가중치에서 제외되고 fxMissing으로 표시 */ }
  }));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  try {
    const posts = await sql`
      SELECT id, title, body, posted_at FROM journal_posts
      WHERE category = '매매일지'
      ORDER BY posted_at ASC`;

    // 1차 계산으로 필요한 환율 목록을 뽑고, 2차 계산에 반영
    const needs = new Set();
    computePerformance(posts, (cur, date) => { if (cur !== 'KRW') needs.add(`${cur}|${date}`); return 1; });
    const fx = await loadFx(needs);
    const result = computePerformance(posts, (cur, date) => (cur === 'KRW' ? 1 : fx.get(`${cur}|${date}`) || null));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ ok: true, asof: new Date().toISOString(), ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'db error' });
  }
}
