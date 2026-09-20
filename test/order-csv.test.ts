import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvOrders, validateOrders } from "../src/order-csv.js";

test("CSV 주문을 숫자, 불리언 및 인용된 선택 필드로 변환한다", () => {
  const orders = parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate,orderComment\nORD-1,CUST-1,MAT-1,3,10,false,true,1200,2026-01-20,\"긴급, 확인 필요\"\n");
  assert.deepEqual(orders, [{ orderId: "ORD-1", customerId: "CUST-1", materialId: "MAT-1", orderQuantity: 3, availableQuantity: 10, customerBlocked: false, materialBlocked: true, estimatedAmount: 1200, dueDate: "2026-01-20", orderComment: "긴급, 확인 필요" }]);
  assert.doesNotThrow(() => validateOrders(orders));
});

test("CSV 필수 열과 데이터 형식을 검증한다", () => {
  assert.throws(() => parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked\nORD-1,CUST-1,MAT-1,3,10,false\n"), /materialBlocked/);
  assert.throws(() => parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked\nORD-1,CUST-1,MAT-1,nope,10,false,false\n"), /orderQuantity/);
});
