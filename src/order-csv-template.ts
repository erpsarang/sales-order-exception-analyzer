/** 실제 주문 분석 전 주문 데이터와 기준값을 교체해야 하는 주문 단독용 예제 CSV입니다. */
export function createOrderCsvTemplate(): string {
  const rows = [
    "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate,orderComment",
    "EXAMPLE-001,EXAMPLE-C001,EXAMPLE-M001,10,20,false,false,150000,2026-10-01,예제 주문",
    "EXAMPLE-002,EXAMPLE-C002,EXAMPLE-M002,10,3,true,true,,,",
  ];
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

/** 고객·자재/재고 기준 CSV 두 개와 함께 사용하는 직접 판정 열 없는 주문 예제입니다. */
export function createUploadedReferenceOrderCsvTemplate(): string {
  const rows = [
    "orderId,customerId,materialId,orderQuantity,estimatedAmount,dueDate,orderComment",
    "EXAMPLE-001,EXAMPLE-C001,EXAMPLE-M001,10,150000,2026-10-01,예제 주문",
    "EXAMPLE-002,EXAMPLE-C002,EXAMPLE-M002,10,,,",
  ];
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
