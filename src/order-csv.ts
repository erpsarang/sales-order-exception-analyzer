import { analyzeOrderBatch } from "./batch-order-analysis.js";
import type { OrderInput } from "./order-analysis.js";
import { enrichOrder, type BusinessOrder, type DecisionContextProvider } from "./decision-context.js";

const requiredStringFields = ["orderId", "customerId", "materialId"] as const;
const requiredNumberFields = ["orderQuantity", "availableQuantity"] as const;
const requiredBooleanFields = ["customerBlocked", "materialBlocked"] as const;
const optionalNumberFields = ["estimatedAmount"] as const;
const optionalStringFields = ["dueDate", "orderComment"] as const;
const csvFields = [...requiredStringFields, ...requiredNumberFields, ...requiredBooleanFields, ...optionalNumberFields, ...optionalStringFields] as const;
type CsvField = (typeof csvFields)[number];

export function validateOrders(value: unknown): asserts value is OrderInput[] {
  if (!Array.isArray(value)) throw new Error("JSON 최상위 값은 주문 배열이어야 합니다.");
  value.forEach((order: unknown, index) => {
    const location = `입력 ${index + 1}번째 주문`;
    if (typeof order !== "object" || order === null || Array.isArray(order)) throw new Error(`${location}: 주문 객체가 필요합니다.`);
    const fields = order as Record<string, unknown>;
    for (const key of requiredStringFields) {
      if (typeof fields[key] !== "string" || fields[key].trim() === "") throw new Error(`${location}: ${key}는 비어 있지 않은 문자열이어야 합니다.`);
    }
    for (const key of [...requiredNumberFields, ...optionalNumberFields] as const) {
      if (key === "estimatedAmount" && !(key in fields)) continue;
      if (typeof fields[key] !== "number" || !Number.isFinite(fields[key])) throw new Error(`${location}: ${key}는 유한한 숫자여야 합니다.`);
    }
    for (const key of requiredBooleanFields) {
      if (typeof fields[key] !== "boolean") throw new Error(`${location}: ${key}는 true 또는 false여야 합니다.`);
    }
    for (const key of optionalStringFields) {
      if (key in fields && typeof fields[key] !== "string") throw new Error(`${location}: ${key}는 문자열이어야 합니다.`);
    }
  });
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; } else { quoted = false; afterQuote = true; }
      } else cell += character;
      continue;
    }
    if (afterQuote) {
      if (character === ",") { row.push(cell); cell = ""; afterQuote = false; }
      else if (character === "\n" || character === "\r") {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(cell); rows.push(row); row = []; cell = ""; afterQuote = false;
      } else throw new Error("CSV 형식 오류: 닫는 큰따옴표 뒤에는 쉼표 또는 줄바꿈만 올 수 있습니다.");
      continue;
    }
    if (character === '"') {
      if (cell !== "") throw new Error("CSV 형식 오류: 큰따옴표는 셀의 시작에서만 사용할 수 있습니다.");
      quoted = true;
    } else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("CSV 형식 오류: 닫히지 않은 큰따옴표가 있습니다.");
  if (cell !== "" || row.length > 0 || afterQuote) { row.push(cell); rows.push(row); }
  return rows;
}

function csvError(row: number, field: string, message: string): Error {
  return new Error(`CSV 데이터 ${row}번째 행 ${field}: ${message}`);
}

export interface CsvUploadResult {
  orders: OrderInput[];
  referenceSource: "csv" | "provider";
}

export interface MissingCsvReference {
  orderIndex: number;
  orderId: string;
  referenceKind: "customer" | "material" | "inventory";
  identifier: string;
}

export type CsvUploadPreflightResult =
  | { status: "ready"; upload: CsvUploadResult }
  | { status: "missing-references"; missingReferences: MissingCsvReference[] };

interface ParsedOrderRows {
  orders: BusinessOrder[];
  referenceSource: "csv" | "provider";
}

export function parseCsvOrders(source: string): OrderInput[] {
  return parseOrderRows(source).orders;
}

export function parseCsvOrdersForUpload(source: string, provider: DecisionContextProvider): OrderInput[] {
  return parseCsvUpload(source, provider).orders;
}

/** 출처는 기준값 보완 분기로 결정하며 공급자의 데이터 성격은 호출자가 설명한다. */
export function parseCsvUpload(source: string, provider: DecisionContextProvider): CsvUploadResult {
  return parseOrderRows(source, provider);
}

/** ready는 기준 점검 통과를 뜻하며 출고 가능 판정은 아니다. 조회 오류는 그대로 전달한다. */
export function preflightCsvUploadReferences(source: string, provider: DecisionContextProvider): CsvUploadPreflightResult {
  const parsed = parseValidatedOrderRows(source, true);
  const missingReferences: MissingCsvReference[] = [];
  if (parsed.referenceSource === "provider") {
    parsed.orders.forEach((order, orderIndex) => {
      if (provider.getCustomerBlocked(order.customerId) === undefined) {
        missingReferences.push({ orderIndex, orderId: order.orderId, referenceKind: "customer", identifier: order.customerId });
      }
      if (provider.getMaterialBlocked(order.materialId) === undefined) {
        missingReferences.push({ orderIndex, orderId: order.orderId, referenceKind: "material", identifier: order.materialId });
      }
      if (provider.getAvailableQuantity(order.materialId) === undefined) {
        missingReferences.push({ orderIndex, orderId: order.orderId, referenceKind: "inventory", identifier: order.materialId });
      }
    });
  }
  if (missingReferences.length > 0) return { status: "missing-references", missingReferences };
  return { status: "ready", upload: completeOrderRows(parsed, provider) };
}

