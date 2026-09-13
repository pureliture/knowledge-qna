# Knowledge QnA MCP 마일스톤 계획서 (Milestones)

- **참조 명세**:
  - 요구사항 정의서: [docs/specs/knowledge-qna-mcp/intention.md](./docs/specs/knowledge-qna-mcp/intention.md)
  - 상세 설계서: [docs/specs/knowledge-qna-mcp/design.md](./docs/specs/knowledge-qna-mcp/design.md)
  - 원본 요청서: [ORIGINAL_REQUEST.md](./ORIGINAL_REQUEST.md)
- **실행 계약**: agentic-execution
- **활성 슬라이스 (Active Slice)**: **M2 (Search Adapters, Token Budget & Retrieval Engine - COMPLETED & FULLY VERIFIED)**

---

## 마일스톤 개요 (Vertical Slices)

| 마일스톤 | 이름 | 범위 및 핵심 산출물 | 주요 검증 게이트 | 상태 |
|---|---|---|---|---|
| **M0** | Project Bootstrap & Stdio MCP Foundation | - Node 24 LTS, ESM, TypeScript strict 기반 부트스트랩<br>- 헥사고날 클린 아키텍처 계층 골격 수립 및 엄격한 디커플링<br>- 정규화 AST 기반 아키텍처 계층 경계 검증 테스트 강화<br>- 호스트 로컬 라이브러리 레지스트리 및 결정론적 매칭 구현<br>- Stdio MCP v2 서버 (`resolve_library`, `get_context`) 및 stdout 무결성 가드<br>- CLI 기본 명령어 (`docsctx serve`, `docsctx doctor`, `-c`, `-v` 지원) | T-01, T-10, Arch Test, Adversarial Tests | **완료 및 검증 완료 (VERIFIED - Gate Passed)** |
| **M1** | Canonical Corpus & SQLite Manifest Pipeline | - 허용 목록 기반 웹/Sitemap 문서 수집 및 304 조건부 GET<br>- 구조 보존 HTML → Markdown AST 정규화<br>- 표/코드블록 원자성 보존 AST 청킹 엔진<br>- SHA-256 콘텐츠 주소화 파일시스템 저장소 (`var/corpus/`)<br>- SQLite 단일 작성자 임대 및 매니페스트 카탈로그 (`var/manifest/catalog.sqlite`)<br>- `docsctx sync` 파이프라인 구현 | T-02, T-03, T-04, T-05, T-06 | **완료 및 최종 검증 완료 (COMPLETED & VERIFIED - Gate Passed)** |
| **M2** | Search Adapters, Token Budget & Retrieval Engine | - `SearchBackend` (읽기) 및 `IndexBackend` (색인) 포트 분리<br>- `js-tiktoken` (`cl100k_base`) 컨텍스트 토큰 예산 패킹 엔진<br>- 로컬 청크 수화, 출처(`S1`, `S2`) 매핑 및 검증<br>- 오프라인 테스트 및 복원 검증용 `InMemorySearchAdapter`<br>- `docsctx index`, `docsctx search` 구현 | T-09, T-11, T-12 | **완료 및 최종 검증 완료 (COMPLETED & VERIFIED - Gate Passed)** |
| **M3** | Google Agent Search, CLI Operations & Benchmark | - Google Agent Search 어댑터 및 ADC 인증<br>- 전체 CLI 명령어 세트 (`docsctx eval`, `docsctx gc`, `docsctx doctor --remote`)<br>- 검색 품질 평가 벤치마크 (Recall, MRR, nDCG, ContextHitRate)<br>- 동시성 임대 펜싱 및 복구 탄력성 검증 | T-13, T-14, T-15 | 대기 |

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
- Sentinel 독립 승리 감사(Victory Audit) 보고 단계로 진입.


