import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { analyzeOrderBatch, type BatchOrderAnalysisResult, type StockAllocationResult } from "./batch-order-analysis.js";
import { createExceptionCsv, parseCsvOrders, validateOrders } from "./order-csv.js";
import type { OrderInput } from "./order-analysis.js";
import { formatOrderSummary } from "./order-summary.js";
import { allocationReasonLabels, createSupplyRiskOrders, supplyRiskExplanation, supplyRiskSortDescription } from "./supply-risk-view.js";

// 기존 stockAllocations 결과만 읽어 공급 위험 구간을 만든다. 새 계산 규칙은 없다.
function createSupplyRiskLines(batch: BatchOrderAnalysisResult): string[] {
  const allocations = batch.stockAllocations;
  const calculated = allocations.filter((allocation): allocation is Extract<StockAllocationResult, { status: "CALCULATED" }> => allocation.status === "CALCULATED");
  const shortages = createSupplyRiskOrders(batch);
  const lines = [
    "공급 위험 (누적 재고 배분):",
    `공급 위험: ${shortages.length}건`,
    supplyRiskExplanation,
  ];
  const first = shortages[0];
  if (first) {
    lines.push(`첫 공급 위험 주문: ${first.orderId} (입력 ${first.resultIndex + 1}), 납기 ${first.dueDate}, 부족량 ${first.shortageQuantity}`);
    lines.push(`공급 위험 주문 목록 (${supplyRiskSortDescription}):`);
    for (const item of shortages) {
      lines.push(`입력 ${item.resultIndex + 1} / 주문 ${JSON.stringify(item.orderId)} / 자재 ${item.materialId} / 거래처 ${item.orderDetails.customerId} / 납기 ${item.dueDate} / 주문수량 ${item.orderDetails.orderQuantity} / 부족수량 ${item.shortageQuantity} / 예상금액 ${item.estimatedAmount === null ? "" : item.estimatedAmount}`);
    }
  }
  const partial = calculated.filter((allocation) => allocation.excludedOrders);
  if (partial.length > 0) {
    lines.push(`일부 주문을 제외하고 계산한 자재: ${partial.length}건. 제외된 주문은 공급 위험 건수에 포함되지 않습니다.`);
    for (const allocation of partial) {
      for (const excluded of allocation.excludedOrders!) {
        lines.push(`제외 주문: 자재 ${allocation.materialId} / 입력 ${excluded.resultIndex + 1} / 주문 ${JSON.stringify(excluded.orderId)} / 사유 ${excluded.reasons.map((reason) => allocationReasonLabels[reason]).join(", ")}`);
      }
    }
  }
  const unable = allocations.filter((allocation) => allocation.status === "UNABLE_TO_CALCULATE");
  if (unable.length > 0) {
    lines.push(`배분 계산 불가 자재: ${unable.length}건. 공급 위험 건수는 계산 가능한 자재의 주문만 포함합니다.`);
    for (const allocation of unable) {
      if (allocation.status !== "UNABLE_TO_CALCULATE") continue;
      lines.push(`  ${allocation.materialId}: ${allocation.reasons.map((reason) => allocationReasonLabels[reason]).join(", ")}`);
    }
    if (calculated.length === 0) lines.push("계산 가능한 자재가 없어 전체 공급 위험 여부를 판단할 수 없습니다.");
  }
  return lines;
}

export async function runOrderAnalysisCli(args: string[]): Promise<string> {
  let filePath: string;
  let csvPath: string | undefined;
  if (args.length === 1 && args[0]) [filePath] = args;
  else if (args.length === 3 && args[0] && args[1] === "--csv" && args[2]) [filePath, , csvPath] = args;
  else throw new Error("주문 JSON 또는 CSV 파일 경로 하나를 지정하고, 필요하면 --csv <output.csv>를 추가하세요. 사용법: npm run analyze -- orders.json [--csv output.csv]");
  let source: string;
  try { source = await readFile(filePath, "utf8"); } catch { throw new Error(`파일을 읽을 수 없습니다: ${JSON.stringify(filePath)}. 경로와 읽기 권한을 확인하세요.`); }
  let orders: OrderInput[];
  if (filePath.toLowerCase().endsWith(".csv")) {
    orders = parseCsvOrders(source);
    validateOrders(orders);
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { throw new Error(`올바른 JSON이 아닙니다: ${JSON.stringify(filePath)}. JSON 문법을 확인하세요.`); }
    validateOrders(parsed);
    orders = parsed;
  }
  const batch = analyzeOrderBatch(orders);
  if (csvPath) {
    try { await writeFile(csvPath, createExceptionCsv(orders, batch), "utf8"); } catch { throw new Error(`CSV 파일을 저장할 수 없습니다: ${JSON.stringify(csvPath)}. 경로와 쓰기 권한을 확인하세요.`); }
  }
  const summaryDisplay = formatOrderSummary(batch.summary);
  const lines = [
    `주문 분석: 전체 ${batch.summary.totalCount}건 / 정상 ${batch.summary.shipReadyCount}건 / 예외 ${batch.summary.exceptionCount}건`,
    `예외율: ${summaryDisplay.exceptionRateText}`,
    `예외 사유별 건수: ${summaryDisplay.reasonCountsText}`,
    `최다 사유: ${summaryDisplay.topReasonText}`,
    "주문별 결과 (입력 순서):",
  ];
  batch.results.forEach((result, index) => lines.push(`입력 ${index + 1}: ${JSON.stringify(result)}`));
  lines.push("예외 처리 순서 (입력 번호는 1부터 시작):");
  if (batch.exceptionWorklist.length === 0) lines.push("처리할 예외가 없습니다.");
  for (const item of batch.exceptionWorklist) {
    lines.push(`${item.rank}순위 / 입력 ${item.resultIndex + 1} / 주문 ${JSON.stringify(item.orderId)}`);
    lines.push(`상세: ${JSON.stringify(item.orderDetails)}`);
    for (const guide of item.exceptionGuides) lines.push(`사유: ${guide.reasonCode} / 확인: ${guide.check} / 조치: ${guide.action}`);
  }
  lines.push(...createSupplyRiskLines(batch));
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrderAnalysisCli(process.argv.slice(2)).then((output) => console.log(output)).catch((error: unknown) => {
    console.error(`오류: ${error instanceof Error ? error.message : "주문 분석에 실패했습니다."}`);
    process.exitCode = 1;
  });
}
