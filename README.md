# sales-order-exception-analyzer
주문 데이터를 받아 출고 가능/예외를 판정하고 사유코드 반환

## 주문 판정 사용 예시

`analyzeOrder`는 외부 I/O 없이 주문을 판정하는 순수 함수입니다.

```typescript
import { analyzeOrder } from "./src/order-analysis.js";

const result = analyzeOrder({
  orderId: "SO-001",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 5,
  customerBlocked: true,
  materialBlocked: false,
});
// result:
// { status: "EXCEPTION", reasonCodes: ["CUSTOMER_BLOCKED", "INSUFFICIENT_STOCK"] }
```

예외가 없으면 `{ status: "SHIP_READY", reasonCodes: [] }`를 반환합니다.
해당하는 모든 사유는 `INVALID_QUANTITY`(주문수량 ≤ 0),
`CUSTOMER_BLOCKED`(고객 차단), `MATERIAL_BLOCKED`(자재 차단),
`INSUFFICIENT_STOCK`(가용재고 < 주문수량) 순서로 반환합니다.

테스트: `npm test` · TypeScript 빌드 검사: `npm run build`
