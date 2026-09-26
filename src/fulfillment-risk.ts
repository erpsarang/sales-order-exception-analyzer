import type { OrderInput } from "./order-analysis.js";

export type ExclusionReason = "INVALID_DUE_DATE" | "INVALID_ORDER_QUANTITY";
export type CalculationIssue =
  | "INVALID_AVAILABLE_QUANTITY"
  | "INCONSISTENT_AVAILABLE_QUANTITY"
  | "NO_ELIGIBLE_ORDERS";

export interface ExcludedOrder {
  inputIndex: number;
  orderId: string;
  reasons: ExclusionReason[];
}

export interface FulfillmentStep {
  inputIndex: number;
  orderId: string;
  dueDate: string;
  orderQuantity: number;
  remainingBefore: number;
  remainingAfter: number;
  shortageQuantity: number;
  /** JavaScript number 합산이며 표현 범위를 넘으면 Infinity가 된다. */
  cumulativeShortageQuantity: number;
}

export interface FirstShortage {
  inputIndex: number;
  orderId: string;
  dueDate: string;
  shortageQuantity: number;
}

export interface MaterialFulfillmentRisk {
  materialId: string;
  /** 재고를 확정할 수 없으면 unavailable, 제외 주문이 있으면 partial. */
  status: "complete" | "partial" | "unavailable";
  initialStock: number | null;
  calculationIssues: CalculationIssue[];
  excludedOrders: ExcludedOrder[];
  steps: FulfillmentStep[];
  /** 계산 대상 주문에 한정된다. null만으로 전체 주문의 부족 없음을 뜻하지 않는다. */
  firstShortage: FirstShortage | null;
}

type EligibleOrder = Pick<FulfillmentStep, "inputIndex" | "orderId" | "dueDate" | "orderQuantity">;

function validDueDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2
    ? (leapYear ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return day <= daysInMonth;
}

function validStock(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 자재 첫 등장 순서로 반환하는 독립적인 순수 계산이다.
 * 제외 주문도 재고 일관성 검사에는 포함하며 차단 여부와 금액은 사용하지 않는다.
 * partial의 firstShortage는 유효한 주문만 계산한 결과다. 전부 제외된 경우에도
 * partial을 유지하고 NO_ELIGIBLE_ORDERS로 계산 대상 없음을 명시한다.
 * complete이고 firstShortage가 null일 때만 모든 입력 수요에 부족이 없다.
 */
export function analyzeFulfillmentRisk(
  orders: ReadonlyArray<Readonly<OrderInput>>,
): MaterialFulfillmentRisk[] {
  const groups = new Map<string, { order: Readonly<OrderInput>; inputIndex: number }[]>();
  orders.forEach((order, inputIndex) => {
    const group = groups.get(order.materialId);
    const entry = { order, inputIndex };
    if (group) group.push(entry);
    else groups.set(order.materialId, [entry]);
  });

  const results: MaterialFulfillmentRisk[] = [];
  for (const [materialId, group] of groups) {
    const eligible: EligibleOrder[] = [];
    const excludedOrders: ExcludedOrder[] = [];
    let stock: number | null = null;
    let invalidStock = false;
    let inconsistentStock = false;

    for (const { order, inputIndex } of group) {
      if (!validStock(order.availableQuantity)) invalidStock = true;
      else if (stock === null) stock = order.availableQuantity === 0 ? 0 : order.availableQuantity;
      else if (stock !== order.availableQuantity) inconsistentStock = true;

      const reasons: ExclusionReason[] = [];
      const dueDate = order.dueDate;
      const dateIsValid = validDueDate(dueDate);
      if (!dateIsValid) reasons.push("INVALID_DUE_DATE");
      if (typeof order.orderQuantity !== "number" || !Number.isFinite(order.orderQuantity) || order.orderQuantity <= 0) {
        reasons.push("INVALID_ORDER_QUANTITY");
      }
      if (reasons.length > 0) excludedOrders.push({ inputIndex, orderId: order.orderId, reasons });
      else if (dateIsValid) {
        eligible.push({ inputIndex, orderId: order.orderId, dueDate, orderQuantity: order.orderQuantity });
      }
    }

    const calculationIssues: CalculationIssue[] = [];
    if (invalidStock) calculationIssues.push("INVALID_AVAILABLE_QUANTITY");
    if (inconsistentStock) calculationIssues.push("INCONSISTENT_AVAILABLE_QUANTITY");
    if (eligible.length === 0) calculationIssues.push("NO_ELIGIBLE_ORDERS");
    const initialStock = invalidStock || inconsistentStock ? null : stock;
    const result: MaterialFulfillmentRisk = {
      materialId,
      status: initialStock === null ? "unavailable" : excludedOrders.length > 0 ? "partial" : "complete",
      initialStock,
      calculationIssues,
      excludedOrders,
      steps: [],
      firstShortage: null,
    };

    if (initialStock !== null) {
      eligible.sort((left, right) => left.dueDate === right.dueDate
        ? left.inputIndex - right.inputIndex
        : left.dueDate < right.dueDate ? -1 : 1);
      let remaining = initialStock;
      let cumulativeShortageQuantity = 0;
      for (const order of eligible) {
        const remainingBefore = remaining;
        const shortageQuantity = Math.max(0, order.orderQuantity - remainingBefore);
        remaining = Math.max(0, remainingBefore - order.orderQuantity);
        cumulativeShortageQuantity += shortageQuantity;
        result.steps.push({
          ...order,
          remainingBefore,
          remainingAfter: remaining,
          shortageQuantity,
          cumulativeShortageQuantity,
        });
        if (shortageQuantity > 0 && result.firstShortage === null) {
          result.firstShortage = {
            inputIndex: order.inputIndex,
            orderId: order.orderId,
            dueDate: order.dueDate,
            shortageQuantity,
          };
        }
      }
    }
    results.push(result);
  }
  return results;
}
