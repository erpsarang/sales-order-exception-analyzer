# Sales Order Exception Analyzer

주문·고객·자재·재고·납기 정보를 함께 보아 **출고 가능 주문과 예외 주문을 구분하고, 사람이 먼저 확인해야 할 주문과 조치 포인트를 보여 주는 의사결정 지원 App**입니다.

현재 제품은 단순한 정상/예외 분류를 넘어 CSV 업로드, 기준 데이터 결합, Batch 요약, 예외 우선순위, 조치 안내, 예외 CSV 다운로드까지 제공합니다. 같은 자재의 주문은 납기순으로 현재 가용재고를 누적 배분해 **공급 위험 주문**도 알려 줍니다. 다만 입고 예정·구매·생산계획을 반영하는 **완전한 ATP 엔진은 아닙니다.**

> 현재 제품 단계: **Exception Detection** + **Fulfillment Risk Prediction의 첫 단계(현재 재고 누적 배분)**
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

### 누적 재고 배분과 공급 위험

계산은 `src/batch-order-analysis.ts`의 `allocateStock()`에서 수행하며, 결과는 `analyzeOrderBatch().stockAllocations`에 담깁니다.

- **배분 단위와 순서**
  - 같은 `materialId`의 주문끼리 묶습니다.
  - 그 자재의 `availableQuantity`를 납기일(`dueDate`)이 빠른 순으로 차례로 배분합니다.
  - 납기일이 같으면 원래 입력 순서를 따릅니다.
- **주문별 결과**
  - 각 주문에 배분 가능 수량, 배분 수량, 남은 재고, 부족 수량을 계산합니다.
  - 부족 수량이 0보다 크면 공급 위험 주문입니다.
  - 차단된 주문도 수요에 포함하며, 주문별 정상/예외 판정과는 별개로 계산합니다.
- **계산 불가 (`UNABLE_TO_CALCULATE`)**
  - 아래 중 하나라도 해당하면 **그 자재 전체를 계산 불가**로 둡니다.
    - 가용재고가 음수이거나 숫자가 아닌 경우
    - 같은 자재 주문끼리 `availableQuantity` 값이 서로 다른 경우
    - 납기일이 없거나 수량이 0 이하여서 제외하고 나니 그 자재에 유효 주문이 하나도 남지 않는 경우 (예: 주문 CSV에 `dueDate` 열이 없는 경우)
  - **일부 주문만 제외**: 납기일이 없거나 올바른 `YYYY-MM-DD`가 아닌 주문, 주문수량이 0 이하인 주문은 그 주문만 배분에서 제외하고, 같은 자재의 나머지 유효 주문은 현재 가용재고로 납기순 누적 배분합니다. 빠진 납기일은 추정하거나 채우지 않습니다. 제외된 주문은 그 자재 결과(`CALCULATED`)의 `excludedOrders`에 입력 행 번호(`resultIndex`), 주문번호, 제외 사유(`INVALID_DUE_DATE`, `INVALID_QUANTITY`)와 함께 남습니다. 제외 주문이 없으면 이 필드는 없습니다. 화면은 그 자재의 배분 표 바로 아래에 "일부 주문 제외: N건" 안내와 제외한 주문 표(입력 행 번호, 주문번호, 제외 사유)를 보여 주고, 공급 위험 요약에는 일부 주문을 제외하고 계산한 자재 수와 제외된 주문이 공급 위험 건수에 포함되지 않는다는 안내를 표시합니다. 입력 행 번호는 헤더를 뺀 주문 행 기준 1부터 셉니다.
  - 화면은 계산 불가 자재를 "배분 계산 불가 자재: N건"으로 따로 표시합니다. 공급 위험 건수는 계산 가능한 자재의 주문만 셉니다.

### Web UI

브라우저에서 CSV를 선택하여 분석할 수 있습니다.

현재 화면에서 확인할 수 있는 내용은 다음과 같습니다.

- 전체 / 정상 / 예외 건수
- 예외율, 사유별 건수, 최다 사유
- 예외 주문의 자재, 수량, 가용재고, 부족 수량, 거래처, 예상금액, 납기일, 주문 코멘트
- 각 예외 사유의 확인 사항과 조치 안내
- 분석에 실제 사용한 기준값과 기준 데이터 출처
- 예외 주문 CSV 다운로드
- 누락된 기준 데이터가 있으면 `누락된 기준 데이터` 표(입력 행 번호, 주문번호, 기준 종류, 식별자)를 보여 주고 분석을 멈춤
- `공급 위험 (누적 재고 배분)` 영역
  - 공급 위험 건수 (`공급 위험: N건`)
  - 첫 공급 위험 주문 (주문번호, 입력 행 번호, 납기, 부족량)
  - `공급 위험 주문` 표
    - 열: 주문번호, 자재, 거래처, 납기일, 주문수량, 부족수량, 예상금액
    - 정렬: 납기일이 빠른 순 → 예상금액이 큰 순(금액이 없으면 뒤로) → 입력 순서
  - 일부 주문을 제외하고 계산한 자재 수 (`일부 주문을 제외하고 계산한 자재: N건`, 해당 자재가 있을 때만 표시)
  - `공급 위험 CSV 다운로드` 버튼 (공급 위험이 있을 때만 표시)
  - `자재별 현재 재고 배분` 표
    - 일부 주문이 제외된 자재는 표 아래에 `배분에서 제외한 주문` 표(입력 행 번호, 주문번호, 제외 사유)

