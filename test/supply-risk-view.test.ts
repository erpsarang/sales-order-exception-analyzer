import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { runOrderAnalysisCli } from "../src/order-analysis-cli.js";
import { createSupplyRiskCsv } from "../src/order-csv.js";
import { allocationReasonLabels, createSupplyRiskOrders, supplyRiskExplanation, supplyRiskSortDescription } from "../src/supply-risk-view.js";

const base = { customerId: "C-1", materialId: "M-1", orderQuantity: 1, availableQuantity: 0, customerBlocked: false, materialBlocked: false };
const orders = [
  { ...base, orderId: "X", dueDate: "2026-10-01", estimatedAmount: 100 },
  { ...base, orderId: "Y", dueDate: "2026-10-01", estimatedAmount: 500 },
  { ...base, orderId: "Z", dueDate: "2026-10-01" },
  { ...base, orderId: "W", dueDate: "2026-10-02", estimatedAmount: 1 },
  { ...base, orderId: "OK", materialId: "M-2", availableQuantity: 5, dueDate: "2026-10-01" },
  { ...base, orderId: "U1", materialId: "M-3", availableQuantity: 1, dueDate: "2026-10-01" },
  { ...base, orderId: "U2", materialId: "M-3", availableQuantity: 2, dueDate: "2026-10-01" },
];

test("공급 위험 주문은 부족 주문만 납기, 예상금액 내림차순(없으면 뒤), 입력 순서로 정렬한다", () => {
  const result = createSupplyRiskOrders(analyzeOrderBatch(orders));
  assert.deepEqual(result.map((item) => item.orderId), ["Y", "X", "Z", "W"]);
  assert.deepEqual(result.map((item) => item.estimatedAmount), [500, 100, null, 1]);
});

test("배분 불가 사유 문구와 설명 문장을 제공한다", () => {
  assert.equal(allocationReasonLabels.CONFLICTING_AVAILABLE_QUANTITY, "같은 자재의 가용재고 값이 서로 다름");
  assert.ok(supplyRiskExplanation.includes("입고 예정 등 미래 공급은 반영하지 않습니다."));
});

test("공급 위험 CSV와 CLI 출력의 주문 순서가 공유 목록과 같다", async () => {
  const expected = createSupplyRiskOrders(analyzeOrderBatch(orders)).map((item) => item.orderId);
  const csvIds = createSupplyRiskCsv(analyzeOrderBatch(orders)).split("\n").slice(1).filter((line) => line !== "").map((line) => line.split(",")[0]);
  assert.deepEqual(csvIds, expected);
  const directory = mkdtempSync(join(tmpdir(), "supply-risk-"));
  try {
    const path = join(directory, "orders.json");
    writeFileSync(path, JSON.stringify(orders));
    const lines = (await runOrderAnalysisCli([path])).split("\n");
    const cliIds = lines.filter((line) => /^입력 \d+ \/ 주문 /.test(line) && line.includes("부족수량")).map((line) => /주문 "([^"]+)"/.exec(line)![1]);
    assert.deepEqual(cliIds, expected);
    assert.ok(lines.includes(supplyRiskExplanation));
    assert.ok(lines.includes(`공급 위험 주문 목록 (${supplyRiskSortDescription}):`));
    assert.ok(lines.some((line) => line.trim() === "M-3: 같은 자재의 가용재고 값이 서로 다름"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
