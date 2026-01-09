/**
 * 룰 태거 (LLM 기반)
 * 
 * 추출된 룰에 태그를 부여하여 코드와 매칭 가능하게 함
 * 
 * ═══════════════════════════════════════════════════════════════════
 * 금융권 원칙: "탐지는 넓게, 검증은 LLM"
 * ═══════════════════════════════════════════════════════════════════
 * 
 * - 문제를 놓치지 않는 것이 최우선 과제
 * - 패턴은 넓게 잡아서 후보를 많이 탐지
 * - LLM이 실제 문제인지 최종 검증
 * - pure_regex는 극히 제한적으로만 사용
 * 
 * @module tagger/ruleTagger
 */

import { getLLMClient } from '../clients/llmClient.js';
import { getTagDefinitionLoader } from './tagDefinitionLoader.js';
import logger from '../utils/loggerUtils.js';

export class RuleTagger {
  constructor() {
    this.llmClient = null;
    this.tagLoader = null;
    this.initialized = false;
    
    // pure_regex 허용 목록 (100% 확실한 경우만)
    this.pureRegexAllowList = [
      'System.out.print',
      'System.err.print',
      'printStackTrace',
      'TODO',
      'FIXME',
      'XXX',
      'HACK'
    ];
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.tagLoader = getTagDefinitionLoader();
    await this.tagLoader.initialize();

    this.initialized = true;
    logger.info('✅ RuleTagger 초기화 완료');
  }

  /**
   * 룰에 태그 부여
   * 
   * @param {Object} rule - 룰 객체
   * @returns {Promise<Object>} 태그가 부여된 룰
   */
  async tagRule(rule) {
    try {
      const prompt = this.buildTaggingPrompt(rule);
      
      const response = await this.llmClient.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 1500,
        system_prompt: 'You are an expert at categorizing Java code quality rules for financial systems. Respond only in valid JSON format.'
      });

      const tagResult = this.llmClient.cleanAndExtractJSON(response);

      if (!tagResult) {
        logger.warn(`룰 태깅 실패 (JSON 파싱): ${rule.ruleId}`);
        return this.applyFallbackTags(rule);
      }

      // checkType 검증 및 조정 (금융권 원칙)
      let checkType = tagResult.checkType || 'llm_contextual';
      let checkTypeReason = tagResult.reasoning || '';
      
      checkType = this.validateAndAdjustCheckType(checkType, rule, tagResult);

