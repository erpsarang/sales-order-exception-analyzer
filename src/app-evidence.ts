import { createHash } from "node:crypto";
import { analyzeOrderBatch, type BatchOrderAnalysisResult, type BatchOrderResult } from "./batch-order-analysis.js";
import type { OrderInput } from "./order-analysis.js";

export interface AppRuntimeBatchOutput {
  format: "batch-projection-v1";
  fullOutputDigest: string;
  summary: {
    totalCount: number;
    shipReadyCount: number;
    exceptionCount: number;
    reasonCounts: BatchOrderAnalysisResult["summary"]["reasonCounts"];
  };
  results: Array<{
    orderId: BatchOrderResult["orderId"];
    status: BatchOrderResult["status"];
    reasonCodes: BatchOrderResult["reasonCodes"];
    guideRefs: number[];
  }>;
  guideTable: BatchOrderResult["exceptionGuides"];
  exceptionPriorities: Array<{ rank: number; resultIndex: number }>;
  exceptionWorklist: Array<{ rank: number; resultIndex: number }>;
}

/** v1의 가시 필드는 명시적으로 유지하고 전체 출력 변경은 digest에 반영한다. */
export function projectAppRuntimeBatchOutput(
  output: BatchOrderAnalysisResult,
): AppRuntimeBatchOutput {
  const fullOutputDigest = createHash("sha256").update(JSON.stringify(output), "utf8").digest("hex");
  const guideTable: AppRuntimeBatchOutput["guideTable"] = [];
  const guideIndices = new Map<string, number>();
  const results = output.results.map((result) => ({
    orderId: result.orderId,
    status: result.status,
    reasonCodes: [...result.reasonCodes],
    guideRefs: result.exceptionGuides.map((guide) => {
      const key = JSON.stringify(guide);
      const existing = guideIndices.get(key);
      if (existing !== undefined) return existing;
      const index = guideTable.length;
      guideTable.push({ ...guide });
      guideIndices.set(key, index);
      return index;
    }),
  }));
  return {
    format: "batch-projection-v1",
    fullOutputDigest,
    summary: {
      totalCount: output.summary.totalCount,
      shipReadyCount: output.summary.shipReadyCount,
      exceptionCount: output.summary.exceptionCount,
      reasonCounts: { ...output.summary.reasonCounts },
    },
    results,
    guideTable,
    exceptionPriorities: output.exceptionPriorities.map(({ rank, resultIndex }) => ({ rank, resultIndex })),
    exceptionWorklist: output.exceptionWorklist.map(({ rank, resultIndex }) => ({ rank, resultIndex })),
  };
}

export interface AppRuntimeEvidenceScenario {
  readonly id: string;
  readonly description: string;
  readonly input: {
    readonly orderCount: number;
    readonly orderIds: readonly string[];
    readonly orders: ReadonlyArray<Readonly<OrderInput>>;
  };
  readonly output: AppRuntimeBatchOutput;
}

export interface AppRuntimeEvidence {
  readonly schemaVersion: 1;
  readonly kind: "sales-order-app-runtime-evidence";
  readonly sourceSha: string;
  readonly productPurpose: string;
  readonly scenarios: readonly AppRuntimeEvidenceScenario[];
}

const GIT_SHA = /^[0-9a-f]{40,64}$/;

const baseOrder: Readonly<OrderInput> = Object.freeze({
  orderId: "SO-READY-1",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
});

function scenario(
  id: string,
  description: string,
  orders: ReadonlyArray<Readonly<OrderInput>>,
): AppRuntimeEvidenceScenario {
  return {
    id,
    description,
    input: {
      orderCount: orders.length,
      orderIds: orders.map(({ orderId }) => orderId),
      orders: orders.map((order) => ({ ...order })),
    },
    output: projectAppRuntimeBatchOutput(analyzeOrderBatch(orders)),
  };
}

export function createAppRuntimeEvidence(
  sourceSha: string,
  productPurpose: string,
): AppRuntimeEvidence {
  if (!GIT_SHA.test(sourceSha)) throw new Error("sourceSha must be a lowercase Git commit SHA");
  if (!productPurpose.trim()) throw new Error("productPurpose must be non-empty");

  const scenarios: AppRuntimeEvidenceScenario[] = [
    scenario(
      "all-ready",
      "모든 주문이 출고 가능한 batch",
      [
        baseOrder,
        { ...baseOrder, orderId: "SO-READY-2", orderQuantity: 5, availableQuantity: 5 },
      ],
    ),
    scenario(
      "mixed-exceptions",
      "정상 주문과 서로 다른 예외 사유가 함께 있는 batch",
      [
        {
          ...baseOrder,
          estimatedAmount: 1250000,
          dueDate: "2026-10-15",
          orderComment: "오전 입고 요청",
        },
        { ...baseOrder, orderId: "SO-INVALID", orderQuantity: 0 },
        { ...baseOrder, orderId: "SO-CUSTOMER", customerBlocked: true },
        { ...baseOrder, orderId: "SO-STOCK", availableQuantity: 1 },
      ],
    ),
    scenario(
      "multiple-reasons",
      "한 주문에 여러 예외 사유가 동시에 있는 batch",
      [{
        ...baseOrder,
        orderId: "SO-MULTI",
        customerBlocked: true,
        materialBlocked: true,
        availableQuantity: 1,
      }],
    ),
    scenario(
      "duplicate-exception-id",
      "동일 주문 ID의 예외 입력이 반복되는 batch",
      [
        {
          ...baseOrder,
          orderId: "SO-DUP",
          customerBlocked: true,
          estimatedAmount: 1250000,
          dueDate: "2026-10-15",
          orderComment: "오전 입고 요청",
        },
        {
          ...baseOrder,
          orderId: "SO-DUP",
          customerId: "C-002",
          materialId: "M-002",
          orderQuantity: 5,
          availableQuantity: 1,
          estimatedAmount: 625000,
          dueDate: "2026-10-16",
          orderComment: "오후 입고 요청",
        },
      ],
    ),
  ];

  return {
    schemaVersion: 1,
    kind: "sales-order-app-runtime-evidence",
    sourceSha,
    productPurpose,
    scenarios,
  };
}

export function verifyAppRuntimeEvidence(
  evidence: AppRuntimeEvidence,
  expectedSourceSha: string,
): void {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== "sales-order-app-runtime-evidence" ||
    evidence.sourceSha !== expectedSourceSha ||
    !evidence.productPurpose?.trim() ||
    !Array.isArray(evidence.scenarios)
  ) {
    throw new Error("invalid App Runtime Evidence identity");
  }

  const regenerated = createAppRuntimeEvidence(expectedSourceSha, evidence.productPurpose);
  if (JSON.stringify(regenerated) !== JSON.stringify(evidence)) {
    throw new Error("App Runtime Evidence does not match deterministic app execution");
  }

  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 8_192) {
    throw new Error("App Runtime Evidence exceeds bounded evidence item budget");
  }
}
