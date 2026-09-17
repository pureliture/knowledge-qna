# Knowledge QnA MCP 마일스톤 계획서 (Milestones)

- **참조 명세**:
  - 요구사항 정의서: [docs/specs/knowledge-qna-mcp/intention.md](./docs/specs/knowledge-qna-mcp/intention.md)
  - 상세 설계서: [docs/specs/knowledge-qna-mcp/design.md](./docs/specs/knowledge-qna-mcp/design.md)
  - 원본 요청서: [ORIGINAL_REQUEST.md](./ORIGINAL_REQUEST.md)
- **실행 계약**: agentic-execution
- **활성 슬라이스 (Active Slice)**: **M3 (Google Agent Search Adapter, Index Lifecycle, CLI Operations & Fencing - COMPLETED & OFFLINE VERIFIED / REMOTE BLOCKED)**

---

## 마일스톤 개요 (Vertical Slices)

| 마일스톤 | 이름 | 범위 및 핵심 산출물 | 주요 검증 게이트 | 상태 |
|---|---|---|---|---|
| **M0** | Project Bootstrap & Stdio MCP Foundation | - Node 24 LTS, ESM, TypeScript strict 기반 부트스트랩<br>- 헥사고날 클린 아키텍처 계층 골격 수립 및 엄격한 디커플링<br>- 정규화 AST 기반 아키텍처 계층 경계 검증 테스트 강화<br>- 호스트 로컬 라이브러리 레지스트리 및 결정론적 매칭 구현<br>- Stdio MCP v2 서버 (`resolve_library`, `get_context`) 및 stdout 무결성 가드<br>- CLI 기본 명령어 (`docsctx serve`, `docsctx doctor`, `-c`, `-v` 지원) | T-01, T-10, Arch Test, Adversarial Tests | **완료 및 검증 완료 (VERIFIED - Gate Passed)** |
| **M1** | Canonical Corpus & SQLite Manifest Pipeline | - 허용 목록 기반 웹/Sitemap 문서 수집 및 304 조건부 GET<br>- 구조 보존 HTML → Markdown AST 정규화<br>- 표/코드블록 원자성 보존 AST 청킹 엔진<br>- SHA-256 콘텐츠 주소화 파일시스템 저장소 (`var/corpus/`)<br>- SQLite 단일 작성자 임대 및 매니페스트 카탈로그 (`var/manifest/catalog.sqlite`)<br>- `docsctx sync` 파이프라인 구현 | T-02, T-03, T-04, T-05, T-06 | **완료 및 최종 검증 완료 (COMPLETED & VERIFIED - Gate Passed)** |
| **M2** | Search Adapters, Token Budget & Retrieval Engine | - `SearchBackend` (읽기) 및 `IndexBackend` (색인) 포트 분리<br>- `js-tiktoken` (`cl100k_base`) 컨텍스트 토큰 예산 패킹 엔진<br>- 로컬 청크 수화, 출처(`S1`, `S2`) 매핑 및 검증<br>- 오프라인 테스트 및 복원 검증용 `InMemorySearchAdapter`<br>- `docsctx index`, `docsctx search` 구현 | T-09, T-11, T-12 | **완료 및 최종 검증 완료 (COMPLETED & VERIFIED - Gate Passed)** |
| **M3** | Google Agent Search, CLI Operations & Benchmark | - Google Agent Search 어댑터 및 ADC 인증<br>- 전체 CLI 명령어 세트 (`docsctx gc`, `docsctx doctor --remote`, `docsctx index --plan/resume/abandon/rebuild`)<br>- 원격/오프라인 수명 주기 (STAGING → IMPORTING → VERIFYING → READY → PUBLISHED → RETIRED → DELETING → DELETED)<br>- 동시성 임대 펜싱 및 복구 탄력성 검증 (T-07, T-08, T-09, T-14, T-15) | T-07, T-08, T-09, T-14, T-15 | **완료 및 오프라인 검증 완료 (OFFLINE VERIFIED / REMOTE BLOCKED - Gate Passed)** |


---

## M0 상세 작업 내역 및 검증 상태 (Active Slice: M0)

### 1. 작업 범위
1. **프로젝트 환경 초기화**:
   - `milestones.md`, `package.json`, `tsconfig.json`, `.nvmrc`, `bin/docsctx.js`
   - Node 24 LTS 호환 패키지 설치 (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `better-sqlite3`, `zod`, `js-tiktoken`, `commander`, `yaml`, `cheerio`, `turndown`, `turndown-plugin-gfm`, `marked`, `vitest`, `typescript`)
