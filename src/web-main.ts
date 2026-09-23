import "./web-styles.css";
import { analyzeOrderBatch } from "./batch-order-analysis.js";
import { createExceptionCsv, parseCsvOrders, validateOrders } from "./order-csv.js";
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
  const file = fileInput.files?.[0];
  if (!file) {
    showError("분석할 CSV 파일을 선택하세요.");
    return;
  }
  clearError();
  analyzeButton.disabled = true;
  try {
    const orders = parseCsvOrders(await file.text());
    validateOrders(orders);
    const batch = analyzeOrderBatch(orders);
    setText("#total-count", batch.summary.totalCount);
    setText("#ready-count", batch.summary.shipReadyCount);
    setText("#exception-count", batch.summary.exceptionCount);
    renderSummary(formatOrderSummary(batch.summary));
    tableBody.replaceChildren();
    for (const item of batch.exceptionWorklist) {
      const order = orders[item.resultIndex]!;
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
      row.append(cell(order.orderId), cell(order.materialId), cell(order.orderQuantity), cell(order.customerId), cell(order.estimatedAmount), cell(order.dueDate), cell(order.orderComment), reasonCell);
      tableBody.append(row);
    }
    const hasExceptions = batch.exceptionWorklist.length > 0;
    exceptionTable.hidden = !hasExceptions;
    emptyMessage.hidden = hasExceptions;
    downloadButton.hidden = !hasExceptions;
    exceptionCsv = createExceptionCsv(orders, batch);
    resultSection.hidden = false;
  } catch (error) {
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
