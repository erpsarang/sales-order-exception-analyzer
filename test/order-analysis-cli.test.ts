import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOrderAnalysisCli } from "../src/order-analysis-cli.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { createExceptionCsv, parseCsvOrders } from "../src/order-csv.js";
import { formatOrderSummary } from "../src/order-summary.js";

const normal = { orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 10, availableQuantity: 20, customerBlocked: false, materialBlocked: false };
async function run(args: string[]) { try { return { status: 0, stdout: await runOrderAnalysisCli(args), stderr: "" }; } catch (error) { return { status: 1, stdout: "", stderr: (error as Error).message }; } }
async function withFile(source: string, check: (path: string, directory: string) => Promise<void>, name = "orders.json") {
  const directory = mkdtempSync(join(tmpdir(), "order-cli-"));
  try { const path = join(directory, name); writeFileSync(path, source); await check(path, directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("JSON 입력과 예외 CSV 출력 호환성을 보존한다", async () => {
  await withFile(JSON.stringify([{ ...normal, orderQuantity: 0, availableQuantity: -1, customerBlocked: true }]), async (path, directory) => {
    const output = join(directory, "exceptions.csv");
    const result = await run([path, "--csv", output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /전체 1건 \/ 정상 0건 \/ 예외 1건/);
    assert.match(result.stdout, /INVALID_QUANTITY/);
    assert.equal(readFileSync(output, "utf8").startsWith("\uFEFF주문번호,자재,수량"), true);
    assert.equal(readFileSync(output, "utf8"), '\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\nSO-1,M-1,0,C-1,,,,"INVALID_QUANTITY, CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"\n');
    assert.deepEqual(result.stdout.split("\n").slice(1, 4), [
      "예외율: 100%",
      "예외 사유별 건수: INVALID_QUANTITY 1건, CUSTOMER_BLOCKED 1건, INSUFFICIENT_STOCK 1건",
      "최다 사유: INVALID_QUANTITY, CUSTOMER_BLOCKED, INSUFFICIENT_STOCK",
    ]);
  });
});

test("CSV 입력은 BOM과 숫자 및 boolean 변환을 지원한다", async () => {
  const source = "\uFEFForderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount\nSO-1,C-1,M-1,10,20,false,false,1200.5\nSO-2,C-2,M-2,0,1,true,false,\n";
  await withFile(source, async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /전체 2건 \/ 정상 1건 \/ 예외 1건/);
    assert.match(result.stdout, /INVALID_QUANTITY/);
    assert.deepEqual(result.stdout.split("\n").slice(1, 4), [
      "예외율: 50%",
      "예외 사유별 건수: INVALID_QUANTITY 1건, CUSTOMER_BLOCKED 1건",
      "최다 사유: INVALID_QUANTITY, CUSTOMER_BLOCKED",
    ]);
  }, "orders.csv");
});

test("CSV 입력은 선택 필드와 CSV 이스케이프를 지원한다", async () => {
  const source = "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,orderComment\n\"SO,\"\"1\"\"\",C-1,M-1,10,20,false,false,\"첫 줄\n\"\"둘째 줄\"\"\"\n";
  await withFile(source, async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /전체 1건 \/ 정상 1건 \/ 예외 0건/);
    assert.match(result.stdout, /SO,\\"1\\"/);
  }, "orders.csv");
});

test("CSV 변환 및 헤더 오류는 원인을 안내한다", async () => {
  const cases: [string, RegExp][] = [
    ["orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked\nSO-1,C-1,M-1,ten,20,false,false\n", /CSV 데이터 1번째 행 orderQuantity/],
    ["orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked\nSO-1,C-1,M-1,10,20,FALSE,false\n", /CSV 데이터 1번째 행 customerBlocked/],
    ["orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked\n", /필수 필드 materialBlocked/],
    ["orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,unknown\n", /알 수 없는 필드/],
    ["orderId,orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked\n", /orderId 필드가 중복/],
  ];
  for (const [source, expected] of cases) await withFile(source, async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }, "orders.csv");
});

test("기존 JSON 검증과 CSV 미지정 동작을 보존한다", async () => {
  await withFile(JSON.stringify([normal]), async (path, directory) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /처리할 예외가 없습니다/);
    assert.equal(existsSync(join(directory, "exceptions.csv")), false);
  });
  await withFile("{", async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JSON 문법/);
  });
});