2. **헥사고날 아키텍처 계층 구조 확립 및 결함 치유 (Iteration 2 Remediation)**:
   - `src/domain/`: 모델(Document, Snapshot, Chunk, Revision 등), 결정론적 해시 계산(`identity.ts`), 에러 체계(`errors.ts`) (Zero I/O, Zero external SDK, `node:crypto` 유일 허용)
   - `src/application/`: 포트 인터페이스(`LibraryRegistry.ts` 스토리지 순수 포트) 및 유스케이스(`resolve-library`, `get-context`)
   - `src/infrastructure/`: 인프라-애플리케이션 결합 제거 (`YamlLibraryRegistry`에서 `ResolveLibraryUseCase` 제거, 중복 ID 감지 추가), 토큰 카운터, StderrLogger, 파일시스템/SQLite 매니페스트 기본 골격
   - `src/interfaces/`: Stdio MCP v2 서버, `docsctx` CLI 서브커맨드(`serve`, `doctor`, `-c`/`--config`, `-v`/`--var-root` 단축 옵션 완벽 지원)
   - `src/composition/`: DI 컨테이너(`container.ts`) 및 CLI 진입점(`main.ts`)
3. **자동화된 아키텍처 테스트 강화 (Major Finding 2 & Hardening)**:
   - `test/architecture/layer-boundaries.test.ts`:
     - Rule 1 (Domain Whitelist): 오직 `node:crypto` 및 도메인 내부 상대경로만 허용
     - Rule 2 (Application Boundary): 인프라, 인터페이스, 컴포지션, 금지 외부 모듈 차단
     - Rule 3 (Infrastructure Boundary): `application/` 임포트 시 `application/ports/` 경로만 엄격 허용 (구체 use case 임포트 차단)
     - Rule 4 (Interfaces Boundary): 구체 인프라 어댑터 직접 참조 차단
     - AST 템플릿 리터럴(`ts.isNoSubstitutionTemplateLiteral`) 및 동적 임포트(`<dynamic-import-expression>`) 우회 전면 차단
     - 표준 절대경로 해소(`path.resolve` + `isInside`) 기반 트래버설 공격 방어
4. **라이브러리 레지스트리 및 결정론적 매칭 구현 (T-01 & Finding 3 Fix)**:
   - `config/libraries/` YAML 기반 레지스트리 (중복 ID 검출 시 즉각 Error 발생)
   - Step 1 Exact ID Match: 복수 일치 시(`idMatches.length > 1`) 정렬된 후보 목록과 함께 `AmbiguousLibraryError`(`AMBIGUOUS_LIBRARY`) 발생
   - Step 2 Exact Name/Alias Match 및 Step 3 Substring Match 모호성 처리
   - `LIBRARY_NOT_FOUND`, `VERSION_NOT_FOUND`, `defaultVersionKey` 일관 처리
5. **Stdio MCP v2 서버 구현 (T-10)**:
   - `@modelcontextprotocol/server` StdioServerTransport
   - `tools/list`: 오직 `resolve_library`와 `get_context` 2개만 노출
   - `stdout` 엄격 격리: 콘솔 가드(Monkey-patch guard) 적용 및 로그의 `stderr` 강제 전송
   - Zod wire schema 및 `ToolEnvelope<T>` 검증

### 2. 검증 증거 (Verification Evidence - Iteration 2 Remediation)
- [x] TypeScript strict 컴파일: `npm run build` (dist/ 생성, TS 오류 0건)
- [x] 강화된 아키텍처 테스트 통과: `npm run test:arch` (4/4 테스트 100% 통과, 템플릿 리터럴 및 경로 트래버설 방어)
- [x] 레지스트리 단위 테스트 통과 (T-01): `test/unit/registry.test.ts` (14/14 통과, ResolveLibraryUseCase 디커플링 및 중복 ID 검증 포함)
- [x] 도메인 Identity 해싱 단위 테스트: `test/unit/identity.test.ts` (13/13 통과)
- [x] 적대적 매칭 스트레스 테스트 통과: `test/adversarial/library-resolution-adversarial.test.ts` (36/36 통과, 복수 Exact ID 모호성 검증 포함)
- [x] 아키텍처 프로브 공격 검증: `test/adversarial/architecture-boundary-probe.test.ts` (5/5 통과)
- [x] Stdio MCP 계약 및 프로토콜 서브프로세스 적대적 테스트 통과 (T-10):
  - `test/contract/mcp-stdio.test.ts` (7/7 통과, stdout 비 JSON-RPC 0바이트 검증 완료)
  - `test/adversarial/stdio-protocol-adversarial.test.ts` (8/8 통과)
