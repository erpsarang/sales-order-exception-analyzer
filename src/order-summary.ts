import type { BatchOrderAnalysisResult } from "./batch-order-analysis.js";
import type { ReasonCode } from "./order-analysis.js";

type BatchSummary = BatchOrderAnalysisResult["summary"];
type SummaryInput = {
  readonly exceptionRate: BatchSummary["exceptionRate"];
  readonly reasonCounts: Readonly<BatchSummary["reasonCounts"]>;
  readonly topReasonCodes: ReadonlyArray<ReasonCode>;
};

const reasonCodeOrder: readonly ReasonCode[] = [
  "INVALID_QUANTITY",
  "CUSTOMER_BLOCKED",
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
];

export interface OrderSummaryDisplay {
  exceptionRateText: string;
  reasonCounts: { reasonCode: ReasonCode; count: number; text: string }[];
  reasonCountsText: string;
  topReasonText: string;
}

/** 배치 summary의 통계만 표시 형식으로 변환하며 입력을 변경하지 않는다. */
export function formatOrderSummary(summary: SummaryInput): OrderSummaryDisplay {
  const reasonCounts = reasonCodeOrder
    .map((reasonCode) => ({ reasonCode, count: summary.reasonCounts[reasonCode] }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count
      || reasonCodeOrder.indexOf(left.reasonCode) - reasonCodeOrder.indexOf(right.reasonCode))
    .map(({ reasonCode, count }) => ({ reasonCode, count, text: `${reasonCode} ${count}건` }));

  return {
    exceptionRateText: `${Math.round(summary.exceptionRate * 10000) / 100}%`,
    reasonCounts,
    reasonCountsText: reasonCounts.length === 0 ? "예외 없음" : reasonCounts.map(({ text }) => text).join(", "),
    topReasonText: summary.topReasonCodes.length === 0 ? "예외 없음" : summary.topReasonCodes.join(", "),
  };
}
