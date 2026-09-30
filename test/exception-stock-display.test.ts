import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import type { OrderInput } from "../src/order-analysis.js";
import * as orderCsv from "../src/order-csv.js";
import { createCsvDecisionContextProvider } from "../src/csv-decision-reference.js";
import { localDecisionContextProvider } from "../src/local-decision-reference.js";
import * as orderCsvTemplate from "../src/order-csv-template.js";
import { formatOrderSummary } from "../src/order-summary.js";

const labels = ["주문번호", "자재", "수량", "가용재고", "부족 수량", "거래처", "예상금액", "납기일", "주문 코멘트", "예외 사유"];
const header = `\uFEFF${labels.join(",")}\n`;
const input = [
  "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,dueDate",
  "ready,C,M,2,3,false,false,2026-01-01",
  "duplicate,C,M,10,3,false,false,2026-01-04",
  "duplicate,C,M,8,2,true,false,2026-01-02",
  "blocked,C,M,2,3,false,true,2026-01-03",
  "independent,C,M,10,3,false,false,2026-01-05",
  "zero,C,M,0,0,false,false,2026-01-06",
  "negative,C,M,-1,-4,false,false,2026-01-07",
  "fraction,C,M,2.5,1.25,false,false,2026-01-08",
].join("\n");
const expectedRows = [
  ["duplicate", "M", "8", "2", "6", "C", "", "2026-01-02", ""],
  ["blocked", "M", "2", "3", "", "C", "", "2026-01-03", ""],
  ["duplicate", "M", "10", "3", "7", "C", "", "2026-01-04", ""],
  ["independent", "M", "10", "3", "7", "C", "", "2026-01-05", ""],
  ["zero", "M", "0", "0", "", "C", "", "2026-01-06", ""],
  ["negative", "M", "-1", "-4", "3", "C", "", "2026-01-07", ""],
  ["fraction", "M", "2.5", "1.25", "1.25", "C", "", "2026-01-08", ""],
];
const expectedReasons = ['"CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"', "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK", "INSUFFICIENT_STOCK", "INVALID_QUANTITY", '"INVALID_QUANTITY, INSUFFICIENT_STOCK"', "INSUFFICIENT_STOCK"];
test("CSV preserves original row links after sorting, duplicate IDs and independent stock calculations", () => {
  const orders = orderCsv.parseCsvOrders(input);
  const before = structuredClone(orders);
  const batch = analyzeOrderBatch(orders);
  const batchBefore = structuredClone(batch);
  assert.deepEqual(batch.exceptionWorklist.map(item => item.resultIndex), [2, 3, 1, 4, 5, 6, 7]);
  assert.equal(orderCsv.createExceptionCsv(orders, batch, true), header + expectedRows.map((row, index) => `${row.join(",")},${expectedReasons[index]}\n`).join(""));
  assert.deepEqual(orders, before);
  assert.deepEqual(batch, batchBefore);
});
test("CSV preserves BOM, escaping, optional empty cells and trailing newline", () => {
  const orders: OrderInput[] = [{ orderId: '주문,"A"', customerId: "C", materialId: "M", orderQuantity: 10, availableQuantity: 3, customerBlocked: false, materialBlocked: false, orderComment: '첫 줄\r\n"확인", 필요' }];
  assert.equal(orderCsv.createExceptionCsv(orders, analyzeOrderBatch(orders), true), header + '"주문,""A""",M,10,3,7,C,,,"첫 줄\r\n""확인"", 필요",INSUFFICIENT_STOCK\n');
  assert.equal(orderCsv.createExceptionCsv([], analyzeOrderBatch([]), true), header);
});
test("default CSV retains the existing CLI format for exceptions and empty results", () => {
  const legacyHeader = "\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\n";
  const orders: OrderInput[] = [{ orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 0, availableQuantity: -1, customerBlocked: true, materialBlocked: false }];
  assert.equal(orderCsv.createExceptionCsv(orders, analyzeOrderBatch(orders)), legacyHeader + 'SO-1,M-1,0,C-1,,,,"INVALID_QUANTITY, CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"\n');
  assert.equal(orderCsv.createExceptionCsv([], analyzeOrderBatch([])), legacyHeader);
  const ready = orderCsv.parseCsvOrders(input.split("\n").slice(0, 2).join("\n"));
  assert.equal(orderCsv.createExceptionCsv(ready, analyzeOrderBatch(ready)), legacyHeader);
});

