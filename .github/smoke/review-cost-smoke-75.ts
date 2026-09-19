import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSemanticReviewPrompt, SEMANTIC_REVIEW_OUTPUT_SCHEMA } from "../../src/self-improvement/review.js";

const inputPath = process.env.SMOKE_INPUT_JSON;
const outputDir = process.env.SMOKE_OUTPUT_DIR;
if (!inputPath || !outputDir) throw new Error("SMOKE_INPUT_JSON/SMOKE_OUTPUT_DIR are required");

const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
  repository: string;
  issueNumber: number;
  baseSha: string;
  verifiedHeadSha: string;
  requirements: { title: string; body: string | null; digest: string };
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  `${outputDir}/review-prompt.md`,
  createSemanticReviewPrompt(input),
  "utf8",
);
writeFileSync(
  `${outputDir}/review-output.schema.json`,
  `${JSON.stringify(SEMANTIC_REVIEW_OUTPUT_SCHEMA, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  `${outputDir}/identity.json`,
  `${JSON.stringify({
    repository: input.repository,
    issueNumber: input.issueNumber,
    baseSha: input.baseSha,
    verifiedHeadSha: input.verifiedHeadSha,
    requirementsDigest: input.requirements.digest,
  }, null, 2)}\n`,
  "utf8",
);