test("10건 중 예외 4건의 요약은 batch summary와 일치하며 상세 출력과 반복 실행을 보존한다", async () => {
  const orders = [
    { ...normal, availableQuantity: 0, customerBlocked: true, dueDate: "2026-10-16" },
    { ...normal, availableQuantity: 0, dueDate: "2026-10-15" },
    { ...normal, availableQuantity: 0 },
    { ...normal, customerBlocked: true },
    ...Array.from({ length: 6 }, () => ({ ...normal })),
  ];
  const batch = analyzeOrderBatch(orders);
  const display = formatOrderSummary(batch.summary);
  await withFile(JSON.stringify(orders), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.deepEqual(lines.slice(0, 5), [
      "주문 분석: 전체 10건 / 정상 6건 / 예외 4건",
      "예외율: 40%",
      "예외 사유별 건수: INSUFFICIENT_STOCK 3건, CUSTOMER_BLOCKED 2건",
      "최다 사유: INSUFFICIENT_STOCK",
      "주문별 결과 (입력 순서):",
    ]);
    assert.deepEqual(lines.slice(1, 4), [
      `예외율: ${display.exceptionRateText}`,
      `예외 사유별 건수: ${display.reasonCountsText}`,
      `최다 사유: ${display.topReasonText}`,
    ]);
    assert.deepEqual(lines.slice(5, 5 + orders.length), batch.results.map((item, index) => `입력 ${index + 1}: ${JSON.stringify(item)}`));
    const worklistLines = ["예외 처리 순서 (입력 번호는 1부터 시작):"];
    for (const item of batch.exceptionWorklist) {
      worklistLines.push(`${item.rank}순위 / 입력 ${item.resultIndex + 1} / 주문 ${JSON.stringify(item.orderId)}`);
      worklistLines.push(`상세: ${JSON.stringify(item.orderDetails)}`);
      for (const guide of item.exceptionGuides) worklistLines.push(`사유: ${guide.reasonCode} / 확인: ${guide.check} / 조치: ${guide.action}`);
    }
    assert.deepEqual(lines.slice(5 + orders.length, 5 + orders.length + worklistLines.length), worklistLines);
    assert.equal(lines[5 + orders.length + worklistLines.length], "공급 위험 (누적 재고 배분):");
    assert.deepEqual(await run([path]), result);
  });
});

test("빈 입력과 정상 입력은 추가 요약에 예외 없음을 표시한다", async () => {
  for (const orders of [[], [normal]]) {
    await withFile(JSON.stringify(orders), async (path, directory) => {
      const output = join(directory, "exceptions.csv");
      const result = await run([path, "--csv", output]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split("\n").slice(1, 5), [
        "예외율: 0%", "예외 사유별 건수: 예외 없음", "최다 사유: 예외 없음", "주문별 결과 (입력 순서):",
      ]);
      assert.match(result.stdout, /처리할 예외가 없습니다/);
      assert.equal(readFileSync(output, "utf8"), "\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\n");
    });
  }
});

test("CSV 재분석은 반올림 요약과 기존 예외 CSV 내용을 동일하게 유지한다", async () => {
  const source = 'orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,orderComment\nSO-1,C-1,M-1,10,0,true,false,"확인, 요청"\nSO-2,C-1,M-1,10,20,false,false,\nSO-3,C-1,M-1,10,20,false,false,\n';
  const orders = parseCsvOrders(source);
  const batch = analyzeOrderBatch(orders);
  await withFile(source, async (path, directory) => {
    const output = join(directory, "exceptions.csv");
    const first = await run([path, "--csv", output]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.stdout.split("\n").slice(1, 4), [
      "예외율: 33.33%",
      "예외 사유별 건수: CUSTOMER_BLOCKED 1건, INSUFFICIENT_STOCK 1건",
      "최다 사유: CUSTOMER_BLOCKED, INSUFFICIENT_STOCK",
    ]);
    const csv = readFileSync(output, "utf8");
    assert.equal(csv, createExceptionCsv(orders, batch));
    assert.equal(csv, '\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\nSO-1,M-1,10,C-1,,,"확인, 요청","CUSTOMER_BLOCKED, INSUFFICIENT_STOCK"\n');
    assert.deepEqual(await run([path, "--csv", output]), first);
    assert.equal(readFileSync(output, "utf8"), csv);
  }, "orders.csv");
});

function supplyRiskSection(stdout: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.indexOf("공급 위험 (누적 재고 배분):");
  assert.notEqual(start, -1);
  return lines.slice(start);
}

