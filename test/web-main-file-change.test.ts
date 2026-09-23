import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type UploadFile = { text(): Promise<string> };
type Listener = () => unknown;

// 화면 제어만 검증한다. CSV 및 판정 모듈은 반환값이 고정된 대역으로 주입한다.
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
  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join("");
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  append(...elements: Element[]): void {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
  }
  prepend(...elements: Element[]): void {
    for (const element of elements) element.parent = this;
    this.children.unshift(...elements);
  }
  replaceChildren(...elements: Element[]): void {
    this.ownText = "";
    this.children = [];
    this.append(...elements);
  }
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
  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  async emit(name: string): Promise<void> {
    await Promise.all((this.listeners.get(name) ?? []).map(listener => listener()));
  }
  click(): void { void this.emit("click"); }
}

const source = readFileSync(new URL("../src/web-main.ts", import.meta.url), "utf8");
// CSS 로딩 없이 실제 화면 모듈의 이벤트 처리기를 실행한다.
const executable = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function setup() {
  const body = new Element("body");
  const nodes = new Map<string, Element>();
  for (const id of ["csv-file", "analyze-button", "download-button", "error-message", "result-section", "exception-table", "empty-message", "total-count", "ready-count", "exception-count"]) {
    const element = new Element(id === "exception-table" ? "table" : "div");
    element.id = id;
    nodes.set(id, element);
    body.append(element);
  }
  const node = (id: string): Element => {
    const element = body.querySelector(`#${id}`);
    assert.ok(element, id);
    return element;
  };
  node("exception-table").append(new Element("thead"), new Element("tbody"));
  for (const id of ["download-button", "error-message", "result-section", "empty-message"]) node(id).hidden = true;
  const parsed: string[] = [];
  const downloads: Blob[] = [];
  type Order = { orderId: string; customerId: string; materialId: string; orderQuantity: number; availableQuantity: number; customerBlocked: boolean; materialBlocked: boolean };
  runInNewContext(executable, {
    exports: {},
    Error,
    Blob,
    document: { body, querySelector: (selector: string) => body.querySelector(selector), createElement: (tag: string) => new Element(tag) },
    URL: { createObjectURL: (blob: Blob) => { downloads.push(blob); return "blob:test"; }, revokeObjectURL: () => {} },
    localDecisionContextProvider: {},
    parseCsvUpload: (text: string) => {
      parsed.push(text);
      if (text === "invalid") throw new Error("잘못된 CSV");
      return { referenceSource: "provider", orders: [{ orderId: text, customerId: "C", materialId: "M", orderQuantity: 1, availableQuantity: 2, customerBlocked: text === "exception", materialBlocked: false }] };
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
    node, parsed, downloads,
    select(file?: UploadFile): Promise<void> {
      node("csv-file").files = file ? [file] : [];
      return node("csv-file").emit("change");
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
function assertCleared(ui: ReturnType<typeof setup>): void {
  for (const id of ["result-section", "download-button", "error-message", "reference-provenance"]) assert.equal(ui.node(id).hidden, true, id);
  assert.equal(ui.node("reference-provenance").textContent, "");
  assert.equal(ui.node("error-message").textContent, "");
  assert.equal(ui.node("analyze-button").disabled, false);
  assert.equal(ui.node("exception-table").querySelector("tbody")!.children.length, 0);
}

test("파일 변경은 결과와 다운로드를 즉시 무효화하며 새 분석에서 예외 0건을 표시한다", async () => {
  const ui = setup();
  await ui.select(file("exception"));
  await ui.analyze();
  assert.equal(ui.node("exception-count").textContent, "1");
  assert.equal(ui.node("reference-provenance").hidden, false);
  await ui.download();
  assert.equal(await ui.downloads[0]!.text(), "exception-csv:exception");
  const changed = ui.select(file("normal"));
  assertCleared(ui);
  assert.match(ui.node("analysis-status").textContent, /분석하기/);
  assert.equal(ui.node("analysis-status").attributes.get("role"), "status");
  assert.notEqual(ui.node("analysis-status").parent, ui.node("result-section"));
  await changed;
  assert.deepEqual(ui.parsed, ["exception"]);
  await ui.download();
  assert.equal(ui.downloads.length, 1);
  await ui.analyze();
  assert.equal(ui.node("result-section").hidden, false);
  assert.equal(ui.node("exception-count").textContent, "0");
  assert.equal(ui.node("empty-message").hidden, false);
  assert.equal(ui.node("download-button").hidden, true);
  await ui.download();
  assert.equal(ui.downloads.length, 1);
});

test("선택 해제는 기존 결과와 다운로드를 제거하고 파일 선택을 안내한다", async () => {
  const ui = setup();
  await ui.select(file("exception"));
  await ui.analyze();
  await ui.select();
  assertCleared(ui);
  assert.match(ui.node("analysis-status").textContent, /파일을 선택/);
  await ui.download();
  assert.equal(ui.downloads.length, 0);
  await ui.analyze();
  assert.equal(ui.node("error-message").hidden, false);
  assert.deepEqual(ui.parsed, ["exception"]);
  await ui.select(file("normal"));
  assertCleared(ui);
});

test("현재 분석 오류는 표시하고 다음 선택에서 지운다", async () => {
  const ui = setup();
  await ui.select(file("invalid"));
  await ui.analyze();
  assert.equal(ui.node("error-message").textContent, "잘못된 CSV");
  assert.equal(ui.node("analyze-button").disabled, false);
  await ui.select(file("normal"));
  assertCleared(ui);
});

for (const outcome of ["success", "failure"] as const) {
  for (const oldFirst of [true, false]) {
    test(`이전 읽기 ${outcome}, 이전 실행 ${oldFirst ? "먼저" : "나중에"} 완료 시 새 실행 보호`, async () => {
      const ui = setup();
      const old = deferred();
      const current = deferred();
      await ui.select(old.file);
      const oldRun = ui.analyze();
      assert.equal(ui.node("analyze-button").disabled, true);
      await ui.select(current.file);
      assertCleared(ui);
      const currentRun = ui.analyze();
      const finishOld = async () => {
        const before = ui.snapshot();
        if (outcome === "success") old.resolve("exception");
        else old.reject(new Error("이전 읽기 실패"));
        await oldRun;
        assert.equal(ui.snapshot(), before);
      };
      if (oldFirst) {
        await finishOld();
        assert.equal(ui.node("analyze-button").disabled, true);
      }
      current.resolve("normal");
      await currentRun;
      if (!oldFirst) await finishOld();
      assert.deepEqual(ui.parsed, ["normal"]);
      assert.equal(ui.node("exception-count").textContent, "0");
      assert.equal(ui.node("result-section").hidden, false);
      assert.equal(ui.node("error-message").hidden, true);
      assert.equal(ui.node("analyze-button").disabled, false);
      await ui.download();
      assert.equal(ui.downloads.length, 0);
    });
  }
  test(`선택 해제 후 이전 읽기 ${outcome} 완료는 화면을 변경하지 않는다`, async () => {
    const ui = setup();
    const pending = deferred();
    await ui.select(pending.file);
    const run = ui.analyze();
    await ui.select();
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

test("새 분석 시작은 이전 다운로드를 무효화한다", async () => {
  const ui = setup();
  const pending = deferred();
  let reads = 0;
  await ui.select({ text: () => ++reads === 1 ? Promise.resolve("exception") : pending.file.text() });
  await ui.analyze();
  const rerun = ui.analyze();
  await ui.download();
  assert.equal(ui.downloads.length, 0);
  pending.reject(new Error("새 읽기 실패"));
  await rerun;
  assert.equal(ui.node("error-message").textContent, "새 읽기 실패");
  await ui.download();
  assert.equal(ui.downloads.length, 0);
});