- [x] 전체 테스트 스위트 100% 통과: `npm test` (7개 파일, 87/87 테스트 통과)
- [x] CLI 진단 도구 및 단축 플래그 동작:
  - `./bin/docsctx.js doctor` HEALTHY 확인
  - `./bin/docsctx.js -c config/libraries doctor` HEALTHY 확인
  - `./bin/docsctx.js -c=config/libraries doctor` HEALTHY 확인
  - `./bin/docsctx.js -c /tmp/nonexistent doctor` 정상 실패(exit code 1, Loaded 0 libraries) 확인

### 3. 완료 상태 및 M1 연계
- M0 전체 게이트 통과 완료 (87/87 테스트 통과).

---

## M1 상세 작업 내역 및 검증 상태 (Active Slice: M1)

### 1. 작업 범위
1. **M1 Slice 1: Core Parsing & Storage Infrastructure (Gate T-04)**:
   - `HtmlDocumentNormalizer`: HTML → 구조 보존 Markdown, 제목/표/코드펜스/언어태그 보존, 노이즈 태그 제거.
   - `MarkdownAstChunker`: marked AST 기반 결정론적 청킹, 표 및 코드블록 원자성 보존, 800 토큰 목표(200~1400 토큰), 1400~16000 토큰 oversized 블록 분리, 16000 토큰 초과 시 `DOCUMENT_TOO_LARGE` 예외.
   - `FilesystemCorpusStore`: `var/corpus/` 구조화 저장소 (`documents/`, `chunks/`, `revisions/`, `profiles/`), 원자적 쓰기(`tmp` + `fsync` + `rename`), `CORPUS_CORRUPT` 감지.
   - `SqliteManifestStore`: `user_version = 2` 마이그레이션, `sync_runs`, `corpus_revisions`, 단일 작성자 펜싱 임대(`writer_leases`), 원자적 CAS `commitSyncRevision`.
2. **M1 Slice 2: Discovery, Fetching, Sync Pipeline & CLI (Gates T-02, T-03, T-05, T-06)**:
   - `UrlNormalizer`: WHATWG URL 정규화, 호스트 소문자화, 기본 포트 80/443 제거, fragment 제거, path 대소문자 및 trailing slash 보존, `canonicalQueryKeys` 사전순 정렬.
   - `RobotsParser`: robots.txt 파싱 및 경로 허용 판정 (`docsctx` 및 `*` 지원, 더 구체적인 규칙 우선).
   - `SsrfValidator`: DNS lookup 모킹 seam 제공, IPv4/IPv6 사설/루프백/링크로컬 IP 차단, HTTPS 기본 정책.
   - `SitemapSourceProvider`: 중첩 sitemap index 지원, 재귀 깊이 5 제한, 순환 참조 Set 방지, 1,000개 문서 상한, 10 MiB 사이트맵 상한, static URL 소스 지원 (Gate T-02).
   - `HttpDocumentFetcher`: 304 조건부 GET, 404/410 감지, 5회 홉 리디렉션 매 홉 SSRF 및 호스트 재검증, `rawHash` 계산 (Gate T-03).
   - `SyncUseCase`: discovery → fetch → normalize → chunk → store → manifest 전체 파이프라인 조율:
     - 304 수신 시 snapshotId/chunkIds 재정규화 없이 재사용 (Gate T-03).
     - 200 수신 시 rawHash 및 normalizedHash 일치 감지로 기존 snapshotId/chunkIds 재사용 (Gate T-03).
     - 2회 연속 완전 탐색 부재 또는 명시적 404/410 시만 삭제 확정 (Gate T-05).
     - 부분 discovery 실패나 타임아웃 시 문서 보존 (Gate T-05).
     - `docsctx sync` 실행 중 published search pointer 불변 보장 (Gate T-06).
   - `docsctx sync <libraryId> [--version <key>]` CLI 명령어 구현: stderr 진행 로그, stdout 클린 JSON 요약.
   - `docsctx doctor` 진단 도구 강화: corpus 디렉터리 레이아웃 검사, SQLite `PRAGMA integrity_check`, 라이브러리 프로파일 경계 검증.
   - `container.ts` 및 `main.ts` DI 조립.

### 2. 검증 증거 (Verification Evidence - M1 Gate 2 Remediation Final)
- [x] TypeScript strict 컴파일: `npm run build` (dist/ 생성, TS 오류 0건)
- [x] 헥사고날 아키텍처 계층 경계 검증: `npm run test:arch` (4/4 테스트 100% 통과, 무결성 검증)
- [x] 단위 테스트 (Unit Tests):
  - `test/unit/url-normalization.test.ts` (12/12 통과, WHATWG 정규화, query key 정렬)
  - `test/unit/sitemap-discovery.test.ts` (11/11 통과, sitemap index, depth 5 제한, cycle 방지, 1000 문서 상한, static 소스, 리디렉션 SSRF 방어, robots.txt 준수 - Gate T-02)
  - `test/unit/ssrf-validator.test.ts` (7/7 통과, 사설/루프백/링크로컬 IP 차단, mockable DNS - Gate T-02)
  - `test/unit/robots-parser.test.ts` (5/5 통과, robots.txt 파싱 및 경로 규칙 매칭)
  - `test/unit/html-normalizer.test.ts` (7/7 통과, HTML 구조 보존 Markdown 변환)
  - `test/unit/ast-chunker.test.ts` (9/9 통과, 코드/표 원자성, 토큰 범위 및 oversized 블록)
  - `test/unit/storage.test.ts` (5/5 통과, Filesystem & SQLite 스토리지 무결성)
  - `test/unit/identity.test.ts` (13/13 통과)
  - `test/unit/registry.test.ts` (14/14 통과)
