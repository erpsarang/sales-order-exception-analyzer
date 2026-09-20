import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCandidateChangeSet,
  type CandidateChangeSet,
  type WorkerProposal,
} from "./single-pass-worker.js";
import { applyTrustedLockfile } from "./trusted-lockfile.js";
import {
  createWorkerCandidateProvenance,
  PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME,
  PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH,
  planImplementAiCallId,
  validatePlanImplementWorkerSource,
  verifyPlanImplementWorkerBundle,
  workerAiCallLedgerArtifactName,
  workerCandidateArtifactName,
  type HandoffArtifactMetadata,
  type PlanImplementWorkerBundle,
  type PlanImplementWorkerRecoveryGuard,
  type PlanImplementWorkerSourceRun,
} from "./plan-implement-worker.js";

const HANDOFF_FILES = [
  "context.json",
  "contract.json",
  "handoff.json",
  "prompt.md",
  "schema.json",
  "source.json",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

const RECOVERY_SHA = /^[0-9a-f]{40,64}$/;

function selectedRecoveryGuard(): PlanImplementWorkerRecoveryGuard | undefined {
  const kind = process.env.RECOVERY_GUARD_KIND?.trim() ?? "";
  const baseSha = process.env.RECOVERY_BASE_SHA?.trim() ?? "";
  const currentDefaultSha = process.env.RECOVERY_CURRENT_SHA?.trim() ?? "";
  if (!kind && !baseSha && !currentDefaultSha) return undefined;
  if (
    kind !== "trusted-recovery-compare-v1" ||
    !RECOVERY_SHA.test(baseSha) ||
    !RECOVERY_SHA.test(currentDefaultSha)
  ) {
    throw new Error("invalid recovery guard");
  }
  return { kind, baseSha, currentDefaultSha };
}
function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function normalizeDigest(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} digest missing`);
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} digest invalid`);
  return normalized;
}

