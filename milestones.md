# Knowledge QnA MCP 마일스톤 계획서 (Milestones)

- **참조 명세**:
  - 요구사항 정의서: [docs/specs/knowledge-qna-mcp/intention.md](./docs/specs/knowledge-qna-mcp/intention.md)
  - 상세 설계서: [docs/specs/knowledge-qna-mcp/design.md](./docs/specs/knowledge-qna-mcp/design.md)
  - 원본 요청서: [ORIGINAL_REQUEST.md](./ORIGINAL_REQUEST.md)
- **실행 계약**: agentic-execution
- **활성 슬라이스 (Active Slice)**: **M0 (Iteration 2: Remediation 완료)**

---

## 마일스톤 개요 (Vertical Slices)

| 마일스톤 | 이름 | 범위 및 핵심 산출물 | 주요 검증 게이트 | 상태 |
|---|---|---|---|---|
| **M0** | Project Bootstrap & Stdio MCP Foundation | - Node 24 LTS, ESM, TypeScript strict 기반 부트스트랩<br>- 헥사고날 클린 아키텍처 계층 골격 수립 및 엄격한 디커플링<br>- 정규화 AST 기반 아키텍처 계층 경계 검증 테스트 강화<br>- 호스트 로컬 라이브러리 레지스트리 및 결정론적 매칭 구현<br>- Stdio MCP v2 서버 (`resolve_library`, `get_context`) 및 stdout 무결성 가드<br>- CLI 기본 명령어 (`docsctx serve`, `docsctx doctor`, `-c`, `-v` 지원) | T-01, T-10, Arch Test, Adversarial Tests | **치유 완료 (REMEDIATED - Gate Ready)** |
| **M1** | Canonical Corpus & SQLite Manifest Pipeline | - 허용 목록 기반 웹/Sitemap 문서 수집 및 304 조건부 GET<br>- 구조 보존 HTML → Markdown AST 정규화<br>- 표/코드블록 원자성 보존 AST 청킹 엔진<br>- SHA-256 콘텐츠 주소화 파일시스템 저장소 (`var/corpus/`)<br>- SQLite 단일 작성자 임대 및 매니페스트 카탈로그 (`var/manifest/catalog.sqlite`)<br>- `docsctx sync` 파이프라인 구현 | T-02, T-03, T-04, T-05, T-06 | 대기 |
| **M2** | Search Adapters, Token Budget & Retrieval Engine | - `SearchBackend` (읽기) 및 `IndexBackend` (색인) 포트 분리<br>- `js-tiktoken` (`cl100k_base`) 컨텍스트 토큰 예산 패킹 엔진<br>- 로컬 청크 수화, 출처(`S1`, `S2`) 매핑 및 검증<br>- 오프라인 테스트 및 복원 검증용 `InMemorySearchAdapter`<br>- `docsctx index`, `docsctx search` 구현 | T-09, T-11, T-12 | 대기 |
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

### 3. 다음 작업 (Next Action)
- M0 Iteration 2 Remediation 리뷰 및 감사(Auditor verification) 통과 후 Milestone M1 (Canonical Corpus & SQLite Manifest Pipeline: 웹 수집, AST 정규화 및 청킹, SQLite 카탈로그) 착수.