function parseOrderRows(source: string, provider?: DecisionContextProvider): CsvUploadResult {
  return completeOrderRows(parseValidatedOrderRows(source, provider !== undefined), provider);
}

function completeOrderRows(parsed: ParsedOrderRows, provider?: DecisionContextProvider): CsvUploadResult {
  // 모든 업무 필드 검증을 마친 뒤 조회하며, 실패 시 배열을 반환하지 않는다.
  if (parsed.referenceSource === "provider" && provider !== undefined) {
    return { orders: parsed.orders.map((order) => enrichOrder(order, provider)), referenceSource: "provider" };
  }
  return { orders: parsed.orders as OrderInput[], referenceSource: "csv" };
}

function parseValidatedOrderRows(source: string, allowBusinessFields: boolean): ParsedOrderRows {
  const rows = parseCsv(source);
  const header = rows.shift();
  if (!header) throw new Error("CSV 헤더가 필요합니다.");
  header[0] = header[0]!.replace(/^\uFEFF/, "");
  const fields = new Set<string>();
  for (const field of header) {
    if (!csvFields.includes(field as CsvField)) throw new Error(`CSV 헤더 오류: 알 수 없는 필드 ${JSON.stringify(field)}입니다.`);
    if (fields.has(field)) throw new Error(`CSV 헤더 오류: ${field} 필드가 중복되었습니다.`);
    fields.add(field);
  }
  const businessOnly = allowBusinessFields && ["availableQuantity", ...requiredBooleanFields].every((field) => !fields.has(field));
  const requiredFields = businessOnly
    ? [...requiredStringFields, "orderQuantity"]
    : [...requiredStringFields, ...requiredNumberFields, ...requiredBooleanFields];
  for (const field of requiredFields) {
    if (!fields.has(field)) throw new Error(`CSV 헤더 오류: 필수 필드 ${field}이(가) 없습니다.`);
  }
  const orders = rows.map((row, index) => {
    const rowNumber = index + 1;
    if (row.length !== header.length) throw new Error(`CSV 데이터 ${rowNumber}번째 행: 헤더는 ${header.length}개 필드인데 ${row.length}개 필드가 있습니다.`);
    const values = Object.fromEntries(header.map((field, column) => [field, row[column]!])) as Record<CsvField, string>;
    const order: Record<string, unknown> = {};
    for (const field of requiredStringFields) {
      const value = values[field];
      if (value.trim() === "") throw csvError(rowNumber, field, "비어 있지 않은 문자열이어야 합니다.");
      order[field] = value;
    }
    for (const field of [...requiredNumberFields, ...optionalNumberFields] as const) {
      const value = values[field];
      if (value === undefined || (field === "estimatedAmount" && value.trim() === "")) continue;
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) throw csvError(rowNumber, field, "유한한 숫자여야 합니다.");
      order[field] = number;
    }
    if (!businessOnly) for (const field of requiredBooleanFields) {
      const value = values[field];
      if (value !== "true" && value !== "false") throw csvError(rowNumber, field, "true 또는 false여야 합니다.");
      order[field] = value === "true";
    }
    for (const field of optionalStringFields) {
      const value = values[field];
      if (value !== undefined && value !== "") order[field] = value;
    }
    return order as unknown as BusinessOrder;
  });
  return { orders, referenceSource: businessOnly ? "provider" : "csv" };
}

function escapeCsvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// 기존 호출의 CSV 형식은 보존하며 웹 다운로드는 재고 열을 명시적으로 포함한다.
export function createExceptionCsv(orders: OrderInput[], batch: ReturnType<typeof analyzeOrderBatch>, includeStock = false): string {
  const header = ["주문번호", "자재", "수량", ...(includeStock ? ["가용재고", "부족 수량"] : []), "거래처", "예상금액", "납기일", "주문 코멘트", "예외 사유"];
  const rows = batch.exceptionWorklist.map((item) => {
    const order = orders[item.resultIndex]!;
    const shortage = item.reasonCodes.includes("INSUFFICIENT_STOCK")
      ? order.orderQuantity - order.availableQuantity
      : undefined;
    return [order.orderId, order.materialId, order.orderQuantity, ...(includeStock ? [order.availableQuantity, shortage] : []), order.customerId, order.estimatedAmount, order.dueDate, order.orderComment, item.exceptionGuides.map((guide) => guide.reasonCode).join(", ")].map(escapeCsvCell).join(",");
  });
  return `\uFEFF${[header.map(escapeCsvCell).join(","), ...rows].join("\n")}\n`;
}