class ElementDouble {
  id = "";
  children: ElementDouble[] = [];
  private ownText = "";
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  className = "";
  scope = "";
  hidden = false;
  disabled = false;
  download = "";
  parent: ElementDouble | undefined;
  files: { text(): Promise<string> }[] = [];
  listeners = new Map<string, () => void | Promise<void>>();
  constructor(readonly tagName: string) {}
  append(...nodes: ElementDouble[]): void { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  prepend(...nodes: ElementDouble[]): void { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  replaceChildren(...nodes: ElementDouble[]): void { this.ownText = ""; this.children = []; this.append(...nodes); }
  insertAdjacentElement(position: string, element: ElementDouble): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    element.parent = this.parent;
    this.parent.children.splice(index + (position === "afterend" ? 1 : 0), 0, element);
  }
  querySelector(selector: string): ElementDouble | null {
    for (const child of this.children) {
      if (child.tagName === selector || `#${child.id}` === selector) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  addEventListener(event: string, listener: () => void | Promise<void>): void { this.listeners.set(event, listener); }
  click(): void { void this.listeners.get("click")?.(); }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}
const source = readFileSync(new URL("../src/web-main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
// Blob.text()는 BOM을 제거하므로 다운로드 바이트의 BOM을 보존해 검증한다.
async function readDownload(blob: Blob): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer());
}
function setup() {
  const root = new ElementDouble("body");
  for (const id of ["csv-file", "customer-file", "material-file", "analyze-button", "download-button", "error-message", "result-section", "exception-table", "empty-message", "total-count", "ready-count", "exception-count"]) {
    const element = new ElementDouble(id === "exception-table" ? "table" : "div");
    element.id = id;
    root.append(element);
  }
  const get = (id: string): ElementDouble => { const node = root.querySelector(`#${id}`); assert.ok(node, id); return node; };
  const head = new ElementDouble("thead");
  const body = new ElementDouble("tbody");
  get("exception-table").append(head, body);
  const downloads: Blob[] = [];
  const filenames: string[] = [];
  const modules: Record<string, unknown> = {
    "./web-styles.css": {},
    "./batch-order-analysis.js": { analyzeOrderBatch },
    "./order-csv.js": orderCsv,
    "./csv-decision-reference.js": { createCsvDecisionContextProvider },
    "./local-decision-reference.js": { localDecisionContextProvider },
    "./order-csv-template.js": orderCsvTemplate,
    "./order-summary.js": { formatOrderSummary },
  };
  runInNewContext(compiled, {
    exports: {}, Error, Blob,
    require: (name: string) => { assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`); return modules[name]; },
    document: { body: root, querySelector: (selector: string) => root.querySelector(selector), createElement: (tag: string) => {
      const element = new ElementDouble(tag);
      if (tag === "a") element.addEventListener("click", () => { filenames.push(element.download); });
      return element;
    } },
    URL: { createObjectURL: (blob: Blob) => { downloads.push(blob); return "blob:test"; }, revokeObjectURL: () => {} },
    window: { setTimeout: (callback: () => void) => callback() },
  });
  return {
    get, head, body, downloads, filenames,
    select: async (id: string, text?: string) => { get(id).files = text === undefined ? [] : [{ text: async () => text }]; await get(id).listeners.get("change")!(); },
    analyze: async () => { await get("analyze-button").listeners.get("click")!(); },
    download: async () => { await get("download-button").listeners.get("click")!(); },
  };
}
test("화면에서 내려받은 주문·고객·자재 예제 CSV 세 파일을 업로드해 분석한다", async () => {
  const ui = setup();
  const help = ui.get("csv-upload-help");
  assert.match(help.textContent, /서로 맞는 예제 데이터/);
  const labels = [
    "기준 CSV 업로드용 주문 양식 다운로드",
    "고객 기준 예제 CSV 다운로드",
    "자재·재고 기준 예제 CSV 다운로드",
  ];
  for (const label of labels) {
    const button = help.children.find(node => node.tagName === "button" && node.textContent === label);
    assert.ok(button, label);
    await button.listeners.get("click")!();
  }
  assert.deepEqual(ui.filenames, [
    "example-order-upload-template.csv",
    "example-customer-reference.csv",
    "example-material-reference.csv",
  ]);
  const [orders, customers, materials] = await Promise.all(ui.downloads.map(readDownload));
  assert.equal(orders, orderCsvTemplate.createUploadedReferenceOrderCsvTemplate());
  assert.equal(customers, orderCsvTemplate.createCustomerCsvTemplate());
  assert.equal(materials, orderCsvTemplate.createMaterialCsvTemplate());
  await ui.select("csv-file", orders);
  await ui.select("customer-file", customers);
  await ui.select("material-file", materials);
  await ui.analyze();
  assert.equal(ui.get("error-message").hidden, true);
  assert.equal(ui.get("result-section").hidden, false);
  assert.equal(ui.get("total-count").textContent, "2");
  assert.equal(ui.get("ready-count").textContent, "1");
  assert.equal(ui.get("exception-count").textContent, "1");
  assert.match(ui.get("reference-provenance").textContent, /업로드 기준 분석/);
  assert.deepEqual(ui.body.children.map(row => row.children[0]!.textContent), ["EXAMPLE-002"]);
});

test("web renders accessible headers and row-specific stock values in CSV column order", async () => {
  const ui = setup();
  const headers = ui.head.children[0]!.children;
  assert.deepEqual(headers.map(node => node.textContent), labels);
  assert.ok(headers.every(node => node.tagName === "th" && node.scope === "col"));
  await ui.select("csv-file", input);
  await ui.analyze();
  assert.equal(ui.get("error-message").hidden, true);
  assert.equal(ui.get("result-section").hidden, false);
  assert.equal(ui.get("total-count").textContent, "8");
  assert.equal(ui.get("ready-count").textContent, "1");
  assert.equal(ui.get("exception-count").textContent, "7");
  await ui.download();
  assert.equal(await readDownload(ui.downloads[0]!), header + expectedRows.map((row, index) => `${row.join(",")},${expectedReasons[index]}\n`).join(""));
  assert.deepEqual(ui.body.children.map(row => row.children.slice(0, 9).map(node => node.textContent)), expectedRows.map(row => row.map(value => value === "" ? "—" : value)));
  assert.ok(ui.body.children.every(row => row.children.length === labels.length));
  const firstGuides = ui.body.children[0]!.children[9]!.children[0]!.children;
  assert.deepEqual(firstGuides.map(guide => guide.children[0]!.textContent), ["CUSTOMER_BLOCKED", "INSUFFICIENT_STOCK"]);
  await ui.analyze();
  assert.equal(ui.body.children.length, expectedRows.length);
  await ui.select("csv-file", input.split("\n").slice(0, 2).join("\n"));
  await ui.analyze();
  assert.equal(ui.body.children.length, 0);
  assert.equal(ui.get("exception-table").hidden, true);
  assert.equal(ui.get("download-button").hidden, true);
  assert.equal(ui.get("empty-message").hidden, false);
  await ui.download();
  assert.equal(ui.downloads.length, 1);
});
const supplyRiskInput = [
  "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,dueDate",
  "SO-1,C-1,M-1,6,10,false,false,2026-10-01",
  "SO-2,C-1,M-1,6,10,false,false,2026-10-02",
].join("\n");
test("주문별 예외가 없어도 누적 부족 주문을 공급 위험 CSV로 내려받는다", async () => {
  const ui = setup();
  await ui.select("csv-file", supplyRiskInput);
  await ui.analyze();
  const riskButton = ui.get("supply-risk-download-button");
  assert.equal(ui.get("exception-count").textContent, "0");
  assert.equal(ui.get("download-button").hidden, true);
  assert.equal(riskButton.hidden, false);
  assert.equal(riskButton.textContent, "공급 위험 CSV 다운로드");
  assert.match(ui.get("supply-risk-summary").textContent, /공급 위험: 1건/);
  riskButton.click();
  assert.deepEqual(ui.filenames, ["supply-risk-orders.csv"]);
  assert.equal(await readDownload(ui.downloads[0]!), "\uFEFF주문번호,자재,부족 수량\nSO-2,M-1,2\n");
  await ui.download();
  assert.equal(ui.downloads.length, 1);
});
test("공급 위험이 0건이면 버튼을 숨기고 기존 예외 CSV는 그대로 내려받는다", async () => {
  const ui = setup();
  await ui.select("csv-file", supplyRiskInput.replace("SO-2,C-1,M-1,6", "SO-2,C-1,M-1,4"));
  await ui.analyze();
  const riskButton = ui.get("supply-risk-download-button");
  assert.equal(riskButton.hidden, true);
  riskButton.click();
  assert.equal(ui.downloads.length, 0);
  await ui.select("csv-file", input);
  await ui.analyze();
  assert.equal(ui.get("download-button").hidden, false);
  await ui.download();
  const orders = orderCsv.parseCsvOrders(input);
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(ui.filenames, ["exception-orders.csv"]);
  assert.equal(await readDownload(ui.downloads[0]!), orderCsv.createExceptionCsv(orders, batch, true));
});
test("선택 파일 변경과 분석 실패 후에는 이전 공급 위험 CSV를 내려받을 수 없다", async () => {
  const ui = setup();
  await ui.select("csv-file", supplyRiskInput);
  await ui.analyze();
  const riskButton = ui.get("supply-risk-download-button");
  ui.get("csv-file").files = [{ text: async () => supplyRiskInput }];
  riskButton.click();
  assert.equal(ui.downloads.length, 0);
  await ui.select("csv-file", "invalid");
  assert.equal(riskButton.hidden, true);
  riskButton.click();
  assert.equal(ui.downloads.length, 0);
  await ui.analyze();
  assert.equal(ui.get("result-section").hidden, true);
  riskButton.click();
  assert.equal(ui.downloads.length, 0);
});
const businessHeader = "orderId,customerId,materialId,orderQuantity";
const customers = "customerId,customerBlocked\nC-1,false\nC-2,true";
const materials = "materialId,materialBlocked,availableQuantity\nM-1,false,3\nM-2,true,0";
const business = `${businessHeader},estimatedAmount,dueDate,orderComment\nready,C-1,M-1,2,,,\nduplicate,C-1,M-1,10,100,2026-10-02,\nduplicate,C-2,M-2,2,200,2026-10-01,"확인, 요청"\nindependent,C-1,M-1,10,,,`;
async function selectThree(ui: ReturnType<typeof setup>, orders = business, customer = customers, material = materials) {
  await ui.select("csv-file", orders);
  await ui.select("customer-file", customer);
  await ui.select("material-file", material);
}
test("실제 기준 CSV부터 화면, 요약, 재고 및 다운로드까지 연결한다", async () => {
  const ui = setup();
  await selectThree(ui);
  await ui.analyze();
  assert.equal(ui.get("error-message").hidden, true);
  assert.equal(ui.get("total-count").textContent, "4");
  assert.equal(ui.get("ready-count").textContent, "1");
  assert.equal(ui.get("exception-count").textContent, "3");
  const provenance = ui.get("reference-provenance");
  assert.match(provenance.textContent, /업로드/);
  assert.doesNotMatch(provenance.textContent, /예제/);
  const orders = orderCsv.parseCsvUpload(business, createCsvDecisionContextProvider(customers, materials)).orders;
  const batch = analyzeOrderBatch(orders);
  const summary = formatOrderSummary(batch.summary);
  const statistics = ui.get("result-section").children.find(node => node.className === "exception-statistics")!;
  assert.equal(statistics.children[0]!.children[1]!.textContent, summary.exceptionRateText);
  assert.equal(statistics.children[2]!.children[1]!.textContent, summary.topReasonText);
  for (const reason of summary.reasonCounts) assert.ok(statistics.textContent.includes(reason.text));
  assert.deepEqual(ui.body.children.map(row => row.children.slice(0, 5).map(node => node.textContent)), batch.exceptionWorklist.map(item => {
    const order = orders[item.resultIndex]!;
    return [order.orderId, order.materialId, String(order.orderQuantity), String(order.availableQuantity), String(order.orderQuantity - order.availableQuantity)];
  }));
  assert.equal(ui.body.children.filter(row => row.children[4]!.textContent === "7").length, 2);
  await ui.download();
  const downloaded = await readDownload(ui.downloads[0]!);
  assert.equal(downloaded, orderCsv.createExceptionCsv(orders, batch, true));
  assert.ok(downloaded.startsWith("\uFEFF"));
  assert.match(downloaded, /"확인, 요청"/);
  await ui.analyze();
  await ui.download();
  assert.equal(await readDownload(ui.downloads[1]!), downloaded);
});
test("로컬 예제, 직접 입력, 빈 업로드 기준 및 정상 결과의 출처를 구분한다", async () => {
  const ui = setup();
  await ui.select("csv-file", `${businessHeader}\nSO-1,C-1,M-1,1`);
  await ui.analyze();
  assert.match(ui.get("reference-provenance").textContent, /로컬 예제/);
  await ui.select("csv-file", input);
  await ui.analyze();
  assert.match(ui.get("reference-provenance").textContent, /직접 포함/);
  assert.doesNotMatch(ui.get("reference-provenance").textContent, /예제/);
  for (const orders of [businessHeader, `${businessHeader}\nready,C-1,M-1,1`]) {
    await selectThree(ui, orders);
    await ui.analyze();
    assert.equal(ui.get("result-section").hidden, false);
    assert.equal(ui.get("exception-count").textContent, "0");
    assert.equal(ui.get("empty-message").hidden, false);
    assert.equal(ui.get("download-button").hidden, true);
    assert.match(ui.get("reference-provenance").textContent, /업로드/);
    assert.doesNotMatch(ui.get("reference-provenance").textContent, /예제/);
  }
});
const failures: [string, string, string, RegExp][] = [
  [business, "customerId,customerBlocked\nC-1,TRUE", materials, /고객.*customerBlocked/],
  [business, customers, "materialId,materialBlocked,availableQuantity\nM-1,false,NaN", /자재\/재고.*availableQuantity/],
  [business, "customerId,customerBlocked\nC-1,false\nC-1,true", materials, /고객.*중복/],
  [business, customers, 'materialId,materialBlocked,availableQuantity\n"broken', /자재\/재고.*큰따옴표/],
  [`${businessHeader}\nvalid,C-1,M-1,1\nmissing,C-missing,M-1,1`, customers, materials, /missing.*고객.*C-missing/],
  [`${businessHeader}\nvalid,C-1,M-1,1\nmissing,C-1,M-missing,1`, customers, materials, /missing.*자재.*M-missing/],
  [input, customers, materials, /직접 판정 열.*제거/],
];
for (let mask = 1; mask < 7; mask += 1) {
  const fields = ["availableQuantity", "customerBlocked", "materialBlocked"].filter((_, index) => mask & (1 << index));
  failures.push([`${businessHeader},${fields.join(",")}`, customers, materials, /직접 판정 열.*제거/]);
}
for (const [index, [orders, customer, material, error]] of failures.entries()) {
  test(`기준/조회/주문 형식 오류 ${index + 1}: 이전 결과와 부분 결과 및 다운로드 전체 차단`, async () => {
    const ui = setup();
    await selectThree(ui);
    await ui.analyze();
    assert.equal(ui.get("download-button").hidden, false);
    await selectThree(ui, orders, customer, material);
    await ui.analyze();
    assert.equal(ui.get("error-message").hidden, false);
    assert.match(ui.get("error-message").textContent, error);
    for (const id of ["result-section", "download-button", "reference-provenance", "exception-table"]) assert.equal(ui.get(id).hidden, true, id);
    for (const id of ["total-count", "ready-count", "exception-count", "reference-provenance"]) assert.equal(ui.get(id).textContent, "", id);
    assert.equal(ui.body.children.length, 0);
    const statistics = ui.get("result-section").children.find(node => node.className === "exception-statistics")!;
    assert.ok(statistics.children.every(group => group.children[1]!.textContent === ""));
    await ui.download();
    assert.equal(ui.downloads.length, 0);
    await selectThree(ui);
    await ui.analyze();
    assert.equal(ui.get("error-message").hidden, true);
    assert.equal(ui.get("result-section").hidden, false);
  });
}
