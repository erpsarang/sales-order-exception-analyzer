import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAppRuntimeEvidence } from "./app-evidence.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function readProductPurpose(): string {
  const readme = readFileSync("README.md", "utf8");
  const lines = readme.split(/\r?\n/).map((line) => line.trim());
  const headingIndex = lines.findIndex((line) => line === "# sales-order-exception-analyzer");
  const purpose = headingIndex >= 0 ? lines.slice(headingIndex + 1).find(Boolean) : undefined;
  if (!purpose) throw new Error("README.md에서 제품 목적을 찾을 수 없습니다");
  return purpose;
}

const output = requiredEnv("APP_EVIDENCE_OUTPUT");
const evidence = createAppRuntimeEvidence(
  requiredEnv("APP_EVIDENCE_SOURCE_SHA"),
  readProductPurpose(),
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
