# AI Development Framework

This repository is bootstrapped with AI Development Framework MVP v0.2 canonical PLAN runtime.

- Source repository: `erpsarang/self-improvement-mvp`
- Framework line: `v0.2`
- Framework source SHA: `b6ec8c86ef236b91d5e6d2445d67590917894dc4`
- Canonical path: User Requirement → Read-only AI PLAN → Human `PLAN-승인` → PLAN_AUTHORIZE → ImplementContract + Context Pack → bounded untrusted Worker → exact-base deterministic CI → bounded pre-Bridge repair (max 2) if required → PASS candidate only → PLAN Bridge → SEAL → PUBLISH → VERIFY → Semantic REVIEW → bounded LOCAL_FIX if required → MERGE_READY → Human Merge.
- PLAN contract: `questions` contains blocking questions only; `implementationScope.ready=true` requires `questions=[]`; any blocking question requires `ready=false` with an empty implementation scope.
- PLAN context: exact source paths or function names are optional hints, not required user input. The bounded selector preserves an explicitly referenced runtime source and its direct test when present, and business-relation augmentation can use a relevant existing test plus its relative imports to recover the related runtime source from business-only requirements.
- PLAN impact-test scope: existing impacted tests may be included in `allowedPaths` when a changed return shape/API/contract requires updating exact assertions; unrelated tests must not be broadened into the write scope.
- Pre-Bridge repair: initial Worker and repair attempts run in separate fresh jobs, with bounded state transfer through artifacts and at most two repair attempts.
- Trust model: IMPLEMENT/FIX workers are untrusted; worker output is a candidate artifact.
- Trusted Rail: exact-SHA/provenance validation is preserved.
- Final merge: Human-only. Auto Merge is prohibited.
