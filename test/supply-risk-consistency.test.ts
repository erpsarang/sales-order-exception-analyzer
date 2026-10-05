import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { runOrderAnalysisCli } from "../src/order-analysis-cli.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { createExceptionCsv, createSupplyRiskCsv, preflightCsvUploadReferences, validateOrders } from "../src/order-csv.js";
import { formatOrderSummary } from "../src/order-summary.js";
import { allocationReasonLabels, createSupplyRiskOrders, supplyRiskExplanation } from "../src/supply-risk-view.js";

type Listener = () => unknown;
class Element {
  id = "";
  hidden = false;
  disabled = false;
  files: { text(): Promise<string> }[] = [];
  children: Element[] = [];
  parent: Element | undefined;
  listeners = new Map<string, Listener[]>();
  private ownText = "";
  constructor(readonly tag: string) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  append(...elements: Element[]): void {
    for (const element of elements) { element.parent = this; this.children.push(element); }
  }
  prepend(...elements: Element[]): void {
    for (const element of elements) element.parent = this;
    this.children.unshift(...elements);
  }
  replaceChildren(...elements: Element[]): void { this.ownText = ""; this.children = []; this.append(...elements); }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (selector === `#${child.id}` || selector === child.tag) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(): null { return null; }
  insertAdjacentElement(position: string, element: Element): void {
    assert.ok(this.parent);
    const index = this.parent.children.indexOf(this);
    element.parent = this.parent;
    this.parent.children.splice(index + (position === "afterend" ? 1 : 0), 0, element);
  }
  setAttribute(): void {}
  addEventListener(name: string, listener: Listener): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  async emit(name: string): Promise<void> { await Promise.all((this.listeners.get(name) ?? []).map(listener => listener())); }
  click(): void {}
}

const webSource = readFileSync(new URL("../src/web-main.ts", import.meta.url), "utf8");
const executable = ts.transpileModule(webSource.replace(/^import .*;\r?\n/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// 직접 판정 열 7개를 포함한 주문 CSV. 화면과 CLI가 같은 문자열을 읽는다.
const ordersCsv = [
  "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate",
  "SO-A,C-1,M-1,5,0,false,false,100,2026-10-02",
  "SO-B,C-1,M-1,5,0,false,false,500,2026-10-02",
  "SO-C,C-1,M-1,5,0,false,false,,2026-10-02",
  "SO-D,C-1,M-1,1,0,false,false,999,2026-10-01",
  "SO-N,C-2,M-2,1,10,false,false,50,2026-10-05",
  "SO-X,C-3,M-3,1,5,false,false,10,2026-10-01",
  "SO-Y,C-3,M-3,1,6,false,false,20,2026-10-01",
].join("\n") + "\n";

const expectedOrderIds = ["SO-D", "SO-B", "SO-A", "SO-C"];
const expectedReasons = [`M-3: ${allocationReasonLabels.CONFLICTING_AVAILABLE_QUANTITY}`];

async function readScreenAndCsv(): Promise<{ screenIds: string[]; screenReasons: string[]; csvIds: string[] }> {
  const body = new Element("body");
  for (const id of ["csv-file", "customer-file", "material-file", "analyze-button", "download-button", "error-message", "result-section", "exception-table", "empty-message", "total-count", "ready-count", "exception-count"]) {
    const element = new Element(id === "exception-table" ? "table" : "div");
    element.id = id;
    body.append(element);
  }
  const node = (id: string): Element => { const element = body.querySelector(`#${id}`); assert.ok(element, id); return element; };
  node("exception-table").append(new Element("thead"), new Element("tbody"));
  for (const id of ["download-button", "error-message", "result-section", "empty-message"]) node(id).hidden = true;
  const downloads: Blob[] = [];
  runInNewContext(executable, {
    exports: {}, Error, Blob,
    document: { body, querySelector: (selector: string) => body.querySelector(selector), createElement: (tag: string) => new Element(tag) },
    URL: { createObjectURL: (blob: Blob) => { downloads.push(blob); return "blob:test"; }, revokeObjectURL: () => {} },
    localDecisionContextProvider: {},
    createCsvDecisionContextProvider: () => ({}),
    allocationReasonLabels, createSupplyRiskOrders, supplyRiskExplanation,
    createExceptionCsv, createSupplyRiskCsv, preflightCsvUploadReferences, validateOrders,
    analyzeOrderBatch, formatOrderSummary,
  });
  node("csv-file").files = [{ text: async () => ordersCsv }];
  await node("csv-file").emit("change");
  await node("analyze-button").emit("click");
  assert.equal(node("error-message").hidden, true, node("error-message").textContent);
  const risk = node("supply-risk-summary");
  assert.equal(risk.hidden, false);
  const rows = risk.querySelector("tbody")!.children;
  const screenIds = rows.map(row => row.children[0]!.textContent);
  const screenReasons = risk.querySelector("ul")!.children.map(item => item.textContent);
  await node("supply-risk-download-button").emit("click");
  assert.equal(downloads.length, 1);
  const csvText = (await downloads[0]!.text()).replace(/^﻿/, "");
  const csvIds = csvText.split("\n").slice(1).filter(line => line !== "").map(line => line.split(",")[0]!);
  return { screenIds, screenReasons, csvIds };
}

async function readCli(): Promise<{ cliIds: string[]; cliReasons: string[] }> {
  const directory = mkdtempSync(join(tmpdir(), "supply-risk-consistency-"));
  try {
    const path = join(directory, "orders.csv");
    writeFileSync(path, ordersCsv);
    const lines = (await runOrderAnalysisCli([path])).split("\n");
    const section = lines.slice(lines.indexOf("공급 위험 (누적 재고 배분):"));
    assert.ok(section.length > 1);
    const cliIds = section.filter(line => /^입력 \d+ \/ 주문 /.test(line)).map(line => /주문 "([^"]+)"/.exec(line)![1]!);
    const cliReasons = section.filter(line => line.startsWith("  ")).map(line => line.trim());
    return { cliIds, cliReasons };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("같은 입력의 공급 위험 주문 순서와 배분 불가 사유가 화면, 공급 위험 CSV, CLI에서 같다", async () => {
  const { screenIds, screenReasons, csvIds } = await readScreenAndCsv();
  const { cliIds, cliReasons } = await readCli();
  assert.ok(screenIds.length > 0 && csvIds.length > 0 && cliIds.length > 0);
  assert.ok(screenReasons.length > 0 && cliReasons.length > 0);
  assert.deepEqual(screenIds, expectedOrderIds);
  assert.deepEqual(csvIds, expectedOrderIds);
  assert.deepEqual(cliIds, expectedOrderIds);
  assert.deepEqual(screenIds, csvIds);
  assert.deepEqual(screenIds, cliIds);
  assert.deepEqual(screenReasons, expectedReasons);
  assert.deepEqual(cliReasons, expectedReasons);
  assert.deepEqual(screenReasons, cliReasons);
});
