import "./web-styles.css";
import { analyzeOrderBatch, type StockAllocationResult } from "./batch-order-analysis.js";
import { createExceptionCsv, createSupplyRiskCsv, preflightCsvUploadReferences, validateOrders, type CsvUploadResult, type MissingCsvReference } from "./order-csv.js";
import { localDecisionContextProvider } from "./local-decision-reference.js";
import { createCsvDecisionContextProvider } from "./csv-decision-reference.js";
import { formatOrderSummary, type OrderSummaryDisplay } from "./order-summary.js";

const fileInput = document.querySelector<HTMLInputElement>("#csv-file")!;
const customerInput = document.querySelector<HTMLInputElement>("#customer-file")!;
const materialInput = document.querySelector<HTMLInputElement>("#material-file")!;
const inputs = [fileInput, customerInput, materialInput] as const;
const analyzeButton = document.querySelector<HTMLButtonElement>("#analyze-button")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download-button")!;
const errorMessage = document.querySelector<HTMLElement>("#error-message")!;
const resultSection = document.querySelector<HTMLElement>("#result-section")!;
const exceptionTable = document.querySelector<HTMLTableElement>("#exception-table")!;
const tableBody = exceptionTable.querySelector("tbody")!;
const emptyMessage = document.querySelector<HTMLElement>("#empty-message")!;
type Selection = readonly [File | undefined, File | undefined, File | undefined];
const selection = (): Selection => [fileInput.files?.[0], customerInput.files?.[0], materialInput.files?.[0]];
const matches = (files: Selection): boolean => inputs.every((input, index) => input.files?.[0] === files[index]);
let executionId = 0;
let resultExecutionId: number | undefined;
let resultFiles: Selection | undefined;
let exceptionCsv = "";
let supplyRiskBatch: ReturnType<typeof analyzeOrderBatch> | undefined;

const analysisStatus = document.createElement("p");
analysisStatus.id = "analysis-status";
analysisStatus.setAttribute?.("role", "status");
analysisStatus.setAttribute?.("aria-live", "polite");
resultSection.insertAdjacentElement?.("beforebegin", analysisStatus);
const missingReferenceSection = document.createElement("section");
missingReferenceSection.id = "missing-references";
missingReferenceSection.hidden = true;
resultSection.insertAdjacentElement?.("beforebegin", missingReferenceSection);
function renderMissingReferences(missingReferences: MissingCsvReference[]): void {
  const heading = document.createElement("h2");
  heading.textContent = "누락된 기준 데이터";
  const guidance = document.createElement("p");
  guidance.textContent = "누락된 기준이 있어 분석을 완료하지 않았습니다. 아래 식별자의 고객·자재·재고 기준을 CSV에 보완한 뒤 다시 분석하세요. 누락값은 추정하거나 자동 입력하지 않습니다.";
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = "주문별 누락 기준 (입력 행 번호는 헤더를 제외한 데이터 행 순서)";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["입력 행 번호", "주문번호", "기준 종류", "식별자"]) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = label;
    headerRow.append(header);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  const labels = { customer: "고객", material: "자재", inventory: "재고" };
  for (const missing of missingReferences) {
    const row = document.createElement("tr");
    row.append(cell(missing.orderIndex + 1), cell(missing.orderId), cell(labels[missing.referenceKind]), cell(missing.identifier));
    body.append(row);
  }
  table.append(caption, head, body);
  missingReferenceSection.replaceChildren(heading, guidance, table);
  missingReferenceSection.hidden = false;
  showError(missingReferences.map(missing => `주문 ${missing.orderId}: ${labels[missing.referenceKind]} 기준 ${missing.identifier} 누락`).join("\n"));
}
function promptForAnalysis(): void {
  const [order, customer, material] = selection();
  analysisStatus.textContent = !order ? "분석할 주문 CSV 파일을 선택하세요."
    : Boolean(customer) !== Boolean(material) ? "고객 기준 CSV와 자재/재고 기준 CSV를 모두 선택하세요."
    : "선택한 CSV 파일을 분석하려면 분석하기 버튼을 누르세요.";
}
promptForAnalysis();

