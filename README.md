# Sales Order Exception Analyzer

주문·고객·자재·재고·납기 정보를 함께 보아 **출고 가능 주문과 예외 주문을 구분하고, 사람이 먼저 확인해야 할 주문과 조치 포인트를 보여 주는 의사결정 지원 App**입니다.

현재 제품은 단순한 정상/예외 분류를 넘어 CSV 업로드, 기준 데이터 결합, Batch 요약, 예외 우선순위, 조치 안내, 예외 CSV 다운로드까지 제공합니다. 다만 아직 **주문 간 재고를 누적 배분하는 ATP 엔진은 아닙니다.**

> 현재 제품 단계: **Exception Detection**
>
> 제품 방향: **Exception Detection → Fulfillment Risk Prediction → Decision Support**

---

## 1. 현재 구현된 기능

### 주문 예외 판정

주문마다 다음 사유를 모두 확인합니다.

| Reason Code | 조건 | 기본 조치 방향 |
| --- | --- | --- |
| `INVALID_QUANTITY` | `orderQuantity <= 0` | 주문수량과 단위를 확인하고 양수로 정정 |
| `CUSTOMER_BLOCKED` | 고객이 차단 상태 | 차단 사유와 해제 요건 확인 |
| `MATERIAL_BLOCKED` | 자재가 차단 상태 | 차단 사유와 해제 요건 확인 |
| `INSUFFICIENT_STOCK` | `availableQuantity < orderQuantity` | 가용재고와 부족 수량 확인 |

예외가 하나도 없으면 `SHIP_READY`, 하나 이상이면 `EXCEPTION`입니다. 한 주문에 여러 예외가 동시에 존재할 수 있으며 각 사유별 확인 사항과 조치 안내를 함께 반환합니다.

### Batch 분석과 작업 순서

여러 주문을 한 번에 분석하여 다음 정보를 제공합니다.

- 전체 / 정상 / 예외 건수와 예외율
- 예외 사유별 건수와 최다 사유
- 주문별 판정 결과
- 예외 주문 작업 목록
- 예외 우선순위

현재 예외 우선순위는 **유효한 납기일이 빠른 주문 → 유효한 예상금액이 큰 주문 → 원래 입력 순서** 기준입니다.

### Web UI

브라우저에서 CSV를 선택하여 분석할 수 있습니다.

현재 화면에서 확인할 수 있는 내용은 다음과 같습니다.

- 전체 / 정상 / 예외 건수
- 예외율, 사유별 건수, 최다 사유
- 예외 주문의 자재, 수량, 가용재고, 부족 수량, 거래처, 예상금액, 납기일, 주문 코멘트
- 각 예외 사유의 확인 사항과 조치 안내
- 분석에 실제 사용한 기준값과 기준 데이터 출처
- 예외 주문 CSV 다운로드

### CSV 양식

Web UI에서 두 종류의 주문 CSV 양식을 내려받을 수 있습니다.

1. **주문 단독용 CSV 양식**  
   주문에 `availableQuantity`, `customerBlocked`, `materialBlocked`를 직접 입력하는 방식입니다.

2. **기준 CSV 업로드용 주문 양식**  
   주문에는 업무 필드만 넣고, 고객 기준 CSV와 자재/재고 기준 CSV를 별도로 업로드하는 방식입니다.

두 양식의 데이터는 예제이므로 실제 업무에서는 주문 및 기준값을 교체해야 합니다.

### 기준 데이터 누락 점검 API

코어 로직에는 `preflightCsvUploadReferences()`가 구현되어 있습니다. 주문 전체를 확인하여 누락된 고객 / 자재 / 재고 기준을 다음 정보와 함께 한 번에 수집할 수 있습니다.

- 주문 위치
- 주문번호
- 누락 기준 종류(`customer`, `material`, `inventory`)
- 누락 식별자

현재 Web UI의 일반 업로드 흐름은 이 집계 결과를 별도 수정 화면으로 보여 주지는 않습니다. Web UI는 CSV 또는 기준 오류를 메시지로 표시하며, **여러 누락 기준을 한 번에 수정하는 전용 화면은 향후 개선 대상**입니다.

### CLI

JSON 또는 직접 판정 기준을 포함한 주문 CSV를 CLI에서도 분석할 수 있습니다.

CLI 출력에는 Batch 요약, 주문별 결과, 예외 처리 순서와 조치 안내가 포함됩니다. 선택적으로 예외 주문 CSV를 파일로 저장할 수 있습니다.

---

## 2. 설치와 실행

CI 검증 환경은 **Node.js 22**를 사용합니다. 로컬에서도 Node.js 22 사용을 권장합니다.

```bash
git clone https://github.com/erpsarang/sales-order-exception-analyzer.git
cd sales-order-exception-analyzer
npm ci
```

### 테스트

```bash
npm test
```

`npm test`는 먼저 TypeScript/Vite 빌드를 수행한 뒤 테스트를 실행합니다.

