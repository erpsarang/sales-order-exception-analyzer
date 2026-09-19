import assert from "node:assert/strict";
import { runOrderAnalysisCli } from "../src/order-analysis-cli.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const normal = {
  orderId: "SO-1", customerId: "C-1", materialId: "M-1",
  orderQuantity: 10, availableQuantity: 20,
  customerBlocked: false, materialBlocked: false,
};
async function run(args: string[]) {
  try {
    return { status: 0, stdout: await runOrderAnalysisCli(args), stderr: "" };
  } catch (error) {
    return { status: 1, stdout: "", stderr: (error as Error).message };
  }
}
async function withFile(source: string, check: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "order-cli-"));
  try {
    const path = join(directory, "주문 파일.json");
    writeFileSync(path, source);
    await check(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("CLI는 집계, 중복 ID의 입력 위치, 처리 순서와 모든 예외 안내를 출력한다", async () => {
  const exception = {
    ...normal, orderQuantity: 0, availableQuantity: -1,
    customerBlocked: true, materialBlocked: true, dueDate: "2026-10-02",
  };
  await withFile(JSON.stringify([normal, exception, { ...exception, dueDate: "2026-10-01" }]), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /전체 3건 \/ 정상 1건 \/ 예외 2건/);
    assert.match(result.stdout, /입력 1: .*SHIP_READY/);
    assert.match(result.stdout, /1순위 \/ 입력 3 \/ 주문 "SO-1"/);
    assert.match(result.stdout, /2순위 \/ 입력 2 \/ 주문 "SO-1"/);
    for (const [code, check, action] of [
      ["INVALID_QUANTITY", "주문수량과 입력 단위 확인", "수량을 양수로 정정 후 재분석"],
      ["CUSTOMER_BLOCKED", "고객 차단 사유와 해제 요건 확인", "해제 가능 여부 확인 후 주문 재분석"],
      ["MATERIAL_BLOCKED", "자재 차단 사유와 해제 요건 확인", "해제 가능 여부 확인 후 주문 재분석"],
      ["INSUFFICIENT_STOCK", "가용재고와 부족 수량 확인", "재고 확보 또는 주문수량 조정 후 재분석"],
    ]) {
      assert.ok(result.stdout.includes(`사유: ${code} / 확인: ${check} / 조치: ${action}`));
    }
  });
});

test("빈 배열과 정상 주문만 있는 파일도 성공한다", async () => {
  for (const orders of [[], [normal]]) {
    await withFile(JSON.stringify(orders), async (path) => {
      const result = await run([path]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`전체 ${orders.length}건 / 정상 ${orders.length}건 / 예외 0건`));
      assert.match(result.stdout, /처리할 예외가 없습니다/);
    });
  }
});

test("인자 오류와 읽을 수 없는 파일은 실패 코드와 안내를 반환한다", async () => {
  for (const args of [[], ["a", "b"], [join(root, "missing-orders-file.json")], [root]]) {
    const result = await run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /사용법|파일을 읽을 수 없습니다/);
  }
});

test("잘못된 JSON과 주문 필드는 부분 결과 없이 거부한다", async () => {
  const cases: [string, RegExp][] = [
    ["{", /JSON 문법/],
    ["{}", /주문 배열/],
    ["[null]", /입력 1번째 주문.*객체/],
    ["[[]]", /입력 1번째 주문.*객체/],
  ];
  for (const [field, value] of [
    ["orderId", " "], ["customerId", null], ["materialId", 1],
    ["orderQuantity", "10"], ["availableQuantity", null],
    ["customerBlocked", "false"], ["materialBlocked", 0],
    ["estimatedAmount", null], ["dueDate", 123], ["orderComment", false],
  ] as const) {
    cases.push([JSON.stringify([normal, { ...normal, [field]: value }]), new RegExp(`입력 2번째 주문: ${field}`)]);
  }
  cases.push([JSON.stringify([{ ...normal, orderQuantity: undefined }]), /orderQuantity/]);
  cases.push([JSON.stringify([normal]).replace('"orderQuantity":10', '"orderQuantity":1e400'), /orderQuantity/]);
  for (const [source, message] of cases) {
    await withFile(source, async (path) => {
      const result = await run([path]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, message);
    });
  }
});
