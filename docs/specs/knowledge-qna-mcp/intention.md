---
title: Knowledge QnA MCP 요구사항 문서 (Intention)
status: Draft
approval: pending
---

# Knowledge QnA MCP 요구사항 문서 (Intention)

## 1. 목적과 문서의 효력

Knowledge QnA MCP는 AI coding agent가 등록된 공식 기술 문서에서 근거를 찾도록, 버전과 출처를 확인할 수 있는 문서 context를 MCP로 제공한다. 대표 사용 흐름은 “Palantir Foundry의 Object Type 생성 문서를 찾아줘” → library 확인 → 관련 문서와 코드 예제 반환이다.

제품명에 QnA가 포함되어도 V1의 결과물은 **문서 발췌와 출처**다. 답변의 작성·추론은 호출한 agent의 책임이다. 제품 이름 변경은 일반 지식 검색, 대화 기록 저장, 자체 답변 생성으로 범위를 확장하지 않는다.

이 문서는 사용자 가치, 지원 범위, 관찰 가능한 완료 조건의 기준이다. [설계 문서](./design.md)는 이를 실현할 데이터·API·패키지 계약과 검증 방법을 정의한다. 충돌이 발견되면 구현자가 한쪽을 임의로 선택하지 않고 두 문서를 먼저 일치시킨다.

현재는 두 문서만 있는 신규 프로젝트다. 아래 동작은 구현 요구사항이며 구현·실서비스 검증을 마쳤다는 주장이 아니다. 이번 검토에서 추가한 기본값과 설계 선택도 문서별 승인 대상이다.

## 2. 사용자와 사용 흐름

| 사용자 | 필요한 결과 | 성공의 관찰 방법 |
| --- | --- | --- |
| Codex·Claude Code 등 MCP client | 특정 library/version의 공식 근거 | 두 공개 tool을 통해 출처 있는 context를 받는다 |
| 운영자 | 문서 수집과 검색 반영 상태를 구분 | sync 완료와 index 게시 완료를 CLI에서 따로 확인한다 |
| backend 교체 담당자 | 원문 사이트·Google export 없이 검색 재구축 | 보존한 corpus로 다른 adapter를 색인하고 같은 공개 계약을 호출한다 |

정상 흐름은 `resolve_library` → `get_context`다. 이미 정확한 library ID를 아는 client는 바로 `get_context`를 호출할 수 있다. 조회 요청은 등록 변경·수집·색인·외부 웹 탐색을 시작하지 않는다.

## 3. 책임과 범위

V1 core에 포함하는 기능은 다음과 같다.

- 운영자가 검토한 공식 공개 HTML documentation library 등록
- 명시된 sitemap 또는 static URL 목록의 수집과 정규화
- heading·목록·표·코드의 구조를 보존한 Markdown과 chunk 생성
- 문서 내용 이력, 제품 버전, 마지막 확인 시각의 구분
- 로컬 filesystem corpus와 SQLite 운영 manifest
- Google Agent Search를 이용한 색인과 검색
- stdio MCP의 `resolve_library`, `get_context`
- context 예산, 출처 연결, 오류 계약, 운영 CLI와 retrieval 평가

`ask_docs`와 Streamable HTTP는 선택 확장으로 남긴다. V1 core의 설치·시작·tool 목록·완료 조건에 포함하지 않고, 추가할 때 별도 계약을 정한다. 미사용 answer adapter나 HTTP 인증 구조를 V1에서 선행 구현하지 않는다.

V1은 공개 HTML 문서만 지원한다. PDF·영상·로그인 문서·JavaScript 실행이 필요한 페이지·private ACL·generic internet search·사용자 문서 업로드·Web UI·대화 상태·agent planning은 제외한다. Google 검색 외에 embeddings API, Gemini 직접 생성, Vector Search, RAG Engine, Agent Engine, GraphRAG, LangChain, Cloud SQL, BigQuery를 필수 의존성으로 추가하지 않는다.

배포 단위는 단일 운영자/신뢰 영역의 host-local package다. 여러 MCP client process는 같은 corpus를 읽을 수 있지만 network filesystem, 분산 writer, multi-tenant 서비스는 V1 지원 범위가 아니다.

## 4. 핵심 원칙과 용어

