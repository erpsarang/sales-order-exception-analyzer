import { appendFileSync, readFileSync } from "node:fs";
import {
  planAuthorizeArtifactName,
  type PlanAuthorizeArtifact,
} from "./plan-authorization.js";
import {
  verifyPlanAuthorizeArtifact,
  type PlanAuthorizeArtifactMetadata,
} from "./plan-implement-handoff.js";
import {
  classifyPlanRecovery,
  type PlanRunObservation,
} from "./plan-recovery.js";

const SHA256 = /^[0-9a-f]{64}$/;

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function normalizeDigest(value: string, name: string): string {
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!SHA256.test(normalized)) throw new Error(`${name} digest invalid`);
  return normalized;
}

function output(name: string, value: string | number | boolean): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${name}=${String(value)}\n`, "utf8");
}

function repositoryParts(): { owner: string; repo: string; repository: string } {
  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) throw new Error("invalid GITHUB_REPOSITORY");
  return { owner, repo, repository };
}

function token(): string {
  return required("GITHUB_TOKEN");
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "self-improvement-mvp-plan-recovery",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response;
}

async function api<T>(path: string): Promise<T> {
  return await (await request(path)).json() as T;
}

async function allComments(owner: string, repo: string, issueNumber: number): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await api<any[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function main(): Promise<void> {
  const { owner, repo, repository } = repositoryParts();
  const authorization = verifyPlanAuthorizeArtifact(
    JSON.parse(readFileSync(required("PLAN_AUTHORIZE_JSON"), "utf8")),
  );
  if (authorization.repository !== repository) throw new Error("PLAN_AUTHORIZE repository mismatch");

  const sourceArtifact: PlanAuthorizeArtifactMetadata = {
    name: required("SOURCE_ARTIFACT_NAME"),
    id: positiveInteger("SOURCE_ARTIFACT_ID"),
    digest: normalizeDigest(required("SOURCE_ARTIFACT_DIGEST"), "source PLAN_AUTHORIZE artifact"),
  };
  if (sourceArtifact.name !== planAuthorizeArtifactName(authorization)) {
    throw new Error("source PLAN_AUTHORIZE artifact name does not match payload");
  }

  const sourceRunId = positiveInteger("SOURCE_RUN_ID");
  const sourceRunAttempt = positiveInteger("SOURCE_RUN_ATTEMPT");
  if (authorization.authorization.runId !== sourceRunId) {
    throw new Error("PLAN_AUTHORIZE run id mismatch");
  }
  if (authorization.authorization.runAttempt > sourceRunAttempt) {
    throw new Error("PLAN_AUTHORIZE artifact comes from a future run attempt");
  }

  const sourceRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}`);
  if (
    sourceRun.name !== "Trusted PLAN_AUTHORIZE" ||
    sourceRun.path !== ".github/workflows/plan-authorize.yml" ||
    sourceRun.event !== "issue_comment" ||
    sourceRun.conclusion !== "success" ||
    Number(sourceRun.run_attempt) !== sourceRunAttempt
  ) {
    throw new Error("PLAN_AUTHORIZE source workflow identity mismatch");
  }

  const artifactsResponse = await api<any>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}/artifacts?per_page=100`);
  const exactArtifacts = (artifactsResponse.artifacts ?? []).filter((item: any) =>
    !item.expired &&
    item.name === sourceArtifact.name &&
    Number(item.id) === sourceArtifact.id &&
    normalizeDigest(String(item.digest ?? ""), "source PLAN_AUTHORIZE artifact") === sourceArtifact.digest
  );
  if (exactArtifacts.length !== 1) throw new Error("source PLAN_AUTHORIZE artifact identity mismatch");

  const repositoryInfo = await api<any>(`/repos/${owner}/${repo}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) throw new Error("default branch missing");
  if (sourceRun.head_branch !== defaultBranch) throw new Error("PLAN_AUTHORIZE source is not on default branch");

  const branch = await api<any>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const currentDefaultSha = branch.commit?.sha;
  if (typeof currentDefaultSha !== "string") throw new Error("default branch HEAD missing");

  const rawPlanRun = await api<any>(`/repos/${owner}/${repo}/actions/runs/${authorization.plan.runId}`);
  const planRun: PlanRunObservation = {
    name: String(rawPlanRun.name ?? ""),
    path: String(rawPlanRun.path ?? ""),
    event: String(rawPlanRun.event ?? ""),
    status: String(rawPlanRun.status ?? ""),
    conclusion: rawPlanRun.conclusion == null ? null : String(rawPlanRun.conclusion),
    runAttempt: Number(rawPlanRun.run_attempt),
    headBranch: String(rawPlanRun.head_branch ?? ""),
    headSha: String(rawPlanRun.head_sha ?? ""),
  };

  const decision = classifyPlanRecovery(authorization, planRun, defaultBranch, currentDefaultSha);
  output("recovery_required", decision.required);
  output("reason", decision.reason);
  output("issue_number", authorization.requirement.issueNumber);
  output("target_sha", currentDefaultSha);
  if (!decision.required) return;

  const marker = `<!-- self-improvement:AUTO_REPLAN authorization-digest=${authorization.authorizationDigest} -->`;
  const comments = await allComments(owner, repo, authorization.requirement.issueNumber);
  if (comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker))) {
    output("dispatched", false);
    return;
  }

  const pendingBody = [
    marker,
    "## Fresh PLAN 자동 복구",
    `복구 사유: \`${decision.reason}\``,
    `현재 default branch SHA: \`${currentDefaultSha}\``,
    "기존 PLAN 승인/provenance는 재사용하지 않습니다.",
    "현재 main에서 새로운 Read-only AI PLAN을 시작합니다.",
    "새 PLAN이 생성되면 Human `PLAN-승인`이 다시 필요합니다.",
  ].join("\n\n");

  const pending = await (await request(
    `/repos/${owner}/${repo}/issues/${authorization.requirement.issueNumber}/comments`,
    { method: "POST", body: JSON.stringify({ body: pendingBody }) },
  )).json() as any;

  try {
    await request(
      `/repos/${owner}/${repo}/actions/workflows/plan.yml/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: defaultBranch,
          inputs: { issue_number: String(authorization.requirement.issueNumber) },
        }),
      },
    );
  } catch (error) {
    if (Number.isSafeInteger(Number(pending.id))) {
      try {
        await request(
          `/repos/${owner}/${repo}/issues/comments/${Number(pending.id)}`,
          { method: "DELETE" },
        );
      } catch {
        // Best effort cleanup. Original dispatch error is authoritative.
      }
    }
    throw error;
  }

  output("dispatched", true);
}

await main();