const uploadHelp = document.createElement("section");
uploadHelp.id = "csv-upload-help";
const uploadHelpHeading = document.createElement("h2");
uploadHelpHeading.textContent = "CSV 양식과 입력 예시";
uploadHelp.append(uploadHelpHeading);
for (const text of [
  "기본 주문 필수 열 4개: orderId, customerId, materialId, orderQuantity (숫자). 선택 열: estimatedAmount (숫자), dueDate, orderComment. 선택 열은 생략하거나 셀을 비워 둘 수 있습니다.",
  "고객 기준 필수 열 2개: customerId, customerBlocked. 자재/재고 기준 필수 열 3개: materialId, materialBlocked, availableQuantity. 두 기준 CSV에는 선택 열이 없습니다.",
  "customerBlocked와 materialBlocked는 소문자 true가 차단, false가 미차단입니다. availableQuantity는 유한한 숫자이며 식별자는 주문 값과 정확히 일치해야 합니다.",
  "세 파일 분석: 기준 CSV 업로드용 주문 양식과 두 기준 파일을 함께 선택하세요. 업로드용 양식은 기본 주문과 선택 열만 포함하므로 직접 판정 열을 제거할 필요가 없습니다. 기준 하나만 선택하면 분석할 수 없습니다.",
  "주문 단독 분석: 주문 단독용 양식의 직접 판정 열 3개에 기준값을 입력하고 주문 CSV만 선택하세요 (필수 열 총 7개). 직접 판정 열 없이 기본 주문 열만 있으면 운영 데이터가 아닌 로컬 예제 기준을 사용합니다.",
]) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  uploadHelp.append(paragraph);
}
const templateNotice = document.createElement("p");
templateNotice.textContent = "두 양식은 예제 주문 2건을 담고 있습니다. 실제 업무에서는 주문 데이터를 교체하세요. 주문 단독용은 기준값도 교체해야 하며, 예제 값으로는 정상 1건과 차단·재고 부족 1건입니다. 기준 CSV 업로드용의 분석 결과는 함께 선택한 기준 파일의 값에 따라 달라집니다.";
uploadHelp.append(templateNotice);
for (const template of [
  { label: "주문 단독용 CSV 양식 다운로드", filename: "example-order-template.csv", uploaded: false },
  { label: "기준 CSV 업로드용 주문 양식 다운로드", filename: "example-order-upload-template.csv", uploaded: true },
]) {
  const templateDownloadButton = document.createElement("button");
  templateDownloadButton.type = "button";
  templateDownloadButton.textContent = template.label;
  uploadHelp.append(templateDownloadButton);
  templateDownloadButton.addEventListener("click", async () => {
    const { createOrderCsvTemplate, createUploadedReferenceOrderCsvTemplate } = await import("./order-csv-template.js");
    const csv = template.uploaded ? createUploadedReferenceOrderCsvTemplate() : createOrderCsvTemplate();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = template.filename;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  });
}
const uploadAnchor = fileInput.closest?.("label") ?? fileInput;
uploadAnchor.insertAdjacentElement?.("afterend", uploadHelp);

