export function needsHumanOutputPlanContext(requirement: string): boolean {
  const lower = requirement.toLowerCase();

  const koreanOutputIntent =
    /(표시|보여주|안내|문구|메시지|댓글|코멘트)/.test(requirement);
  const englishOutputIntent =
    /\b(user-facing|human-facing|display|show|render|message|comment|next action)\b/.test(lower);

  return koreanOutputIntent || englishOutputIntent;
}

export function planImpactTestScopeGuidance(): string {
  return "Context Pack에 기존 테스트가 있고 그 테스트가 변경 대상의 반환 shape/API/contract를 정확히 검증한다면 영향 여부를 확인하세요. 수정이 실제로 필요할 때만 그 기존 테스트의 exact path를 implementationScope.allowedPaths에 포함하고, 무관한 테스트로 범위를 넓히지 마세요.";
}