- [x] 계약 테스트 (Contract Tests):
  - `test/contract/document-fetcher.test.ts` (7/7 통과, 304 조건부 GET, 리디렉션 5회 및 SSRF 차단, 404/410 - Gate T-03)
  - `test/contract/mcp-stdio.test.ts` (7/7 통과, stdio v2 격리)
- [x] 통합 테스트 (Integration Tests):
  - `test/integration/normalization-chunking.test.ts` (1/1 통과 - Gate T-04)
  - `test/integration/sync-pipeline.test.ts` (7/7 통과, 304 재사용, 불완전 탐색 시 삭제 방지, 2회 부재 삭제, 404/410 확정 삭제, 프로파일 변경 재청킹 - Gate T-03, T-05)
  - `test/integration/gate-t06.test.ts` (2/2 통과, sync 실행 시 신규 revision 생성 및 published search pointer 불변 보장 - Gate T-06)
- [x] 적대적/경계 테스트 (Adversarial & Hardening Tests):
  - `test/adversarial/library-resolution-adversarial.test.ts` (36/36 통과)
  - `test/adversarial/architecture-boundary-probe.test.ts` (5/5 통과)
  - `test/adversarial/stdio-protocol-adversarial.test.ts` (8/8 통과)
  - `test/adversarial/m1-pipeline-adversarial.test.ts` (23/23 통과)
  - `test/adversarial/m1-normalization-chunking-adversarial.test.ts` (15/15 통과, blockquote 내 중첩 코드/표 원자성 보존)
  - `test/adversarial/m1-storage-concurrency-adversarial.test.ts` (14/14 통과, 만료된 임대 갱신 방지, 만료 임대 CAS 커밋 거부)
  - `test/adversarial/m1-challenger-verification.test.ts` (7/7 통과)
- [x] 전체 회귀 테스트 스위트: `npm test` (21개 테스트 파일, 210/210 테스트 100% 통과, 0 failures, 0 skipped, 0 expected fail)
- [x] M1 Gate 2 독립 검증단 5인 전원 일치 승인:
  - `auditor_m1_g2_1`: **CLEAN** (하드코딩/더미 없음, 5대 remediation 결함 실질 해소, 무결성 검증 완료)
  - `reviewer_m1_g2_1`: **APPROVE** (아키텍처 및 코드 품질 승인)
  - `reviewer_m1_g2_2`: **APPROVE** (기능 및 명세 정합성 승인)
  - `challenger_m1_g2_1`: **APPROVE** (T-02, T-03, T-05 적대적 검증 승인)
  - `challenger_m1_g2_2`: **APPROVE** (T-04, T-06 적대적 검증 승인)

### 3. 완료 상태 및 M2 연계
- M1 마일스톤 전수 게이트 만장일치 통과 완료 (210/210 테스트 통과, 5/5 승인).
- Milestone M2 활성화.

---

## M2 상세 작업 내역 및 검증 계획 (Active Slice: M2)

### 1. 작업 범위
1. **Search & Index Backend Ports (R4, Gate T-09)**:
   - `src/application/ports/SearchBackend.ts`: 읽기 포트 (`search(query, options): Promise<SearchResult>`)
   - `src/application/ports/IndexBackend.ts`: 색인/게시 포트 (`indexRevision(params): Promise<void>`)
   - 엄격한 헥사고날 인터페이스 분리 (도메인/애플리케이션 계층에 SDK 누출 금지)
2. **InMemorySearchAdapter (R4, Gate T-12)**:
   - `src/infrastructure/search/InMemorySearchAdapter.ts`:
     - 오프라인 테스트 및 완전한 코퍼스 복원/검색 검증 어댑터
     - 메모리 내 토큰/전문 역인덱스 또는 어휘 검색 지원
     - 코퍼스 리비전 인덱싱 및 점수 기반 쿼리 매칭
