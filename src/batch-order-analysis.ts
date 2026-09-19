import { analyzeOrder, type OrderAnalysisResult, type OrderInput } from "./order-analysis.js";

type ReasonCode = OrderAnalysisResult["reasonCodes"][number];

const reasonCodeOrder: readonly ReasonCode[] = [
  "INVALID_QUANTITY",
  "CUSTOMER_BLOCKED",
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
];

export interface BatchOrderResult extends OrderAnalysisResult {
  orderId: string;
  orderDetails: Pick<OrderInput, "materialId" | "orderQuantity" | "customerId" | "estimatedAmount" | "dueDate" | "orderComment">;
}

export interface ExceptionPriority {
  rank: number;
  resultIndex: number;
  orderId: string;
  basis: {
    dueDate: string | null;
    estimatedAmount: number | null;
  };
}

export interface BatchOrderAnalysisResult {
  results: BatchOrderResult[];
  exceptionPriorities: ExceptionPriority[];
  summary: {
    totalCount: number;
    shipReadyCount: number;
    exceptionCount: number;
    exceptionRate: number;
    exceptionOrderIds: string[];
    reasonCounts: Record<ReasonCode, number>;
    topReasonCodes: ReasonCode[];
  };
}

// 연도 0001~9999의 실제 YYYY-MM-DD만 인정하며 날짜 보정이나 현재 시각을 사용하지 않는다.
function validDueDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2
    ? (leapYear ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return day <= daysInMonth ? value : null;
}

function validEstimatedAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 입력 순서대로 기존 주문 판정을 수행하며 입력을 변경하지 않는다. */
export function analyzeOrderBatch(
  orders: ReadonlyArray<Readonly<OrderInput>>,
): BatchOrderAnalysisResult {
  let shipReadyCount = 0;
  let exceptionCount = 0;
  const reasonCounts: Record<ReasonCode, number> = {
    INVALID_QUANTITY: 0,
    CUSTOMER_BLOCKED: 0,
    MATERIAL_BLOCKED: 0,
    INSUFFICIENT_STOCK: 0,
  };
  const results = orders.map((order) => {
    const analysis = analyzeOrder(order);
    if (analysis.status === "SHIP_READY") shipReadyCount += 1;
    else {
      exceptionCount += 1;
      for (const reasonCode of analysis.reasonCodes) {
        reasonCounts[reasonCode] += 1;
      }
    }
    const orderDetails: BatchOrderResult["orderDetails"] = {
      materialId: order.materialId,
      orderQuantity: order.orderQuantity,
      customerId: order.customerId,
    };
    if (order.estimatedAmount !== undefined) orderDetails.estimatedAmount = order.estimatedAmount;
    if (order.dueDate !== undefined) orderDetails.dueDate = order.dueDate;
    if (order.orderComment !== undefined) orderDetails.orderComment = order.orderComment;
    return { orderId: order.orderId, orderDetails, ...analysis };
  });
  const exceptionOrderIds = results
    .filter((result) => result.status === "EXCEPTION")
    .map((result) => result.orderId);
  const maxReasonCount = Math.max(...reasonCodeOrder.map((code) => reasonCounts[code]));
  const topReasonCodes = maxReasonCount === 0
    ? []
    : reasonCodeOrder.filter((code) => reasonCounts[code] === maxReasonCount);

  // 예외 항목만 별도 배열에 담고 항목별·호출별 basis를 새로 만든다.
  // 무효·누락 값은 basis에서만 null로 바꾸며 기존 상세정보와 results 순서는 보존한다.
  const exceptionPriorities: ExceptionPriority[] = [];
  results.forEach((result, resultIndex) => {
    if (result.status !== "EXCEPTION") return;
    exceptionPriorities.push({
      rank: 0,
      resultIndex,
      orderId: result.orderId,
      basis: {
        dueDate: validDueDate(result.orderDetails.dueDate),
        estimatedAmount: validEstimatedAmount(result.orderDetails.estimatedAmount),
      },
    });
  });
  // 유효 납기 우선 → 납기 오름차순 → 유효 금액 우선 → 금액 내림차순 → 입력 인덱스 오름차순.
  // 고정 길이의 유효 날짜는 문자열 비교로 시간대와 무관하게 정렬한다.
  exceptionPriorities.sort((left, right) => {
    const leftDate = left.basis.dueDate;
    const rightDate = right.basis.dueDate;
    if (leftDate !== rightDate) {
      if (leftDate === null) return 1;
      if (rightDate === null) return -1;
      return leftDate < rightDate ? -1 : 1;
    }
    const leftAmount = left.basis.estimatedAmount;
    const rightAmount = right.basis.estimatedAmount;
    if (leftAmount !== rightAmount) {
      if (leftAmount === null) return 1;
      if (rightAmount === null) return -1;
      return leftAmount > rightAmount ? -1 : 1;
    }
    return left.resultIndex - right.resultIndex;
  });
  // rank는 1 기반이며 resultIndex는 원래 results의 0 기반 위치다.
  exceptionPriorities.forEach((priority, index) => {
    priority.rank = index + 1;
  });

  return {
    results,
    exceptionPriorities,
    summary: {
      totalCount: results.length,
      shipReadyCount,
      exceptionCount,
      exceptionRate: results.length === 0 ? 0 : exceptionCount / results.length,
      exceptionOrderIds,
      reasonCounts,
      topReasonCodes,
    },
  };
}
