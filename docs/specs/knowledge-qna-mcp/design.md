---
title: Knowledge QnA MCP 설계 문서
status: Draft
approval: pending
---

# Knowledge QnA MCP 설계 문서

## 1. 문서의 역할과 설계 상태

[요구사항 문서](./intention.md)의 I-001~I-016을 구현하는 V1 설계다. 현재 존재하는 산출물은 이 두 Markdown 문서이며 아래 package·명령·schema는 구현 대상이다.

원래 의도인 공식 문서 retrieval, canonical corpus 소유, Google backend 교체 가능성은 유지한다. 구현자가 결정해야 했던 갱신·오류·예산·평가의 동작은 이 문서에서 정한다. 기술적 기본값은 이번 검토의 설계 제안이며 사용자 승인 사실로 표현하지 않는다.

| 검토에서 발견한 문제 | 영향 | 이 설계의 처리 |
| --- | --- | --- |
| QnA라는 이름과 retrieval-first의 관계 불명확 | 생성형 답변 서비스로 범위 확대 가능 | core 결과물을 문서 context로 고정 |
| 이전 chunk 삭제 후 rollback을 약속 | 삭제된 원격 데이터를 로컬 transaction으로 복구할 수 없음 | 새 generation 게시 뒤 별도 정리 |
| 문서별 snapshot을 library 전체 filter로 사용 | 변경하지 않은 문서 누락 | 문서 snapshot·corpus revision·index generation 분리 |
| 변경 chunk만 업로드하며 전체 snapshot 격리 보장 | 같은 ID 덮어쓰기·membership 누락 | incremental sync와 전체 generation 색인의 비용을 구분 |
| 304에도 body hash 검사가 필수처럼 표현 | 불필요한 GET과 재처리 | 유효한 cache/기존 snapshot의 304 재사용 |
| code block 분할 금지와 절대 chunk 상한 충돌 | 코드 손상 또는 구현자별 다른 처리 | oversized atomic block 규칙 |
| title/URL substring만으로 Recall·nDCG 주장 | 정답 수와 relevance grade가 없어 지표 의미 불명확 | 문서별 qrels와 context 지표 |
| 미정의 type·normalizer port·source 설정 | 계층 우회, 구체 구현자의 추측 | package 역할 및 입출력 표 명시 |

## 2. V1 설계 선택

- 단일 npm package, TypeScript strict, ESM, Node.js 24 LTS를 기준으로 한다. Package명은 `knowledge-qna-mcp`, 실행 명령은 기존 `docsctx`다. 실제 checkout 이름 `knowledge-qna/`는 변경하지 않는다.
- MCP v2 `@modelcontextprotocol/server`를 사용한다. Transport는 stdio 하나이며 Google SDK는 adapter에서만 import한다.
- Registry·filesystem corpus·SQLite manifest는 host-local이다. 여러 reader와 단일 writer를 지원하고 분산 DB·queue·scheduler를 추가하지 않는다.
- 수집은 incremental, 원격 검색 게시 단위는 library/version **전체 generation**이다. 동일 revision의 재게시가 필요 없으면 index는 no-op이다.
- 정상 게시에는 원격 삭제가 없다. 과거 generation 정리는 별도 CLI 유지보수 작업이다.
- Core에는 answer package·HTTP transport·local 검색 엔진 구현을 포함하지 않는다. 미래 adapter는 아래 계약을 만족해야 한다.

