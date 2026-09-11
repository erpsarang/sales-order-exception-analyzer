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

## Batch 주문 판정 사용 예시

`analyzeOrderBatch`는 읽기 전용 주문 배열을 받아 각 주문에 `analyzeOrder`를
적용하는 순수 함수입니다. 입력 배열과 주문 객체를 변경하지 않으며 입력 순서와
기존 사유코드 순서를 유지합니다.

```typescript
import { analyzeOrderBatch } from "./src/batch-order-analysis.js";

const order = {
  orderId: "SO-001",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
};
const batch = analyzeOrderBatch([
  order,
  { ...order, orderId: "SO-002", availableQuantity: 5, customerBlocked: true },
]);
// batch:
// {
//   results: [
//     { orderId: "SO-001", status: "SHIP_READY", reasonCodes: [] },
//     { orderId: "SO-002", status: "EXCEPTION",
//       reasonCodes: ["CUSTOMER_BLOCKED", "INSUFFICIENT_STOCK"] },
//   ],
//   summary: { totalCount: 2, shipReadyCount: 1, exceptionCount: 1 },
// }
```

빈 배열은 `{ results: [], summary: { totalCount: 0, shipReadyCount: 0,
exceptionCount: 0 } }`을 반환합니다.

테스트: `npm test` · TypeScript 빌드 검사: `npm run build`
