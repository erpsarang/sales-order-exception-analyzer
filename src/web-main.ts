import "./web-styles.css";
import { analyzeOrderBatch } from "./batch-order-analysis.js";
import { createExceptionCsv, parseCsvUpload, validateOrders, type CsvUploadResult } from "./order-csv.js";
import { localDecisionContextProvider } from "./local-decision-reference.js";
import { formatOrderSummary, type OrderSummaryDisplay } from "./order-summary.js";

const fileInput = document.querySelector<HTMLInputElement>("#csv-file")!;
const analyzeButton = document.querySelector<HTMLButtonElement>("#analyze-button")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download-button")!;
const errorMessage = document.querySelector<HTMLElement>("#error-message")!;
const resultSection = document.querySelector<HTMLElement>("#result-section")!;
const exceptionTable = document.querySelector<HTMLTableElement>("#exception-table")!;
const tableBody = exceptionTable.querySelector("tbody")!;
const emptyMessage = document.querySelector<HTMLElement>("#empty-message")!;
let exceptionCsv = "";

const uploadHelp = document.createElement("section");
uploadHelp.id = "csv-upload-help";
const uploadHelpHeading = document.createElement("h2");
uploadHelpHeading.textContent = "CSV 양식과 입력 예시";
uploadHelp.append(uploadHelpHeading);
for (const text of [
  "기본 주문 필수 열 4개: orderId (예: EXAMPLE-001), customerId (예: EXAMPLE-C001), materialId (예: EXAMPLE-M001), orderQuantity (주문수량, 예: 10).",
  "업무 기준값 열 3개: availableQuantity (가용재고, 예: 20), customerBlocked (고객 차단 여부), materialBlocked (자재 차단 여부). 실제 업무 기준을 입력할 때는 이 3개 열을 모두 포함하세요. 기준값을 포함한 양식의 필수 열은 총 7개입니다.",
  "기본 주문 열만 업로드하면 로컬 예제 기준을 사용합니다. 이는 운영 데이터가 아니므로 실제 출고 판단에는 업무 기준값 3개 열을 모두 입력하세요.",
  "customerBlocked와 materialBlocked는 소문자 true가 차단, false가 미차단입니다. 주문수량과 가용재고는 숫자로 입력하세요.",
  "선택 열: estimatedAmount (예상금액, 예: 150000), dueDate (납기일, 예: 2026-10-01), orderComment (주문 코멘트, 예: 예제 주문). 선택 열은 생략하거나 셀을 비워 둘 수 있습니다.",
]) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  uploadHelp.append(paragraph);
}
const templateNotice = document.createElement("p");
templateNotice.textContent = "다운로드 파일은 정상 주문 1건과 차단·재고 부족 주문 1건을 담은 예제 데이터입니다. 실제 주문 분석 시 예제 주문 데이터와 가용재고·고객 및 자재 차단 여부를 실제 업무 기준값으로 교체하세요.";
const templateDownloadButton = document.createElement("button");
templateDownloadButton.type = "button";
templateDownloadButton.textContent = "예제 CSV 양식 다운로드";
uploadHelp.append(templateNotice, templateDownloadButton);
// 파일 입력이 label 안에 있어도 다운로드 버튼은 독립적인 요소로 배치한다.
const uploadAnchor = fileInput.closest?.("label") ?? fileInput;
uploadAnchor.insertAdjacentElement?.("afterend", uploadHelp);

templateDownloadButton.addEventListener("click", async () => {
  const { createOrderCsvTemplate } = await import("./order-csv-template.js");
  const url = URL.createObjectURL(new Blob([createOrderCsvTemplate()], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "example-order-template.csv";
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // 다운로드 시작 후 임시 URL을 해제한다.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
});

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

function clearReference(): void {
  referenceSection.hidden = true;
  referenceSection.replaceChildren();
}

function renderReference(upload: CsvUploadResult): void {
  clearReference();
  if (upload.referenceSource !== "provider" || upload.orders.length === 0) return;
  // 이 화면의 provider는 localDecisionContextProvider로 고정되어 있다.
  const heading = document.createElement("h2");
  heading.textContent = "예제 기준 분석";
  const notice = document.createElement("p");
  notice.textContent = "데이터 출처: 운영 데이터가 아닌 로컬 예제 기준입니다. 아래 가용재고와 고객·자재 차단 여부는 예제 값이며, 정상 판정도 실제 재고와 차단 상태를 확인한 결과가 아닙니다. 주문마다 같은 자재의 재고를 동일하게 적용하며 주문 간 재고를 차감하지 않습니다.";
  const guidance = document.createElement("p");
  guidance.textContent = "실제 출고 판단에는 availableQuantity, customerBlocked, materialBlocked 열에 업무 기준값을 포함한 CSV를 사용하세요.";
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = "전체 주문에 적용한 예제 기준값 (입력 행 번호는 헤더를 제외한 데이터 행 순서)";
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of ["입력 행 번호", "주문번호", "고객", "자재", "가용재고 (예제)", "고객 차단 여부 (예제)", "자재 차단 여부 (예제)"]) {
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

function clearError(): void {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

function cell(value: string | number | undefined): HTMLTableCellElement {
  const element = document.createElement("td");
  element.textContent = value === undefined || value === "" ? "—" : String(value);
  return element;
}

analyzeButton.addEventListener("click", async () => {
  clearReference();
  resultSection.hidden = true;
  downloadButton.hidden = true;
  exceptionCsv = "";
  const file = fileInput.files?.[0];
  if (!file) {
    showError("분석할 CSV 파일을 선택하세요.");
    return;
  }
  clearError();
  analyzeButton.disabled = true;
  try {
    const upload = parseCsvUpload(await file.text(), localDecisionContextProvider);
    const { orders } = upload;
    validateOrders(orders);
    const batch = analyzeOrderBatch(orders);
    setText("#total-count", batch.summary.totalCount);
    setText("#ready-count", batch.summary.shipReadyCount);
    setText("#exception-count", batch.summary.exceptionCount);
    renderSummary(formatOrderSummary(batch.summary));
    tableBody.replaceChildren();
    for (const item of batch.exceptionWorklist) {
      const order = orders[item.resultIndex]!;
      const shortage = item.reasonCodes.includes("INSUFFICIENT_STOCK")
        ? order.orderQuantity - order.availableQuantity
        : undefined;
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
    downloadButton.hidden = !hasExceptions;
    exceptionCsv = createExceptionCsv(orders, batch, true);
    renderReference(upload);
    resultSection.hidden = false;
  } catch (error) {
    clearReference();
    exceptionCsv = "";
    downloadButton.hidden = true;
    resultSection.hidden = true;
    showError(error instanceof Error ? error.message : "CSV 분석에 실패했습니다.");
  } finally {
    analyzeButton.disabled = false;
  }
});

downloadButton.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([exceptionCsv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "exception-orders.csv";
  link.click();
  URL.revokeObjectURL(url);
});