test("이슈 예시: 같은 자재 두 주문이 재고를 넘으면 공급 위험 1건과 부족량을 출력한다", async () => {
  const source = "orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate\nSO-1,C-1,M-001,15,20,false,false,,2026-10-01\nSO-2,C-1,M-001,10,20,false,false,,2026-10-02\n";
  await withFile(source, async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.ok(lines.indexOf("공급 위험 (누적 재고 배분):") > lines.indexOf("예외 처리 순서 (입력 번호는 1부터 시작):"));
    const section = supplyRiskSection(result.stdout);
    assert.ok(section.includes("공급 위험: 1건"));
    assert.ok(section.includes("첫 공급 위험 주문: SO-2 (입력 2), 납기 2026-10-02, 부족량 5"));
    assert.ok(section.some((line) => line.startsWith('입력 2 / 주문 "SO-2" / 자재 M-001 / 거래처 C-1 / 납기 2026-10-02 / 주문수량 10 / 부족수량 5 / 예상금액')));
  }, "orders.csv");
});

test("공급 위험이 없으면 공급 위험 0건을 출력한다", async () => {
  await withFile(JSON.stringify([{ ...normal, dueDate: "2026-10-01" }]), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const section = supplyRiskSection(result.stdout);
    assert.ok(section.includes("공급 위험: 0건"));
    assert.equal(section.some((line) => line.startsWith("첫 공급 위험 주문")), false);
  });
});

test("공급 위험 목록은 납기일, 예상금액 내림차순(없으면 뒤), 입력 순서로 정렬한다", async () => {
  const due = "2026-10-02";
  const orders = [
    { ...normal, orderId: "A", orderQuantity: 10, availableQuantity: 10, dueDate: "2026-10-01" },
    { ...normal, orderId: "B", orderQuantity: 5, availableQuantity: 10, dueDate: due, estimatedAmount: 100 },
    { ...normal, orderId: "C", orderQuantity: 5, availableQuantity: 10, dueDate: due, estimatedAmount: 500 },
    { ...normal, orderId: "D", orderQuantity: 5, availableQuantity: 10, dueDate: due },
    { ...normal, orderId: "E", orderQuantity: 1, availableQuantity: 10, dueDate: "2026-10-03", estimatedAmount: 9999 },
  ];
  await withFile(JSON.stringify(orders), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const section = supplyRiskSection(result.stdout);
    assert.ok(section.includes("공급 위험: 4건"));
    const ids = section.filter((line) => /^입력 \d+ \/ 주문 /.test(line)).map((line) => /주문 "([^"]+)"/.exec(line)![1]);
    assert.deepEqual(ids, ["C", "B", "D", "E"]);
    assert.ok(section.includes("첫 공급 위험 주문: C (입력 3), 납기 2026-10-02, 부족량 5"));
  });
});

test("일부 주문이 제외된 자재는 제외 주문을 안내하고 공급 위험 건수에 포함하지 않는다", async () => {
  const orders = [
    { ...normal, orderId: "A", orderQuantity: 15, availableQuantity: 20, dueDate: "2026-10-01" },
    { ...normal, orderId: "B", orderQuantity: 5, availableQuantity: 20 },
    { ...normal, orderId: "C", orderQuantity: 10, availableQuantity: 20, dueDate: "2026-10-02" },
  ];
  await withFile(JSON.stringify(orders), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const section = supplyRiskSection(result.stdout);
    assert.ok(section.includes("공급 위험: 1건"));
    assert.ok(section.some((line) => line.startsWith("일부 주문을 제외하고 계산한 자재: 1건")));
    assert.ok(section.includes('제외 주문: 자재 M-1 / 입력 2 / 주문 "B" / 사유 납기일이 없거나 올바르지 않음'));
  });
});

test("계산 불가 자재는 원인과 함께 안내하고 전체 판단 불가 문구를 출력한다", async () => {
  const orders = [
    { ...normal, orderId: "A", availableQuantity: 5, dueDate: "2026-10-01" },
    { ...normal, orderId: "B", availableQuantity: 6, dueDate: "2026-10-02" },
  ];
  await withFile(JSON.stringify(orders), async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    const section = supplyRiskSection(result.stdout);
    assert.ok(section.includes("공급 위험: 0건"));
    assert.ok(section.some((line) => line.startsWith("배분 계산 불가 자재: 1건")));
    assert.ok(section.some((line) => line.trim() === "M-1: 같은 자재의 가용재고 값이 서로 다름"));
    assert.ok(section.includes("계산 가능한 자재가 없어 전체 공급 위험 여부를 판단할 수 없습니다."));
  });
});