### 빌드

```bash
npm run build
```

### 로컬 Web UI

현재 `package.json`에는 별도 `dev` script가 없으므로 설치된 Vite를 직접 실행합니다.

```bash
npx vite
```

터미널에 표시되는 로컬 주소를 브라우저에서 열어 사용합니다.

### CLI

JSON 또는 직접 판정 기준이 포함된 CSV:

```bash
npm run analyze -- orders.json
npm run analyze -- orders.csv
```

예외 주문 CSV도 저장하려면:

```bash
npm run analyze -- orders.csv --csv exceptions.csv
```

CLI의 CSV 입력은 주문 안에 직접 판정 기준이 포함된 형식입니다. 고객 기준 CSV + 자재/재고 기준 CSV를 결합하는 3-file 분석은 현재 Web UI / 프로그래밍 API 경로를 사용합니다.

---

## 3. CSV 사용 방법

### 공통 주문 필드

| 필드 | 필수 여부 | 설명 |
| --- | --- | --- |
| `orderId` | 필수 | 주문 식별자 |
| `customerId` | 필수 | 고객 식별자 |
| `materialId` | 필수 | 자재 식별자 |
| `orderQuantity` | 필수 | 주문수량, 유한한 숫자 |
| `estimatedAmount` | 선택 | 예상금액, 숫자 |
| `dueDate` | 선택 | 납기일 문자열. 우선순위에서 유효한 `YYYY-MM-DD`를 사용 |
| `orderComment` | 선택 | 주문 코멘트 |

식별자는 자동으로 trim하거나 대소문자를 정규화하지 않습니다. 기준 CSV의 ID와 **정확히 일치**해야 합니다.

### 방식 A — 주문 CSV에 판정 기준을 직접 포함

주문 CSV에 다음 세 필드를 모두 포함합니다.

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `availableQuantity` | 필수 | 현재 주문 판정에 사용할 가용재고 |
| `customerBlocked` | 필수 | `true` / `false` |
| `materialBlocked` | 필수 | `true` / `false` |

예:

```csv
orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate,orderComment
SO-1001,C-001,M-001,10,20,false,false,1500000,2026-10-01,정상 주문
SO-1002,C-002,M-002,50,20,true,false,3200000,2026-09-30,확인 필요
```

직접 판정 필드는 세 개를 **모두 넣거나 모두 빼야 합니다.** 일부만 넣은 CSV는 필수 필드 오류로 처리됩니다.

### 방식 B — 주문 + 고객 기준 + 자재/재고 기준 CSV

주문 CSV에는 기본 주문 필드만 넣습니다.

```csv
orderId,customerId,materialId,orderQuantity,estimatedAmount,dueDate,orderComment
SO-1001,C-001,M-001,10,1500000,2026-10-01,정상 주문
SO-1002,C-002,M-002,50,3200000,2026-09-30,확인 필요
```

고객 기준 CSV:

```csv
customerId,customerBlocked
C-001,false
C-002,true
```

자재/재고 기준 CSV:

```csv
materialId,materialBlocked,availableQuantity
M-001,false,20
M-002,false,20
```

Web UI에서 세 파일을 함께 선택합니다.

- 고객 기준 필수 열: `customerId`, `customerBlocked`
- 자재/재고 기준 필수 열: `materialId`, `materialBlocked`, `availableQuantity`
- Boolean 값은 소문자 `true` / `false`만 허용합니다.
- 고객/자재 식별자가 주문 CSV와 정확히 일치해야 합니다.
- 기준 CSV 하나만 올리는 방식은 지원하지 않습니다. 두 기준 CSV가 모두 필요합니다.

### 방식 C — 내장 로컬 예제 기준

직접 판정 열 없이 주문 CSV만 선택하면 Web UI는 내장된 로컬 예제 기준을 사용할 수 있습니다.

현재 내장 예제는 다음 ID를 중심으로 한 재현용 데이터입니다.

- 고객: `C-1`, `C-2`
- 자재: `M-1`, `M-2`

이 방식은 **운영 데이터가 아니라 데모/재현용**입니다. 실제 업무 분석에는 방식 A 또는 방식 B를 사용하세요.

---

## 4. 결과 해석

### 상태

- `SHIP_READY`: 현재 주문에 적용된 기준값으로 예외 사유가 발견되지 않음
- `EXCEPTION`: 하나 이상의 예외 사유가 발견됨

`SHIP_READY`는 실제 출고를 보장하는 ATP 확약이 아닙니다. 현재 입력된 기준값에 대해 정의된 네 가지 예외가 없다는 의미입니다.

### 부족 수량

Web UI는 `INSUFFICIENT_STOCK` 주문에 대해 다음 방식으로 부족 수량을 표시합니다.

```text
부족 수량 = orderQuantity - availableQuantity
```

### 예외 처리 순서