| 용어 | 의미 |
| --- | --- |
| Library | 하나의 공식 documentation 제품군 |
| `versionKey` | 제품 문서의 버전 이름. explicit 버전 또는 rolling 문서의 `current` |
| Document snapshot | 한 URL의 정규화된 내용 상태. 제품 버전이나 수집 실행 ID와 다르다 |
| Corpus revision | library/version 전체의 문서 snapshot과 chunk 참조를 고정한 목록 |
| Index generation | 한 corpus revision을 특정 backend에 게시하기 위해 만든 검색 세대 |
| Published generation | 새 조회가 선택하는 검색 세대 |
| Freshness | 원격 문서를 마지막으로 확인한 시각. “지금 원격 사이트와 동일함”을 보장하지 않는다 |

정규화 문서와 corpus revision 목록을 canonical 데이터로 보존한다. Chunk와 Google index는 파생물이다. SQLite는 게시 pointer와 실행 상태의 authority이며, Google 결과를 canonical 본문으로 역수입하지 않는다.

이식성은 “같은 corpus와 MCP 계약으로 backend를 교체할 수 있음”을 뜻한다. backend별 순위·지연·요금·tokenizer가 동일하다는 뜻은 아니다. 실제 교체에는 새 adapter, 재색인과 평가가 필요하며 설정 한 줄만 바꾸면 미구현 backend가 작동한다고 약속하지 않는다.

## 5. 기능 요구사항

### I-001. Library 식별과 버전

Registry는 stable ID, 이름, aliases, 명시적 기본 버전, 버전별 source 설정을 갖는다. resolution은 로컬 문자열 규칙으로 결정하며 LLM을 호출하지 않는다.

모호한 이름은 후보와 함께 `AMBIGUOUS_LIBRARY`를 반환한다. 알 수 없는 library/version을 다른 값으로 대체하지 않는다. 생략한 version은 registry에 선언된 기본값을 사용하며 문자열 정렬로 최신 버전을 추측하지 않는다.

### I-002. 수집 범위와 원격 접근

운영자가 허용한 host·path·source만 수집한다. Sitemap index는 중첩·중복·순환·수집 상한을 처리한다. Redirect와 canonical link에도 같은 범위 검사를 적용한다.

Robots 정책과 source별 수집 허용 여부를 확인한다. JavaScript shell, 로그인 페이지, 차단 응답을 정상 문서로 저장하지 않는다. 제한 도달·discovery 실패·parse 실패를 정상 완료나 문서 삭제로 취급하지 않는다.

### I-003. 변경 확인과 정규화

유효한 기존 본문이 있으면 conditional GET의 304를 변경 없음으로 처리한다. 200 응답은 원본 body hash와 정규화 결과를 구분해 기록한다.

본문과 처리 profile이 동일하면 정규화·chunk 생성을 반복하지 않는다. Normalizer 또는 chunker/tokenizer 설정이 바뀌면 필요한 단계부터 재처리한다. 본문이 바뀌지 않았어도 마지막 성공 확인 시각은 갱신한다.

### I-004. Canonical Corpus와 복원

Snapshot·chunk ID는 같은 입력에 대해 재현 가능해야 한다. 기존 snapshot을 덮어쓰지 않고 새 상태를 별도 보존한다.

Corpus revision은 변경되지 않은 문서도 포함한 전체 membership을 보존한다. 선택한 revision의 문서, 처리 profile, registry 사본만으로 chunk 재생성과 새 backend 색인이 가능해야 한다. 원본 HTML cache가 없어도 이 복원은 가능해야 한다.

### I-005. 수집과 검색 게시의 분리

`sync` 성공은 로컬 corpus revision 생성/확인을 뜻한다. `index` 성공은 그 revision의 검색 게시 완료를 뜻한다. 수집이 성공하고 색인이 실패한 상태를 별도로 보고한다.

게시 전 실패는 이전 게시 pointer와 검색 데이터를 변경하지 않는다. 조회 한 번은 시작 시 선택한 하나의 generation만 사용하며 이전·신규 문서 세대를 혼합하지 않는다.

V1 수집은 incremental이다. V1 검색 게시에는 전체 generation을 준비하는 방식을 사용한다. 따라서 한 문서 변경도 전체 검색 entry 업로드를 유발할 수 있다. 이 추가 비용은 일관성 보장을 위한 설계 선택이며 변경 chunk만 원격 전송한다는 보장은 하지 않는다.