3. **Local Chunk Hydration & Content Hash Verification (R4, Gate T-11)**:
   - `src/application/retrieval/ChunkHydrator.ts`:
     - 검색 히트 chunkId를 `var/corpus/chunks/`에서 읽어 canonical Markdown/메타데이터 수화
     - 코퍼스 리비전 매니페스트 소속 검증
     - SHA-256 콘텐츠 해시 불일치 시 `CORPUS_CORRUPT` 감지 및 거부
4. **Citation Engine (R4, Gate T-11)**:
   - `src/application/retrieval/CitationMapper.ts`:
     - 1:1 출처 식별자 매핑 (`S1`, `S2`...)
     - 정규화된 문서 제목, 공식 URL (유효 앵커/헤딩 프래그먼트 `#section` 정합성 검증)
     - 헤딩 경로(heading hierarchy) 배열 제공
5. **Context Packing Engine & Token Budget (R4, Gate T-11)**:
   - `src/application/retrieval/ContextPacker.ts`:
     - `js-tiktoken` (`cl100k_base`) 고정 토크나이저 사용
     - `maxTokens` 예산 엄격 준수 (기본 6,000, 256 ~ 16,000 유효 범위 검증)
     - 토큰 한도 초과 시 `truncated: true` 플래그 및 원자적 청크 단위 절삭 (청크 중간 절단 방지)
     - 첫 번째 최소 청크조차 예산 초과 시 `TOKEN_BUDGET_EXCEEDED` 반환
     - 검색 결과 0건 시 `status: "no_matches"` 반환
6. **GetContextUseCase MCP 실연동 (R2, R4, Gate T-10, T-11)**:
   - `src/application/usecases/GetContextUseCase.ts`:
     - M0 스텁을 실 검색 -> 수화/검증 -> 인용 매핑 -> 컨텍스트 패킹 파이프라인으로 교체
     - `src/interfaces/mcp/McpServer.ts`와 완벽 통합
7. **CLI 명령어 확장 (R5)**:
   - `docsctx index <libraryId> [--version <key>]`: 인덱싱 실행 및 매니페스트 published revision 포인터 갱신
   - `docsctx search <libraryId> "<query>" [--version <key>] [--max-tokens <n>]`: CLI 검색 및 패킹된 컨텍스트 출력
8. **아키텍처 및 무결성 가드**:
   - `npm run test:arch`: 4개 레이어 규칙 100% 준수
   - 진정성 있는 검색 및 패킹 구현 (하드코딩 배제, 포렌식 무결성 감사 통과)

### 2. 검증 증거 (Verification Evidence - M2 Final)
- [x] TypeScript strict 컴파일: `npm run build` (tsc 엄격 모드 컴파일 에러 0건)
- [x] 헥사고날 아키텍처 계층 경계 검증: `npm run test:arch` (4/4 테스트 100% 통과, 0 violations)
- [x] InMemorySearchAdapter 오프라인 색인 및 검색 테스트 (Gate T-12):
  - `test/unit/in-memory-search.test.ts` (6/6 통과, Okapi BM25, 필드 가중치, 결정론적 Tie-breaking)
  - `test/contract/search-index-backend.test.ts` (2/2 통과, Search/Index 포트 계약 준수)
  - `test/adversarial/m2-challenger-verification.test.ts` (15/15 통과, 대량 동점 불변성, 세대 격리, 오프라인 복원)
- [x] Chunk Hydration 및 해시 검증 테스트 (Gate T-09, T-11):
  - `test/unit/chunk-hydrator.test.ts` (7/7 통과, O(1) 리비전 매핑, sha256Hex 및 computeChunkId 무결성)
  - `test/adversarial/m2-challenger-hydration-budget.test.ts` (32/32 통과, 변조 감지 및 미등록 청크 격리)
- [x] Citation 매핑 및 앵커 유효성 테스트 (Gate T-11):
  - `test/unit/citation-mapper.test.ts` (10/10 통과, 1:1 S1/S2 매핑, 앵커 교차 검증, 마크다운 이스케이프)
- [x] Token Budget (256~16,000, 6,000 기본값, truncated, TOKEN_BUDGET_EXCEEDED, no_matches) 단위/적대적 테스트 (Gate T-11):
  - `test/unit/context-packer.test.ts` (8/8 통과, 원자적 패킹, 중간 절단 방지, 예산 초과 에러)
  - `test/adversarial/m2-retrieval-adversarial.test.ts` (10/10 통과, Tiktoken 특수 토큰 safe 인코딩)
- [x] GetContextUseCase 및 MCP Stdio 통합 테스트 (Gate T-10, T-11):
  - `test/integration/m2-retrieval-pipeline.test.ts` (4/4 통과, E2E 검색->수화->인용->패킹 파이프라인)
  - `test/contract/mcp-stdio.test.ts` (7/7 통과, stdout 100% JSON-RPC 격리)
  - `test/adversarial/stdio-protocol-adversarial.test.ts` (8/8 통과)