예외 작업 목록은 현재 다음 순서로 정렬됩니다.

1. 유효한 납기일이 있는 주문 우선
2. 납기일 오름차순
3. 같은 조건이면 유효한 예상금액이 있는 주문 우선
4. 예상금액 내림차순
5. 마지막으로 원래 입력 순서

이 우선순위는 **업무 조치 순서를 돕기 위한 정렬 기준**이며 재고를 실제로 예약하거나 차감하지 않습니다.

### 예외 CSV

Web UI에서 내려받는 예외 CSV에는 가용재고와 부족 수량이 포함됩니다.

CLI의 `--csv` 출력은 기존 호환 형식을 유지하며 주문번호, 자재, 수량, 거래처, 예상금액, 납기일, 주문 코멘트, 예외 사유를 기록합니다.

---

## 5. 현재의 중요한 한계

### 주문 간 재고를 누적 차감하지 않음

현재 `availableQuantity`는 **각 주문을 독립적으로 판정**할 때 사용됩니다.

예를 들어 같은 자재의 현재고가 100이고 주문이 다음과 같더라도:

| 납기 | 주문수량 |
| --- | ---: |
| 9/28 | 30 |
| 9/29 | 50 |
| 10/1 | 40 |

현재 로직은 앞 주문이 사용한 30, 50을 다음 주문의 재고에서 차감하지 않습니다. 따라서 "어느 주문/어느 납기부터 공급이 어려워지는가"를 아직 계산하지 못합니다.

### 완전한 ATP 엔진이 아님

현재 제품은 다음 공급 정보를 종합하지 않습니다.

- 입고 예정
- 구매계획
- 생산계획
- 재고 예약/할당
- 공급 우선순위 정책

따라서 결과는 **현재 입력 기준에 대한 예외 탐지와 업무 판단 지원**으로 해석해야 합니다.

### Web UI의 누락 기준 보정 흐름

여러 누락 기준을 한 번에 수집하는 preflight 코어 로직은 있지만, 현재 Web UI는 이를 사용자가 한 화면에서 수정하는 전용 workflow로 제공하지 않습니다.

---

## 6. 프로그래밍 API

### 단건 분석

```typescript
import { analyzeOrder } from "./src/order-analysis.js";

const result = analyzeOrder({
  orderId: "SO-001",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 5,
  customerBlocked: true,
  materialBlocked: false,
});
```

### Batch 분석

```typescript
import { analyzeOrderBatch } from "./src/batch-order-analysis.js";

const batch = analyzeOrderBatch(orders);
```

### 업로드 기준 사전 점검

```typescript
import { preflightCsvUploadReferences } from "./src/order-csv.js";

const result = preflightCsvUploadReferences(orderCsv, provider);
```

`status === "missing-references"`이면 모든 누락 항목을 확인할 수 있고, `status === "ready"`이면 기준 보강이 완료된 주문을 분석에 사용할 수 있습니다.

---

## 7. 제품 비전

이 프로젝트의 방향은 단순히 예외 코드를 더 많이 만드는 것이 아닙니다.

### 현재 — Exception Detection

- 주문별 출고 예외 탐지
- 원인과 조치 안내
- Batch 요약과 작업 우선순위
- 주문/고객/자재/재고 기준 결합

### Next — Fulfillment Risk Prediction

가까운 다음 단계는 **같은 `materialId` 주문들을 납기일 순으로 보면서 현재 가용재고를 누적 배분**하는 것입니다.

목표는 다음 질문에 답하는 것입니다.

> "현재 재고를 납기순으로 배분하면 어느 주문, 어느 납기부터 공급이 어려워지는가?"

첫 단계에서는 현재 `availableQuantity`만 사용하여 작게 시작하고, 이후 필요할 때 입고예정·구매·생산계획을 추가합니다.

### Vision — Decision Support

장기적으로는 예외 목록 자체보다 다음 판단을 돕는 제품을 지향합니다.

- 무엇을 먼저 확인해야 하는가?
- 어느 고객/자재/납기가 가장 위험한가?
- 재고 확보, 수량 조정, 차단 해제 등 어떤 조치가 필요한가?
- 공급 상황이 바뀌면 어떤 주문의 위험이 달라지는가?

즉 제품의 진화 방향은 다음과 같습니다.

**Exception Detection → Fulfillment Risk Prediction → Decision Support**

---

## 8. 개발 원칙

이 App은 AI Development Framework를 이용해 점진적으로 개선하고 있습니다.

- 제품 변경은 작은 단위로 진행
- IMPLEMENT/FIX 결과는 검증 전까지 candidate artifact
- exact SHA / provenance 기반 검증
- 최종 Merge는 Human-only
- Auto Merge 금지

README의 **현재 구현(Implemented)** 과 **미래 방향(Next / Vision)** 을 의도적으로 분리합니다. 구현되지 않은 기능을 현재 기능처럼 설명하지 않습니다.
