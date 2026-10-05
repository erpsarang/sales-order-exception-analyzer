import type { BatchOrderAnalysisResult, BatchOrderResult, StockAllocationItem } from "./batch-order-analysis.js";

export const allocationReasonLabels: Record<"INVALID_DUE_DATE" | "INVALID_QUANTITY" | "INVALID_AVAILABLE_QUANTITY" | "CONFLICTING_AVAILABLE_QUANTITY", string> = {
  INVALID_DUE_DATE: "납기일이 없거나 올바르지 않음",
  INVALID_QUANTITY: "주문 수량이 유효하지 않음",
  INVALID_AVAILABLE_QUANTITY: "가용재고가 유효하지 않음",
  CONFLICTING_AVAILABLE_QUANTITY: "같은 자재의 가용재고 값이 서로 다름",
};

export const supplyRiskExplanation = "주문별 정상·예외 판정과 별개로, 같은 자재의 현재 가용재고를 납기순으로 누적 배분한 결과입니다. 입고 예정 등 미래 공급은 반영하지 않습니다.";

export const supplyRiskSortDescription = "납기일 → 예상금액 내림차순 → 입력 순서";

export interface SupplyRiskOrder extends StockAllocationItem {
  orderDetails: BatchOrderResult["orderDetails"];
  estimatedAmount: number | null;
}

// 기존 stockAllocations 결과만 읽어 부족 주문을 추려 정렬한다. 새 계산 규칙은 없다.
export function createSupplyRiskOrders(batch: BatchOrderAnalysisResult): SupplyRiskOrder[] {
  const shortages: SupplyRiskOrder[] = [];
  for (const allocation of batch.stockAllocations) {
    if (allocation.status !== "CALCULATED") continue;
    for (const item of allocation.items) {
      if (item.shortageQuantity <= 0) continue;
      const orderDetails = batch.results[item.resultIndex]!.orderDetails;
      const amount = orderDetails.estimatedAmount;
      shortages.push({
        ...item,
        orderDetails,
        estimatedAmount: typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : null,
      });
    }
  }
  shortages.sort((left, right) => {
    if (left.dueDate !== right.dueDate) return left.dueDate < right.dueDate ? -1 : 1;
    if (left.estimatedAmount !== right.estimatedAmount) {
      if (left.estimatedAmount === null) return 1;
      if (right.estimatedAmount === null) return -1;
      return right.estimatedAmount - left.estimatedAmount;
    }
    return left.resultIndex - right.resultIndex;
  });
  return shortages;
}