const headerRow = document.createElement("tr");
for (const label of ["주문번호", "자재", "수량", "가용재고", "부족 수량", "거래처", "예상금액", "납기일", "주문 코멘트", "예외 사유"]) {
  const header = document.createElement("th");
  header.scope = "col";
  header.textContent = label;
  headerRow.append(header);
}
exceptionTable.querySelector("thead")!.replaceChildren(headerRow);
const statistics = document.createElement("dl");
statistics.className = "exception-statistics";
function statistic(label: string): HTMLElement {
  const group = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const value = document.createElement("dd");
  group.append(term, value);
  statistics.append(group);
  return value;
}
const exceptionRateValue = statistic("예외율");
const reasonCountsValue = statistic("예외 사유별 건수");
const topReasonValue = statistic("최다 사유");
resultSection.prepend(statistics);
const referenceSection = document.createElement("section");
referenceSection.id = "reference-provenance";
referenceSection.hidden = true;
resultSection.prepend(referenceSection);
const allocationSection = document.createElement("section");
allocationSection.id = "stock-allocations";
allocationSection.hidden = true;
resultSection.append(allocationSection);
const supplyRiskSection = document.createElement("section");
supplyRiskSection.id = "supply-risk-summary";
supplyRiskSection.hidden = true;
allocationSection.insertAdjacentElement?.("beforebegin", supplyRiskSection);
const supplyRiskDownloadButton = document.createElement("button");
supplyRiskDownloadButton.id = "supply-risk-download-button";
supplyRiskDownloadButton.type = "button";
supplyRiskDownloadButton.textContent = "공급 위험 CSV 다운로드";
supplyRiskDownloadButton.hidden = true;
function renderSupplyRisk(batch: ReturnType<typeof analyzeOrderBatch>): void {
  const allocations = batch.stockAllocations;
  const calculated = allocations.filter((allocation): allocation is Extract<StockAllocationResult, { status: "CALCULATED" }> => allocation.status === "CALCULATED");
  const shortages = calculated.flatMap(allocation => allocation.items
    .filter(item => item.shortageQuantity > 0)
    .map(item => {
      const orderDetails = batch.results[item.resultIndex]!.orderDetails;
      const amount = orderDetails.estimatedAmount;
      return {
        ...item,
        orderDetails,
        estimatedAmount: typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : null,
      };
    }));
  shortages.sort((left, right) => {
    if (left.dueDate !== right.dueDate) return left.dueDate < right.dueDate ? -1 : 1;
    if (left.estimatedAmount !== right.estimatedAmount) {
      if (left.estimatedAmount === null) return 1;
      if (right.estimatedAmount === null) return -1;
      return right.estimatedAmount - left.estimatedAmount;
    }
    return left.resultIndex - right.resultIndex;
  });
  const unableCount = allocations.filter(allocation => allocation.status === "UNABLE_TO_CALCULATE").length;
  const heading = document.createElement("h2");
  heading.textContent = "공급 위험 (누적 재고 배분)";
  const count = document.createElement("p");
  count.textContent = `공급 위험: ${shortages.length}건`;
  const distinction = document.createElement("p");
  distinction.textContent = "주문별 정상·예외 판정과 별개로, 같은 자재의 현재 재고를 납기순으로 누적 배분한 결과입니다.";
  supplyRiskDownloadButton.hidden = shortages.length === 0;
  supplyRiskSection.replaceChildren(heading, count, distinction);
  const first = shortages[0];
  if (first) {
    const onset = document.createElement("p");
    onset.textContent = `첫 공급 위험 주문: ${first.orderId} (입력 행 번호 ${first.resultIndex + 1}), 납기 ${first.dueDate}, 부족량 ${first.shortageQuantity}`;
    supplyRiskSection.append(onset);
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = "공급 위험 주문";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["주문번호", "자재", "거래처", "납기일", "주문수량", "부족수량", "예상금액"]) {
      const header = document.createElement("th");
      header.scope = "col";
      header.textContent = label;
      headerRow.append(header);
    }
    head.append(headerRow);
    const body = document.createElement("tbody");
    for (const item of shortages) {
      const row = document.createElement("tr");
      const amountCell = document.createElement("td");
      amountCell.textContent = item.estimatedAmount === null ? "" : String(item.estimatedAmount);
      row.append(cell(item.orderId), cell(item.materialId), cell(item.orderDetails.customerId), cell(item.dueDate), cell(item.orderDetails.orderQuantity), cell(item.shortageQuantity), amountCell);
      body.append(row);
    }
    table.append(caption, head, body);
    supplyRiskSection.append(table);
  }
  if (unableCount > 0) {
    const unable = document.createElement("p");
    unable.textContent = `배분 계산 불가 자재: ${unableCount}건. 공급 위험 건수는 계산 가능한 자재의 주문만 포함합니다.`;
    supplyRiskSection.append(unable);
    if (calculated.length === 0) {
      const unknown = document.createElement("p");
      unknown.textContent = "계산 가능한 자재가 없어 전체 공급 위험 여부를 판단할 수 없습니다.";
      supplyRiskSection.append(unknown);
    }
  }
  supplyRiskSection.append(supplyRiskDownloadButton);
  supplyRiskSection.hidden = false;
}
const allocationReasonLabels: Record<"INVALID_DUE_DATE" | "INVALID_QUANTITY" | "INVALID_AVAILABLE_QUANTITY" | "CONFLICTING_AVAILABLE_QUANTITY", string> = {
  INVALID_DUE_DATE: "납기일 누락 또는 유효하지 않음",
  INVALID_QUANTITY: "주문 수량이 유효하지 않음",
  INVALID_AVAILABLE_QUANTITY: "가용재고가 유효하지 않음",
  CONFLICTING_AVAILABLE_QUANTITY: "같은 자재의 가용재고 값이 서로 다름",
};
function renderAllocations(allocations: StockAllocationResult[]): void {
  allocationSection.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "자재별 현재 재고 배분";
  const explanation = document.createElement("p");
  explanation.textContent = "기존 주문별 예외 판정은 각 주문을 가용재고와 따로 비교합니다. 아래 배분은 같은 자재의 현재 가용재고를 납기순으로 누적 차감합니다. 미래 입고나 계획은 포함하지 않으며, 차단된 주문도 수요에 포함합니다.";
  allocationSection.append(heading, explanation);
  if (allocations.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "배분할 주문이 없습니다.";
    allocationSection.append(empty);
  }
  for (const allocation of allocations) {
    const materialHeading = document.createElement("h3");
    materialHeading.textContent = `자재 ${allocation.materialId}`;
    allocationSection.append(materialHeading);
    if (allocation.status === "UNABLE_TO_CALCULATE") {
      const message = document.createElement("p");
      message.textContent = `배분 계산 불가: ${allocation.reasons.map(reason => allocationReasonLabels[reason]).join(", ")}. 부족 시작 주문과 납기는 판단할 수 없습니다.`;
      allocationSection.append(message);
      continue;
    }
    const available = document.createElement("p");
    available.textContent = `현재 가용재고: ${allocation.availableQuantity}`;
    allocationSection.append(available);
    const firstShortage = allocation.items.find(item => item.shortageQuantity > 0);
    const onset = document.createElement("p");
    onset.textContent = firstShortage
      ? `첫 부족 주문: ${firstShortage.orderId} (입력 행 번호 ${firstShortage.resultIndex + 1}), 납기 ${firstShortage.dueDate}, 부족량 ${firstShortage.shortageQuantity}`
      : "현재 가용재고로 모든 주문에 배분 가능합니다.";
    allocationSection.append(onset);
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = `자재 ${allocation.materialId} 납기순 재고 배분`;
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const label of ["입력 행 번호", "주문번호", "납기일", "배분 가능 수량", "배분량", "처리 후 잔량", "부족량"]) {
      const header = document.createElement("th");
      header.scope = "col";
      header.textContent = label;
      row.append(header);
    }
    head.append(row);
    const body = document.createElement("tbody");
    for (const item of allocation.items) {
      const itemRow = document.createElement("tr");
      itemRow.append(cell(item.resultIndex + 1), cell(item.orderId), cell(item.dueDate), cell(item.allocatableQuantity), cell(item.allocatedQuantity), cell(item.remainingQuantity), cell(item.shortageQuantity));
      body.append(itemRow);
    }
    table.append(caption, head, body);
    allocationSection.append(table);
  }
  allocationSection.hidden = false;
}
function clearReference(): void {
  referenceSection.hidden = true;
  referenceSection.replaceChildren();
}
function clearError(): void {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}
function resetAnalysis(): void {
  clearReference();
  clearError();
  supplyRiskDownloadButton.hidden = true;
  supplyRiskBatch = undefined;
  supplyRiskSection.hidden = true;
  supplyRiskSection.replaceChildren();
  allocationSection.hidden = true;
  allocationSection.replaceChildren();
  missingReferenceSection.hidden = true;
  missingReferenceSection.replaceChildren();
  resultSection.hidden = true;
  downloadButton.hidden = true;
  exceptionCsv = "";
  resultExecutionId = undefined;
  resultFiles = undefined;
  tableBody.replaceChildren();
  exceptionTable.hidden = true;
  emptyMessage.hidden = true;
  for (const selector of ["#total-count", "#ready-count", "#exception-count"]) document.querySelector<HTMLElement>(selector)!.textContent = "";
  exceptionRateValue.textContent = "";
  reasonCountsValue.replaceChildren();
  topReasonValue.textContent = "";
}
for (const input of inputs) input.addEventListener("change", () => {
  executionId += 1;
  resetAnalysis();
  analyzeButton.disabled = false;
  promptForAnalysis();
});
function renderReference(upload: CsvUploadResult, uploaded: boolean): void {
  clearReference();
  const local = upload.referenceSource === "provider" && !uploaded;
  const heading = document.createElement("h2");
  heading.textContent = local ? "예제 기준 분석" : uploaded ? "업로드 기준 분석" : "주문에 직접 포함된 기준값 분석";
  const notice = document.createElement("p");
  notice.textContent = local
    ? "데이터 출처: 운영 데이터가 아닌 로컬 예제 기준입니다. 가용재고와 고객·자재 차단 여부는 예제 값이며 정상 판정도 실제 재고와 차단 상태를 확인한 결과가 아닙니다."
    : uploaded ? "데이터 출처: 사용자가 업로드한 고객 기준 CSV와 자재/재고 기준 CSV입니다."
    : "데이터 출처: 주문 CSV에 직접 포함된 availableQuantity, customerBlocked, materialBlocked 값입니다.";
  const guidance = document.createElement("p");
  guidance.textContent = "주문별 예외 판정은 주문 간 재고를 차감하지 않습니다. 자재별 현재 재고 배분은 아래에서 확인하세요. 실제 출고 전 기준값을 확인하세요.";
  if (local) guidance.textContent += " 실제 업무 기준은 두 기준 CSV 또는 직접 판정 열 3개로 제공하세요.";
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `전체 주문에 적용한 ${local ? "예제 " : ""}기준값 (입력 행 번호는 헤더를 제외한 데이터 행 순서)`;
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  const suffix = local ? " (예제)" : "";
  for (const label of ["입력 행 번호", "주문번호", "고객", "자재", `가용재고${suffix}`, `고객 차단 여부${suffix}`, `자재 차단 여부${suffix}`]) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = label;
    row.append(header);
  }
  head.append(row);
  const body = document.createElement("tbody");
  upload.orders.forEach((order, index) => {
    const entry = document.createElement("tr");
    entry.append(cell(index + 1), cell(order.orderId), cell(order.customerId), cell(order.materialId), cell(order.availableQuantity), cell(order.customerBlocked ? "차단 있음" : "차단 없음"), cell(order.materialBlocked ? "차단 있음" : "차단 없음"));
    body.append(entry);
  });
  table.append(caption, head, body);
  referenceSection.append(heading, notice, guidance, table);
  referenceSection.hidden = false;
}
function renderSummary(display: OrderSummaryDisplay): void {
  exceptionRateValue.textContent = display.exceptionRateText;
  topReasonValue.textContent = display.topReasonText;
  if (display.reasonCounts.length === 0) {
    reasonCountsValue.textContent = display.reasonCountsText;
    return;
  }
  const list = document.createElement("ul");
  for (const reason of display.reasonCounts) {
    const item = document.createElement("li");
    item.textContent = reason.text;
    list.append(item);
  }
  reasonCountsValue.replaceChildren(list);
}
function setText(selector: string, value: number): void {
  document.querySelector<HTMLElement>(selector)!.textContent = String(value);
}
function showError(message: string): void {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}
function cell(value: string | number | undefined): HTMLTableCellElement {
  const element = document.createElement("td");
  element.textContent = value === undefined || value === "" ? "—" : String(value);
  return element;
}
async function readCsv(file: File, label: string): Promise<string> {
  try { return await file.text(); }
  catch (error) {
    throw new Error(`${label} CSV 읽기 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const uploadedOrderGuidance = "세 파일 분석에는 기준 CSV 업로드용 주문 양식을 다운로드해 사용하세요. 기본 필수 열은 orderId, customerId, materialId, orderQuantity이며 선택 열은 estimatedAmount, dueDate, orderComment입니다. 기존 주문 파일을 사용한다면 직접 판정 열 availableQuantity, customerBlocked, materialBlocked는 제거하세요.";
analyzeButton.addEventListener("click", async () => {
  const currentExecutionId = ++executionId;
  resetAnalysis();
  const files = selection();
  const [file, customer, material] = files;
  const isCurrentExecution = (): boolean => currentExecutionId === executionId && matches(files);
  analyzeButton.disabled = false;
  if (!file || Boolean(customer) !== Boolean(material)) {
    promptForAnalysis();
    showError(!file ? "분석할 주문 CSV 파일을 선택하세요." : `누락된 ${customer ? "자재/재고" : "고객"} 기준 CSV를 선택하세요. 두 기준 파일이 모두 필요합니다.`);
    return;
  }
  const uploaded = Boolean(customer && material);
  analysisStatus.textContent = "선택한 CSV 파일을 분석하고 있습니다.";
  analyzeButton.disabled = true;
  try {
    const [text, customerText, materialText] = await Promise.all([
      readCsv(file, "주문"),
      customer ? readCsv(customer, "고객 기준") : Promise.resolve(""),
      material ? readCsv(material, "자재/재고 기준") : Promise.resolve(""),
    ]);
    if (!isCurrentExecution()) return;
    const provider = uploaded ? createCsvDecisionContextProvider(customerText, materialText) : localDecisionContextProvider;
    let preflight: ReturnType<typeof preflightCsvUploadReferences>;
    try { preflight = preflightCsvUploadReferences(text, provider); }
    catch (error) {
      if (!uploaded) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${uploadedOrderGuidance}`);
    }
    if (preflight.status === "missing-references") {
      renderMissingReferences(preflight.missingReferences);
      analysisStatus.textContent = "누락된 기준 데이터를 확인하세요. CSV를 보완한 뒤 다시 분석하세요.";
      return;
    }
    const upload = preflight.upload;
    if (uploaded && upload.referenceSource !== "provider") throw new Error(uploadedOrderGuidance);
    const { orders } = upload;
    validateOrders(orders);
    const batch = analyzeOrderBatch(orders);
    const csv = createExceptionCsv(orders, batch, true);
    const summary = formatOrderSummary(batch.summary);
    if (!isCurrentExecution()) return;
    setText("#total-count", batch.summary.totalCount);
    setText("#ready-count", batch.summary.shipReadyCount);
    setText("#exception-count", batch.summary.exceptionCount);
    renderSummary(summary);
    for (const item of batch.exceptionWorklist) {
      const order = orders[item.resultIndex]!;
      const shortage = item.reasonCodes.includes("INSUFFICIENT_STOCK") ? order.orderQuantity - order.availableQuantity : undefined;
      const row = document.createElement("tr");
      const reasonCell = document.createElement("td");
      reasonCell.className = "exception-guides-cell";
      const guideList = document.createElement("ul");
      guideList.className = "exception-guides";
      for (const guide of item.exceptionGuides) {
        const guideItem = document.createElement("li");
        const reasonCode = document.createElement("strong");
        reasonCode.textContent = guide.reasonCode;
        const details = document.createElement("dl");
        const checkLabel = document.createElement("dt");
        checkLabel.textContent = "확인 사항";
        const check = document.createElement("dd");
        check.textContent = guide.check;
        const actionLabel = document.createElement("dt");
        actionLabel.textContent = "조치 안내";
        const action = document.createElement("dd");
        action.textContent = guide.action;
        details.append(checkLabel, check, actionLabel, action);
        guideItem.append(reasonCode, details);
        guideList.append(guideItem);
      }
      reasonCell.append(guideList);
      row.append(cell(order.orderId), cell(order.materialId), cell(order.orderQuantity), cell(order.availableQuantity), cell(shortage), cell(order.customerId), cell(order.estimatedAmount), cell(order.dueDate), cell(order.orderComment), reasonCell);
      tableBody.append(row);
    }
    const hasExceptions = batch.exceptionWorklist.length > 0;
    exceptionTable.hidden = !hasExceptions;
    emptyMessage.hidden = hasExceptions;
    renderReference(upload, uploaded);
    renderSupplyRisk(batch);
    renderAllocations(batch.stockAllocations);
    exceptionCsv = csv;
    supplyRiskBatch = batch;
    resultExecutionId = currentExecutionId;
    resultFiles = files;
    downloadButton.hidden = !hasExceptions;
    resultSection.hidden = false;
    analysisStatus.textContent = "선택한 CSV 파일의 분석이 완료되었습니다.";
  } catch (error) {
    if (!isCurrentExecution()) return;
    resetAnalysis();
    showError(error instanceof Error ? error.message : "CSV 분석에 실패했습니다.");
    analysisStatus.textContent = "CSV 분석에 실패했습니다. 파일을 확인한 뒤 다시 분석하세요.";
  } finally {
    if (isCurrentExecution()) analyzeButton.disabled = false;
  }
});
downloadButton.addEventListener("click", () => {
  if (resultExecutionId !== executionId || !resultFiles || !matches(resultFiles)
    || resultSection.hidden || downloadButton.hidden || !exceptionCsv) return;
  const url = URL.createObjectURL(new Blob([exceptionCsv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "exception-orders.csv";
  link.click();
  URL.revokeObjectURL(url);
});
supplyRiskDownloadButton.addEventListener("click", () => {
  if (resultExecutionId !== executionId || !resultFiles || !matches(resultFiles)
    || resultSection.hidden || supplyRiskSection.hidden || supplyRiskDownloadButton.hidden || !supplyRiskBatch) return;
  const csv = createSupplyRiskCsv(supplyRiskBatch);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "supply-risk-orders.csv";
  link.click();
  URL.revokeObjectURL(url);
});
