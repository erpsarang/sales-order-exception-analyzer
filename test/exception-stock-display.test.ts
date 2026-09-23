import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import type { OrderInput } from "../src/order-analysis.js";
import * as orderCsv from "../src/order-csv.js";

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
const expectedReasons = [
  '"CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"',
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
  "INSUFFICIENT_STOCK",
  "INVALID_QUANTITY",
  '"INVALID_QUANTITY, INSUFFICIENT_STOCK"',
  "INSUFFICIENT_STOCK",
];

test("CSV preserves original row links after sorting, duplicate IDs and independent stock calculations", () => {
  const orders = orderCsv.parseCsvOrders(input);
  const before = structuredClone(orders);
  const batch = analyzeOrderBatch(orders);
  const batchBefore = structuredClone(batch);
  assert.deepEqual(batch.exceptionWorklist.map((item) => item.resultIndex), [2, 3, 1, 4, 5, 6, 7]);
  const expected = header + expectedRows.map((row, index) => `${row.join(",")},${expectedReasons[index]}\n`).join("");
  assert.equal(orderCsv.createExceptionCsv(orders, batch, true), expected);
  assert.deepEqual(orders, before);
  assert.deepEqual(batch, batchBefore);
});

test("CSV preserves BOM, escaping, optional empty cells and trailing newline", () => {
  const orders: OrderInput[] = [{
    orderId: '주문,"A"', customerId: "C", materialId: "M",
    orderQuantity: 10, availableQuantity: 3,
    customerBlocked: false, materialBlocked: false,
    orderComment: '첫 줄\r\n"확인", 필요',
  }];
  assert.equal(orderCsv.createExceptionCsv(orders, analyzeOrderBatch(orders), true),
    header + '"주문,""A""",M,10,3,7,C,,,"첫 줄\r\n""확인"", 필요",INSUFFICIENT_STOCK\n');
  assert.equal(orderCsv.createExceptionCsv([], analyzeOrderBatch([]), true), header);
});

test("default CSV retains the existing CLI format for exceptions and empty results", () => {
  const legacyHeader = "\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\n";
  const orders: OrderInput[] = [{
    orderId: "SO-1", customerId: "C-1", materialId: "M-1",
    orderQuantity: 0, availableQuantity: -1,
    customerBlocked: true, materialBlocked: false,
  }];
  assert.equal(orderCsv.createExceptionCsv(orders, analyzeOrderBatch(orders)),
    legacyHeader + 'SO-1,M-1,0,C-1,,,,"INVALID_QUANTITY, CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"\n');
  assert.equal(orderCsv.createExceptionCsv([], analyzeOrderBatch([])), legacyHeader);
  const ready = orderCsv.parseCsvOrders(input.split("\n").slice(0, 2).join("\n"));
  assert.equal(orderCsv.createExceptionCsv(ready, analyzeOrderBatch(ready)), legacyHeader);
});

// Execute the web entry with a minimal DOM double; no browser dependency is needed.
class ElementDouble {
  children: ElementDouble[] = [];
  textContent = "";
  className = "";
  scope = "";
  hidden = false;
  disabled = false;
  files: { text(): Promise<string> }[] = [];
  listeners = new Map<string, () => void | Promise<void>>();
  constructor(readonly tagName: string) {}
  append(...nodes: ElementDouble[]): void { this.children.push(...nodes); }
  prepend(...nodes: ElementDouble[]): void { this.children.unshift(...nodes); }
  replaceChildren(...nodes: ElementDouble[]): void { this.children = [...nodes]; }
  querySelector(selector: string): ElementDouble | null {
    for (const child of this.children) {
      if (child.tagName === selector) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  addEventListener(event: string, listener: () => void | Promise<void>): void {
    this.listeners.set(event, listener);
  }
}

test("web renders accessible headers and row-specific stock values in CSV column order", async () => {
  const elements = new Map<string, ElementDouble>();
  for (const id of ["csv-file", "analyze-button", "download-button", "error-message", "result-section", "exception-table", "empty-message", "total-count", "ready-count", "exception-count"]) {
    elements.set(`#${id}`, new ElementDouble(id === "exception-table" ? "table" : "div"));
  }
  const get = (id: string): ElementDouble => elements.get(`#${id}`)!;
  const head = new ElementDouble("thead");
  const body = new ElementDouble("tbody");
  const oldRow = new ElementDouble("tr");
  oldRow.append(new ElementDouble("th"));
  head.append(oldRow);
  get("exception-table").append(head, body);
  get("csv-file").files = [{ text: async () => input }];
  const source = readFileSync(new URL("../src/web-main.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let generatedCsv = "";
  const modules: Record<string, unknown> = {
    "./web-styles.css": {},
    "./batch-order-analysis.js": { analyzeOrderBatch },
    "./order-csv.js": {
      ...orderCsv,
      createExceptionCsv: (...args: Parameters<typeof orderCsv.createExceptionCsv>) => {
        generatedCsv = orderCsv.createExceptionCsv(...args);
        return generatedCsv;
      },
    },
    // Complete CSV inputs do not use the reference provider.
    "./local-decision-reference.js": { localDecisionContextProvider: {} },
    "./order-summary.js": {
      formatOrderSummary: () => ({ exceptionRateText: "", topReasonText: "", reasonCounts: [], reasonCountsText: "" }),
    },
  };
  runInNewContext(compiled, {
    exports: {},
    require: (name: string) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
    document: {
      querySelector: (selector: string) => elements.get(selector) ?? null,
      createElement: (tag: string) => new ElementDouble(tag),
    },
  });
  assert.equal(head.children.length, 1);
  const headers = head.children[0]!.children;
  assert.deepEqual(headers.map((node) => node.textContent), labels);
  assert.ok(headers.every((node) => node.tagName === "th" && node.scope === "col"));
  const analyze = get("analyze-button").listeners.get("click");
  assert.ok(analyze);
  await analyze();
  assert.equal(get("error-message").hidden, true);
  assert.equal(get("result-section").hidden, false);
  assert.equal(get("exception-table").hidden, false);
  assert.equal(get("download-button").hidden, false);
  assert.equal(get("total-count").textContent, "8");
  assert.equal(get("ready-count").textContent, "1");
  assert.equal(get("exception-count").textContent, "7");
  assert.equal(generatedCsv, header + expectedRows.map((row, index) => `${row.join(",")},${expectedReasons[index]}\n`).join(""));
  assert.deepEqual(body.children.map((row) => row.children.slice(0, 9).map((node) => node.textContent)),
    expectedRows.map((row) => row.map((value) => value === "" ? "—" : value)));
  assert.ok(body.children.every((row) => row.children.length === labels.length));
  const firstGuides = body.children[0]!.children[9]!.children[0]!.children;
  assert.deepEqual(firstGuides.map((guide) => guide.children[0]!.textContent), ["CUSTOMER_BLOCKED", "INSUFFICIENT_STOCK"]);
  await analyze();
  assert.equal(body.children.length, expectedRows.length);
  get("csv-file").files = [{ text: async () => input.split("\n").slice(0, 2).join("\n") }];
  await analyze();
  assert.equal(body.children.length, 0);
  assert.equal(get("exception-table").hidden, true);
  assert.equal(get("download-button").hidden, true);
  assert.equal(get("empty-message").hidden, false);
  assert.equal(generatedCsv, header);
});