function output(name: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${value}\n`, { flag: "a" });
}

function repositoryParts(): { owner: string; repo: string; repository: string } {
  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("invalid GITHUB_REPOSITORY");
  return { owner, repo, repository };
}

async function api<T>(path: string): Promise<T> {
  const token = required("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-improvement-mvp-plan-implement-worker",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json() as T;
}

function assertExactHandoffFiles(directory: string): void {
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((entry) => !entry.isFile())) throw new Error("handoff artifact must contain files only");
  const actual = files.map((entry) => entry.name).sort();
  const expected = [...HANDOFF_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`handoff artifact file set mismatch: ${actual.join(",")}`);
  }
}

function loadBundle(directory: string): PlanImplementWorkerBundle {
  assertExactHandoffFiles(directory);
  return verifyPlanImplementWorkerBundle({
    contract: JSON.parse(readFileSync(join(directory, "contract.json"), "utf8")),
    context: JSON.parse(readFileSync(join(directory, "context.json"), "utf8")),
    handoff: JSON.parse(readFileSync(join(directory, "handoff.json"), "utf8")),
    source: JSON.parse(readFileSync(join(directory, "source.json"), "utf8")),
    prompt: readFileSync(join(directory, "prompt.md"), "utf8"),
    schema: JSON.parse(readFileSync(join(directory, "schema.json"), "utf8")),
  });
}

function selectedSourceArtifact(): HandoffArtifactMetadata {
  return {
    name: required("SOURCE_ARTIFACT_NAME"),
    id: positiveInteger("SOURCE_ARTIFACT_ID"),
    digest: normalizeDigest(required("SOURCE_ARTIFACT_DIGEST"), "source handoff artifact"),
  };
}

interface ReusableAttempt0Candidate {
  readonly workerRunId: number;
  readonly workerRunAttempt: number;
  readonly artifact: HandoffArtifactMetadata;
}

async function findReusableAttempt0Candidate(
  bundle: PlanImplementWorkerBundle,
  source: PlanImplementWorkerSourceRun,
  aiCallId: string,
): Promise<ReusableAttempt0Candidate | undefined> {
  const { owner, repo } = repositoryParts();
  const ledgerName = workerAiCallLedgerArtifactName(aiCallId);
  const response = await api<any>(
    `/repos/${owner}/${repo}/actions/artifacts?name=${encodeURIComponent(ledgerName)}&per_page=100`,
  );
  const ledgers = (response.artifacts ?? [])
    .filter((artifact: any) =>
      artifact?.name === ledgerName &&
      artifact?.expired === false &&
      Number.isSafeInteger(Number(artifact?.workflow_run?.id)) &&
      Number(artifact.workflow_run.id) > 0,
    )
    .sort((left: any, right: any) => Number(right.id) - Number(left.id));

  for (const ledger of ledgers) {
    const workerRunId = Number(ledger.workflow_run.id);
    const run = await api<any>(`/repos/${owner}/${repo}/actions/runs/${workerRunId}`);
    const workerRunAttempt = Number(run.run_attempt);
    if (
      Number(run.id) !== workerRunId ||
      !Number.isSafeInteger(workerRunAttempt) ||
      workerRunAttempt < 1 ||
      run.name !== PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME ||
      run.path !== PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH ||
      run.event !== "workflow_run" ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.head_branch !== source.defaultBranch
    ) {
      continue;
    }

    const expectedCandidateName = workerCandidateArtifactName({
      bundle,
      sourceRunId: source.id,
      sourceRunAttempt: source.runAttempt,
      workerRunId,
      workerRunAttempt,
    });
    const artifacts = await api<any>(`/repos/${owner}/${repo}/actions/runs/${workerRunId}/artifacts?per_page=100`);
    const matches = (artifacts.artifacts ?? []).filter(
      (artifact: any) => artifact?.name === expectedCandidateName && artifact?.expired === false,
    );
    if (matches.length !== 1) continue;
    const artifact = matches[0];
    const artifactId = Number(artifact.id);
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) continue;

    return {
      workerRunId,
      workerRunAttempt,
      artifact: {
        name: expectedCandidateName,
        id: artifactId,
        digest: normalizeDigest(artifact.digest, "reusable candidate artifact"),
      },
    };
  }

  return undefined;
}

function assertExactCandidateFiles(directory: string): void {
  const files = readdirSync(directory, { withFileTypes: true });
  if (files.some((entry) => !entry.isFile())) throw new Error("candidate artifact must contain files only");
  const actual = files.map((entry) => entry.name).sort();
  const expected = ["candidate-provenance.json", "candidate.json"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`candidate artifact file set mismatch: ${actual.join(",")}`);
  }
}

async function validateLiveSource(
  bundle: PlanImplementWorkerBundle,
  selectedArtifact: HandoffArtifactMetadata,
): Promise<PlanImplementWorkerSourceRun> {
  const { owner, repo, repository } = repositoryParts();
  const sourceRunId = positiveInteger("SOURCE_RUN_ID");
  const sourceRunAttempt = positiveInteger("SOURCE_RUN_ATTEMPT");

  const sourceRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}`);
  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");
  const branch = await api<any>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const currentDefaultSha = branch.commit?.sha;
  if (typeof currentDefaultSha !== "string") throw new Error("default branch HEAD missing");

  const source: PlanImplementWorkerSourceRun = {
    id: Number(sourceRun.id),
    runAttempt: Number(sourceRun.run_attempt),
    repository,
    workflowName: sourceRun.name,
    workflowPath: sourceRun.path,
    event: sourceRun.event,
    conclusion: sourceRun.conclusion,
    headBranch: sourceRun.head_branch,
    defaultBranch,
    headSha: sourceRun.head_sha,
    currentDefaultSha,
  };
  if (source.id !== sourceRunId || source.runAttempt !== sourceRunAttempt) {
    throw new Error("selected source handoff run identity changed");
  }

  const artifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}/artifacts?per_page=100`);
  const matches = (artifactsResponse.artifacts ?? []).filter(
    (item: any) => item.name === selectedArtifact.name && !item.expired,
  );
  if (matches.length !== 1) throw new Error("source handoff artifact must exist exactly once");
  const artifact = matches[0];
  if (
    Number(artifact.id) !== selectedArtifact.id ||
    normalizeDigest(artifact.digest, "live source handoff artifact") !== selectedArtifact.digest
  ) {
    throw new Error("source handoff artifact identity mismatch");
  }

  validatePlanImplementWorkerSource(bundle, source, selectedArtifact, selectedRecoveryGuard());
  return source;
}

async function prepare(): Promise<void> {
  const sourceDirectory = required("SOURCE_DIRECTORY");
  const workerInput = required("WORKER_INPUT_DIRECTORY");
  const bundle = loadBundle(sourceDirectory);
  const sourceArtifact = selectedSourceArtifact();
  const source = await validateLiveSource(bundle, sourceArtifact);

  const workerRunId = positiveInteger("WORKER_RUN_ID");
  const workerRunAttempt = positiveInteger("WORKER_RUN_ATTEMPT");
  const aiCallId = planImplementAiCallId({ bundle, source, sourceArtifact });
  const reusable = await findReusableAttempt0Candidate(bundle, source, aiCallId);

  output("ai_call_id", aiCallId);
  output("ai_call_ledger_name", workerAiCallLedgerArtifactName(aiCallId));
  output("reuse_candidate", reusable ? "true" : "false");
  if (reusable) {
    output("reuse_worker_run_id", String(reusable.workerRunId));
    output("reuse_worker_run_attempt", String(reusable.workerRunAttempt));
    output("reuse_candidate_name", reusable.artifact.name);
    output("reuse_candidate_id", String(reusable.artifact.id));
    output("reuse_candidate_digest", reusable.artifact.digest);
  } else {
    mkdirSync(workerInput, { recursive: true });
    writeFileSync(join(workerInput, "prompt.md"), bundle.prompt);
    writeFileSync(
      join(workerInput, "schema.json"),
      JSON.stringify(JSON.parse(readFileSync(join(sourceDirectory, "schema.json"), "utf8")), null, 2),
    );
  }

  output("candidate_artifact_name", workerCandidateArtifactName({
    bundle,
    sourceRunId: source.id,
    sourceRunAttempt: source.runAttempt,
    workerRunId,
    workerRunAttempt,
  }));
}

async function reuse(): Promise<void> {
  const sourceDirectory = required("SOURCE_DIRECTORY");
  const reusedDirectory = required("REUSED_CANDIDATE_DIRECTORY");
  const outputDirectory = required("CANDIDATE_OUTPUT_DIRECTORY");
  const bundle = loadBundle(sourceDirectory);
  const sourceArtifact = selectedSourceArtifact();
  const source = await validateLiveSource(bundle, sourceArtifact);
  const aiCallId = planImplementAiCallId({ bundle, source, sourceArtifact });
  if (required("AI_CALL_ID") !== aiCallId) throw new Error("AI call identity changed before reuse");

  const reuseWorkerRunId = positiveInteger("REUSE_WORKER_RUN_ID");
  const reuseWorkerRunAttempt = positiveInteger("REUSE_WORKER_RUN_ATTEMPT");
  const selectedArtifact: HandoffArtifactMetadata = {
    name: required("REUSE_CANDIDATE_NAME"),
    id: positiveInteger("REUSE_CANDIDATE_ID"),
    digest: normalizeDigest(required("REUSE_CANDIDATE_DIGEST"), "selected reusable candidate artifact"),
  };
  const expectedName = workerCandidateArtifactName({
    bundle,
    sourceRunId: source.id,
    sourceRunAttempt: source.runAttempt,
    workerRunId: reuseWorkerRunId,
    workerRunAttempt: reuseWorkerRunAttempt,
  });
  if (selectedArtifact.name !== expectedName) throw new Error("reusable candidate artifact name mismatch");

  const { owner, repo } = repositoryParts();
  const priorRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${reuseWorkerRunId}`);
  if (
    Number(priorRun.id) !== reuseWorkerRunId ||
    Number(priorRun.run_attempt) !== reuseWorkerRunAttempt ||
    priorRun.name !== PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME ||
    priorRun.path !== PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH ||
    priorRun.event !== "workflow_run" ||
    priorRun.status !== "completed" ||
    priorRun.conclusion !== "success" ||
    priorRun.head_branch !== source.defaultBranch
  ) {
    throw new Error("reusable candidate source Worker identity mismatch");
  }
  const artifacts = await api<any>(
    `/repos/${owner}/${repo}/actions/runs/${reuseWorkerRunId}/artifacts?per_page=100`,
  );
  const matches = (artifacts.artifacts ?? []).filter(
    (artifact: any) => artifact?.name === selectedArtifact.name && artifact?.expired === false,
  );
  if (matches.length !== 1) throw new Error("reusable candidate artifact must exist exactly once");
  const liveArtifact = matches[0];
  if (
    Number(liveArtifact.id) !== selectedArtifact.id ||
    normalizeDigest(liveArtifact.digest, "live reusable candidate artifact") !== selectedArtifact.digest
  ) {
    throw new Error("reusable candidate artifact identity mismatch");
  }

  assertExactCandidateFiles(reusedDirectory);
  const candidate = JSON.parse(readFileSync(join(reusedDirectory, "candidate.json"), "utf8")) as CandidateChangeSet;
  const recoveryGuard = selectedRecoveryGuard();
  const provenance = createWorkerCandidateProvenance({
    bundle,
    source,
    sourceArtifact,
    ...(recoveryGuard ? { recoveryGuard } : {}),
    workerRunId: positiveInteger("WORKER_RUN_ID"),
    workerRunAttempt: positiveInteger("WORKER_RUN_ATTEMPT"),
    candidate,
  });

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "candidate.json"), JSON.stringify(candidate, null, 2));
  writeFileSync(join(outputDirectory, "candidate-provenance.json"), JSON.stringify(provenance, null, 2));
}