공급 위험 CSV(`createSupplyRiskCsv`)의 열은 `주문번호`, `자재`, `거래처`, `납기일`, `주문수량`, `부족수량`, `예상금액` 7개이며, 화면의 `공급 위험 주문` 표와 순서가 같습니다.

- 정렬: 납기일이 빠른 순 → 예상금액이 큰 순 → 입력 순서
  - 예상금액이 없거나 유효하지 않으면(음수 등) 빈 칸으로 두고 뒤로 보냅니다.
- 대상 행: 계산 가능한 자재 중 부족수량이 0보다 큰 주문만 포함합니다. 계산 불가 자재의 주문과, 납기일이 없거나 수량이 0 이하여서 배분에서 제외된 주문은 포함되지 않습니다.

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

Web UI는 이 집계 결과를 `누락된 기준 데이터` 표(입력 행 번호, 주문번호, 기준 종류, 식별자)로 한 번에 보여 주고 분석을 멈춥니다. 다만 화면에서 바로 수정하는 기능은 없으며, CSV를 고친 뒤 다시 분석해야 합니다.

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

이 값은 각 주문을 가용재고와 따로 비교한 **주문별 판정**의 부족 수량입니다. `공급 위험 (누적 재고 배분)`의 부족 수량은 같은 자재의 주문을 납기순으로 누적 배분한 결과이므로 서로 다른 개념입니다.

### 예외 처리 순서

예외 작업 목록은 현재 다음 순서로 정렬됩니다.

1. 유효한 납기일이 있는 주문 우선
2. 납기일 오름차순
3. 같은 조건이면 유효한 예상금액이 있는 주문 우선
4. 예상금액 내림차순
5. 마지막으로 원래 입력 순서

이 우선순위는 **업무 조치 순서를 돕기 위한 정렬 기준**이며 재고를 실제로 예약하거나 차감하지 않습니다. 납기순 누적 재고 배분 결과는 예외 작업 목록과 별도로 `공급 위험 (누적 재고 배분)` 영역에서 보여 줍니다.

### 예외 CSV

Web UI에서 내려받는 예외 CSV에는 가용재고와 부족 수량이 포함됩니다.

CLI의 `--csv` 출력은 기존 호환 형식을 유지하며 주문번호, 자재, 수량, 거래처, 예상금액, 납기일, 주문 코멘트, 예외 사유를 기록합니다.

---

## 5. 현재의 중요한 한계

### 완전한 ATP 엔진이 아님

현재 제품은 현재 `availableQuantity`만 사용하며 다음 공급 정보를 반영하지 않습니다.

- 입고 예정
- 구매계획
- 생산계획
- 재고 예약/할당
- 공급 우선순위 정책 (배분 순서는 납기만으로 정하며 고객 우선순위 같은 정책은 없음)

따라서 결과는 **현재 입력 기준에 대한 예외 탐지, 현재 재고 기준 공급 위험 확인과 업무 판단 지원**으로 해석해야 합니다.

### 계산 불가 자재

가용재고가 음수 또는 숫자가 아니거나 같은 자재 주문끼리 가용재고 값이 다르면 그 자재 전체를 계산하지 않습니다. 납기일이 없거나 올바르지 않은 주문, 주문수량이 0 이하인 주문을 제외하고 나서 유효 주문이 하나도 남지 않는 자재도 계산 불가입니다. 계산 불가 자재의 주문은 공급 위험 건수에 포함되지 않습니다. 유효 주문이 남아 있으면 제외된 주문만 빠지고 나머지 주문으로 공급 위험을 계산합니다.

### Web UI의 누락 기준 보정 흐름

Web UI는 누락된 기준을 `누락된 기준 데이터` 표로 한 번에 보여 주지만, 화면에서 바로 수정하는 기능은 없습니다. CSV를 고친 뒤 다시 분석해야 합니다.

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

납기순 누적 재고 배분 결과는 `batch.stockAllocations`로 접근합니다. 기존 Batch 결과의 JSON 출력 키에는 포함되지 않습니다.

### 업로드 기준 사전 점검

```typescript
import { preflightCsvUploadReferences } from "./src/order-csv.js";

const result = preflightCsvUploadReferences(orderCsv, provider);
```

`status === "missing-references"`이면 모든 누락 항목을 확인할 수 있고, `status === "ready"`이면 기준 보강이 완료된 주문을 분석에 사용할 수 있습니다.

---

## 7. 제품 비전

이 프로젝트의 방향은 단순히 예외 코드를 더 많이 만드는 것이 아닙니다.

### 현재 — Exception Detection + 현재 재고 누적 배분

- 주문별 출고 예외 탐지
- 원인과 조치 안내
- Batch 요약과 작업 우선순위
- 주문/고객/자재/재고 기준 결합
- 같은 `materialId` 주문을 납기순으로 현재 `availableQuantity`에서 누적 배분
- 공급 위험 주문 표시와 공급 위험 CSV 다운로드

### Next — Fulfillment Risk Prediction 확장

납기순 누적 재고 배분은 현재 `availableQuantity` 기준으로 이미 구현되어 있습니다. 남은 다음 단계는 입고예정·구매·생산계획을 반영하는 것입니다.

> "현재 재고에 입고예정·구매·생산계획을 더하면 어느 주문, 어느 납기의 공급 위험이 달라지는가?"

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
