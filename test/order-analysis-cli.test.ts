import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOrderAnalysisCli } from "../src/order-analysis-cli.js";

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
  });
});

test("CSV 입력은 BOM과 숫자 및 boolean 변환을 지원한다", async () => {
  const source = "\uFEFForderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount\nSO-1,C-1,M-1,10,20,false,false,1200.5\nSO-2,C-2,M-2,0,1,true,false,\n";
  await withFile(source, async (path) => {
    const result = await run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /전체 2건 \/ 정상 1건 \/ 예외 1건/);
    assert.match(result.stdout, /INVALID_QUANTITY/);
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
