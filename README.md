# beaverlog

비버의 저장소 (beaverlog-gamma.vercel.app)

## 체결 알림 → 매매일지
- 아이폰 단축어: '체결' 포함 문자 수신 시 `POST /api/trade` (JSON: key, text)
- `api/trade.js`: 해석(`api/_parse.js`) → 매매일지 비공개 저장 → 텔레그램 알림
- 텔레그램 알림에 답장하면 `api/webhook.js`가 [사유] 기록
- 필요한 환경변수: TRADE_KEY, OWNER_CHAT_ID, TG_TOKEN, DATABASE_URL

## 매니저 커뮤니케이션 MVP (미배포)

기존 `POST /api/draft`에 `manager_weight`, `manager_stock`, `manager_price` 종류를 추가했습니다. `x-manager-draft-key` 헤더가 `MANAGER_DRAFT_KEY` 환경변수와 일치해야 접수합니다. 본문은 `{ "kind": "manager_stock", "source": "user" | "ai", "dataClassification": "public", "data": { ... } }` 형태입니다. 공개적으로 확인됐고 외부 저장이 허용된 자료임을 확인한 입력만 접수합니다. 접수 시 기존 초안 메시지로 주인에게만 보내며, 답장 수정과 [발행]/[폐기] 버튼을 그대로 사용합니다. [발행]을 누르면 최종본을 주인 DM으로 보내고 기존 비버로그 `콜` 카테고리에 비공개로 저장합니다. 매니저 수신자에게 자동 전달하는 기능은 없습니다.

주인이 텔레그램 봇 DM에 `#비중콜초안 업종명`, `#종목콜초안 종목명`, `#주가콜초안 종목명` 중 하나를 보내면 작성 틀이 초안으로 돌아옵니다. 그 메시지에 완성한 전문을 답장하고 [발행]을 누릅니다. `[작성 필요]`가 남아 있으면 발행을 막습니다. 이 수동 경로는 기존 봇의 소유자 확인을 이용하며 새 API 키가 필요하지 않습니다.

필수 데이터:

- 비중콜 `sector`, `opinion`(OW/N/UW), `strength`(1~5), `weeklyChange`, `catalyst`, `stocks` 배열. 각 종목은 `rank`, `name`, `opinion`, `strength`, `weight`, `rationale`, `weeklyChange`, `catalyst`.
- 종목콜 `name`, `whyNow`, `verifiedNumbers` 배열, `differentiation`, `catalyst`, `risk`. 각 수치는 `metric`, `value`, `asOf`, `source`, `verified: true`가 필요합니다. `source`가 `ai`이면 AI 제안으로 표시됩니다. 입력자가 사실 확인을 마친 수치만 넣어야 합니다.
- 주가콜 `name`, `asOf`, `marketSource`, `dataAuthorized: true`, `intradayAvailable: true`, `changePct`, `sectorChangePct`, `volume`, `sameTimeAverageVolume`, `confirmedFacts`, `inferredCause`, `response`. 절댓값 등락률 5%, 업종 대비 3%p, 동시간 평균 거래량 2배 중 하나를 충족해야 접수됩니다. 데이터 권한이나 장중 제공 여부가 확인되지 않으면 후보를 만들지 않습니다.

비중콜에서 `automatic: true`를 보내면 금요일 15:30 KST 이후에만 접수합니다. 예약 실행, 시세 수집, AI 제안 생성은 연결되지 않았습니다. 실제 환경의 데이터 권한과 예약 작업 접근을 확인한 뒤 연결해야 합니다. 시험 중에는 실제 기업 자료나 회사 기밀을 보내지 말고 합성 데이터와 로컬 테스트만 사용하세요. 배포와 외부 전송은 별도 승인 대상입니다.
