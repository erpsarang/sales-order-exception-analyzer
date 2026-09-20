/**
 * Canonical Execution Lineage — Step 1A public surface.
 *
 * 이 모듈은 아직 어떤 workflow/handler에서도 사용되지 않는다.
 * 기존 provenance/digest/판정은 그대로이며, 후속 단계에서 소비자를 하나씩 옮긴다.
 */
export * from "./constants.js";
export * from "./sources.js";
export * from "./base.js";
export * from "./drift.js";
export * from "./provenance.js";
