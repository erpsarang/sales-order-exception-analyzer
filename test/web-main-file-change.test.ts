import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type UploadFile = { text(): Promise<string> };
type Listener = () => unknown;
class Element {
  id = "";
  hidden = false;
  disabled = false;
  files: UploadFile[] = [];
  children: Element[] = [];
  parent: Element | undefined;
  attributes = new Map<string, string>();
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
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: Listener): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  async emit(name: string): Promise<void> { await Promise.all((this.listeners.get(name) ?? []).map(listener => listener())); }
  click(): void { void this.emit("click"); }
}
const source = readFileSync(new URL("../src/web-main.ts", import.meta.url), "utf8");
const executable = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const inputIds = ["csv-file", "customer-file", "material-file"] as const;
function setup() {
  const body = new Element("body");
  for (const id of [...inputIds, "analyze-button", "download-button", "error-message", "result-section", "exception-table", "empty-message", "total-count", "ready-count", "exception-count"]) {
    const element = new Element(id === "exception-table" ? "table" : "div");
    element.id = id;
    body.append(element);
  }
  const node = (id: string): Element => { const element = body.querySelector(`#${id}`); assert.ok(element, id); return element; };
  node("exception-table").append(new Element("thead"), new Element("tbody"));
  for (const id of ["download-button", "error-message", "result-section", "empty-message"]) node(id).hidden = true;
  const parsed: string[] = [];
  const references: string[][] = [];
  const downloads: Blob[] = [];
  type Order = { orderId: string; customerId: string; materialId: string; orderQuantity: number; availableQuantity: number; customerBlocked: boolean; materialBlocked: boolean };
  runInNewContext(executable, {
    exports: {}, Error, Blob,
    document: { body, querySelector: (selector: string) => body.querySelector(selector), createElement: (tag: string) => new Element(tag) },
    URL: { createObjectURL: (blob: Blob) => { downloads.push(blob); return "blob:test"; }, revokeObjectURL: () => {} },
    localDecisionContextProvider: {},
    createCsvDecisionContextProvider: (customer: string, material: string) => { references.push([customer, material]); return {}; },
    parseCsvUpload: (text: string) => {
      parsed.push(text);
      if (text === "invalid") throw new Error("잘못된 CSV");
      return { referenceSource: text === "direct" ? "csv" : "provider", orders: [{ orderId: text, customerId: "C", materialId: "M", orderQuantity: 1, availableQuantity: 2, customerBlocked: text === "exception", materialBlocked: false }] };
    },
    validateOrders: () => {},
    analyzeOrderBatch: (orders: Order[]) => {
      const count = orders[0]!.customerBlocked ? 1 : 0;
      return { summary: { totalCount: 1, shipReadyCount: 1 - count, exceptionCount: count }, exceptionWorklist: count ? [{ resultIndex: 0, reasonCodes: ["CUSTOMER_BLOCKED"], exceptionGuides: [] }] : [] };
    },
    formatOrderSummary: () => ({ exceptionRateText: "통계", topReasonText: "사유", reasonCounts: [], reasonCountsText: "건수" }),
    createExceptionCsv: (orders: Order[]) => `exception-csv:${orders[0]!.orderId}`,
  });
  return {
    node, parsed, references, downloads,
    select(file?: UploadFile, id: string = "csv-file"): Promise<void> {
      node(id).files = file ? [file] : [];
      return node(id).emit("change");
    },
    analyze: () => node("analyze-button").emit("click"),
    download: () => node("download-button").emit("click"),
    snapshot: () => JSON.stringify(body, (key, value: unknown) => key === "parent" || key === "listeners" ? undefined : value),
  };
}
function file(text: string): UploadFile { return { text: async () => text }; }
function deferred() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { file: { text: () => promise }, resolve, reject };
}
async function selectThree(ui: ReturnType<typeof setup>): Promise<void> {
  await ui.select(file("exception"));
  await ui.select(file("customers"), "customer-file");
  await ui.select(file("materials"), "material-file");
}
function assertCleared(ui: ReturnType<typeof setup>): void {
  for (const id of ["result-section", "download-button", "error-message", "reference-provenance"]) assert.equal(ui.node(id).hidden, true, id);
  for (const id of ["reference-provenance", "error-message", "total-count", "ready-count", "exception-count"]) assert.equal(ui.node(id).textContent, "", id);
  assert.equal(ui.node("analyze-button").disabled, false);
  assert.equal(ui.node("exception-table").querySelector("tbody")!.children.length, 0);
}
for (const id of inputIds) {
  for (const clear of [false, true]) test(`${id} ${clear ? "해제" : "교체"}는 즉시 결과와 다운로드를 지운다`, async () => {
    const ui = setup();
    await selectThree(ui);
    await ui.analyze();
    await ui.download();
    assert.equal(await ui.downloads[0]!.text(), "exception-csv:exception");
    const changed = ui.select(clear ? undefined : file("normal"), id);
    assertCleared(ui);
    await changed;
    await ui.download();
    assert.equal(ui.downloads.length, 1);
    await ui.analyze();
    if (clear) {
      assert.equal(ui.node("error-message").hidden, false);
      assert.equal(ui.node("result-section").hidden, true);
    } else {
      assert.equal(ui.node("result-section").hidden, false);
      assert.equal(ui.node("exception-count").textContent, id === "csv-file" ? "0" : "1");
    }
  });
  for (const outcome of ["success", "failure"] as const) {
    for (const oldFirst of [true, false]) test(`${id}: 이전 ${outcome}, 이전 완료 먼저=${oldFirst}`, async () => {
      const ui = setup();
      await selectThree(ui);
      const old = deferred();
      const current = deferred();
      await ui.select(old.file, id);
      const oldRun = ui.analyze();
      await ui.select(current.file, id);
      assertCleared(ui);
      const currentRun = ui.analyze();
      const finishOld = async () => {
        const before = ui.snapshot();
        if (outcome === "success") old.resolve("invalid");
        else old.reject(new Error("이전 읽기 실패"));
        await oldRun;
        assert.equal(ui.snapshot(), before);
      };
      if (oldFirst) { await finishOld(); assert.equal(ui.node("analyze-button").disabled, true); }
      current.resolve("normal");
      await currentRun;
      if (!oldFirst) await finishOld();
      assert.deepEqual(ui.parsed, [id === "csv-file" ? "normal" : "exception"]);
      assert.equal(ui.references.length, 1);
      assert.equal(ui.node("error-message").hidden, true);
      assert.equal(ui.node("result-section").hidden, false);
      assert.equal(ui.node("analyze-button").disabled, false);
    });
    test(`${id}: 선택 해제 후 이전 ${outcome} 무시`, async () => {
      const ui = setup();
      await selectThree(ui);
      const pending = deferred();
      await ui.select(pending.file, id);
      const run = ui.analyze();
      await ui.select(undefined, id);
      const before = ui.snapshot();
      if (outcome === "success") pending.resolve("exception");
      else pending.reject(new Error("이전 오류"));
      await run;
      assert.equal(ui.snapshot(), before);
      assert.deepEqual(ui.parsed, []);
      await ui.download();
      assert.equal(ui.downloads.length, 0);
    });
  }
  test(`${id}: change 이벤트 없이 선택이 달라도 다운로드 차단`, async () => {
    const ui = setup();
    await selectThree(ui);
    await ui.analyze();
    ui.node(id).files = [file("replacement")];
    await ui.download();
    assert.equal(ui.downloads.length, 0);
  });
  test(`${id}: 읽기 실패는 파일 종류와 원인을 표시하고 전체 차단`, async () => {
    const ui = setup();
    await selectThree(ui);
    await ui.select({ text: async () => { throw new Error("접근 실패"); } }, id);
    await ui.analyze();
    assert.match(ui.node("error-message").textContent, /CSV 읽기 실패: 접근 실패/);
    assert.equal(ui.node("result-section").hidden, true);
    await ui.download();
    assert.equal(ui.downloads.length, 0);
  });
}
test("입력 조합 검증 및 출처 전환", async () => {
  const ui = setup();
  await ui.analyze();
  assert.match(ui.node("error-message").textContent, /주문 CSV/);
  await ui.select(file("normal"));
  for (const id of ["customer-file", "material-file"]) {
    await ui.select(file("reference"), id);
    await ui.analyze();
    assert.match(ui.node("error-message").textContent, /누락된/);
    assert.deepEqual(ui.parsed, []);
    await ui.select(undefined, id);
  }
  await ui.analyze();
  assert.match(ui.node("reference-provenance").textContent, /로컬 예제/);
  assert.equal(ui.node("empty-message").hidden, false);
  await ui.select(file("direct"));
  await ui.analyze();
  assert.match(ui.node("reference-provenance").textContent, /직접 포함/);
  await ui.select(file("c"), "customer-file");
  await ui.select(file("m"), "material-file");
  await ui.analyze();
  assert.match(ui.node("error-message").textContent, /직접 판정 열/);
  assert.equal(ui.node("result-section").hidden, true);
  await ui.select(file("exception"));
  await ui.analyze();
  assert.match(ui.node("reference-provenance").textContent, /업로드/);
  assert.doesNotMatch(ui.node("reference-provenance").textContent, /예제/);
});
test("재분석 시작은 결과를 지우고 같은 파일의 이전 실행도 무효화한다", async () => {
  const ui = setup();
  const old = deferred();
  const current = deferred();
  let reads = 0;
  await ui.select({ text: () => ++reads === 1 ? Promise.resolve("exception") : reads === 2 ? old.file.text() : current.file.text() });
  await ui.analyze();
  const oldRun = ui.analyze();
  assert.equal(ui.node("result-section").hidden, true);
  await ui.download();
  assert.equal(ui.downloads.length, 0);
  const currentRun = ui.analyze();
  old.resolve("invalid");
  await oldRun;
  assert.equal(ui.node("analyze-button").disabled, true);
  current.reject(new Error("새 읽기 실패"));
  await currentRun;
  assert.match(ui.node("error-message").textContent, /새 읽기 실패/);
  await ui.download();
  assert.equal(ui.downloads.length, 0);
  await ui.select(file("normal"));
  assertCleared(ui);
  assert.equal(ui.node("analysis-status").attributes.get("role"), "status");
  assert.notEqual(ui.node("analysis-status").parent, ui.node("result-section"));
});