      // 태그 결과 적용 (패턴 정보 포함)
      return {
        ...rule,
        tagCondition: tagResult.tagCondition || null,
        requiredTags: tagResult.requiredTags || [],
        excludeTags: tagResult.excludeTags || [],
        checkType,
        checkTypeReason,
        // 패턴 정보 (이슈에서 코드가 있는 경우 LLM이 추출)
        antiPatterns: this.normalizePatterns(tagResult.antiPatterns),
        goodPatterns: this.normalizePatterns(tagResult.goodPatterns)
      };

    } catch (error) {
      logger.error(`룰 태깅 오류 (${rule.ruleId}):`, error.message);
      return this.applyFallbackTags(rule);
    }
  }

  /**
   * checkType 검증 및 조정 (금융권 원칙)
   * 
   * pure_regex는 극히 제한적으로만 허용
   * 확실하지 않으면 llm_with_regex 또는 llm_contextual로 변경
   */
  validateAndAdjustCheckType(checkType, rule, tagResult) {
    // pure_regex인 경우 허용 목록 확인
    if (checkType === 'pure_regex') {
      const titleLower = rule.title?.toLowerCase() || '';
      const descLower = rule.description?.toLowerCase() || '';
      const combinedText = `${titleLower} ${descLower}`;
      
      const isPureRegexAllowed = this.pureRegexAllowList.some(keyword => 
        combinedText.includes(keyword.toLowerCase())
      );
      
      if (!isPureRegexAllowed) {
        // pure_regex가 적절하지 않음 → llm_with_regex로 변경
        logger.info(`  🔄 [${rule.ruleId}] pure_regex → llm_with_regex (금융권 원칙: 문맥 검증 필요)`);
        return 'llm_with_regex';
      }
    }
    
    // llm_with_regex인데 antiPatterns이 없으면 llm_contextual로
    if (checkType === 'llm_with_regex') {
      const hasAntiPatterns = tagResult.antiPatterns && tagResult.antiPatterns.length > 0;
      if (!hasAntiPatterns) {
        logger.info(`  🔄 [${rule.ruleId}] llm_with_regex → llm_contextual (antiPatterns 없음)`);
        return 'llm_contextual';
      }
    }
    
    // llm_with_ast인데 AST 관련 키워드가 없으면 llm_contextual로
    if (checkType === 'llm_with_ast') {
      const astKeywords = ['복잡도', '길이', '깊이', '파라미터', 'complexity', 'length', 'depth', 'nesting'];
      const titleLower = rule.title?.toLowerCase() || '';
      const hasAstKeyword = astKeywords.some(kw => titleLower.includes(kw));
      
      if (!hasAstKeyword) {
        logger.info(`  🔄 [${rule.ruleId}] llm_with_ast → llm_contextual (AST 분석 불필요)`);
        return 'llm_contextual';
      }
    }
    
    return checkType;
  }

  /**
   * 룰 배치 태깅
   * 
   * @param {Object[]} rules - 룰 배열
   * @returns {Promise<Object[]>} 태그가 부여된 룰 배열
   */
  async tagRules(rules) {
    const taggedRules = [];

    for (const rule of rules) {
      const tagged = await this.tagRule(rule);
      taggedRules.push(tagged);
      
      // 간단한 딜레이 (API 부하 방지)
      await this._sleep(100);
    }

    logger.info(`총 ${taggedRules.length}개 룰 태깅 완료`);
    return taggedRules;
  }

  /**
   * 태깅 프롬프트 생성
   * 
   * 금융권 원칙: "탐지는 넓게, 검증은 LLM"
   * 
   * - 가이드라인: 텍스트 기반 (코드 없음)
   * - 이슈: 코드 예시 포함 (problematicCode, fixedCode)
   */
  buildTaggingPrompt(rule) {
    const tagDescriptions = this.tagLoader.getTagDescriptionsForPrompt();
    
    // 이슈에서 온 룰인 경우 코드 정보 포함
    const hasCode = rule.problematicCode || rule.fixedCode;
    
    let codeSection = '';
    if (hasCode) {
      codeSection = `
## 코드 예시 (패턴 추출 시 참고)
### 문제 코드
\`\`\`java
${(rule.problematicCode || '없음').substring(0, 800)}
\`\`\`

### 수정 코드
\`\`\`java
${(rule.fixedCode || '없음').substring(0, 800)}
\`\`\`
`;
    }

    return `당신은 금융권 Java 코드 품질 전문가입니다.
다음 규칙을 분석하고, 이 규칙이 적용되어야 하는 코드의 특성을 태그와 패턴으로 표현해주세요.

═══════════════════════════════════════════════════════════════════════════════
## 금융권 핵심 원칙: "탐지는 넓게, 검증은 LLM"
═══════════════════════════════════════════════════════════════════════════════

⚠️ 문제를 놓치지 않는 것이 최우선입니다.
- 놓치는 것(False Negative)보다 검토하는 것(False Positive)이 낫습니다
- 패턴은 넓게 작성하여 의심 코드를 최대한 탐지
- LLM이 실제 문제인지 최종 판단
- 확실하지 않으면 llm_contextual 또는 llm_with_regex 선택

═══════════════════════════════════════════════════════════════════════════════
## 규칙 정보
═══════════════════════════════════════════════════════════════════════════════
- ID: ${rule.ruleId}
- 제목: ${rule.title}
- 설명: ${rule.description}
- 카테고리: ${rule.category}
- 심각도: ${rule.severity}
${codeSection}
═══════════════════════════════════════════════════════════════════════════════
## ${tagDescriptions}

═══════════════════════════════════════════════════════════════════════════════
## checkType 선택 기준 (신중하게 선택)
═══════════════════════════════════════════════════════════════════════════════

### 1. pure_regex (극히 제한적으로 사용)
   ⚠️ 다음 경우에만 사용:
   - System.out.println, System.err.print
   - e.printStackTrace()
   - TODO, FIXME, XXX, HACK 주석
   
   ❌ 다음은 pure_regex 금지:
   - 빈 catch 블록 → 의도적 무시일 수 있음 (llm_with_regex)
   - SQL 연결 → 동적 쿼리가 아닐 수 있음 (llm_with_regex)
   - 리소스 미해제 → try-with-resources 여부 확인 필요 (llm_with_regex)

### 2. llm_with_regex (권장 - 대부분의 패턴 기반 규칙)
   ✅ 다음 경우에 사용:
   - 패턴으로 후보 탐지 가능하지만, 문맥에 따라 예외가 있을 수 있는 경우
   - 빈 catch 블록, SQL 문자열 연결, 리소스 관리, 하드코딩 값 등
   - antiPatterns으로 넓게 탐지 → LLM이 실제 위반인지 검증

### 3. llm_contextual (안전한 기본값)
   ✅ 다음 경우에 사용:
   - 패턴 정의가 어렵거나 의미론적 분석이 필요한 경우
   - 아키텍처 규칙, 비즈니스 로직, 레이어 위반 등
   - tagCondition으로 대상 코드 필터링 → LLM이 분석

### 4. llm_with_ast
   ✅ 다음 경우에 사용:
   - 코드 구조(AST) 정보가 핵심인 경우
   - 메서드 길이, 순환 복잡도, 중첩 깊이, 파라미터 수 등

═══════════════════════════════════════════════════════════════════════════════
## 출력 형식 (JSON)
═══════════════════════════════════════════════════════════════════════════════

{
  "tagCondition": "태그 논리 표현식 (예: USES_CONNECTION && !HAS_TRY_WITH_RESOURCES)",
  "requiredTags": ["필수 태그 배열 - 이 태그가 있어야 규칙 적용"],
  "excludeTags": ["제외 태그 배열 - 이 태그가 있으면 규칙 미적용"],
  "checkType": "llm_with_regex | llm_contextual | llm_with_ast | pure_regex",
  "antiPatterns": [
    {
      "pattern": "의심 코드 탐지 정규식 (넓게 작성)",
      "flags": "gi",
      "description": "패턴 설명"
    }
  ],
  "goodPatterns": [
    {
      "pattern": "정상 코드 패턴 (예외 처리용)",
      "flags": "g",
      "description": "이 패턴이 있으면 위반 아님"
    }
  ],
  "reasoning": "checkType 선택 이유와 태그 선택 근거"
}

═══════════════════════════════════════════════════════════════════════════════
## 패턴 작성 가이드 (넓게 작성)
═══════════════════════════════════════════════════════════════════════════════

1. antiPatterns은 의심 코드를 놓치지 않도록 넓게 작성
   - 좋음: "Connection\\s+\\w+" (모든 Connection 변수)
   - 나쁨: "Connection\\s+conn\\s*=" (특정 변수명만)

2. goodPatterns으로 정상 케이스를 제외
   - 예: try-with-resources 사용 시 리소스 누수 아님

3. JavaScript 정규식 문법 사용
   - 특수문자 이스케이프: \\., \\(, \\)
   - 대소문자 무시: flags에 "i" 추가

═══════════════════════════════════════════════════════════════════════════════
## 주의사항
═══════════════════════════════════════════════════════════════════════════════

1. 금융권에서는 문제를 놓치는 것이 가장 위험합니다
2. 확실하지 않으면 llm_with_regex 또는 llm_contextual 선택
3. pure_regex는 정말 100% 확실한 경우만 (System.out.print, printStackTrace 등)
4. 코드 예시가 있으면 반드시 참고하여 패턴 추출

JSON만 출력하세요.`;
  }

  /**
   * 패턴 배열 정규화
   * LLM이 문자열 배열이나 객체 배열로 반환할 수 있음
   */
  normalizePatterns(patterns) {
    if (!patterns || !Array.isArray(patterns)) {
      return [];
    }
    
    return patterns.map(p => {
      let patternStr, flags, description;
      
      // 이미 객체인 경우
      if (typeof p === 'object' && p.pattern) {
        patternStr = p.pattern;
        flags = p.flags || 'g';
        description = p.description || '';
      }
      // 문자열인 경우
      else if (typeof p === 'string') {
        patternStr = p;
        flags = 'g';
        description = '';
      }
      else {
        return null;
      }
      
      // 🔧 PCRE → JavaScript 변환
      const converted = this._convertPCREtoJS(patternStr, flags);
      patternStr = converted.pattern;
      flags = converted.flags;
      
      // 🔧 유효성 검증: RegExp로 변환 가능한지 테스트
      try {
        new RegExp(patternStr, flags);
        return { pattern: patternStr, flags, description };
      } catch (e) {
        // 추가 정제 시도
        const sanitized = this._sanitizePattern(patternStr);
        try {
          new RegExp(sanitized, flags);
          logger.debug(`패턴 자동 정제: "${patternStr.substring(0, 50)}"`);
          return { pattern: sanitized, flags, description };
        } catch (e2) {
          logger.warn(`⚠️ 유효하지 않은 패턴 제외: "${patternStr.substring(0, 50)}..." - ${e.message}`);
          return null;
        }
      }
    }).filter(p => p !== null && p.pattern);
  }
  
  /**
   * PCRE 정규식을 JavaScript RegExp로 변환
   * @private
   */
  _convertPCREtoJS(pattern, flags) {
    let newPattern = pattern;
    let newFlags = flags;
    
    // 1. Inline flags 추출 및 제거: (?i), (?s), (?m), (?x), (?imsx) 등
    const inlineFlagMatch = newPattern.match(/^\(\?([imsx]+)\)/);
    if (inlineFlagMatch) {
      const inlineFlags = inlineFlagMatch[1];
      newPattern = newPattern.replace(/^\(\?[imsx]+\)/, '');
      
      // flags에 추가 (중복 제거)
      if (inlineFlags.includes('i') && !newFlags.includes('i')) {
        newFlags += 'i';
      }
      if (inlineFlags.includes('m') && !newFlags.includes('m')) {
        newFlags += 'm';
      }
      // (?s) dotall - JavaScript에서는 [\\s\\S] 사용해야 함
      // (?x) verbose - JavaScript에서 미지원, 공백 제거 필요
    }
    
    // 2. 패턴 중간의 inline flags도 제거: (?i:...), (?:...) 등
    newPattern = newPattern.replace(/\(\?[imsx]+:/g, '(?:');
    newPattern = newPattern.replace(/\(\?[imsx]+\)/g, '');
    
    // 3. PCRE 전용 기능 변환
    // (?s) dotall 모드의 . → [\s\S]로 변환 (이미 [\s\S] 사용 중이면 유지)
    // 주의: 이건 복잡하므로 일단 보류
    
    // 4. Atomic groups (?>...) → (?:...) (JavaScript 미지원)
    newPattern = newPattern.replace(/\(\?>/g, '(?:');
    
    // 5. Possessive quantifiers ++, *+, ?+ → +, *, ? (JavaScript 미지원)
    newPattern = newPattern.replace(/\+\+/g, '+');
    newPattern = newPattern.replace(/\*\+/g, '*');
    newPattern = newPattern.replace(/\?\+/g, '?');
    
    // 6. Named groups (?P<name>...) → (?<name>...) (ES2018+)
    newPattern = newPattern.replace(/\(\?P</g, '(?<');
    
    // 7. Named backreference (?P=name) → \k<name> (ES2018+)
    newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
    
    return { pattern: newPattern, flags: newFlags };
  }
  
  /**
   * 패턴 추가 정제 (변환 후에도 실패할 경우)
   * @private
   */
  _sanitizePattern(pattern) {
    let sanitized = pattern;
    
    // 짝이 맞지 않는 괄호 제거 시도
    // 닫히지 않은 문자 클래스 [] 체크
    let bracketCount = 0;
    let parenCount = 0;
    let inBracket = false;
    
    for (let i = 0; i < sanitized.length; i++) {
      const char = sanitized[i];
      const prevChar = i > 0 ? sanitized[i - 1] : '';
      
      if (prevChar !== '\\') {
        if (char === '[' && !inBracket) {
          inBracket = true;
          bracketCount++;
        } else if (char === ']' && inBracket) {
          inBracket = false;
        } else if (char === '(' && !inBracket) {
          parenCount++;
        } else if (char === ')' && !inBracket) {
          parenCount--;
        }
      }
    }
    
    // 닫히지 않은 괄호가 있으면 간단히 제거
    if (parenCount > 0) {
      // 끝에 닫는 괄호 추가
      sanitized += ')'.repeat(parenCount);
    } else if (parenCount < 0) {
      // 시작에 여는 괄호 추가 (비정상적인 케이스)
      sanitized = '('.repeat(-parenCount) + sanitized;
    }
    
    // 닫히지 않은 문자 클래스
    if (inBracket) {
      sanitized += ']';
    }
    
    return sanitized;
  }
  
  /**
   * 정규식 특수문자 이스케이프
   * @private
   */
  _escapeRegexSpecialChars(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 폴백 태그 적용 (LLM 실패 시)
   * 
   * 금융권 원칙: 모든 폴백은 LLM 검증 포함 (pure_regex 제외)
   */
  applyFallbackTags(rule) {
    const category = rule.category?.toLowerCase() || 'general';
    
    // 카테고리 기반 기본 태그 (모두 LLM 검증 포함)
    const categoryTagMap = {
      'resource_management': {
        tagCondition: 'USES_CONNECTION || USES_STATEMENT || USES_RESULTSET || USES_STREAM',
        requiredTags: [],
        checkType: 'llm_with_regex',  // LLM 검증 필수
        antiPatterns: [
          { pattern: 'Connection\\s+\\w+', flags: 'g', description: 'Connection 변수 사용' },
          { pattern: 'Statement\\s+\\w+', flags: 'g', description: 'Statement 변수 사용' },
          { pattern: '\\.getConnection\\s*\\(', flags: 'g', description: 'getConnection 호출' }
        ],
        goodPatterns: [
          { pattern: 'try\\s*\\([^)]+\\)', flags: 'g', description: 'try-with-resources' }
        ]
      },
      'memory_leak': {
        tagCondition: 'USES_CONNECTION || USES_STATEMENT || USES_STREAM',
        requiredTags: [],
        checkType: 'llm_with_regex',
        antiPatterns: [
          { pattern: 'new\\s+\\w*(Stream|Reader|Writer|Connection)\\s*\\(', flags: 'g', description: '리소스 생성' }
        ],
        goodPatterns: [
          { pattern: 'try\\s*\\([^)]+\\)', flags: 'g', description: 'try-with-resources' },
          { pattern: '\\.close\\s*\\(\\s*\\)', flags: 'g', description: 'close 호출' }
        ]
      },
      'security': {
        tagCondition: 'HAS_SQL_CONCATENATION || HAS_HARDCODED_PASSWORD',
        requiredTags: [],
        checkType: 'llm_with_regex',  // SQL Injection 등은 문맥 확인 필요
        antiPatterns: [
          { pattern: '"SELECT[^"]*"\\s*\\+', flags: 'gi', description: 'SQL 문자열 연결' },
          { pattern: '"INSERT[^"]*"\\s*\\+', flags: 'gi', description: 'SQL 문자열 연결' },
          { pattern: '"UPDATE[^"]*"\\s*\\+', flags: 'gi', description: 'SQL 문자열 연결' },
          { pattern: '"DELETE[^"]*"\\s*\\+', flags: 'gi', description: 'SQL 문자열 연결' },
          { pattern: 'password\\s*=\\s*"[^"]+"', flags: 'gi', description: '하드코딩된 비밀번호' }
        ],
        goodPatterns: []
      },
      'exception_handling': {
        tagCondition: 'HAS_EMPTY_CATCH || HAS_GENERIC_CATCH',
        requiredTags: [],
        checkType: 'llm_with_regex',  // 의도적 무시 vs 실수 판단 필요
        antiPatterns: [
          { pattern: 'catch\\s*\\([^)]+\\)\\s*\\{\\s*\\}', flags: 'g', description: '빈 catch 블록' },
          { pattern: 'catch\\s*\\(\\s*Exception\\s+\\w+\\s*\\)', flags: 'g', description: '범용 Exception 캐치' }
        ],
        goodPatterns: [
          { pattern: 'logger\\.(error|warn|info)', flags: 'g', description: '로깅 있음' },
          { pattern: '//\\s*(ignore|intentional|의도)', flags: 'gi', description: '의도적 무시 주석' }
        ]
      },
      'performance': {
        tagCondition: 'HAS_DB_CALL_IN_LOOP || HAS_NESTED_LOOP',
        requiredTags: [],
        checkType: 'llm_contextual',  // N+1 등 의미 분석 필요
        antiPatterns: [],
        goodPatterns: []
      },
      'concurrency': {
        tagCondition: 'HAS_LOOP',
        requiredTags: [],
        checkType: 'llm_contextual',  // 동시성 이슈는 문맥 분석 필요
        antiPatterns: [],
        goodPatterns: []
      },
      'architecture': {
        tagCondition: 'IS_CONTROLLER || IS_SERVICE || IS_DAO',
        requiredTags: [],
        checkType: 'llm_contextual',  // 레이어 위반 등 의미 분석 필요
        antiPatterns: [],
        goodPatterns: []
      },
      'business_logic': {
        tagCondition: 'IS_SERVICE || IS_DAO',
        requiredTags: [],
        checkType: 'llm_contextual',  // 비즈니스 로직 오류는 LLM 필수
        antiPatterns: [],
        goodPatterns: []
      },
      'validation': {
        tagCondition: 'IS_CONTROLLER || IS_SERVICE',
        requiredTags: [],
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      },
      'database': {
        tagCondition: 'USES_CONNECTION || USES_STATEMENT || IS_DAO',
        requiredTags: [],
        checkType: 'llm_with_regex',
        antiPatterns: [
          { pattern: 'executeQuery\\s*\\(', flags: 'g', description: 'DB 쿼리 실행' },
          { pattern: 'executeUpdate\\s*\\(', flags: 'g', description: 'DB 업데이트 실행' }
        ],
        goodPatterns: []
      },
      'transaction': {
        tagCondition: 'IS_SERVICE',
        requiredTags: [],
        checkType: 'llm_contextual',  // 트랜잭션 경계는 의미 분석 필요
        antiPatterns: [],
        goodPatterns: []
      },
      'logging': {
        tagCondition: 'IS_SERVICE || IS_CONTROLLER',
        requiredTags: [],
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      },
      'api_integration': {
        tagCondition: 'IS_SERVICE',
        requiredTags: [],
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      }
    };

    const defaultTags = categoryTagMap[category] || {
      tagCondition: null,
      requiredTags: [],
      checkType: 'llm_contextual',  // 기본값: LLM 검증
      antiPatterns: [],
      goodPatterns: []
    };

    logger.info(`  📋 [${rule.ruleId}] 폴백 태그 적용 (${category} → ${defaultTags.checkType})`);

    return {
      ...rule,
      tagCondition: defaultTags.tagCondition,
      requiredTags: defaultTags.requiredTags,
      excludeTags: [],
      checkType: defaultTags.checkType,
      checkTypeReason: `폴백: ${category} 카테고리 기본값`,
      antiPatterns: defaultTags.antiPatterns,
      goodPatterns: defaultTags.goodPatterns
    };
  }

  /**
   * sleep 유틸리티
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 싱글톤 인스턴스
 */
let instance = null;

export function getRuleTagger() {
  if (!instance) {
    instance = new RuleTagger();
  }
  return instance;
}

export default RuleTagger;
