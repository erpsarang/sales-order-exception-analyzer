import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { analyzeOrderBatch } from "./batch-order-analysis.js";
import { createExceptionCsv, parseCsvOrders, validateOrders } from "./order-csv.js";
import type { OrderInput } from "./order-analysis.js";

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
  const lines = [`주문 분석: 전체 ${batch.summary.totalCount}건 / 정상 ${batch.summary.shipReadyCount}건 / 예외 ${batch.summary.exceptionCount}건`, "주문별 결과 (입력 순서):"];
  batch.results.forEach((result, index) => lines.push(`입력 ${index + 1}: ${JSON.stringify(result)}`));
  lines.push("예외 처리 순서 (입력 번호는 1부터 시작):");
  if (batch.exceptionWorklist.length === 0) lines.push("처리할 예외가 없습니다.");
  for (const item of batch.exceptionWorklist) {
    lines.push(`${item.rank}순위 / 입력 ${item.resultIndex + 1} / 주문 ${JSON.stringify(item.orderId)}`);
    lines.push(`상세: ${JSON.stringify(item.orderDetails)}`);
    for (const guide of item.exceptionGuides) lines.push(`사유: ${guide.reasonCode} / 확인: ${guide.check} / 조치: ${guide.action}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrderAnalysisCli(process.argv.slice(2)).then((output) => console.log(output)).catch((error: unknown) => {
    console.error(`오류: ${error instanceof Error ? error.message : "주문 분석에 실패했습니다."}`);
    process.exitCode = 1;
  });
}