### I-006. 삭제·재시도·동시 실행

삭제는 성공적으로 끝난 전체 discovery에서 빠진 URL 또는 확인된 404/410을 근거로 판단한다. 일시적인 누락을 줄이기 위한 확인 규칙을 설계 문서에 고정한다.

문서 삭제는 새 게시 generation의 검색 범위에서 제외하는 것으로 먼저 반영한다. 이전 generation의 물리 삭제는 게시와 별도이며 진행 중 조회와 복구용 generation을 보호해야 한다.

같은 작업을 재실행해 중복 ID·중복 게시를 만들지 않는다. 동시 writer는 저장소 수준에서 직렬화하고, crash·partial import·timeout 뒤 실행 상태를 확인해 재개한다.

### I-007. 코드·표·큰 문서 처리

Heading context와 코드의 줄바꿈·들여쓰기·언어 표시는 보존한다. 코드 블록을 의미 없는 조각으로 자르지 않는다.

설정된 chunk 목표 크기는 일반적인 분할 기준이다. 하나의 코드·표 블록이 목표 상한보다 큰 경우의 보존/오류 규칙은 별도로 적용한다. 큰 블록 때문에 본문을 조용히 유실하거나 반환 token 예산을 초과해서는 안 된다.

### I-008. 검색 격리와 본문 검증

검색은 명시된 library, version, published generation 안에서만 실행한다. 잘못된 filter나 backend 오류를 무필터 검색으로 재시도하지 않는다.

Backend는 후보 ID와 순위를 제공한다. 반환 본문과 citation은 로컬 canonical chunk에서 읽고 해당 generation membership을 검증한다. 관련 결과 없음과 corpus 미게시, 저장소 손상, backend 장애는 서로 다른 상태다.

### I-009. MCP 공개 도구

V1 core의 `tools/list`는 `resolve_library`, `get_context` 정확히 두 개다. 운영 명령은 MCP tool로 노출하지 않는다.

입출력에는 machine-readable schema를 제공한다. 안정된 성공·오류 형태와 input 한계, 기본값은 설계 문서에서 정의한다. stdio의 stdout에는 MCP protocol만 기록한다.

### I-010. Context와 출처

반환 context의 발췌마다 source ID를 연결하고 title, 공식 URL, heading path, 문서 snapshot 식별자와 마지막 확인 시각을 함께 반환한다.

공식 URL은 원격의 현재 페이지를 가리키며 과거 snapshot을 호스팅하는 링크로 오해하게 표시하지 않는다. 사용된 source만 반환하고, backend snippet이나 생성된 문장을 공식 원문처럼 제공하지 않는다.

### I-011. Token 예산과 검색 결과 없음

`maxTokens`의 적용 대상과 tokenizer를 공개한다. V1은 반환 `context` 문자열의 예산을 보장하며 JSON metadata·MCP envelope·client prompt 전체의 token 수는 별도다.

빈 검색 결과는 정상 `no_matches`다. 관련 chunk는 있으나 예산 안에 온전한 발췌를 하나도 담을 수 없으면 `TOKEN_BUDGET_EXCEEDED`를 반환한다. 예산에 맞춰 일부 결과를 생략한 경우 그 사실을 표시한다.

### I-012. 선택 확장

`ask_docs`는 후속 답변 생성 기능 후보이며 core contract의 선행조건이 아니다. 정확한 API, 지원 상태, citation 검증, 데이터 전송·비용 정책을 확인하기 전 V1 필수 package나 milestone에 넣지 않는다.

### I-013. 운영 CLI

기존 명령 이름 `docsctx`를 유지한다. 제품명 변경은 CLI rename을 뜻하지 않는다.

| 명령 | 관찰 가능한 효과 |
| --- | --- |
| `docsctx sync <libraryId>` | 원격 수집과 로컬 revision 완성. 검색 게시 없음 |
| `docsctx index <libraryId>` | 완성된 로컬 revision을 backend에 게시. 원격 수집 없음 |
| `docsctx sync <libraryId> --index` | 두 작업을 순서대로 실행하고 각각의 결과 보고 |
| `docsctx search <libraryId> <query>` | MCP와 같은 retrieval 결과 확인 |
| `docsctx eval` | 고정 fixture 평가. 원격 모드는 명시적으로 선택 |
| `docsctx serve` | stdio MCP 시작 |
| `docsctx doctor` | 설정·저장소·backend 준비 상태의 읽기 전용 진단 |