- [x] CLI `docsctx index` 및 `docsctx search` 테스트:
  - `./bin/docsctx.js search --help` (정상 구동, JSON 출력 및 진행 로그 분리)
  - `./bin/docsctx.js index --help` (정상 구동, 원자적 게시 지원)
- [x] 전체 회귀 테스트 스위트:
  - `npm test` (31개 테스트 파일, 320/320 테스트 100% 통과, 0 failures, 0 skipped, 0 expected fail)
- [x] Milestone M2 독립 게이트 검증단 5인 전원 만장일치 승인:
  - `auditor_m2_1`: **CLEAN** (포렌식 무결성 감사 통과, 하드코딩 0건, 진성 BM25/Tiktoken/해시 검증 확인)
  - `reviewer_m2_1`: **APPROVE** (아키텍처 및 헥사고날 계층 경계 검토 승인)
  - `reviewer_m2_2`: **APPROVE** (기능 및 명세 정합성 검토 승인)
  - `challenger_m2_1`: **APPROVE** (검색 엔진, BM25 가중치, 동점 처리, 오프라인 복원 적대적 검증 승인)
  - `challenger_m2_2`: **APPROVE** (청크 수화, 해시 무결성, 인용 및 토큰 예산 패킹 적대적 검증 승인)

### 3. 완료 상태 및 M3 연계
- M0, M1, M2의 모든 요구사항 및 수용 기준 100% 충족 및 전수 게이트 무결 검증 완료.
- Milestone M3 활성화.

---

## Gate B0 실측 증거 및 원격 진단 (Gate B0 Findings & Remote Blocker Isolation)

### 1. Palantir Foundry Sitemap 및 HTML 정규화 실측 증거
- [x] **Sitemap 소스 확인**:
  - `https://www.palantir.com/sitemap.xml`은 마케팅 전용 sitemap (Foundry URL 0건).
  - `https://www.palantir.com/robots.txt`에 명시된 `https://www.palantir.com/docs/sitemap.xml`이 공식 문서 sitemap임 확인.
  - `https://palantir.com/docs/sitemap.xml` -> `https://www.palantir.com/docs/sitemap.xml` (302 redirect), 59건의 `/docs/foundry/` URL 확인 완료.
  - `config/libraries/palantir-foundry.yaml`의 `sitemapUrls`를 `https://www.palantir.com/docs/sitemap.xml`로, `allowedHosts`에 `palantir.com` 추가 갱신 완료.
- [x] **HTML 본문 및 Selector 적합성**:
  - 대표 문서 `https://www.palantir.com/docs/foundry/developers/` (HTTP 200, 268,160 bytes) 실측 결과, 22만 자의 서버 렌더링 텍스트 확인 (빈 JS-shell 아님).
  - `<main>`/`<article>` 태그 부재 시에도 `HtmlDocumentNormalizer`의 `<body>` 폴백을 통해 9개 정형 헤딩 및 9,123자의 Markdown 추출 성공.
  - `release-notes` 등 일부 동적 렌더링 컴포넌트(`loading...`) 존재하나 핵심 개발자 문서는 온전한 HTML 보존 확인.

