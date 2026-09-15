# AI Development Framework

This repository is bootstrapped with AI Development Framework MVP v0.2 canonical PLAN runtime.

- Source repository: `erpsarang/self-improvement-mvp`
- Framework line: `v0.2`
- Framework source SHA: `0f6d4a9006e50294feba2c4da9291be2fef63700`
- Canonical path: User Requirement → Read-only AI PLAN → Human `PLAN-승인` → PLAN_AUTHORIZE → ImplementContract + Context Pack → bounded untrusted Worker → exact-base deterministic CI → bounded pre-Bridge repair (max 2) if required → PASS candidate only → PLAN Bridge → SEAL → PUBLISH → VERIFY → Semantic REVIEW → bounded LOCAL_FIX if required → MERGE_READY → Human Merge.
- PLAN contract: `questions` contains blocking questions only; `implementationScope.ready=true` requires `questions=[]`; any blocking question requires `ready=false` with an empty implementation scope.
- PLAN context: exact source paths or function names are optional hints, not required user input. The bounded selector preserves an explicitly referenced runtime source and its direct test when present. Business-relation augmentation parses actual TypeScript/JavaScript import syntax, ignores import-looking strings/comments, evaluates relevant test-to-runtime relationships, and prefers application runtime sources over Framework self-test sources when recovering source + direct test from business-only requirements. If an exact application runtime path is already selected, weaker lexical relevance must not replace that high-confidence runtime/direct-test pair.
- PLAN impact-test scope: existing impacted tests may be included in `allowedPaths` when a changed return shape/API/contract requires updating exact assertions; unrelated tests must not be broadened into the write scope.
- Pre-Bridge repair: initial Worker and repair attempts run in separate fresh jobs, with bounded state transfer through artifacts and at most two repair attempts.
- Trust model: IMPLEMENT/FIX workers are untrusted; worker output is a candidate artifact.
- Trusted Rail: exact-SHA/provenance validation is preserved.
- Final merge: Human-only. Auto Merge is prohibited.
