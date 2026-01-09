# 🔍 Code Quality Checker

금융권 Java 코드 품질 점검 시스템 - 태그 기반 룰 매칭 + LLM 검증

## 📋 목차

- [개요](#개요)
- [아키텍처](#아키텍처)
- [요구사항](#요구사항)
- [설치](#설치)
- [설정](#설정)
- [사용법](#사용법)
- [핵심 모듈](#핵심-모듈)
- [운영 가이드](#운영-가이드)
- [개발 가이드](#개발-가이드)
- [트러블슈팅](#트러블슈팅)

---

## 개요

### 프로젝트 소개

이 시스템은 금융권 Java 코드를 자동으로 분석하여 개발 가이드라인 위반 사항을 탐지합니다.

**핵심 기능:**
- 📖 개발 가이드(docx)에서 룰 자동 추출
- 📋 이슈 이력(csv)에서 룰 자동 추출  
- 🏷️ 코드 태깅 (정규식/AST/메트릭 기반)
- 🔍 태그 기반 룰 매칭
- 🤖 LLM 기반 위반 검증
- 📊 상세 점검 리포트 생성

### v4.0 checkType 기반 검사

| checkType | 설명 | LLM 사용 |
|-----------|------|---------|
| `pure_regex` | 정규식만으로 100% 판정 | ❌ |
| `llm_with_regex` | 정규식 후보 → LLM 검증 | ✅ |
| `llm_contextual` | 태그/키워드 필터 → LLM 분석 | ✅ |
| `llm_with_ast` | AST 조건 + LLM 하이브리드 | ✅ |

---

## 아키텍처

### 시스템 구성

```
┌─────────────────────────────────────────────────────────────┐
│                    Code Quality Checker                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │  Guideline  │    │    Issue    │    │    Code     │      │
│  │  Extractor  │    │  Extractor  │    │   Checker   │      │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘      │
│         │                  │                  │              │
│         ▼                  ▼                  ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Qdrant Client                     │    │
│  │              (태그 기반 룰 저장/조회)                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                           ▲                                  │
│                           │                                  │
│  ┌─────────────┐    ┌─────┴─────┐    ┌─────────────┐        │
│  │  Code       │    │   Java    │    │    LLM      │        │
│  │  Tagger     │◄───│   AST     │    │   Client    │        │
│  │             │    │  Parser   │    │  (vLLM)     │        │
│  └─────────────┘    └───────────┘    └─────────────┘        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      External Services                       │
├─────────────────┬───────────────────────────────────────────┤
│    Qdrant       │              vLLM Server                   │
│  Vector DB      │           (LLM Inference)                  │
│  (Port 6333)    │             (Port 8000)                    │
└─────────────────┴───────────────────────────────────────────┘
```

### 점검 흐름

```
Java 코드 입력
       │
       ▼
┌──────────────────┐
│   Code Tagger    │ ← 태그 추출 (50+ 정규식 패턴)
│                  │   - 리소스, 예외처리, 보안
│                  │   - 아키텍처, 루프, 동시성
└────────┬─────────┘
         │ tags[]
         ▼
┌──────────────────┐
│  Qdrant Client   │ ← 태그 조건 매칭
│                  │   - requiredTags, excludeTags
│                  │   - tagCondition 표현식
└────────┬─────────┘
         │ matchedRules[]
         ▼
┌──────────────────┐
│  Code Checker    │ ← v4.0 단계적 필터링
│  preFilterRules  │   - pure_regex → 즉시 판정
│  verifyWithLLM   │   - LLM 후보 → 통합 검증
└────────┬─────────┘
         │ issues[]
         ▼
    점검 리포트
```

### 디렉토리 구조

```
code-quality-checker/
├── src/
│   ├── main.js                 # CLI 진입점
│   ├── config/
│   │   └── config.js           # 환경 설정
│   ├── clients/
│   │   ├── llmClient.js        # vLLM 클라이언트 (457줄)
│   │   └── qdrantClient.js     # Qdrant 클라이언트 (746줄)
│   ├── ast/
│   │   └── javaAstParser.js    # Java AST 파서 (701줄)
│   ├── tagger/
│   │   ├── codeTagger.js       # 코드 태거 (707줄)
│   │   └── tagDefinitionLoader.js
│   ├── checker/
│   │   ├── codeChecker.js      # 코드 점검기 (912줄)
│   │   └── resultBuilder.js    # 결과 빌더
│   ├── extractor/
│   │   ├── guidelineExtractor.js
│   │   └── issueExtractor.js
│   └── utils/
│       ├── fileUtils.js
│       ├── codeUtils.js
│       └── loggerUtils.js
├── assets/
│   ├── tags/                   # 태그 정의
│   └── schema/                 # 룰 스키마
├── input/
│   ├── guidelines/             # 개발 가이드 (docx)
│   ├── issues/                 # 이슈 CSV
│   └── code/                   # 점검 대상 Java
├── output/
│   ├── rules/                  # 추출된 룰 JSON
│   └── reports/                # 점검 리포트
├── package.json
├── .env                        # 환경 변수
└── README.md
```

---

## 요구사항

### 시스템 요구사항

| 항목 | 최소 | 권장 |
|------|------|------|
| Node.js | 18.x | 20.x |
| RAM | 4GB | 8GB |
| Disk | 1GB | 5GB |

### 외부 서비스

| 서비스 | 버전 | 용도 |
|--------|------|------|
| **Qdrant** | 1.7+ | 벡터 DB (룰 저장/조회) |
| **vLLM** | 0.4+ | LLM 추론 서버 |

### 지원 LLM 모델

- Qwen2.5-Coder-32B-Instruct (권장)
- Qwen2.5-Coder-14B-Instruct
- CodeLlama-34B-Instruct
- 기타 vLLM 지원 모델

---

## 설치

### 1. 프로젝트 클론

```bash
git clone <repository-url>
cd code-quality-checker
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 환경 변수 설정

```bash
cp .env.example .env
# .env 파일 편집
```

### 4. 디렉토리 생성

```bash
mkdir -p input/guidelines input/issues input/code
mkdir -p output/rules output/reports
```

### 5. Qdrant 설치 및 실행

```bash
# Docker 사용
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant

# 또는 바이너리 직접 실행
./qdrant
```

### 6. vLLM 서버 실행

```bash
# vLLM 서버 시작
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2.5-Coder-32B-Instruct \
    --port 8000 \
    --tensor-parallel-size 4
```

---

## 설정

### 환경 변수 (.env)

```bash
# ═══════════════════════════════════════════════════════════
# vLLM 설정
# ═══════════════════════════════════════════════════════════
VLLM_BASE_URL=http://localhost:8000
VLLM_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct
VLLM_TIMEOUT=180000
VLLM_MAX_RETRIES=3

# ═══════════════════════════════════════════════════════════
# Qdrant 설정
# ═══════════════════════════════════════════════════════════
QDRANT_HOST=localhost
QDRANT_PORT=6333
QDRANT_COLLECTION=rules
# QDRANT_API_KEY=your-api-key  # 인증 필요시

# ═══════════════════════════════════════════════════════════
# 로깅 설정
# ═══════════════════════════════════════════════════════════
LOG_LEVEL=info  # debug, info, warn, error
```

### 설정 파일 (src/config/config.js)

```javascript
export const config = {
  llm: {
    baseUrl: process.env.VLLM_BASE_URL || 'http://localhost:8000',
    model: process.env.VLLM_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
    timeout: parseInt(process.env.VLLM_TIMEOUT) || 180000,
    maxRetries: parseInt(process.env.VLLM_MAX_RETRIES) || 3
  },
  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT) || 6333,
    collectionName: process.env.QDRANT_COLLECTION || 'rules',
    vectorDimensions: 1536
  },
  paths: {
    input: {
      guidelines: './input/guidelines',
      issues: './input/issues',
      code: './input/code'
    },
    output: {
      rules: './output/rules',
      reports: './output/reports'
    }
  }
};
```

---

## 사용법

### CLI 명령어

```bash
# 도움말
npm run help
# 또는
node src/main.js help

# 개발 가이드에서 룰 추출
npm run extract-guidelines
# 또는
node src/main.js extract-guidelines

# 이슈 CSV에서 룰 추출
npm run extract-issues
# 또는
node src/main.js extract-issues

# 코드 점검
npm run check
# 또는
node src/main.js check
```

### 워크플로우

#### 1단계: 룰 추출 (최초 1회 또는 가이드 변경 시)

```bash
# 개발 가이드 파일 준비
cp 개발가이드.docx input/guidelines/

# 룰 추출 실행
npm run extract-guidelines
```

**출력 예시:**
```
🚀 코드 품질 점검 시스템
==================================================

📖 개발 가이드에서 룰 추출
--------------------------------------------------
✅ LLMClient 초기화 완료
✅ Qdrant 클라이언트 초기화 완료
📄 처리 중: 개발가이드.docx
   - 추출된 룰: 45개
   - Qdrant 저장 완료

📊 결과:
   - 처리 파일: 1개
   - 추출된 룰: 45개
   - 저장 위치: output/rules/guidelines_1704067200000.json

✅ 완료 (12345ms)
```

#### 2단계: 코드 점검

```bash
# 점검 대상 파일 준비
cp *.java input/code/

# 점검 실행
npm run check
```

**출력 예시:**
```
🚀 코드 품질 점검 시스템
==================================================

🔍 코드 점검
--------------------------------------------------
✅ CodeChecker 초기화 완료
점검: UserService.java
[UserService.java] 태그 12개: USES_CONNECTION, HAS_TRY_CATCH, ...
[UserService.java] 매칭된 룰 5개
[UserService.java] → pure_regex 위반: 2개
[UserService.java] → LLM 후보: 3개
[UserService.java] 이슈 4개 발견 (2341ms)

📊 UserService.java
────────────────────────────────────────
🔴 CRITICAL (1개)
   [25행] SQL_INJECTION_RISK
         SQL 문자열 연결 발견
         제안: PreparedStatement 사용

🟠 HIGH (2개)
   [42행] RESOURCE_LEAK
         Connection이 finally에서 close되지 않음
         제안: try-with-resources 사용

   [67행] EMPTY_CATCH_BLOCK
         예외를 무시하고 있음
         제안: 적절한 예외 처리 또는 로깅 추가

🟡 MEDIUM (1개)
   [89행] GENERIC_EXCEPTION
         catch(Exception e) 사용
         제안: 구체적인 예외 타입 사용

📁 리포트 저장: output/reports/check_1704067200000.json

✅ 완료 (5678ms)
```

### 프로그래밍 방식 사용

```javascript
import { getCodeChecker } from './src/checker/codeChecker.js';
import { getCodeTagger } from './src/tagger/codeTagger.js';

// 코드 점검
async function checkMyCode() {
  const checker = getCodeChecker();
  await checker.initialize();
  
  const code = `
    public class UserService {
      public void getUser(String id) {
        Connection conn = dataSource.getConnection();
        String sql = "SELECT * FROM users WHERE id = '" + id + "'";
        // ...
      }
    }
  `;
  
  const result = await checker.checkCode(code, 'UserService.java');
  console.log(result.issues);
}

// 태그만 추출
async function extractTags() {
  const tagger = getCodeTagger();
  await tagger.initialize();
  
  const result = await tagger.extractTags(code, { useLLM: false });
  console.log(result.tags);
  // ['USES_CONNECTION', 'HAS_SQL_CONCATENATION', ...]
}
```

---

## 핵심 모듈

### 1. LLMClient (llmClient.js)

vLLM 서버와 통신하는 클라이언트

**주요 기능:**
- vLLM OpenAI-compatible API 호출
- 재시도 로직 (지수 백오프)
- JSON 응답 추출

```javascript
import { getLLMClient } from './src/clients/llmClient.js';

const llm = getLLMClient();
await llm.initialize();

const response = await llm.generateCompletion(prompt, {
  temperature: 0.1,
  max_tokens: 2000
});

const json = llm.cleanAndExtractJSON(response);
```

### 2. QdrantClient (qdrantClient.js)

Qdrant 벡터 DB와 통신하는 클라이언트

**주요 기능:**
- 룰 저장/조회
- 태그 조건 매칭
- AND/OR/NOT 표현식 평가

```javascript
import { getQdrantClient } from './src/clients/qdrantClient.js';

const qdrant = getQdrantClient();
await qdrant.initialize();

// 룰 저장
await qdrant.storeRule({
  ruleId: 'SQL_INJECTION',
  title: 'SQL Injection 방지',
  checkType: 'pure_regex',
  antiPatterns: [{ pattern: '["\'"]\\s*\\+\\s*\\w+.*SELECT', flags: 'gi' }],
  requiredTags: ['HAS_SQL_CONCATENATION'],
  severity: 'CRITICAL'
});

// 태그 기반 조회
const rules = await qdrant.findRulesByTags(['USES_CONNECTION', 'HAS_SQL_CONCATENATION']);
```

### 3. JavaASTParser (javaAstParser.js)

Java 코드 분석기 (정규식 기반)

**주요 기능:**
- 클래스/메서드/변수 추출
- 순환 복잡도 계산
- 리소스 누수 분석
- 보안 취약점 탐지

```javascript
import { getJavaAstParser } from './src/ast/javaAstParser.js';

const parser = getJavaAstParser();
const result = parser.parseJavaCode(javaCode);

console.log(result.analysis.cyclomaticComplexity);
console.log(result.analysis.resourceLifecycles);
console.log(result.analysis.securityPatterns);
```

### 4. CodeTagger (codeTagger.js)

코드에서 태그를 추출하는 모듈

**지원 태그 (50+개):**

| 카테고리 | 태그 예시 |
|----------|----------|
| 리소스 | USES_CONNECTION, HAS_TRY_WITH_RESOURCES, HAS_CLOSE_CALL |
| 예외처리 | HAS_TRY_CATCH, HAS_EMPTY_CATCH, HAS_GENERIC_CATCH |
| 보안 | HAS_SQL_CONCATENATION, HAS_HARDCODED_PASSWORD |
| 아키텍처 | IS_CONTROLLER, IS_SERVICE, IS_DAO |
| 루프 | HAS_FOR_LOOP, HAS_WHILE_LOOP, HAS_STREAM_API |
| 동시성 | HAS_SYNCHRONIZED, USES_LOCK, USES_ATOMIC |
| 로깅 | HAS_LOGGER, USES_SYSOUT |

```javascript
import { getCodeTagger } from './src/tagger/codeTagger.js';

const tagger = getCodeTagger();
await tagger.initialize();

const result = await tagger.extractTags(code, { useLLM: true });
console.log(result.tags);
console.log(result.details); // 소스별 태그
console.log(result.stats);   // 통계
```

### 5. CodeChecker (codeChecker.js)

통합 코드 점검기

**점검 흐름:**
1. 코드 태깅 (CodeTagger)
2. 룰 조회 (QdrantClient)
3. checkType별 사전 필터링
4. pure_regex 즉시 판정
5. LLM 후보 통합 검증
6. 결과 정리

```javascript
import { getCodeChecker } from './src/checker/codeChecker.js';

const checker = getCodeChecker();
await checker.initialize();

// 단일 파일 점검
const result = await checker.checkCode(code, 'MyClass.java');

// 디렉토리 전체 점검
const allResults = await checker.checkAll();

// 통계 조회
console.log(checker.getFilteringStats());
```

---

## 운영 가이드

### 서비스 시작 순서

```bash
# 1. Qdrant 시작
docker-compose up -d qdrant

# 2. vLLM 서버 시작
./start-vllm.sh

# 3. 연결 확인
curl http://localhost:6333/collections
curl http://localhost:8000/v1/models

# 4. 룰 로딩 (최초 1회)
npm run extract-guidelines
```

### Docker Compose 예시

```yaml
version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    restart: unless-stopped

  code-checker:
    build: .
    environment:
      - VLLM_BASE_URL=http://vllm:8000
      - QDRANT_HOST=qdrant
      - QDRANT_PORT=6333
    volumes:
      - ./input:/app/input
      - ./output:/app/output
    depends_on:
      - qdrant

volumes:
  qdrant_data:
```

### 모니터링

#### 로그 레벨 설정

```bash
# 상세 로그
LOG_LEVEL=debug npm run check

# 경고만
LOG_LEVEL=warn npm run check
```

#### 통계 확인

```javascript
const checker = getCodeChecker();
const stats = checker.getFilteringStats();

console.log(stats);
// {
//   totalChecks: 10,
//   pureRegexViolations: 15,
//   llmCandidates: 23,
//   llmCalls: 8,
//   falsePositivesFiltered: 5
// }
```

### 백업

```bash
# Qdrant 스냅샷 생성
curl -X POST "http://localhost:6333/collections/rules/snapshots"

# 룰 JSON 백업
cp -r output/rules/ backup/rules_$(date +%Y%m%d)/
```

### 성능 튜닝

#### vLLM 최적화

```bash
# GPU 메모리 최적화
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2.5-Coder-32B-Instruct \
    --gpu-memory-utilization 0.9 \
    --max-model-len 8192 \
    --tensor-parallel-size 4
```

#### 배치 크기 조정

```javascript
// codeChecker.js에서 배치 크기 조정
const batchSize = 5; // 기본값
```

---

## 개발 가이드

### 새 태그 추가

```javascript
// src/tagger/codeTagger.js

initializeRegexPatterns() {
  // 기존 패턴들...
  
  // 새 태그 추가
  this.regexPatterns.set('HAS_CUSTOM_PATTERN', /your-regex-here/);
}
```

### 새 룰 타입 추가

```javascript
// src/checker/codeChecker.js

preFilterRules(sourceCode, astAnalysis, rules, tags) {
  // ...
  
  case 'your_new_type':
    // 새 checkType 처리 로직
    break;
}
```

### 테스트

```javascript
// 싱글톤 리셋
import { resetCodeChecker } from './src/checker/codeChecker.js';
import { resetLLMClient } from './src/clients/llmClient.js';

beforeEach(() => {
  resetCodeChecker();
  resetLLMClient();
});
```

### 코드 스타일

```javascript
// ES Modules 사용
import { something } from './module.js';

// 싱글톤 패턴
let instance = null;
export function getInstance() {
  if (!instance) instance = new Class();
  return instance;
}

// async/await 사용
async function doSomething() {
  try {
    const result = await asyncOperation();
    return result;
  } catch (error) {
    logger.error('Error:', error.message);
    throw error;
  }
}
```

---

## 트러블슈팅

### 연결 오류

#### Qdrant 연결 실패

```bash
# 상태 확인
curl http://localhost:6333/health

# Docker 로그
docker logs qdrant

# 해결: 포트 확인
netstat -tlnp | grep 6333
```

#### vLLM 연결 실패

```bash
# 상태 확인
curl http://localhost:8000/v1/models

# 해결: GPU 메모리 확인
nvidia-smi

# 해결: 모델 경로 확인
ls -la /path/to/model
```

### 성능 이슈

#### LLM 응답 느림

```bash
# 타임아웃 증가
VLLM_TIMEOUT=300000 npm run check

# 또는 .env에서 설정
VLLM_TIMEOUT=300000
```

#### 메모리 부족

```bash
# Node.js 힙 크기 증가
NODE_OPTIONS="--max-old-space-size=4096" npm run check
```

### JSON 파싱 오류

```javascript
// LLM 응답이 JSON이 아닌 경우
const result = llm.cleanAndExtractJSON(response);
if (!result) {
  logger.warn('JSON 추출 실패, 원본:', response);
  // 폴백 처리
}
```

### 태그 매칭 안됨

```javascript
// 디버그 모드로 태그 확인
LOG_LEVEL=debug npm run check

// 또는 직접 확인
const tagger = getCodeTagger();
const result = await tagger.extractTags(code);
console.log('추출된 태그:', result.tags);
console.log('상세:', result.details);
```

### 룰이 조회되지 않음

```javascript
// Qdrant에서 직접 확인
const qdrant = getQdrantClient();
const allRules = await qdrant.getAllRules();
console.log('저장된 룰 수:', allRules.length);

// 태그 조건 확인
const rule = allRules.find(r => r.ruleId === 'YOUR_RULE');
console.log('requiredTags:', rule.requiredTags);
console.log('tagCondition:', rule.tagCondition);
```

---

## 라이선스

MIT License

---

## 연락처

- 이슈: [GitHub Issues](https://github.com/your-repo/issues)
- 이메일: your-email@example.com
