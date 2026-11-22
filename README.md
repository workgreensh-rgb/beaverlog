# beaverlog

비버의 저장소 (beaverlog-gamma.vercel.app)

## 체결 알림 → 매매일지
- 아이폰 단축어: '체결' 포함 문자 수신 시 `POST /api/trade` (JSON: key, text)
- `api/trade.js`: 해석(`api/_parse.js`) → 매매일지 비공개 저장 → 텔레그램 알림
- 텔레그램 알림에 답장하면 `api/webhook.js`가 [사유] 기록
- 필요한 환경변수: TRADE_KEY, OWNER_CHAT_ID, TG_TOKEN, DATABASE_URL
