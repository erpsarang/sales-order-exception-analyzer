import { createDecisionContextProvider, type DecisionContextProvider, type DecisionReference } from "./decision-context.js";

type ReferenceKind = "고객" | "자재/재고";

function referenceError(kind: ReferenceKind, location: string, message: string): Error {
  return new Error(`${kind} 기준 CSV ${location}: ${message}`);
}

/** 데이터 행 번호는 헤더를 제외한 1부터 시작하는 논리적 CSV 레코드 번호다. 인용 셀 내부 줄바꿈은 보존한다. */
function parseReferenceCsv(source: string, kind: ReferenceKind): string[][] {
  const text = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  const syntaxError = (message: string) => referenceError(kind, `${rows.length === 0 ? "1번째 행 헤더" : `${rows.length}번째 행`} ${row.length + 1}번째 열`, message);
  const finishCell = () => {
    row.push(cell);
    cell = "";
    afterQuote = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else cell += character;
      continue;
    }
    if (afterQuote && character !== "," && character !== "\n" && character !== "\r") {
      throw syntaxError("닫는 큰따옴표 뒤에는 쉼표 또는 줄바꿈만 올 수 있습니다.");
    }
    if (character === ",") {
      finishCell();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else if (character === '"') {
      if (cell !== "") throw syntaxError("큰따옴표는 셀의 시작에서만 사용할 수 있습니다.");
      quoted = true;
    } else cell += character;
  }
  if (quoted) throw syntaxError("닫히지 않은 큰따옴표가 있습니다.");
  if (cell !== "" || row.length > 0 || afterQuote) finishRow();
  return rows;
}

function readReferenceRows(
  source: string,
  kind: ReferenceKind,
  requiredFields: readonly string[],
  idField: string,
): Record<string, string>[] {
  const rows = parseReferenceCsv(source, kind);
  const header = rows.shift();
  if (!header) throw referenceError(kind, "1번째 행 헤더", "헤더가 필요합니다.");
  const fields = new Set<string>();
  header.forEach((field, index) => {
    const location = `1번째 행 헤더 ${index + 1}번째 열`;
    if (!requiredFields.includes(field)) {
      throw referenceError(kind, location, `알 수 없는 필드 ${JSON.stringify(field)}입니다.`);
    }
    if (fields.has(field)) throw referenceError(kind, location, `${field} 필드가 중복되었습니다.`);
    fields.add(field);
  });
  for (const field of requiredFields) {
    if (!fields.has(field)) throw referenceError(kind, "1번째 행 헤더", `필수 필드 ${field}이(가) 없습니다.`);
  }

  const identifiers = new Map<string, number>();
  return rows.map((row, index) => {
    const rowNumber = index + 1;
    if (row.length !== header.length) {
      throw referenceError(kind, `${rowNumber}번째 행`, `헤더는 ${header.length}개 필드인데 ${row.length}개 필드가 있습니다.`);
    }
    const values: Record<string, string> = Object.fromEntries(header.map((field, column) => [field, row[column]!]));
    const id = values[idField]!;
    if (id.trim() === "") {
      throw referenceError(kind, `${rowNumber}번째 행 ${idField}`, "비어 있지 않은 식별자여야 합니다.");
    }
    const previousRow = identifiers.get(id);
    if (previousRow !== undefined) {
      throw referenceError(kind, `${rowNumber}번째 행 ${idField}`, `식별자 ${JSON.stringify(id)}가 ${previousRow}번째 행과 중복되었습니다.`);
    }
    identifiers.set(id, rowNumber);
    return values;
  });
}

function readBoolean(value: string, kind: ReferenceKind, row: number, field: string): boolean {
  if (value !== "true" && value !== "false") {
    throw referenceError(kind, `${row}번째 행 ${field}`, "소문자 true 또는 false여야 합니다.");
  }
  return value === "true";
}

/** 두 CSV를 검증한 뒤 기존 공급자를 반환한다. 식별자와 재고 스냅샷은 그대로 보존한다. */
export function createCsvDecisionContextProvider(customerCsv: string, materialCsv: string): DecisionContextProvider {
  const customers = readReferenceRows(customerCsv, "고객", ["customerId", "customerBlocked"], "customerId")
    .map((row, index) => ({
      customerId: row.customerId!,
      customerBlocked: readBoolean(row.customerBlocked!, "고객", index + 1, "customerBlocked"),
    }));
  const materialRows = readReferenceRows(materialCsv, "자재/재고", ["materialId", "materialBlocked", "availableQuantity"], "materialId")
    .map((row, index) => {
      const materialBlocked = readBoolean(row.materialBlocked!, "자재/재고", index + 1, "materialBlocked");
      const value = row.availableQuantity!;
      const availableQuantity = Number(value);
      if (value.trim() === "" || !Number.isFinite(availableQuantity)) {
        throw referenceError("자재/재고", `${index + 1}번째 행 availableQuantity`, "유한한 숫자여야 합니다.");
      }
      return { materialId: row.materialId!, materialBlocked, availableQuantity };
    });
  const reference: DecisionReference = {
    customers,
    materials: materialRows.map(({ materialId, materialBlocked }) => ({ materialId, materialBlocked })),
    inventory: materialRows.map(({ materialId, availableQuantity }) => ({ materialId, availableQuantity })),
  };
  return createDecisionContextProvider(reference);
}