async function validate(): Promise<void> {
  const sourceDirectory = required("SOURCE_DIRECTORY");
  const rawProposalPath = required("RAW_PROPOSAL_PATH");
  const outputDirectory = required("CANDIDATE_OUTPUT_DIRECTORY");
  const bundle = loadBundle(sourceDirectory);
  const sourceArtifact = selectedSourceArtifact();
  const source = await validateLiveSource(bundle, sourceArtifact);
  const workerRunId = positiveInteger("WORKER_RUN_ID");
  const workerRunAttempt = positiveInteger("WORKER_RUN_ATTEMPT");

  const rawProposal = JSON.parse(readFileSync(rawProposalPath, "utf8")) as WorkerProposal;
  // package-lock.json은 AI가 아니라 trusted deterministic step이 생성한다 (AI가 제안한 lock은 버린다).
  const lockfile = applyTrustedLockfile(bundle.context, rawProposal);
  console.log(`trusted package-lock.json: ${lockfile.status}${lockfile.droppedUntrustedLockfile ? " (untrusted lockfile proposal dropped)" : ""}`);
  const proposal = lockfile.proposal;
  const candidate = createCandidateChangeSet(bundle.contract, bundle.context, proposal);
  const recoveryGuard = selectedRecoveryGuard();
  const provenance = createWorkerCandidateProvenance({
    bundle,
    source,
    sourceArtifact,
    ...(recoveryGuard ? { recoveryGuard } : {}),
    workerRunId,
    workerRunAttempt,
    candidate,
  });

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "candidate.json"), JSON.stringify(candidate, null, 2));
  writeFileSync(join(outputDirectory, "candidate-provenance.json"), JSON.stringify(provenance, null, 2));
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "reuse") await reuse();
else if (command === "validate") await validate();
else throw new Error("usage: plan-implement-worker-handler.ts <prepare|reuse|validate>");