세부 flag, 종료 코드, 비동기 작업 재개 및 유지보수 계약은 설계 문서를 따른다.

### I-014. 설정·credential·외부 전송

실제 source 문서 body와 사용자 query가 Google backend에 전달될 수 있음을 운영 설정에 명시한다. Google 연결은 비용·quota·IAM 설정이 갖추어진 환경에서만 사용한다.

Credential은 ADC로 제공한다. Service account key 파일을 사용하는 경우도 repository 밖의 파일을 ADC가 참조하는 방식이며 별도의 자동 fallback 탐색을 만들지 않는다. 로그·MCP 오류·진단에 credential이나 원문 query를 노출하지 않는다.

수집 문서는 신뢰되지 않은 데이터다. 문서 안의 instruction·script를 실행하거나 agent 권한 지시로 승격하지 않는다.

### I-015. 운영 한계와 복구

작업마다 요청·시간·본문 크기·저장 공간 상한을 둔다. 상한에 걸리면 부분 완료를 숨기지 않고 기존 게시 세대를 유지한다. 원격 retry는 횟수와 총시간을 제한한다.

Freshness가 기준을 넘으면 마지막 게시 데이터를 freshness 표시와 함께 제공한다. 새 원격 확인에 실패했는데도 최신이라고 표시하지 않는다. Backend 장애 시 자동으로 다른 provider나 internet search로 전환하지 않는다.

### I-016. 평가와 호환성

Golden query의 정답 단위는 문서 URL/선택적 heading이며, 검색 순위 지표와 최종 context의 정답 포함률을 따로 측정한다. Recall·MRR·nDCG를 계산할 수 있는 명시적 relevance label을 사용한다.

같은 corpus revision·평가 dataset·tokenizer·packing profile을 사용해 backend 간 차이를 비교한다. 일반 CI는 offline 검증을 수행하며 실제 Google 색인·검색·실제 MCP client 연결은 별도 live 검증으로 증명한다.

## 6. 완료 조건과 검증 연결

아래 항목 모두가 V1 core 완료 조건이다. 세부 시나리오는 [설계 문서 §12](./design.md#12-검증-시나리오와-완료-판정)에 대응한다.

| ID | 완료 조건 | 주요 검증 |
| --- | --- | --- |
| A-01 | registry의 정확·모호·미등록 이름 및 명시적 버전 처리 | T-01 |
| A-02 | 최소 1개 실제 공식 library에서 허용된 HTML 수집 | T-02, B0 |
| A-03 | 304·동일 200·profile 변경의 재처리 구분 | T-03 |
| A-04 | 코드·표·큰 블록이 규칙대로 보존/보고됨 | T-04 |
| A-05 | 부분 discovery가 문서 삭제를 유발하지 않음 | T-05 |
| A-06 | sync만으로 검색 게시가 바뀌지 않음 | T-06 |
| A-07 | 갱신·partial import·crash에도 generation이 혼합되지 않음 | T-07, T-08 |
| A-08 | 필터 격리·본문 hash·citation membership 검증 | T-09 |
| A-09 | 두 MCP tool, 정상 빈 결과, 오류, stdout 규칙 확인 | T-10 |
| A-10 | 명시한 tokenizer로 context 예산과 citation 대응 보장 | T-11 |
| A-11 | corpus만으로 재생성·다른 adapter 계약 실행 | T-12 |
| A-12 | 실제 Google 검색 게시와 고정 fixture 평가 통과 | T-13, B0 |
| A-13 | 권한·진단·동시 실행·유지보수 경계 확인 | T-14, T-15 |
| A-14 | 요구사항→설계→검증이 연결되고 실제 MCP client 1종 연결 성공 | T-10, §12 |

초기 retrieval 기준값과 resource limit은 설계 문서의 V1 기본값을 적용한다. 목표 미달을 baseline이라는 이름으로 자동 승인하지 않는다.

## 7. 승인

이 문서는 Knowledge QnA MCP 요구사항 문서 (Intention)에 대한 승인을 기다린다. 설계 문서 승인과 별개이며 이 문서의 승인만으로 구현·배포를 시작하지 않는다.
