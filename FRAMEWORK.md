# AI Development Framework

This repository is bootstrapped with AI Development Framework MVP v0.2 canonical PLAN runtime.

- Source repository: `erpsarang/self-improvement-mvp`
- Framework line: `v0.2`
- Framework source SHA: `0609846c8d11ff301622e789593aef06484310ce`
- Canonical path: User Requirement → Read-only AI PLAN → Human `PLAN-승인` → PLAN_AUTHORIZE → ImplementContract + Context Pack → bounded untrusted Worker → exact-base deterministic CI → bounded pre-Bridge repair (max 2) if required → PASS candidate only → PLAN Bridge → SEAL → PUBLISH → VERIFY → Semantic REVIEW → bounded LOCAL_FIX if required → MERGE_READY → Human Merge.
- PLAN contract: `questions` contains blocking questions only; `implementationScope.ready=true` requires `questions=[]`; any blocking question requires `ready=false` with an empty implementation scope.
- PLAN context: business result fields such as `status`/`summary` do not by themselves activate human-output context; impacted existing tests may be included by exact path only when required by the changed return shape/API/contract.
- Pre-Bridge repair: initial Worker and repair attempts run in separate fresh jobs, with bounded state transfer through artifacts and at most two repair attempts.
- Trust model: IMPLEMENT/FIX workers are untrusted; worker output is a candidate artifact.
- Trusted Rail: exact-SHA/provenance validation is preserved.
- Final merge: Human-only. Auto Merge is prohibited.