Node.js 24가 LTS이고 20이 EOL인 것은 [공식 release 표](https://nodejs.org/en/about/previous-releases)에서 확인했다. MCP v2의 package 경계는 [공식 SDK 문서](https://ts.sdk.modelcontextprotocol.io/v2/)를 따른다. 확인일은 2026-09-12이며 실제 dependency patch version은 Bootstrap에서 registry 확인 후 lockfile에 고정한다.

## 3. Package 구조와 의존성

~~~text
knowledge-qna/
├── src/
│   ├── domain/
│   │   ├── models/             # library, snapshot, chunk, corpus, generation, search
│   │   ├── identity.ts         # 결정적 ID와 hash 규칙
│   │   └── errors.ts
│   ├── application/
│   │   ├── ports/              # 외부 I/O 및 변환 계약
│   │   ├── library/            # resolve-library
│   │   ├── sync/               # discover, 변경 판정, revision 완성
│   │   ├── indexing/           # stage, import, readiness, publish, resume
│   │   ├── retrieval/          # query, hydrate, dedup, pack
│   │   ├── maintenance/        # 보호된 generation 정리
│   │   └── evaluation/         # qrels, metrics
│   ├── infrastructure/
│   │   ├── config/            # 설정과 library registry loader
│   │   ├── source/            # sitemap, static URLs, robots
│   │   ├── fetch/             # 허용 URL에 대한 HTTP GET
│   │   ├── parsing/           # HTML→Markdown, Markdown AST chunker
│   │   ├── storage/           # filesystem, SQLite, migrations
│   │   ├── search/
│   │   │   └── google-agent-search/ # mapper, search, import, readiness
│   │   ├── tokens/            # 고정 tokenizer
│   │   └── logging/
│   ├── interfaces/
│   │   ├── mcp/               # server factory, schemas, 두 tool
│   │   └── cli/               # argument parsing, 출력, 종료 코드
│   ├── composition/           # command별 dependency 조립
│   └── main.ts                # 실행 entry point
├── config/
│   ├── libraries/
│   └── app.example.yaml
├── schemas/                   # 공용 wire/persistence JSON Schema
├── eval/
│   ├── retrieval.yaml
│   └── fixtures/              # 배포 가능한 작은 synthetic/허용 fixture
├── test/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   └── architecture/
├── docs/specs/knowledge-qna-mcp/
│   ├── intention.md
│   └── design.md
├── var/                       # Git 제외; 아래 §5의 runtime 데이터
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
~~~

의존 방향은 `interfaces → application → domain`, `infrastructure → application/ports + domain`이다. Composition만 구체 adapter를 선택한다. Domain은 Node I/O·Google·MCP SDK에 의존하지 않는다. Application은 infrastructure나 interfaces를 import하지 않는다.

HTML normalizer·chunker·tokenizer도 application port로 주입한다. 따라서 sync service가 `infrastructure/parsing`을 직접 import할 이유가 없다. Architecture test는 alias·re-export를 포함한 import 경로를 검사한다.

TypeScript domain type는 의미 모델이고, `schemas/`는 직렬화 경계의 JSON Schema다. 구현 시 Zod 정의에서 JSON Schema를 생성하고 CI에서 차이를 검사한다. 같은 wire schema를 세 위치에 손으로 복제하지 않는다. Google용 snake_case projection schema는 adapter 내부의 별도 mapping이며 canonical chunk schema와 동일 파일로 취급하지 않는다.

`composition`은 command별로 필요한 adapter만 만든다. `sync`, offline eval, local doctor, library resolution은 Google credential 없이 실행할 수 있어야 한다. MCP 시작도 registry/corpus로 가능하며 Google 미설정은 `get_context` 호출 시 진단한다.

## 4. Registry·configuration·수집

### 4.1 Registry 계약

아래는 schema 예시이며 source URL과 selector의 실제 적합성은 B0에서 확인한다. 예시 파일이 존재하거나 사이트 접근이 검증되었다는 뜻은 아니다.

~~~yaml
schemaVersion: 1
id: palantir-foundry
name: Palantir Foundry
aliases: [foundry, palantir]
defaultVersionKey: current
versions:
  - versionKey: current
    strategy: rolling
    source:
      type: sitemap
      sitemapUrls: ["https://www.palantir.com/sitemap.xml"]
      allowedHosts: ["www.palantir.com"]
      includePaths: ["/docs/foundry/**"]
      excludePaths: ["/docs/foundry/release-notes/archive/**"]
      canonicalQueryKeys: []
      collectionAllowed: true
    parser:
      contentSelectors: ["main", "article"]
      removeSelectors: ["nav", "footer", "script", "style"]
    chunking:
      minTokens: 200
      targetTokens: 800
      maxTokens: 1400
      maxAtomicTokens: 16000
    freshness:
      staleAfterHours: 168
~~~

Static source는 `type: static`과 `urls`를 갖고 나머지 host/path 정책은 동일하다. Sitemap base URL에서 sitemap 위치를 추측하지 않는다. `collectionAllowed`는 운영자가 source 정책을 확인했다는 설정이며 법적 허용을 자동 판정하는 기능이 아니다.

ID·versionKey는 `^[a-z0-9][a-z0-9._-]{0,63}$` 형식으로 제한하고 `.`, `..`를 거부한다. 같은 ID/버전 중복, 없는 default version, 빈 source, 잘못된 chunk 크기 순서는 설정 오류다.

Registry의 source/parser/freshness 설정만으로 sync할 수 있다. `readinessQueries`는 index 실행 시 필수이며 각 항목의 정확한 형식과 선택 revision 연결은 §6.3을 따른다. 이 목록이 없다고 sync나 library resolution을 차단하지 않는다.

### 4.2 URL과 fetch

- WHATWG URL로 파싱해 host case·default port·dot segment를 정규화하고 fragment를 제거한다. Path의 대소문자·trailing slash·percent-encoding을 임의로 동일시하지 않는다.
- Query parameter는 `canonicalQueryKeys`로 유지할 key를 명시하고 정렬한다. 내용에 영향을 주는 parameter가 있는 source는 이 설정을 B0에서 검증한다.
- HTTPS를 기본으로 사용한다. HTTP는 library 설정 `allowHttp: true`가 있을 때만 허용하며 private/loopback/link-local IP, userinfo, 임의 port는 거부한다.
- 문서 redirect·canonical link에는 host와 문서 path 규칙을 적용한다. Sitemap 파일은 명시된 sitemap URL 또는 그 index의 child로만 접근하고 host·scheme·주소 검사를 적용하되 문서 includePaths로 sitemap.xml 자체를 차단하지 않는다. Redirect 단계마다 DNS 주소와 연결 주소를 검증한다. 허용 범위 밖 canonical link는 무시하고 fetched URL을 사용한다.
- 같은 canonical URL의 상충 본문, 로그인 redirect, robots disallow, 빈 content selector는 성공으로 숨기지 않는다. Source 정의 수정 또는 오류 보고 대상이다.
- 조건부 GET을 사용한다. 304인데 기존 normalized snapshot이 없으면 무조건 GET을 1회 수행한다. Normalizer profile 변경 시 보존 raw HTML이 없으면 conditional GET을 생략한다.
- 429/503은 Retry-After를 따르되 총 deadline을 넘기지 않는다. 다른 일시적 network/5xx는 최대 3회 시도, 401/403·parse 오류는 재시도하지 않는다.
- HTML main content만 읽고 script·event handler를 제거한다. 링크는 허용 scheme의 절대 URL로 바꾸며 코드는 실행하지 않는다. JavaScript 렌더링이 필요한 shell은 `UNSUPPORTED_SOURCE`다.

V1 기본 한계는 host당 동시 fetch 2개, 초당 요청 1개, fetch당 전체 30초, redirect 5회, HTML 압축 해제 후 5 MiB다. Sitemap은 압축 해제 후 10 MiB, depth 5, 문서 수는 library/version당 1,000개다. 한계를 초과한 discovery는 incomplete이며 일부만 완성 revision으로 게시하지 않는다.

### 4.3 변경과 삭제 판단

성공적인 200/304는 `lastCheckedAt`을 갱신한다. 원본 bytes hash `rawHash`와 정규화 payload hash `normalizedHash`를 구분한다. Navigation 변경처럼 raw만 달라지고 정규화 내용이 같으면 snapshot/chunk를 재사용한다.

Normalizer profile은 알고리즘 버전·selector·URL policy를 포함한다. Chunker profile은 알고리즘 버전·크기 설정·tokenizer ID를 포함한다. Normalizer 변경은 정규화부터, chunker 변경은 보존 Markdown부터 재처리한다.

문서 누락은 **완료된 전체 discovery 2회 연속 부재** 또는 직접 GET의 확정 404/410으로 확인한다. 연속 실패 실행은 횟수에 포함하지 않는다. 첫 부재에서는 기존 snapshot을 revision에 유지하고 `missingPending`을 기록한다.

Timeout·권한 오류·파서 오류·수집 상한은 삭제 증거가 아니다. 필수 fetch/parse 실패가 하나라도 있으면 실행을 실패로 남기고 새 complete revision을 만들지 않는다. 0개 문서 발견은 `SOURCE_EMPTY`로 실패하며, 의도적 전체 폐기는 운영자가 source 제거를 별도로 검토해야 한다.

## 5. Canonical 데이터와 저장소

### 5.1 ID와 단위

Hash 함수 H는 key를 재귀적으로 정렬한 JSON을 UTF-8로 인코딩한 SHA-256이다. 배열 순서는 유지하고 숫자는 유한한 정수, 시간은 UTC ISO 8601 문자열을 사용한다. 단순 문자열 이어붙이기는 사용하지 않는다.

Digest 기반 canonical ID와 hash의 저장 표현은 lower-case hex 64자리다. Index entry에만 digest 원본 32 bytes를 RFC 4648 base32로 인코딩한다. generationId의 UUID와 backendKey의 hash를 혼용하지 않는다.

| ID | 계산 입력 |
| --- | --- |
| `documentId` | [libraryId, versionKey, canonicalUrl] |
| `snapshotId` | [documentId, normalizerProfileId, normalizedHash] |
| `chunkId` | [snapshotId, chunkerProfileId, chunkIndex, headingPath, content] |
| `corpusRevisionId` | [libraryId, versionKey, version 설정/profile hash, 정렬한 전체 document/snapshot/chunk 참조] |
| `generationId` | index run 생성 시 저장하는 UUID. backendKey와 corpusRevisionId에 연결 |
| `indexEntryId` | "k" + H([generationId, chunkId])의 lower-case base32, padding 없음 |

문서 snapshot은 제품 버전도 전체 corpus 세대도 아니다. 이전 snapshot에서 내용이 같은 chunk라도 `snapshotId`가 다르면 다른 chunk ID다. 동일한 chunk가 여러 index generation에서 재사용되어도 index entry ID는 다르므로 이전 검색 데이터를 덮어쓰지 않는다.

`normalizedHash`는 title·Markdown·heading anchor·semantic metadata를 대상으로 한다. Fetch/확인 시각·ETag는 hash에서 제외해 freshness 확인만으로 내용 ID가 바뀌지 않게 한다.

### 5.2 영속 모델

| 모델 | 필수 내용 |
| --- | --- |
| NormalizedDocument | schemaVersion, documentId, snapshotId, libraryId, versionKey, canonicalUrl, title, markdown, headings, normalizedHash, normalizerProfileId, metadata |
| DocumentChunk | schemaVersion, chunkId, documentId, snapshotId, libraryId, versionKey, chunkerProfileId, title, headingPath, anchor?, content, chunkIndex, hasCode, oversized, tokenCount, contentHash |
| FetchObservation | runId, documentId, snapshotId?, requestedUrl, fetchedUrl, status, lastCheckedAt?, fetchedAt?, rawHash?, ETag?, Last-Modified? |
| CorpusRevision | schemaVersion, corpusRevisionId, libraryId, versionKey, 전체 문서→snapshot/chunk 참조, 필요한 registry/profile 사본 |
| IndexGeneration | generationId, backendKey, corpusRevisionId, indexProfileHash, state, 전체 index entry ID 목록, readiness 결과 |
| PublishedPointer | backendKey, libraryId, versionKey, generationId, previousGenerationId?, publishedAt |

모든 schemaVersion은 정수 1, ID/hash/profile은 문자열, chunkIndex는 0부터 시작하는 정수, tokenCount는 0 이상 정수다. headingPath는 문자열 배열, headings는 `{level: 1..6, text: string, anchor?: string}`의 순서 있는 배열이며 metadata는 선택 문자열 필드로 제한한다. FetchObservation.status는 HTTP status 정수 또는 `network_error`이고 시각은 UTC 문자열이다. Corpus의 각 문서 참조는 `{documentId, snapshotId, chunkerProfileId, chunkIds: string[]}`이며 documentId 순으로 정렬하고 chunkIds는 chunkIndex 순으로 보존한다.

`metadata`의 language는 선택적 BCP 47 문서 언어이며 query 언어와 다르다. docType·product·vendor는 registry/파서에서 확인 가능한 값만 넣는다. 임의의 LLM 분류를 추가하지 않는다.

FetchObservation의 snapshotId와 lastCheckedAt은 성공한 200/304가 검증한 snapshot에만 연결한다. 실패·404/410 observation은 성공 freshness 값을 만들지 않는다. 같은 immutable revision에 서로 다른 설정 사본이 들어가지 않도록 version 설정/profile hash도 revision identity에 포함한다.

Heading은 source의 실제 anchor가 있으면 보존한다. 없는 anchor를 존재하는 웹 fragment처럼 만들어 반환하지 않는다. Chunk contentHash는 최종 저장된 content bytes의 SHA-256이다.

~~~text
var/
├── corpus/
│   ├── documents/<documentId>/<snapshotId>.json
│   ├── chunks/<chunkerProfileId>/<snapshotId>.jsonl
│   ├── revisions/<corpusRevisionId>.json
│   └── profiles/<profileId>.json
├── manifest/catalog.sqlite
├── cache/raw/                 # 선택 cache, 복원의 필수 입력 아님
└── reports/                   # 실행 요약과 평가 결과
~~~

경로의 ID는 검증된 digest만 사용한다. 원격 URL이나 사용자 입력을 직접 filesystem path로 쓰지 않는다.

### 5.3 Manifest와 파일 일관성

SQLite는 `sync_runs`, `fetch_observations`, `corpus_revisions`, `index_runs`, `index_batches`, `published_pointers`, `writer_leases`, `read_leases`를 관리한다. 각 run의 source/profile hash·시작/종료 시각·성공/실패 수·오류 code를 저장한다. Index generation 및 전체 entry 목록은 index run에 연결한다.

Filesystem 파일은 같은 volume의 임시 파일에 쓰고 flush·원자 rename 뒤 SQLite transaction으로 complete revision을 등록한다. 동일 ID의 다른 payload는 `CORPUS_CORRUPT`다. SQLite에 등록되지 않은 파일은 orphan이며 자동으로 최신 revision으로 선택하지 않는다.

WAL·foreign key를 켜고 transaction은 짧게 유지한다. Network fetch/import 동안 SQLite transaction을 열어두지 않는다. 스키마 migration은 writer lease 아래 실행하며 실패하면 기존 DB를 유지한다.

`latestCompleteRevision`과 `publishedGeneration`은 다르다. 성공적인 no-change sync도 observation을 남기되 content revision은 새로 만들지 않는다. MCP의 source freshness는 선택한 snapshot과 연결된 최신 성공 observation만 사용한다.

복원 시 선택한 complete corpus revision과 참조 파일·profile을 먼저 검증한다. SQLite 유실 시 명시적으로 선택한 revision으로 catalog와 새 backend index를 재구축할 수 있지만 이전 publish/실행 이력까지 복구했다고 주장하지 않는다. 해당 이력 보존에는 SQLite backup도 필요하다.

## 6. Sync·index·publish 수명 주기

### 6.1 Sync

`DISCOVERING → FETCHING → NORMALIZING → COMPLETE | FAILED`를 사용한다.

정상 완료 시 전체 membership을 가진 revision을 등록한다. 변경 없는 문서는 이전 snapshot/chunk 참조를 포함한다. Sync는 Google를 호출하거나 published pointer를 바꾸지 않는다. `sync --index`만 완료 후 별도 index use case를 호출한다.

### 6.2 Index

~~~text
완성 corpus revision
       │
       ▼
STAGING → IMPORTING → VERIFYING → READY → PUBLISHED
              │            │
              └─ 실패/대기 ─┴─→ 기존 published generation 유지
                                         │
                         신규 게시 뒤 이전 세대는 RETIRED
                                         │
                              보호 조건 확인 후 GC
~~~

1. Writer lease를 잡고 backend/profile과 source corpus revision을 고정한다. 같은 backend/profile/revision이 이미 게시되었으면 no-op이다.
2. 새 generation과 전체 entry 목록을 먼저 journal에 저장한다. **변경되지 않은 chunk도 새 generation entry에 포함한다.**
3. 새 ID로 전체 entry를 batch import한다. API reconciliation mode는 `INCREMENTAL`이다. 이는 Google 저장소 전체를 보존한다는 API 의미이며 변경 chunk만 전송한다는 의미가 아니다.
4. 모든 batch 결과와 document 상태, generation filter 검색 probe를 확인한다. LRO 완료·문서 저장 성공·검색 가능 여부를 각각 기록한다.
5. READY이면 writer 소유권과 예상 previous pointer를 검증한 하나의 SQLite transaction에서 published pointer를 바꾼다. 이전 generation을 RETIRED로 표시하되 삭제하지 않는다.
6. 게시 후 새 요청은 새 generation을 사용하고, 이미 시작한 요청은 이전 generation을 끝까지 사용한다.

**V1 trade-off:** 정상적인 전체 generation 준비는 O(전체 chunk 수)의 업로드와 일시적 중복 저장을 요구한다. 수집·정규화의 incremental 이점은 유지되지만 원격 변경분 전송 최적화는 후속 과제다. 10,000 chunk/generation을 기본 상한으로 두고 `index --plan`에 entry·batch·보존 세대 수를 표시한다. Google `FULL` import로 공유 data store를 덮어쓰는 최적화는 하지 않는다.

### 6.3 Readiness와 partial failure

`IndexBackend.verify`가 READY를 내는 최소 조건은 다음과 같다.

- 전체 예상 entry의 저장/색인 상태가 성공이며 누락·오류가 없다.
- 해당 generation만 선택한 검색에서 readiness query 각각의 기대 chunk를 찾는다.
- 다른 library/version/generation의 결과가 반환되지 않는다.

Readiness query는 library/version마다 최소 3개를 version 설정의 `readinessQueries` 목록으로 정의한다. 항목은 `{query, canonicalUrl, headingPath?}`이며 index 단계에서 선택 revision의 chunk ID로 해석한다. Snapshot이 바뀔 때 registry에 과거 chunk ID가 고정되는 문제를 피한다. 같은 heading에서 여러 chunk가 나오면 첫 chunk를 기대 대상으로 삼는다.

신규·변경 문서마다 title과 첫 heading을 query로 쓰고 첫 chunk를 기대하는 probe도 추가한다. 해당 generation과 기대 chunk ID로 제한한 검색 probe는 가시성을 확인하며, 별도의 무대상 제한 golden query가 검색 품질을 평가한다. 삭제된 readiness target은 검증 실패다. Target 수정은 source 검토 후 config에 반영한다.

Google `indexTime`이 있어도 검색 반영이 늦을 수 있다. READY는 이 조건을 관측했다는 의미이고 모든 미래 query의 rank·가시성을 보장하는 증명은 아니다. 실제 품질은 T-13에서 따로 평가한다. Probe가 부족하다고 승인 없이 기준을 완화하지 않는다.

이 설계의 index 상태 전이는 `STAGING → IMPORTING → VERIFYING → READY → PUBLISHED → RETIRED → DELETING → DELETED`다. 게시 전의 확정 실패는 FAILED, 대기 상한은 READINESS_PENDING이며 둘 다 동일 generation 재개가 가능하다. 원격 작업 종료를 확인하고 포기하면 ABANDONED가 된다. SUPERSEDED도 원격 작업 종료 확인 후 ABANDONED로 정리한다. Published/retired generation을 resume로 재게시하지 않는다.

Partial import는 성공 개수만 보고 게시하지 않는다. 각 entry 상태를 확인해 빠진 ID만 같은 generation으로 재시도한다. 30분 기본 대기 안에 준비되지 않으면 `READINESS_PENDING`으로 남기고 exit 2를 반환한다. 완료 여부가 불명확한 timeout도 failure 확정이나 publish로 바꾸지 않는다.

Import 호출 전 batch ID·payload hash를 저장하고 응답 뒤 provider operation handle을 기록한다. 응답 유실은 handle을 알고 있으면 조회하고, 모르면 같은 immutable ID로 재시도해 중복을 방지한다. Resume는 원래 generation/profile/revision을 사용한다. Profile이 바뀌면 재개를 거부한다.

같은 batchId는 같은 payload만 뜻한다. 실패 ID 부분집합만 재시도할 때는 원래 batch를 참조하는 새 batchId를 기록한다. Provider가 batchId를 idempotency key로 지원한다고 가정하지 않고 entry ID의 불변성과 payload 검증으로 재실행을 안전하게 만든다.

같은 scope에 미완료 index run이 있으면 새 run을 자동 생성하지 않고 `INDEX_RUN_PENDING`과 runId를 반환한다. 재개 또는 `index --abandon <runId>`로 원격 operation 종료를 확인한 뒤 ABANDONED로 전이한다. 취소 응답만으로 원격 작업이 끝났다고 가정하지 않는다. Resume 시 이미 더 최근 revision이 게시되었다면 `SUPERSEDED`로 중지해 과거 revision을 자동으로 재게시하지 않는다.

Crash가 publish transaction 이전이면 이전 pointer, 이후이면 새 pointer가 남는다. 정상 게시에 원격 삭제가 없으므로 로컬 rollback이 원격 삭제를 취소한다는 가정이 필요 없다.

### 6.4 동시성·조회 pin·정리

V1 writer lease는 varRoot 전체에 하나다. 30초 lease, 10초 갱신, 단조 증가 fencing token을 사용한다. State 변경과 publish는 소유 token을 검증한다. Lease 상실 시 이후 쓰기를 중지한다. 진행 중이던 원격 요청은 별도 generation ID에만 영향을 미쳐야 한다.

조회 시작의 짧은 transaction에서 published pointer·membership·연결된 freshness observation을 읽고 해당 generation의 read lease를 만든다. 조회 hard deadline은 20초, read lease 유효시간은 최대 25초다. 결과 직전에도 monotonic deadline과 lease를 검사하고 만료 시 응답을 취소한다. 같은 host의 UTC 시각 역행을 감지하면 GC를 중지한다. 여러 MCP process도 같은 SQLite를 사용한다.

`docsctx gc`는 기본 dry-run이며 `--apply`만 물리 삭제한다. GC도 writer lease를 얻는다. Current generation·직전 성공 generation·유효 read lease·미종료 remote operation·진행 중 index generation은 삭제 금지다. 나머지는 RETIRED/ABANDONED 뒤 24시간 이상 경과한 경우만 후보로 삼는다.

GC는 삭제 대상 generation을 DELETING으로 먼저 전이시켜 재게시/재개를 차단하고 해당 generation의 journal에 있는 entry ID만 삭제한다. Partial delete는 같은 목록으로 재시도하고 이미 없는 ID는 성공이다. 마지막에 DELETED로 기록한다. 전체 data store purge와 정상 index 과정의 선행 삭제는 금지한다.

V1 GC는 원격 index entry만 정리한다. Canonical 문서 이력의 자동 삭제는 하지 않으며 varRoot가 설정 상한(기본 5 GiB)에 도달하면 새 sync/index를 거부하고 운영자에게 알린다. 외부에서 data store를 수정하는 경우의 복구는 `index --rebuild`로 새 generation을 만든다.

기본 원격 보존 상한은 이 varRoot가 관리하는 entry 합계 50,000개다. 새 generation 전체를 더했을 때 상한을 넘으면 원격 쓰기 전에 `RESOURCE_LIMIT_EXCEEDED`로 중지한다. 보호된 generation을 자동 삭제해 공간을 확보하지 않는다. `index --plan`은 이 계산과 GC 가능한 수를 함께 출력한다.

## 7. Application port 계약

아래는 구현할 핵심 공개 type 계약이다. JSON/persistence ID는 문자열이지만 §5의 validation을 적용한다.

~~~typescript
type Scope = { libraryId: string; versionKey: string };
type QueryFilters = { language?: string; docType?: string };
type BackendHealth = { status: "ok" | "unavailable" | "misconfigured"; message?: string };

type SearchRequest = Scope & {
  generationId: string;
  query: string;
  limit: number;
  cursor?: string;
  filters?: QueryFilters;
};
type SearchHit = {
  indexEntryId: string;
  chunkId: string;
  contentHash: string;
  generationId: string;
  libraryId: string;
  versionKey: string;
  rank: number;
};
type SearchResponse = { hits: SearchHit[]; nextCursor?: string };
interface SearchBackend {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
  health(signal: AbortSignal): Promise<BackendHealth>;
}

type IndexEntry = Scope & {
  indexEntryId: string;
  generationId: string;
  chunkId: string;
  documentId: string;
  snapshotId: string;
  title: string;
  headingPath: string[];
  canonicalUrl: string;
  content: string;
  contentHash: string;
  hasCode: boolean;
  language?: string;
  docType?: string;
};
type BatchSubmission = {
  batchId: string;
  operationHandle: string | null;
  state: "pending" | "complete" | "partial" | "failed";
};
type BatchResult = {
  state: "pending" | "complete" | "partial" | "failed";
  succeededIds: string[];
  failed: Array<{ id: string; code: string; retryable: boolean }>;
  unknownIds: string[];
};
type ReadinessProbe = { query: string; expectedChunkIds: string[] };
type ReadinessResult = {
  state: "ready" | "pending" | "failed";
  expectedCount: number;
  indexedCount: number;
  missingIds: string[];
  failedProbeQueries: string[];
};
interface IndexBackend {
  submit(batchId: string, entries: IndexEntry[], signal: AbortSignal): Promise<BatchSubmission>;
  inspect(batch: BatchSubmission, expectedIds: string[], signal: AbortSignal): Promise<BatchResult>;
  verify(entries: IndexEntry[], probes: ReadinessProbe[], signal: AbortSignal): Promise<ReadinessResult>;
  deleteEntries(ids: string[], signal: AbortSignal): Promise<BatchResult>;
}

type TokenizerId = string;
interface TokenCounter {
  readonly id: TokenizerId;
  count(text: string): number;
}
~~~

SearchBackend와 IndexBackend는 동일 Google adapter가 구현할 수 있지만 application에는 읽기·쓰기 권한을 분리해 주입한다. MCP retrieval은 IndexBackend를 받지 않는다. Backend-specific score는 domain에 전달하지 않으며 rank만 사용한다.

Search의 limit은 1~100이며 rank는 해당 응답 안에서 1부터 연속 증가한다. Cursor는 adapter가 만든 opaque 값으로 query/scope/generation/limit/filter가 같은 후속 호출에만 사용한다. MCP 조회는 20개 한 페이지, 평가만 명시적 pagination을 사용한다. 평가의 문서 순위는 페이지 순서와 페이지 내 rank를 이어 붙여 계산한다.

나머지 port의 입출력 및 완료 의미는 다음과 같다. 표의 모델은 §4~§5 정의를 따른다.

| Port | 입력 → 출력 | 완료/오류 의미 |
| --- | --- | --- |
| LibraryRegistry | query 또는 ID/version → LibraryDefinition/후보 | 로컬 결정, alias ambiguity 보존 |
| SourceProvider | VersionSource + AbortSignal → URL stream와 DiscoverySummary | summary.complete일 때만 삭제 비교 가능 |
| DocumentFetcher | URL + 이전 validators → 200 body/304/404/410 | 상태 구분, 기타 오류는 typed error |
| DocumentNormalizer | fetched HTML + parser profile → NormalizedDocument payload | content 없음은 오류, profile 기록 |
| DocumentChunker | snapshot + profile + TokenCounter → DocumentChunk[] | 순서·heading·원문 보존 검사 |
| CorpusStore | immutable 문서/chunk/revision 쓰기·ID 읽기 | hash 검사, 원자 파일 저장, 누락 오류 |
| ManifestStore | run/batch journal·complete revision·published pointer·lease | §6의 transaction/CAS와 상태 전이 강제 |
| EvaluationDataset | fixture와 qrels 읽기 → 검증된 평가 case | 없는 정답·중복 case 거부 |

Port는 외부 I/O의 취소와 deadline을 전달받는다. SQLite 전체 row나 Google resource object를 core model로 노출하지 않는다.

## 8. Google Agent Search adapter

### 8.1 Resource와 schema

V1은 GENERIC structured custom-search data store 하나를 사용한다. 직접 만든 chunk 1개를 structured document 1개로 넣고 Google 자동 document chunking을 추가하지 않는다.

`backendKey`는 provider·project·location·dataStore·servingConfig·index schema profile의 identity hash다. 설정은 전체 `dataStoreName`, `branchName`, `servingConfigName`을 받는다. 상호 불일치나 multi-region endpoint 오류는 `BACKEND_MISCONFIGURED`다. Engine/Data Store ID를 혼합해 암묵적으로 경로를 조립하지 않는다.

| Google field | 원본 | 설정 |
| --- | --- | --- |
| document.id | indexEntryId | generation별 별도 ID |
| library_id, version_key, generation_id | scope, generation | string, indexable, retrievable |
| chunk_id, document_id, snapshot_id, content_hash | canonical 참조 | string, retrievable; chunk_id는 probe filter용 indexable |
| title | 제목 | searchable, retrievable, title key mapping |
| content | 보존 Markdown | searchable, retrievable, description key mapping |
| canonical_url | 공식 URL | retrievable, uri key mapping |
| heading_path | heading 배열 | retrievable, searchable |
| language, doc_type | metadata | string, indexable, retrievable |
| has_code | 코드 여부 | boolean, retrievable |

본문 `structData.content`는 structured text field이며 Google Document 최상위 `content`와 다르다. Adapter는 SDK의 protobuf Struct 직렬화를 round-trip test한다. Metadata와 검색 field 설정의 의미는 [공식 field settings](https://docs.cloud.google.com/generative-ai-app-builder/docs/configure-field-settings)를 따른다.

Google ID는 provider 규칙에 맞게 별도 indexEntryId로 인코딩한다. Raw 64자리 hex를 RFC label로 가정하지 않는다. `k`와 SHA-256의 base32를 조합한 ID는 53자리다. [Document 규칙과 index status](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.collections.dataStores.branches.documents)를 adapter contract test에 반영한다.

### 8.2 Import와 검색

Inline import는 batch당 최대 100개를 **V1 정책 상한**으로 사용한다. 공식 문서는 100개를 권장하며 이를 API의 절대 최대라고 표현하지 않는다. Serialized batch 4 MiB를 추가 정책 상한으로 두고 둘 중 먼저 도달하면 나눈다. [InlineSource RPC](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rpc/google.cloud.discoveryengine.v1#importdocumentsrequest)

항상 명시적 document.id를 전달하고 API mode는 INCREMENTAL이다. FULL은 대상 dataset에서 누락된 문서를 지울 수 있으므로 여러 세대가 공존하는 이 설계에 쓰지 않는다. Partial import 가능성은 [Import API](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.collections.dataStores.branches.documents/import), reconciliation 의미는 [공식 enum](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/ReconciliationMode)을 따른다.

100개씩 올리는 것만으로 GCS와 완전히 무관하다고 약속하지 않는다. Corpus 업로드 경로는 inline이며 import error report의 저장 위치·IAM·잔여물은 실제 provider 설정을 B0에서 확인한다. Error report가 GCS를 사용해도 corpus SoT를 GCS로 옮기지는 않는다.

Search는 검증된 scope/generation으로 고정 filter를 만들고 query를 별도 field로 전달한다. 사용자에게 raw Google filter expression을 받지 않는다. Optional filter도 allowlist key와 escaping을 적용한다. `pageSize = limit`, `autoPaginate: false`, summary/answer generation은 요청하지 않는다. [Search API](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.collections.dataStores.servingConfigs/search)

V1은 한 검색 요청으로 상위 20개를 가져온다. 재정렬·query expansion·자동 번역·인접 문서 자동 fetch는 application에서 하지 않는다. Rank 순서를 유지하고 중복 chunk ID만 제거한다. Backend가 반환한 다른 generation·없는 chunk·hash 불일치는 결과를 섞어 복구하지 않고 `INDEX_INCONSISTENT`로 실패시킨다.

Google schema 변경은 기존 data store에서 자동 수행하지 않는다. 검색을 방해하는 schema 변경은 별도 운영 변경으로 처리한다. `doctor`는 read-only로 예상 profile과 실제 schema 차이를 알린다.

## 9. Chunking과 context packing

### 9.1 Chunking

AST의 heading hierarchy를 따라 paragraph·list·table·code 단위를 순서대로 처리한다. Heading label은 관련 chunk에 포함한다. 같은 heading branch의 작은 section만 병합하고 같은 heading 문자열이어도 다른 위치의 section은 구분한다.

일반 chunk 목표는 800, min은 200, max는 1400이다. Paragraph는 필요하면 sentence/Unicode grapheme boundary로 더 나눌 수 있다. Code block과 table은 atomic unit으로 보존한다.

min은 병합 선호값이며 독립 section·마지막 chunk가 200 미만이어도 유효하다. Content selector는 설정 순서에서 처음으로 비어 있지 않은 본문 container를 찾고, 서로 겹치는 main/article을 중복 추출하지 않는다. 여러 container가 필요한 source는 명시적 selector profile로 정의한다.

하나의 atomic unit과 heading이 1400을 넘고 16000 이하이면 `oversized: true`인 독립 chunk로 저장한다. 16000을 넘으면 source document 처리를 `DOCUMENT_TOO_LARGE`로 실패시키고 원문을 조용히 잘라내지 않는다. Code fence 길이·언어·들여쓰기는 round-trip fixture로 검증한다.

### 9.2 Token 기준과 packing 순서

V1 tokenizer는 `cl100k_base`를 고정 vocabulary로 사용하는 `js-tiktoken`이다. 이는 공개 측정 기준이며 모든 client 모델의 실제 token 수와 같다는 뜻이 아니다. Vocabulary와 package version을 함께 profile에 기록하고 시작 후 원격 tokenizer 파일을 받지 않는다. 구현 확인은 [upstream js-tiktoken](https://github.com/dqbd/tiktoken/tree/main/js)을 기준으로 한다.

1. Backend rank 순서의 최대 20개 후보를 canonical chunk로 hydrate하고 membership/hash를 검사한다.
2. 같은 chunk ID 중복은 하나만 남긴다. 같은 URL의 다른 section은 제거하지 않는다.
3. 기본값 6000, 허용 범위 256~16000인 `maxTokens` 안에서 chunk 전체를 순서대로 담는다. 남은 공간보다 크면 그 chunk를 건너뛰고 다음을 시도한다.
4. Source ID·제목·URL·heading과 구분선을 포함해 **최종 context 전체**를 매번 계산한다. Chunk content를 중간에서 자르지 않는다.
5. 후보가 있으나 아무 chunk도 못 담으면 `TOKEN_BUDGET_EXCEEDED`다. 일부만 생략되면 `truncated: true`, `omittedChunkCount`를 반환한다.

예산의 범위는 `context` 문자열이다. JSON metadata·duplicated structuredContent·MCP envelope·client prompt는 포함하지 않는다. 별도로 serialized tool result 1 MiB 제한을 검사해 `RESPONSE_TOO_LARGE`를 반환한다.

각 source는 chunk 1개에 대응하며 `S1`, `S2` 순으로 ID를 붙인다. Context에는 같은 ID와 title, 공식 URL, heading, 보존 chunk content를 넣는다. 실제 anchor가 있는 경우에만 URL fragment를 붙인다. Title/heading은 Markdown 제어문자를 escape한다.

수집 본문의 instruction은 인용 데이터이며 실행할 지시가 아니라는 tool description을 제공한다. Sanitization을 했다는 이유로 prompt injection이 완전히 제거되었다고 주장하지 않는다.

## 10. MCP 입력·출력과 오류

### 10.1 resolve_library

입력은 `{ query: string }`이며 trim 후 1~200자다. 비교용 문자열만 NFKC·대소문자·연속 공백을 정규화한다.

ID 정확 일치 → name/alias 정확 일치 → name/alias의 query 포함 순으로 찾는다. 해당 우선순위의 후보가 하나면 성공, 여러 개면 그 후보의 ID·name을 정렬해 AMBIGUOUS_LIBRARY로 반환한다. 높은 우선순위에서 결론이 나면 낮은 규칙은 쓰지 않는다.

성공 schema:

~~~json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "libraryId": "palantir-foundry",
    "name": "Palantir Foundry",
    "versionKey": "current",
    "availableVersionKeys": ["current"]
  }
}
~~~

### 10.2 get_context

`libraryId`와 trim 후 1~2000자의 `query`가 필수다. `versionKey` 생략은 registry default, `maxTokens` 생략은 6000이다. 숫자 coercion·소수·범위 밖 예산·알 수 없는 field는 거부한다. Optional `filters`는 language와 docType만 받는다.

요청 예시:

~~~json
{
  "libraryId": "palantir-foundry",
  "query": "create ontology object type",
  "versionKey": "current",
  "maxTokens": 6000
}
~~~

응답 type 계약:

~~~typescript
type SourceRef = {
  id: string;
  chunkId: string;
  documentId: string;
  snapshotId: string;
  title: string;
  url: string;
  headingPath: string[];
  lastCheckedAt: string;
};
type ContextResult = {
  status: "ok" | "no_matches";
  library: { id: string; versionKey: string };
  query: string;
  generationId: string;
  corpusRevisionId: string;
  freshness: {
    publishedAt: string;
    oldestSourceCheckAt: string | null;
    stale: boolean;
    newerCorpusAvailable: boolean;
  };
  context: string;
  sources: SourceRef[];
  budget: {
    scope: "context";
    tokenizerId: string;
    maxTokens: number;
    usedTokens: number;
    truncated: boolean;
    omittedChunkCount: number;
  };
};
type ErrorCode =
  | "LIBRARY_NOT_FOUND" | "AMBIGUOUS_LIBRARY" | "VERSION_NOT_FOUND"
  | "CORPUS_NOT_READY" | "INVALID_REQUEST" | "TOKEN_BUDGET_EXCEEDED"
  | "BACKEND_MISCONFIGURED" | "INDEX_BACKEND_UNAVAILABLE"
  | "SEARCH_FAILED" | "INDEX_INCONSISTENT" | "CORPUS_CORRUPT"
  | "DEADLINE_EXCEEDED" | "RESPONSE_TOO_LARGE";
type ToolEnvelope<T> =
  | { schemaVersion: 1; ok: true; data: T }
  | { schemaVersion: 1; ok: false; error: {
      code: ErrorCode;
      message: string;
      retryable: boolean;
      candidates?: Array<{ libraryId: string; name: string }>;
    } };
~~~

`no_matches`는 published corpus에서 정상 검색이 0개인 경우다. `context: ""`, `sources: []`, `usedTokens: 0`, `truncated: false`를 반환한다. Published pointer가 없으면 CORPUS_NOT_READY다. Backend 구성 오류·장애를 no_matches로 감추지 않는다.

Freshness는 요청 시작 시 고정한다. Context에 실제로 포함한 source들의 마지막 성공 확인 시각 중 가장 오래된 값으로 stale을 계산한다. Source가 없으면 published revision 전체의 가장 오래된 성공 확인을 사용한다. 개별 문서의 확인 실패는 lastCheckedAt을 갱신하지 않는다. 더 최근 complete revision이 있어도 아직 게시하지 않았으면 `newerCorpusAvailable: true`다.

### 10.3 MCP mapping

성공은 `structuredContent`에 ToolEnvelope, `content`에는 같은 envelope의 JSON text 한 개를 넣는다. Text-only client도 JSON.parse 후 `data.context`를 사용할 수 있다. 반환 형태를 “아무 parsing도 불필요하다”라고 약속하지 않는다.

알려진 tool의 schema 오류와 업무 오류는 `isError: true`와 오류 envelope를 반환한다. MCP protocol 자체의 malformed request·unknown method/tool은 protocol 오류다. SDK 자동 validation이 application envelope를 우회하는 경우 MCP boundary에서 mapping해 T-10으로 고정한다.

Stack trace, credential, Google resource 전체 이름, 원문 query는 오류 message에 넣지 않는다. `serve`의 stdout은 JSON-RPC 전용이며 log는 stderr다. `resolve_library`에 registry read만, `get_context`에 read-only·외부 검색 사용을 나타내는 annotations/설명을 설정한다. Sampling이나 사용자 browser 접근은 요청하지 않는다.

오류의 retryable은 같은 입력을 잠시 뒤 다시 호출할 때 의미가 있는지 나타낸다. 네트워크·일시적 backend 장애·deadline은 true, library/version/입력/예산/config 오류와 corpus 손상은 false다. CORPUS_NOT_READY는 운영자의 게시가 필요하므로 false다. SEARCH_FAILED는 adapter가 원인에 따라 구분한다. 오류를 받았다고 client가 자동 sync/index를 실행할 권한을 얻지 않는다.

CLI 수집/운영 오류는 MCP ErrorCode와 별도다. 최소 code는 `SOURCE_FETCH_FAILED`, `DOCUMENT_PARSE_FAILED`, `UNSUPPORTED_SOURCE`, `SOURCE_EMPTY`, `DOCUMENT_TOO_LARGE`, `RESOURCE_LIMIT_EXCEEDED`, `RESOURCE_BUSY`, `INDEX_RUN_PENDING`, `INDEX_PARTIAL_FAILURE`, `READINESS_PENDING`이다. CLI 오류 결과는 code·stage·runId·retryable을 제공하고, 재개 가능한 경우 resumeRunId를 포함한다.

## 11. CLI·기본값·운영

모든 flag는 여기서 정의하는 구현 예정 계약이다. Global `--config <absolute-path>`, `--var-root <absolute-path>`를 지원한다. 기본 config는 현재 directory의 `config/app.yaml`, 기본 varRoot는 그 config가 있는 directory 기준 `../var`다. MCP host에서 호출할 때는 절대 경로 config를 명시한다.

| Command/flag | 계약 |
| --- | --- |
| sync/index/search의 `--version <key>` | 생략 시 registry default |
| `sync --index` | sync 성공 뒤 같은 revision index; 두 run ID를 출력 |
| `index --plan` | local corpus·entry/batch 수·원격 target 요약만 출력; 원격 쓰기 없음 |
| `index --resume <runId>` | 미종료 run을 동일 profile/generation으로 재개 |
| `index --abandon <runId>` | 원격 작업 종료 확인 후 미게시 run 포기; entry 삭제는 GC |
| `index --rebuild` | 같은 corpus도 새 generation으로 재게시 |
| `index --wait-seconds <n>` | 기본 1800, 1~7200; 준비 안 되면 pending으로 반환 |
| `search --max-tokens <n>` | get_context와 같은 입력 검증·ContextResult |
| `eval --live` | 명시된 backend와 게시 revision으로 원격 검색 |
| `doctor` / `doctor --remote` | 기본 로컬 진단 / 명시적 원격 schema·권한·접속 확인 |
| `gc` / `gc --apply` | 계획 / §6.4 보호 조건을 만족한 원격 entry 정리 |

`index --resume`, `--abandon`, `--rebuild`, `--plan`은 서로 함께 사용할 수 없다. 성공/no-op/정상 no_matches는 exit 0, 실패는 1, 완료되지 않은 원격 작업은 2다. 구조화된 CLI 결과는 stdout, progress/log는 stderr다. GC 실행 결과에는 삭제 generation/entry 수와 남은 실패 수를 포함한다.

Runtime 기본값은 search limit 20, query deadline 20초, batch 정책 100개/4 MiB, generation당 10,000 chunks, varRoot 5 GiB다. 원격 API는 search당 최대 3회 시도, index run 누적 5,000 calls를 상한으로 하고 resume도 같은 누적 counter를 사용한다. 상태 확인은 paged list로 batch화하고 재확인은 exponential backoff(최대 60초)를 적용한다. Sync 전체 deadline은 기본 2시간이다. 값은 config로 조정하되 profile/실행 journal에 실제 값을 기록한다. 이는 비용 상한 그 자체가 아니며 실제 Google 요금·quota는 별도로 관측한다.

Source/chunk/index 의미를 바꾸는 profile과 실행 자원 상한은 분리한다. 운영자가 config의 API call 상한·대기시간을 늘려 재개할 수 있지만 이미 사용한 누적 횟수는 초기화하지 않는다. 고정 20초 query deadline을 바꾸면 read lease의 보호 기간도 함께 늘려야 한다.

Google credential은 ADC 표준 순서만 사용한다. `GOOGLE_APPLICATION_CREDENTIALS`는 repository 밖 credential 파일의 위치이며 fallback으로 임의 key 파일을 찾지 않는다. 일반 검색에는 serving 읽기 권한, index에는 document import/get/list 및 operation 조회 권한, gc에는 제한된 delete 권한을 부여한다. Provisioning 권한을 MCP 실행에 요구하지 않는다.

일반 log에는 runId, generationId, stage, counts, duration, 오류 code를 기록한다. Query 원문과 수집 body는 log에 넣지 않는다. 오류 stack에도 민감한 원격 response/headers가 포함되지 않도록 정제한다. `doctor`는 자원 생성·schema 수정·실제 문서 색인을 하지 않는다.

Offline fixture는 배포 가능한 synthetic 문서를 기본으로 한다. 실제 수집 body·credential·varRoot·개인 설정은 Git 및 npm 배포물에서 제외한다.

## 12. 검증 시나리오와 완료 판정

### 12.1 요구사항 추적

I-012는 확장 제외 경계이므로 T-10의 정확히 두 tool 검사와 M0의 answer/HTTP 의존성 부재 검사로 확인한다.

| Test ID | 요구사항 | Given / When / Then |
| --- | --- | --- |
| T-01 | I-001 | alias 충돌·없는 버전·생략 버전 → 오류/후보/선언된 default가 각각 고정됨 |
| T-02 | I-002, I-014 | sitemap 순환·redirect 외부 host·private IP·robots 차단·JS shell → 차단/오류, 실행·외부 확장 없음 |
| T-03 | I-003, I-004 | 304, 같은 200, nav만 변경, normalizer/chunker 변경 → 기대 단계만 실행, ID/freshness 구분 |
| T-04 | I-007 | 표·code fence·한글·oversized block → 원문 보존 또는 명시적 크기 오류 |
| T-05 | I-006 | 일부 sitemap timeout/상한/빈 목록과 완전한 2회 누락 → 실패와 확정 삭제를 구분 |
| T-06 | I-005, I-013 | G1 게시 후 sync만 성공 → corpus는 새 revision, 조회는 G1 |
| T-07 | I-005, I-006 | 문서 A만 바뀌고 B는 동일 → G2에도 B 포함, 실패 전 G1 보존, 성공 후 요청별 한 세대 |
| T-08 | I-005, I-006 | partial batch·response loss·readiness timeout·publish 전후 crash → 같은 ID 재개, 정확한 pointer |
| T-09 | I-008, I-010 | 다른 scope/generation hit·손상 chunk·snippet mismatch → 잘못된 근거 반환 금지 |
| T-10 | I-009, I-011 | 실제 stdio initialize/tools/list/call → 정확히 두 tool, schema 오류·빈 결과·업무 오류·stdout 검사 |
| T-11 | I-010, I-011 | 256/6000/16000 예산과 oversized 후보 → 전체 context token 준수, source ID와 발췌 1:1 |
| T-12 | I-004, I-008, I-016 | network 차단+선택 corpus backup → chunk 재생성, 별도 in-memory adapter에 게시/검색 |
| T-13 | I-016 | 고정 qrels+Google published generation → 아래 절대 기준과 regression 기준 평가 |
| T-14 | I-014, I-015 | credential 없음·권한 부족·quota/timeout·config mismatch → 값 유출 없이 올바른 오류 |
| T-15 | I-006, I-015 | writer 경쟁·만료 lease·진행 중 G1 조회와 G2 게시/GC → stale writer 게시 금지, 사용 중 entry 보존 |

테스트용 in-memory adapter는 생산용 on-prem 검색 엔진을 구현했다는 증거가 아니다. T-12는 이식 가능한 format과 port를 검증하고 실제 local backend의 품질은 그 구현 시 평가한다.

### 12.2 Golden dataset과 지표

평가에서는 문서 top-10을 얻도록 같은 generation에서 100개씩 명시적 pagination을 하되 최대 5페이지/500 chunks로 제한한다. Online get_context는 상위 20개만 사용하므로 두 경로의 비용·후보 수를 결과에 각각 표시한다. 평가 상한에 걸리면 지표를 성공으로 확정하지 않고 incomplete로 남긴다.

최소 20개 양성 query를 한 공식 library에서 선정하며 한국어·영어, 개념 설명·절차·코드 사용례를 포함한다. 기대 정답은 corpus 내 canonical URL과 relevance grade 0~3으로 명시한다. 존재하지 않는 library/version·빈 backend 결과는 별도 부정 fixture로 검사한다.

~~~yaml
schemaVersion: 1
cases:
  - id: ontology-object-type-create
    libraryId: palantir-foundry
    versionKey: current
    query: "Object Type을 만드는 절차"
    qrels:
      - url: "https://www.palantir.com/docs/foundry/example-path/"
        relevance: 3
        headingContains: "Object Type"
~~~

위 URL은 형식 예시다. 실제 평가 fixture에서는 B0로 확인한 corpus URL만 허용하고 label을 사람이 검토한다. URL substring matching만으로 relevance를 자동 생성하지 않는다.

Rank 순서에서 같은 canonical URL은 첫 chunk만 문서 순위에 포함한다. Recall@K는 `top K의 relevant 문서 수 / label된 relevant 문서 수`, MRR@10은 첫 relevant rank의 역수, nDCG@10은 grade gain `2^grade - 1`로 계산한다. 정답 denominator는 고정 qrels에 한정하며 알려지지 않은 전체 웹 정답의 recall이라고 부르지 않는다.

별도 `ContextHitRate`는 최종 packed context에 grade>0 문서의 실제 발췌가 있고, headingContains가 지정되면 일치 heading의 발췌가 있는 query 비율이다. URL만 sources에 넣는 것으로 통과하지 못한다.

V1 제안 통과값은 Recall@5 ≥ 0.70, Recall@10 ≥ 0.85, MRR@10 ≥ 0.60, nDCG@10 ≥ 0.70, ContextHitRate ≥ 0.80이다. 평균은 양성 case 단순 평균을 사용하며 missing label은 평가 실패다. Baseline 생성 자체를 품질 통과로 보지 않는다.

동일 dataset hash·corpusRevisionId·tokenizer/packing profile의 다음 평가에서는 각 지표가 baseline 대비 0.05보다 더 떨어지지 않아야 하고 절대 기준도 충족해야 한다. 문서·label 변경 시 baseline을 자동 대체하지 않고 변경 사유와 새 결과를 검토한다.

### 12.3 검증 종류

일반 CI는 lint/typecheck, unit/contract, temporary SQLite+filesystem integration, architecture import, schema drift, stdio subprocess, offline eval을 실행한다. 실제 Google credential은 넣지 않는다.

Live 검증은 명시적 `eval --live` 또는 보호된 수동 CI에서 수행한다. 테스트용 자원·generation 범위를 고정하고 업로드/검색 호출 수와 결과를 기록한다. 실제 Codex 또는 Claude Code 중 최소 1종에서 tool 호출을 확인한다. 모든 호스트와의 호환성을 단일 client 검증으로 확대하지 않는다.

## 13. 착수 순서와 남은 외부 검증

문서 수준에서 실행 순서를 정했지만 아래 외부 조건은 아직 실증되지 않았다. 실패 시 해당 integration milestone만 차단하고 이미 가능한 offline 작업은 계속한다.

| 단계 | 작업과 통과 조건 |
| --- | --- |
| M0 — Bootstrap | package/lockfile/schema와 실제 registry resolution, 두 MCP tool 계약 및 offline 테스트 |
| M1 — Canonical Corpus | source fixture→snapshot→chunk→revision, no-change/profile 변경/삭제 판정/crash 테스트 |
| B0 — 실제 provider·source 확인 | 아래 검증을 작은 test corpus로 수행 |
| M2 — Index 게시 | Google staging/import/readiness/publish/resume/GC와 T-07~T-09, T-15 통과 |
| M3 — Context 제공 | 실제 MCP client에서 출처·예산·freshness 확인 |
| M4 — 평가 | 고정 qrels·절대 기준·regression 기준과 live 결과 확보 |

B0에서 확인할 항목은 다음과 같다.

- 첫 library의 sitemap, robots, HTML content selector, 수집 허용, 최소 실제 URL을 검증한다. Palantir가 JavaScript shell 등으로 수집 불가능하면 다른 source로 조용히 바꾸지 않고 해당 source 조건을 보고한다.
- 지정 GCP project의 API·billing·IAM·region·structured schema·serving config를 확인한다. Corpus 입력은 inline으로 처리하고 error report 저장 의존성은 별도로 확인한다.
- 작은 실제 batch로 indexEntryId 수용·field mapping·library/version/generation filter·LRO partial result·index status 조회와 검색 readiness를 검증한다.
- 같은 canonical URL과 내용을 가진 두 generation을 함께 저장해 filter가 한 generation의 entry를 정확히 선택하는지 확인한다. Provider의 deduplication 때문에 세대 선택이 깨지는 경우 M2를 시작하지 않는다.
- readinessQueries를 실제 chunk ID로 연결한다. Field나 filter가 지원되지 않으면 그 제약을 계약에 반영한 뒤 integration을 진행한다.
- 실제 설치 가능한 MCP v2 patch와 Node.js 24, SQLite binding, HTML/Markdown parser, tokenizer를 lockfile로 고정하고 최소 동작을 검증한다.

현재 확인한 것은 공식 API 문서와 두 spec의 논리적 계약이다. GCP 자원·실제 source crawl·SDK 설치·성능·품질 baseline·실제 MCP 연결은 이번 문서 수정에서 실행하지 않았다. 따라서 문서 개선 완료와 V1 제품 완료를 구분한다.

## 14. 승인

이 문서는 Knowledge QnA MCP 설계 문서에 대한 승인을 기다린다. Intention 문서 승인과 별개이며 이 문서의 승인만으로 구현·자원 생성·색인·배포를 시작하지 않는다.
