import { analyzeOrderBatch } from "./batch-order-analysis.js";
import type { OrderInput } from "./order-analysis.js";

export interface AppRuntimeEvidenceScenario {
  readonly id: string;
  readonly description: string;
  readonly input: {
    readonly orderCount: number;
    readonly orderIds: readonly string[];
  };
  readonly output: ReturnType<typeof analyzeOrderBatch>;
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
    },
    output: analyzeOrderBatch(orders),
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
        baseOrder,
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
        { ...baseOrder, orderId: "SO-DUP", customerBlocked: true },
        { ...baseOrder, orderId: "SO-DUP", availableQuantity: 1 },
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
