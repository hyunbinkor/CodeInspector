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
 * 변경사항 (v4.4):
 * - [Fix] tagRule: tagCondition 검증 실패 시 LLM 재호출 (최대 2회)
 * - [Fix] validateTagCondition: 대문자 태그명+논리연산자만 허용, 소문자/코드 차단
 * - [Fix] buildTaggingPrompt: tagCondition 작성 규칙 명시, isRetry 강조 경고 추가
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 룰 태깅 (tagCondition 검증 실패 시 재시도)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 룰에 태그 부여
   *
   * tagCondition 검증 실패 시 최대 2회까지 LLM 재호출.
   * 2회 모두 실패하면 tagCondition=null로 나머지 필드는 살려서 반환.
   * JSON 파싱 자체가 실패하면 applyFallbackTags() 적용.
   *
   * @param {Object} rule - 룰 객체
   * @returns {Promise<Object>} 태그가 부여된 룰
   */
  async tagRule(rule) {
    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const isRetry = attempt > 1;
        const prompt = this.buildTaggingPrompt(rule, isRetry);

        const response = await this.llmClient.generateCompletion(prompt, {
          temperature: isRetry ? 0.0 : 0.1,  // 재시도 시 더 결정론적으로
          max_tokens: 1500,
          system_prompt: 'You are an expert at categorizing Java code quality rules for financial systems. Respond only in valid JSON format.'
        });

        const tagResult = this.llmClient.cleanAndExtractJSON(response);

        if (!tagResult) {
          logger.warn(`[${rule.ruleId}] JSON 파싱 실패 (시도 ${attempt}/${MAX_RETRIES})`);
          if (attempt === MAX_RETRIES) return this.applyFallbackTags(rule);
          continue;
        }

        // ✅ [Fix v4.4] tagCondition 유효성 검증
        const tagConditionError = this.validateTagCondition(tagResult.tagCondition);
        if (tagConditionError) {
          logger.warn(`[${rule.ruleId}] tagCondition 검증 실패 (시도 ${attempt}/${MAX_RETRIES}): ${tagConditionError}`);
          logger.warn(`  → 잘못된 값: "${String(tagResult.tagCondition).substring(0, 80)}"`);

          if (attempt < MAX_RETRIES) {
            continue;  // 재시도
          }

          // 마지막 시도도 실패 → tagCondition만 null, 나머지는 살림
          logger.warn(`[${rule.ruleId}] tagCondition 포기 → null 저장, 나머지 필드는 유지`);
          tagResult.tagCondition = null;
        }

        // checkType 검증 및 조정 (금융권 원칙)
        const checkType = this.validateAndAdjustCheckType(
          tagResult.checkType || 'llm_contextual', rule, tagResult
        );

        return {
          ...rule,
          tagCondition: tagResult.tagCondition || null,
          requiredTags: tagResult.requiredTags || [],
          excludeTags: tagResult.excludeTags || [],
          checkType,
          checkTypeReason: tagResult.reasoning || '',
          antiPatterns: this.normalizePatterns(tagResult.antiPatterns),
          goodPatterns: this.normalizePatterns(tagResult.goodPatterns)
        };

      } catch (error) {
        logger.error(`[${rule.ruleId}] 태깅 오류 (시도 ${attempt}/${MAX_RETRIES}):`, error.message);
        if (attempt === MAX_RETRIES) return this.applyFallbackTags(rule);
      }
    }

    return this.applyFallbackTags(rule);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // tagCondition 유효성 검증
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * tagCondition 유효성 검증
   *
   * 대문자 태그명([A-Z][A-Z0-9_]*)과 논리연산자(&&, ||, !, 괄호, 공백)만 허용.
   * 소문자, 점(.), 메서드 호출 등 실제 Java 코드가 섞이면 오류 반환.
   *
   * @param {string|null} tagCondition
   * @returns {string|null} 오류 메시지 (null이면 정상)
   */
  validateTagCondition(tagCondition) {
    if (!tagCondition) return null;  // null/undefined는 허용 (선택 필드)
    if (typeof tagCondition !== 'string') return 'tagCondition이 문자열이 아님';

    const trimmed = tagCondition.trim();
    if (trimmed === '') return null;  // 빈 문자열도 허용

    // 대문자 태그명 + &&/||/! + () + 공백만 허용
    // 소문자, 점(.), 따옴표, 숫자로 시작하는 토큰 등은 불허
    if (!/^[A-Z0-9_&|!()\s]+$/.test(trimmed)) {
      return `허용되지 않은 문자 포함 (소문자·점·메서드 호출 등 실제 코드 의심): "${trimmed.substring(0, 60)}"`;
    }

    // 실제로 평가 가능한지 테스트 (괄호 불균형 등 방지)
    try {
      const testExpr = trimmed.replace(/\b[A-Z][A-Z0-9_]*\b/g, 'false');
      new Function(`return (${testExpr})`)();
    } catch (e) {
      return `표현식 평가 불가: ${e.message}`;
    }

    return null;  // 정상
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // checkType 검증 및 조정
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 배치 태깅
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 프롬프트 생성
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 태깅 프롬프트 생성
   *
   * 금융권 원칙: "탐지는 넓게, 검증은 LLM"
   * - 가이드라인: 텍스트 기반 (코드 없음)
   * - 이슈: 코드 예시 포함 (problematicCode, fixedCode)
   *
   * @param {Object} rule - 룰 객체
   * @param {boolean} isRetry - 재시도 여부 (tagCondition 오류 강조 경고 추가)
   */
  buildTaggingPrompt(rule, isRetry = false) {
    const tagDescriptions = this.tagLoader.getTagDescriptionsForPrompt();

    const hasCode = rule.problematicCode || rule.fixedCode;
    let codeSection = '';
    if (hasCode) {
      codeSection = `
## 코드 예시 (antiPatterns/goodPatterns 작성 시 참고용)
⚠️ 아래 코드는 정규식 패턴 작성에만 참고하세요. tagCondition에 코드를 넣지 마세요.

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

    // ✅ [Fix v4.4] 재시도 시 tagCondition 오류 강조 경고를 프롬프트 맨 앞에 배치
    const retryWarning = isRetry ? `
⛔⛔⛔ 이전 응답이 거부되었습니다 ⛔⛔⛔
tagCondition에 소문자 식별자나 실제 Java 코드(예: writer.setRecord, conn.close())가
포함되어 있었습니다. 이는 절대 금지입니다.
tagCondition에는 아래 태그 목록의 대문자 태그명과 &&/||/! 연산자만 사용하세요.

` : '';

    return `당신은 금융권 Java 코드 품질 전문가입니다.
다음 규칙을 분석하고, 이 규칙이 적용되어야 하는 코드의 특성을 태그와 패턴으로 표현해주세요.
${retryWarning}
═══════════════════════════════════════════════════════════════════════════════
## 금융권 핵심 원칙: "탐지는 넓게, 검증은 LLM"
═══════════════════════════════════════════════════════════════════════════════

⚠️ 문제를 놓치지 않는 것이 최우선입니다.
- 놓치는 것(False Negative)보다 검토하는 것(False Positive)이 낫습니다
- 패턴은 넓게 작성하여 의심 코드를 최대한 탐지
- LLM이 실제 문제인지 최종 판단
- 확실하지 않으면 llm_contextual 또는 llm_with_regex 선택

═══════════════════════════════════════════════════════════════════════════════
## ⛔ tagCondition 작성 규칙 (위반 시 응답 전체 거부됨)
═══════════════════════════════════════════════════════════════════════════════

tagCondition에는 반드시 아래 [사용 가능한 태그 목록]에 있는 태그명만 사용하세요.

✅ 허용: 대문자 태그명, &&, ||, !, ()
   올바른 예시: "USES_CONNECTION && !HAS_TRY_WITH_RESOURCES"
   올바른 예시: "IS_SERVICE || IS_DAO"
   올바른 예시: "HAS_EMPTY_CATCH && !HAS_CLOSE_CALL"

❌ 절대 금지 (이 중 하나라도 있으면 응답 거부):
   - 소문자 식별자: writer, conn, record, service 등
   - 점(.) 포함: writer.setRecord, conn.close()
   - 메서드 호출 형식: hasConnection(), isValid()
   - 코드 예시의 변수명이나 메서드명
   - 태그 목록에 없는 임의 이름

코드 예시(badExample, goodExample)는 antiPatterns/goodPatterns 패턴 작성에만 참고하고
tagCondition에는 절대 코드를 넣지 마세요.

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
  "tagCondition": "대문자 태그명과 &&/||/! 연산자만 사용. 소문자·코드·메서드 호출 절대 금지",
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

JSON만 출력하세요.`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 패턴 정규화
  // ═══════════════════════════════════════════════════════════════════════════

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

      if (typeof p === 'object' && p.pattern) {
        patternStr = p.pattern;
        flags = p.flags || 'g';
        description = p.description || '';
      } else if (typeof p === 'string') {
        patternStr = p;
        flags = 'g';
        description = '';
      } else {
        return null;
      }

      // PCRE → JavaScript 변환
      const converted = this._convertPCREtoJS(patternStr, flags);
      patternStr = converted.pattern;
      flags = converted.flags;

      // 유효성 검증
      try {
        new RegExp(patternStr, flags);
        return { pattern: patternStr, flags, description };
      } catch (e) {
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
    const flagSet = new Set(flags.split('').filter(Boolean));

    // 1. 패턴 어디에나 있는 인라인 플래그 (?i) (?s) (?m) (?x) (?-i) 등 전부 처리
    //    패턴 중간에 있어도 동일하게 적용
    newPattern = newPattern.replace(/\(\?([a-zA-Z\-]+)\)/g, (match, flagStr) => {
      let negate = false;
      for (const ch of flagStr) {
        if (ch === '-') { negate = true; continue; }
        if (negate) continue;           // (?-i) 비활성화 → 제거만
        if (ch === 'i') flagSet.add('i');
        else if (ch === 'm') flagSet.add('m');
        else if (ch === 's') flagSet.add('s'); // ← 핵심 수정: s 플래그 추가
        // x(verbose)는 JS 미지원, 무시
      }
      return '';  // 인라인 플래그 패턴 제거
    });

    // 2. 패턴 중간의 (?i:...) 형태 → (?:...)
    newPattern = newPattern.replace(/\(\?[imsx]+:/g, '(?:');

    // 3. Atomic groups (?>...) → (?:...)
    newPattern = newPattern.replace(/\(\?>/g, '(?:');

    // 4. Possessive quantifiers
    newPattern = newPattern.replace(/\+\+/g, '+');
    newPattern = newPattern.replace(/\*\+/g, '*');
    newPattern = newPattern.replace(/\?\+/g, '?');

    // 5. Named groups (?P<name>...) → (?<name>...)
    newPattern = newPattern.replace(/\(\?P</g, '(?<');

    // 6. Named backreference (?P=name) → \k<name>
    newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');

    return { pattern: newPattern, flags: [...flagSet].join('') };
  }

  /**
   * 패턴 추가 정제 (변환 후에도 실패할 경우)
   * @private
   */
  _sanitizePattern(pattern) {
    let sanitized = pattern;
    let parenCount = 0;
    let inBracket = false;

    for (let i = 0; i < sanitized.length; i++) {
      const char = sanitized[i];
      const prevChar = i > 0 ? sanitized[i - 1] : '';

      if (prevChar !== '\\') {
        if (char === '[' && !inBracket) inBracket = true;
        else if (char === ']' && inBracket) inBracket = false;
        else if (char === '(' && !inBracket) parenCount++;
        else if (char === ')' && !inBracket) parenCount--;
      }
    }

    if (parenCount > 0) sanitized += ')'.repeat(parenCount);
    else if (parenCount < 0) sanitized = '('.repeat(-parenCount) + sanitized;
    if (inBracket) sanitized += ']';

    return sanitized;
  }

  /**
   * 정규식 특수문자 이스케이프
   * @private
   */
  _escapeRegexSpecialChars(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 폴백 태그
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 폴백 태그 적용 (LLM 실패 시)
   *
   * 금융권 원칙: 모든 폴백은 LLM 검증 포함 (pure_regex 제외)
   */
  applyFallbackTags(rule) {
    const category = rule.category?.toLowerCase() || 'general';

    const categoryTagMap = {
      'resource_management': {
        tagCondition: 'USES_CONNECTION || USES_STATEMENT || USES_RESULTSET || USES_STREAM',
        requiredTags: [],
        checkType: 'llm_with_regex',
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
        checkType: 'llm_with_regex',
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
        checkType: 'llm_with_regex',
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
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      },
      'concurrency': {
        tagCondition: 'HAS_LOOP',
        requiredTags: [],
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      },
      'architecture': {
        tagCondition: 'IS_CONTROLLER || IS_SERVICE || IS_DAO',
        requiredTags: [],
        checkType: 'llm_contextual',
        antiPatterns: [],
        goodPatterns: []
      },
      'business_logic': {
        tagCondition: 'IS_SERVICE || IS_DAO',
        requiredTags: [],
        checkType: 'llm_contextual',
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
        checkType: 'llm_contextual',
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
      checkType: 'llm_contextual',
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 유틸리티
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * sleep 유틸리티
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════════════════════════

let instance = null;

export function getRuleTagger() {
  if (!instance) {
    instance = new RuleTagger();
  }
  return instance;
}

export default RuleTagger;