# AI Development Framework

This repository is bootstrapped with AI Development Framework MVP v0.1.

- Source repository: `erpsarang/self-improvement-mvp`
- Framework tag: `v0.1`
- Framework source SHA: `9457926df28a88aa8fe340ad657c52e9f4f43f70`
- Trust model: IMPLEMENT/FIX workers are untrusted; worker output is a candidate artifact.
- Trusted Rail: SEAL → PUBLISH → VERIFY → Semantic REVIEW.
- Verification: exact published SHA.
- LOCAL_FIX: bounded loop.
- Final merge: Human-only. Auto Merge is prohibited.

Framework control-plane files under `.github/workflows`, `src/self-improvement`, and `policy`
are infrastructure. Application feature work must not modify them unless a separate trusted
control-plane change is explicitly authorized.
