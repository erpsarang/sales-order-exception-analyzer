import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { analyzeOrderBatch } from "./batch-order-analysis.js";
import type { OrderInput } from "./order-analysis.js";

function validateOrders(value: unknown): asserts value is OrderInput[] {
  if (!Array.isArray(value)) throw new Error("JSON 최상위 값은 주문 배열이어야 합니다.");
  value.forEach((order: unknown, index) => {
    const location = `입력 ${index + 1}번째 주문`;
    if (typeof order !== "object" || order === null || Array.isArray(order)) {
      throw new Error(`${location}: 주문 객체가 필요합니다.`);
    }
    const fields = order as Record<string, unknown>;
    for (const key of ["orderId", "customerId", "materialId"] as const) {
      if (typeof fields[key] !== "string" || fields[key].trim() === "") {
        throw new Error(`${location}: ${key}는 비어 있지 않은 문자열이어야 합니다.`);
      }
    }
    for (const key of ["orderQuantity", "availableQuantity", "estimatedAmount"] as const) {
      if (key === "estimatedAmount" && !(key in fields)) continue;
      if (typeof fields[key] !== "number" || !Number.isFinite(fields[key])) {
        throw new Error(`${location}: ${key}는 유한한 숫자여야 합니다.`);
      }
    }
    for (const key of ["customerBlocked", "materialBlocked"] as const) {
      if (typeof fields[key] !== "boolean") {
        throw new Error(`${location}: ${key}는 true 또는 false여야 합니다.`);
      }
    }
    for (const key of ["dueDate", "orderComment"] as const) {
      if (key in fields && typeof fields[key] !== "string") {
        throw new Error(`${location}: ${key}는 문자열이어야 합니다.`);
      }
    }
  });
}

function escapeCsvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createExceptionCsv(orders: OrderInput[], batch: ReturnType<typeof analyzeOrderBatch>): string {
  const header = ["주문번호", "자재", "수량", "거래처", "예상금액", "납기일", "주문 코멘트", "예외 사유"];
  const rows = batch.exceptionWorklist.map((item) => {
    const order = orders[item.resultIndex]!;
    return [
      order.orderId,
      order.materialId,
      order.orderQuantity,
      order.customerId,
      order.estimatedAmount,
      order.dueDate,
      order.orderComment,
      item.exceptionGuides.map((guide) => guide.reasonCode).join(", "),
    ].map(escapeCsvCell).join(",");
  });
  return `\uFEFF${[header.map(escapeCsvCell).join(","), ...rows].join("\n")}\n`;
}

export async function runOrderAnalysisCli(args: string[]): Promise<string> {
  let filePath: string;
  let csvPath: string | undefined;
  if (args.length === 1 && args[0]) {
    [filePath] = args;
  } else if (args.length === 3 && args[0] && args[1] === "--csv" && args[2]) {
    [filePath, , csvPath] = args;
  } else {
    throw new Error("주문 JSON 파일 경로 하나를 지정하고, 필요하면 --csv <output.csv>를 추가하세요. 사용법: npm run analyze -- orders.json [--csv output.csv]");
  }
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`파일을 읽을 수 없습니다: ${JSON.stringify(filePath)}. 경로와 읽기 권한을 확인하세요.`);
  }
  let orders: unknown;
  try {
    orders = JSON.parse(source);
  } catch {
    throw new Error(`올바른 JSON이 아닙니다: ${JSON.stringify(filePath)}. JSON 문법을 확인하세요.`);
  }
  validateOrders(orders);
  const batch = analyzeOrderBatch(orders);
  if (csvPath) {
    try {
      await writeFile(csvPath, createExceptionCsv(orders, batch), "utf8");
    } catch {
      throw new Error(`CSV 파일을 저장할 수 없습니다: ${JSON.stringify(csvPath)}. 경로와 쓰기 권한을 확인하세요.`);
    }
  }
  const lines = [
    `주문 분석: 전체 ${batch.summary.totalCount}건 / 정상 ${batch.summary.shipReadyCount}건 / 예외 ${batch.summary.exceptionCount}건`,
    "주문별 결과 (입력 순서):",
  ];
  batch.results.forEach((result, index) => {
    lines.push(`입력 ${index + 1}: ${JSON.stringify(result)}`);
  });
  lines.push("예외 처리 순서 (입력 번호는 1부터 시작):");
  if (batch.exceptionWorklist.length === 0) lines.push("처리할 예외가 없습니다.");
  for (const item of batch.exceptionWorklist) {
    lines.push(`${item.rank}순위 / 입력 ${item.resultIndex + 1} / 주문 ${JSON.stringify(item.orderId)}`);
    lines.push(`상세: ${JSON.stringify(item.orderDetails)}`);
    for (const guide of item.exceptionGuides) {
      lines.push(`사유: ${guide.reasonCode} / 확인: ${guide.check} / 조치: ${guide.action}`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrderAnalysisCli(process.argv.slice(2)).then((output) => console.log(output)).catch((error: unknown) => {
  console.error(`오류: ${error instanceof Error ? error.message : "주문 분석에 실패했습니다."}`);
    process.exitCode = 1;
  });
}