### 2. GCP ADC / Discovery Engine 진단 및 원격 차단 고립 (Remote Blocker Isolation)
- [x] **진단 사실**:
  - 계정: `<operator-account>`
  - 프로젝트: `<gcp-project-id>` (Active, Project # `<gcp-project-number>`)
  - `discoveryengine.googleapis.com` API 비활성화 상태 (`gcloud services list --enabled` 결과: 0건).
  - Quota project 미지정 및 지정 시 `PERMISSION_DENIED` 반환 (API 미사용/비활성화).
  - Data Store, Branch, Serving Config 미존재.
- [x] **고립 조치**:
  - 안전 지침에 따라 임의의 API 활성화, 자원 생성, IAM 변경, 쿼터 프로젝트 설정 전면 금지.
  - B0 Remote Blocker로 공식 고립 기록하고, M3 구현 및 검증은 격리된 Mock/Contract 및 Synthetic Runner 기반 오프라인 100% 검증으로 진행.

---

## M3 상세 작업 내역 및 검증 계획 (Active Slice: M3)

### 1. 작업 범위
1. **Google Agent Search Adapter (`src/infrastructure/search/google-agent-search/`)**:
   - `@google-cloud/discoveryengine` SDK 기반 `SearchBackend` (읽기) 및 `IndexBackend` (색인) 구현.
   - `indexEntryId = 'k' + base32(sha256([generationId, chunkId]))` 정확히 53자리 강제.
   - 배치 분할: 최대 100건 및 4 MiB 직렬화 크기 상한 적용.
   - `INCREMENTAL` reconciliation 모드 강제.
   - `structData.content` 보존 Markdown 직렬화 및 `library_id`, `version_key`, `generation_id` 메타데이터 격리.
   - LRO operation 폴링 및 상태 추적.
   - 고정 필터링을 통한 다중 세대/스코프 완전 격리 (타 세대 오염 시 `INDEX_INCONSISTENT`).
   - `health()`: Secret(토큰, 비공개키) 누출 없는 안전한 진단.
   - 오프라인 테스트용 Client Seam 제공.
2. **Index 수명 주기 및 동시성 펜싱 (`IndexUseCase.ts`)**:
   - `STAGING → IMPORTING → VERIFYING → READY → PUBLISHED → RETIRED → DELETING → DELETED` 전체 수명 주기.
   - `--plan`: 원격 쓰기 없는 로컬 엔트리/배치 계산 요약 출력.
   - `--resume <runId>`: 미완료 세대 안전 재개, 최신 리비전 선점 시 `SUPERSEDED` 차단.
   - `--abandon <runId>`: 미게시 run 안전 포기.
   - `--rebuild`: 강제 신규 세대 생성.
   - `--wait-seconds <n>`: 대기 상한 초과 시 `READINESS_PENDING` 기록 및 Exit Code 2.
3. **원격 엔트리 가비지 컬렉션 (`GarbageCollectionUseCase.ts` & `docsctx gc`)**:
   - Writer lease 획득 및 단일 작성자 펜싱.
   - 보호 조건: 현재 게시 세대 보호, 직전 성공 세대 보호, 활성 Read Lease 보호, 진행 중 세대 보호.
   - 24시간 이상 경과한 RETIRED/ABANDONED 세대만 선별.
   - 기본 Dry-run, `--apply` 시 `DELETING` 전이 후 물리 삭제 및 `DELETED` 전이.
4. **CLI 명령어 확장 및 안전 진단**:
   - `docsctx index <libraryId>`: `--plan`, `--resume`, `--abandon`, `--rebuild`, `--wait-seconds` 지원.
   - `docsctx gc [libraryId]`: 기본 Dry-run, `--apply` 지원.
   - `docsctx doctor --remote`: 원격 백엔드 상태 안전 진단 (Secret 0바이트 누출).
5. **엄격한 게이트 검증 (T-07, T-08, T-09, T-14, T-15)**:
   - T-07: 풀 제너레이션 저널링, 변경 없는 문서 B 포함, 실패 시 G1 보존, 요청별 단일 세대 고정.
   - T-08: 부분 배치 재시도, 응답 유실 복구, readiness 타임아웃(Exit 2), publish 전후 crash 복구, resume/abandon.
   - T-09: 교차 세대/스코프 격리, 변조된 청크 거부 (`INDEX_INCONSISTENT`).
   - T-14: 인증/권한/쿼터 오류 시 토큰/비밀 누출 0바이트 검증.
   - T-15: Fencing token 거부, 활성 Read Lease 세대 GC 보호, Current/Previous 세대 GC 보호.

### 2. 검증 증거 (Verification Evidence - M3 Final)
- [x] TypeScript strict 컴파일: `npm run build` (tsc 엄격 모드 컴파일 에러 0건)
- [x] 헥사고날 아키텍처 계층 경계 검증: `npm run test:arch` (4/4 테스트 100% 통과, 0 violations)
- [x] Gate B0 실측 및 원격 차단 고립 테스트:
  - `test/integration/gate-b0.test.ts` (3/3 통과)
    - Palantir Sitemap 59건 URL 추출 실측 검증
    - Palantir Developers 268KB HTML -> 9개 헤딩, 9,123자 Markdown 정규화 실측 검증 (Non-JS shell 증명)
    - GoogleAgentSearchAdapter ADC 진단 시크릿 누출 0바이트 및 unavailable 격리 검증
- [x] Google Agent Search Adapter 계약 및 보안 테스트 (Gate T-09, T-14):
  - `test/contract/google-agent-search-adapter.test.ts` (16/16 통과)
    - `indexEntryId` 형식(`^k[a-z2-7]{52}$`, 정확히 53자) 강제 및 RFC 4648 Base32 인코딩 검증
    - 100건 및 4 MiB 직렬화 분할 배치 계산 검증
    - `INCREMENTAL` reconciliation 모드 강제
    - LRO 완료 대기, timeout, 부분 실패(errorSamples) 및 배치별 count 처리 검증
    - `library_id`, `version_key`, `generation_id` 필터링 및 다중 세대 응답 혼입 시 `IndexInconsistentError` 거부
    - readiness probe의 빈 scope filter 방지
    - Bearer 토큰, ya29 토큰, PEM 개인키, 서비스 계정 시크릿 0바이트 마스킹 처리 검증
    - 기록된 entry ID를 사용한 원격 document 삭제 경로 검증
- [x] Index 수명 주기, 복구 및 동시성 펜싱 테스트 (Gate T-07, T-08):
  - `test/integration/gate-t07-t08.test.ts` (10/10 통과)
    - T-07: 풀 제너레이션 격리, 변경 없는 청크 포함, 실패 시 기존 세대 보존, 요청별 단일 세대 고정
    - T-08: 배치 실패 시 롤백 및 상태 보존, LRO 타임아웃 시 `READINESS_PENDING` 전이 및 비정상 탈출(Exit 2) 검증
    - T-08: `--plan` 안전 실행(원격 쓰기 0건) 검증
    - T-08: `--resume` 안전 재개 및 신규 리비전에 의한 선점 시 `SUPERSEDED` 차단 검증
    - T-08: `--abandon` 수동 포기 및 잠금 해제 검증
    - T-08: 동시 인덱싱 시도 시 `INDEX_RUN_PENDING` 거부 검증
    - `--wait-seconds` hanging readiness backend deadline 검증
- [x] Garbage Collection 수명 주기 및 안전 보호 테스트 (Gate T-15):
  - `test/integration/gate-t15.test.ts` (5/5 통과)
    - Writer Lease 획득을 통한 동시 실행 차단 검증
    - 4대 보호 조건 검증: 현재 게시 세대 보호, 직전 성공 세대 보호, 활성 Read Lease 세대 보호, 진행 중 Run 보호
    - 24시간 미경과 세대 보호 및 24시간 초과 `retired`/`abandoned` 세대 정상 선별
    - Dry-run 모드(물리 삭제 없음) 및 `--apply` 모드(DELETING 전이 -> 원격 삭제 -> DELETED 전이) 검증
- [x] CLI 운영 도구 구동 검증:
  - `docsctx doctor --remote`
  - `docsctx index <libraryId> --plan`
  - `docsctx gc [libraryId] [--apply]`
  - `doctor --remote`는 기본 InMemory adapter를 원격 성공으로 오인하지 않고 target 미설정 `unavailable`을 보고
- [x] 전체 회귀 테스트 스위트:
  - `npm test` (35개 테스트 파일, 354/354 테스트 100% 통과, 0 failures, 0 skipped, 0 expected fail)

### 3. 완료 상태 (Status: OFFLINE VERIFIED / REMOTE BLOCKED - Gate Passed)
- Gate B0 실측 및 원격 차단 고립(Unavailable), M3 Google Agent Search Adapter, 전체 Index 수명 주기/복구, GC Use Case, CLI 운영 확장, 그리고 Gates T-07, T-08, T-09, T-14, T-15의 오프라인/계약 검증을 통과했다 (354/354 테스트).
- Discovery Engine live verification은 GCP 프로젝트 `gemini-api-498422`에서 API 비활성(`discoveryengine.googleapis.com` 0건) 및 권한 부재로 차단되어 미완료이다. 안전 지침 및 권한 경계에 따라 임의의 API 활성화·리소스 생성 없이 blocker를 고립 유지한다.
- 2026-09-17 Antigravity 독립 세션 검증(`.worktrees/m3-google-agent-search`, branch `antigravity/m3-google-agent-search`, Node `v24.14.1`, npm 11.11.0):
  - `npm run build`: Clean pass (0 TS errors)
  - `npm run test:arch`: 4/4 pass (0 layer boundary violations)
  - `test/integration/gate-b0.test.ts`: 3/3 pass (Palantir live sitemap & HTML normalization, GCP ADC secret leakage 0-byte isolation)
  - `test/contract/google-agent-search-adapter.test.ts`: 16/16 pass (53-char indexEntryId, batch splitting, T-09 cross-generation isolation, T-14 secret sanitization)
  - `test/integration/gate-t07-t08.test.ts`: 10/10 pass (T-07 full generation journaling, T-08 resume/abandon/pending/timeout)
  - `test/integration/gate-t15.test.ts`: 5/5 pass (T-15 writer lease, 4-way GC protections, dry-run vs apply)
  - 전체 회귀 테스트: `npm test` 35개 테스트 파일, 354/354 테스트 100% 통과 (0 failures, 0 skipped)
  - CLI 구동 검증: `docsctx doctor` (HEALTHY), `docsctx doctor --remote` (unavailable fail-closed 격리 확인), `docsctx index --help`, `docsctx gc --help`
- M0, M1, M2는 기존 baseline 완료 상태이고 M3는 오프라인 경로 기준 구현·검증 완료, live GCP activation은 후속 운영 승인 범위다.

