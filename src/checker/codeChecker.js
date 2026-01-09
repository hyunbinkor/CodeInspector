/**
 * 코드 점검기 (통합 버전)
 * 
 * 기존 프로젝트의 DevelopmentGuidelineChecker.js 핵심 로직 통합
 * - v4.0 checkType 기반 단계적 필터링
 * - pure_regex: 정규식만으로 판정 (LLM 스킵)
 * - llm_with_regex: 정규식 후보 → LLM 검증
 * - llm_contextual: 태그/키워드 필터 → LLM 분석
 * - llm_with_ast: AST 정보 + LLM 검증
 * 
 * @module checker/codeChecker
 */

import path from 'path';
import { getCodeTagger } from '../tagger/codeTagger.js';
import { getQdrantClient } from '../clients/qdrantClient.js';
import { getLLMClient } from '../clients/llmClient.js';
import { getJavaAstParser } from '../ast/javaAstParser.js';
import { getResultBuilder } from './resultBuilder.js';
import { listFiles, readTextFile, writeJsonFile } from '../utils/fileUtils.js';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

/**
 * v4.0 규칙 검사 타입 상수 (기존 guidelineChecker.js)
 */
const CHECK_TYPES = {
  PURE_REGEX: 'pure_regex',           // 정규식만으로 100% 판정 (LLM 스킵)
  LLM_WITH_REGEX: 'llm_with_regex',   // 정규식 후보 → LLM 검증
  LLM_CONTEXTUAL: 'llm_contextual',   // 의미론적 분석 (LLM 전담)
  LLM_WITH_AST: 'llm_with_ast'        // AST + LLM 하이브리드
};

export class CodeChecker {
  constructor() {
    this.codeTagger = null;
    this.qdrantClient = null;
    this.llmClient = null;
    this.astParser = null;
    this.resultBuilder = null;
    this.initialized = false;

    // 유효한 checkType (v4.0)
    this.validCheckTypes = ['pure_regex', 'llm_with_regex', 'llm_contextual', 'llm_with_ast'];

    // 필터링 통계 (기존 guidelineChecker.js)
    this.filteringStats = {
      totalChecks: 0,
      pureRegexViolations: 0,
      llmCandidates: 0,
      llmCalls: 0,
      falsePositivesFiltered: 0
    };
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    logger.info('🔧 CodeChecker 초기화 중...');

    this.codeTagger = getCodeTagger();
    await this.codeTagger.initialize();

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.astParser = getJavaAstParser();
    this.resultBuilder = getResultBuilder();

    this.initialized = true;
    logger.info('✅ CodeChecker 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 메인 점검 메서드
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 입력 디렉토리의 모든 Java 파일 점검
   */
  async checkAll() {
    const inputDir = config.paths.input.code;
    const files = await listFiles(inputDir, '.java');

    if (files.length === 0) {
      logger.warn(`Java 파일 없음: ${inputDir}`);
      return { reports: [], files: 0 };
    }

    logger.info(`${files.length}개 Java 파일 발견`);

    const allReports = [];

    for (const filePath of files) {
      const report = await this.checkFile(filePath);
      allReports.push(report);
    }

    // 전체 요약
    const summary = this.resultBuilder.buildSummary(allReports);

    // 결과 저장
    const outputPath = path.join(
      config.paths.output.reports,
      `check_${Date.now()}.json`
    );
    await writeJsonFile(outputPath, {
      checkedAt: new Date().toISOString(),
      summary,
      reports: allReports,
      stats: this.filteringStats
    });

    logger.info(`점검 완료: ${allReports.length}개 파일`);
    logger.info(`총 이슈: ${summary.totalIssues}개`);

    return {
      reports: allReports,
      summary,
      files: files.length,
      outputPath,
      stats: this.filteringStats
    };
  }

  /**
   * 단일 파일 점검
   */
  async checkFile(filePath) {
    const fileName = path.basename(filePath);
    logger.info(`점검: ${fileName}`);

    try {
      const code = await readTextFile(filePath);
      const result = await this.checkCode(code, fileName);

      return {
        file: fileName,
        path: filePath,
        ...result
      };
    } catch (error) {
      logger.error(`파일 점검 실패: ${fileName}`, error.message);
      return {
        file: fileName,
        path: filePath,
        success: false,
        error: error.message,
        tags: [],
        issues: []
      };
    }
  }

  /**
   * 코드 점검 (메인 로직 - v4.0)
   * 
   * 처리 흐름 (기존 guidelineChecker.js checkRules):
   * 1. 코드 태깅 (프로파일 생성)
   * 2. 태그 기반 룰 조회
   * 3. preFilterRules()로 checkType별 사전 필터링
   * 4. pure_regex 즉시 판정
   * 5. LLM 후보 통합 검증
   * 6. 중복 제거 및 결과 정리
   */
  async checkCode(code, fileName = 'unknown') {
    const startTime = Date.now();
    this.filteringStats.totalChecks++;

    // Step 1: 코드 태깅
    logger.debug(`[${fileName}] 태깅 시작...`);
    const taggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const tags = taggingResult.tags;
    logger.info(`[${fileName}] 태그 ${tags.length}개: ${tags.slice(0, 5).join(', ')}...`);

    // Step 2: AST 분석
    const astResult = this.astParser.parseJavaCode(code);
    const astAnalysis = astResult.analysis;

    // Step 3: 태그 기반 룰 조회
    logger.debug(`[${fileName}] 룰 조회...`);
    const matchedRules = await this.qdrantClient.findRulesByTags(tags);
    logger.info(`[${fileName}] 매칭된 룰 ${matchedRules.length}개`);

    if (matchedRules.length === 0) {
      return {
        success: true,
        tags,
        matchedRules: [],
        issues: [],
        duration: Date.now() - startTime
      };
    }

    // Step 4: v4.0 사전 필터링 (checkType별)
    logger.info(`[${fileName}] checkType별 사전 필터링...`);
    const filterResult = this.preFilterRules(code, astAnalysis, matchedRules, tags);

    logger.info(`[${fileName}] → pure_regex 위반: ${filterResult.pureRegexViolations.length}개`);
    logger.info(`[${fileName}] → LLM 후보: ${filterResult.llmCandidates.total}개`);

    this.filteringStats.pureRegexViolations += filterResult.pureRegexViolations.length;
    this.filteringStats.llmCandidates += filterResult.llmCandidates.total;

    // Step 5: pure_regex 위반 수집
    const issues = [...filterResult.pureRegexViolations];

    // Step 6: LLM 검증 (후보가 있을 때만)
    if (filterResult.llmCandidates.total > 0) {
      logger.info(`[${fileName}] LLM 통합 검증...`);
      this.filteringStats.llmCalls++;

      const llmViolations = await this.verifyWithLLM(
        code, astAnalysis, filterResult.llmCandidates, fileName
      );
      issues.push(...llmViolations);
    }

    // Step 7: 중복 제거
    const uniqueIssues = this.deduplicateViolations(issues);

    // Step 8: 결과 빌드
    const report = this.resultBuilder.buildReport({
      fileName,
      code,
      tags,
      matchedRules,
      issues: uniqueIssues,
      duration: Date.now() - startTime
    });

    logger.info(`[${fileName}] 이슈 ${uniqueIssues.length}개 발견 (${Date.now() - startTime}ms)`);

    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // v4.0 사전 필터링 (기존 guidelineChecker.js preFilterRules)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * checkType별 사전 필터링
   */
  preFilterRules(sourceCode, astAnalysis, rules, tags) {
    const pureRegexViolations = [];
    const llmCandidates = {
      llm_with_regex: [],
      llm_contextual: [],
      llm_with_ast: [],
      total: 0
    };

    const tagSet = new Set(tags);

    for (const rule of rules) {
      const checkType = rule.checkType || 'llm_contextual';

      switch (checkType) {
        case 'pure_regex':
          // 정규식 직접 매칭 → 즉시 위반 판정
          const regexResult = this.checkPureRegex(sourceCode, rule);
          if (regexResult.violations.length > 0) {
            pureRegexViolations.push(...regexResult.violations);
          }
          break;

        case 'llm_with_regex':
          // 정규식으로 후보 탐지 → LLM 검증 대상
          const candidates = this.findRegexCandidates(sourceCode, rule);
          if (candidates.length > 0) {
            llmCandidates.llm_with_regex.push({ rule, candidates });
            llmCandidates.total += 1;
          }
          break;

        case 'llm_contextual':
          // 태그/키워드 필터링 → LLM 검증 대상
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
          break;

        case 'llm_with_ast':
          // AST 조건 확인 → LLM 검증 대상
          if (this.matchesAstCondition(sourceCode, astAnalysis, rule)) {
            llmCandidates.llm_with_ast.push({ rule, astAnalysis });
            llmCandidates.total += 1;
          }
          break;

        default:
          // 알 수 없는 checkType → llm_contextual로 처리
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
      }
    }

    return { pureRegexViolations, llmCandidates };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // pure_regex 검사 (기존 guidelineChecker.js checkPureRegex)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 순수 정규식 검사 (LLM 없음)
   */
  checkPureRegex(sourceCode, rule) {
    const violations = [];
    const lines = sourceCode.split('\n');

    // antiPatterns 검사
    if (rule.antiPatterns && rule.antiPatterns.length > 0) {
      for (const antiPattern of rule.antiPatterns) {
        try {
          // RegExp 객체이면 그대로, 아니면 생성
          const regex = antiPattern.regex instanceof RegExp
            ? antiPattern.regex
            : new RegExp(antiPattern.pattern || antiPattern, antiPattern.flags || 'g');

          let match;
          // 정규식 리셋
          regex.lastIndex = 0;

          while ((match = regex.exec(sourceCode)) !== null) {
            // 매칭 위치의 라인 번호 계산
            const beforeMatch = sourceCode.substring(0, match.index);
            const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;

            // goodPatterns로 예외 처리
            const lineContent = lines[lineNumber - 1] || '';
            if (this.matchesGoodPattern(lineContent, rule.goodPatterns)) {
              continue;
            }

            violations.push({
              ruleId: rule.ruleId,
              title: rule.title,
              line: lineNumber,
              column: match.index - beforeMatch.lastIndexOf('\n'),
              severity: rule.severity || 'MEDIUM',
              description: antiPattern.description || rule.description,
              suggestion: rule.examples?.good?.[0] || rule.suggestion || '패턴을 수정하세요',
              category: rule.category || 'general',
              checkType: 'pure_regex',
              source: 'code_checker_regex'
            });

            // 같은 규칙에서 너무 많은 위반 방지
            if (violations.filter(v => v.ruleId === rule.ruleId).length >= 5) {
              break;
            }
          }
        } catch (error) {
          logger.warn(`정규식 오류 [${rule.ruleId}]: ${error.message}`);
        }
      }
    }

    return { violations };
  }

  /**
   * goodPattern 매칭 여부 확인 (기존 guidelineChecker.js)
   */
  matchesGoodPattern(lineContent, goodPatterns) {
    if (!goodPatterns || goodPatterns.length === 0) return false;

    for (const goodPattern of goodPatterns) {
      try {
        const regex = goodPattern.regex instanceof RegExp
          ? goodPattern.regex
          : new RegExp(goodPattern.pattern || goodPattern, goodPattern.flags || 'g');

        if (regex.test(lineContent)) {
          return true;
        }
      } catch (error) {
        // 무시
      }
    }

    return false;
  }

  /**
   * 정규식으로 후보 탐지 (llm_with_regex용)
   */
  findRegexCandidates(sourceCode, rule) {
    const candidates = [];
    const lines = sourceCode.split('\n');

    if (!rule.antiPatterns || rule.antiPatterns.length === 0) {
      return candidates;
    }

    for (const antiPattern of rule.antiPatterns) {
      try {
        const regex = antiPattern.regex instanceof RegExp
          ? antiPattern.regex
          : new RegExp(antiPattern.pattern || antiPattern, antiPattern.flags || 'g');

        let match;
        regex.lastIndex = 0;

        while ((match = regex.exec(sourceCode)) !== null) {
          const beforeMatch = sourceCode.substring(0, match.index);
          const lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;
          const lineContent = lines[lineNumber - 1] || '';

          // goodPattern 체크
          if (this.matchesGoodPattern(lineContent, rule.goodPatterns)) {
            continue;
          }

          candidates.push({
            line: lineNumber,
            content: lineContent.trim(),
            matchedText: match[0],
            patternDescription: antiPattern.description || ''
          });

          // 최대 10개 후보
          if (candidates.length >= 10) break;
        }
      } catch (error) {
        logger.warn(`후보 탐지 오류 [${rule.ruleId}]: ${error.message}`);
      }
    }

    return candidates;
  }

  /**
   * 컨텍스트 조건 매칭 (llm_contextual용)
   */
  matchesContextualCondition(sourceCode, rule, tagSet) {
    // 키워드 매칭
    if (rule.keywords && rule.keywords.length > 0) {
      const lowerCode = sourceCode.toLowerCase();
      const hasKeyword = rule.keywords.some(kw =>
        lowerCode.includes(String(kw).toLowerCase())
      );
      if (hasKeyword) return true;
    }

    // 태그 조건 매칭 (requiredTags)
    if (rule.requiredTags && rule.requiredTags.length > 0) {
      const allTagsPresent = rule.requiredTags.every(tag => tagSet.has(tag));
      if (allTagsPresent) return true;
    }

    // tagCondition 표현식
    if (rule.tagCondition) {
      return this.qdrantClient.evaluateExpression(rule.tagCondition, tagSet);
    }

    return false;
  }

  /**
   * AST 조건 매칭 (llm_with_ast용)
   */
  matchesAstCondition(sourceCode, astAnalysis, rule) {
    const astHints = rule.astHints || {};

    // nodeTypes 체크
    if (astHints.nodeTypes && astHints.nodeTypes.length > 0) {
      const presentNodeTypes = astAnalysis.nodeTypes || [];
      const hasRequiredNode = astHints.nodeTypes.some(nt =>
        presentNodeTypes.includes(nt)
      );
      if (!hasRequiredNode) return false;
    }

    // maxLineCount 체크
    if (astHints.maxLineCount) {
      const methodDeclarations = astAnalysis.methodDeclarations || [];
      const hasLongMethod = this.hasAnyLongMethod(sourceCode, astHints.maxLineCount);
      if (!hasLongMethod) return false;
    }

    // maxCyclomaticComplexity 체크
    if (astHints.maxCyclomaticComplexity) {
      const complexity = astAnalysis.cyclomaticComplexity || 1;
      if (complexity <= astHints.maxCyclomaticComplexity) return false;
    }

    return true;
  }

  /**
   * 긴 메서드 존재 여부 확인 (기존 guidelineChecker.js)
   */
  hasAnyLongMethod(sourceCode, maxLineCount) {
    const lines = sourceCode.split('\n');
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      if (methodPattern.test(lines[i])) {
        const methodInfo = this.findMethodAtLine(lines, i + 1);
        if (methodInfo.found) {
          const length = methodInfo.endLine - methodInfo.startLine + 1;
          if (length > maxLineCount) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 메서드 시작/끝 라인 찾기 (기존 guidelineChecker.js)
   */
  findMethodAtLine(lines, targetLine) {
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = Math.min(targetLine - 1, lines.length - 1); i >= 0; i--) {
      const line = lines[i];
      const match = line.match(methodPattern);

      if (match) {
        let braceCount = 0;
        let endLine = i;

        for (let j = i; j < lines.length; j++) {
          for (const char of lines[j]) {
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
          }

          if (braceCount === 0 && j > i) {
            endLine = j;
            break;
          }
        }

        return {
          found: true,
          name: match[1],
          startLine: i,
          endLine: endLine
        };
      }
    }

    return { found: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // LLM 검증 (기존 guidelineChecker.js verifyWithSectionedPrompt)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * LLM 통합 검증
   */
  async verifyWithLLM(sourceCode, astAnalysis, llmCandidates, fileName) {
    const violations = [];

    try {
      // 섹션별 통합 프롬프트 생성
      const prompt = this.buildSectionedPrompt(sourceCode, llmCandidates);

      const response = await this.llmClient.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 3000
      });

      // 응답 파싱
      const parsed = this.llmClient.cleanAndExtractJSON(response);
      if (parsed && parsed.violations && Array.isArray(parsed.violations)) {
        for (const v of parsed.violations) {
          if (v.violation === true || v.violation === undefined) {
            // 해당 규칙 찾기
            const allRules = [
              ...llmCandidates.llm_with_regex.map(i => i.rule),
              ...llmCandidates.llm_contextual.map(i => i.rule),
              ...llmCandidates.llm_with_ast.map(i => i.rule)
            ];
            const rule = allRules.find(r => r.ruleId === v.ruleId);
            const checkType = rule?.checkType || 'llm_contextual';

            violations.push({
              ruleId: v.ruleId || 'UNKNOWN',
              title: v.title || rule?.title || '',
              line: v.line || 0,
              severity: rule?.severity || 'MEDIUM',
              description: v.description || '',
              suggestion: v.suggestion || '',
              confidence: v.confidence || 0.8,
              category: rule?.category || 'general',
              checkType: checkType,
              source: 'code_checker_llm'
            });
          }
        }
      }

    } catch (error) {
      logger.warn(`[${fileName}] LLM 검증 실패: ${error.message}`);
      // 폴백: 배치 검증
      const fallbackViolations = await this.fallbackBatchVerification(sourceCode, llmCandidates);
      violations.push(...fallbackViolations);
    }

    return violations;
  }

  /**
   * 섹션별 통합 프롬프트 생성 (기존 guidelineChecker.js)
   */
  buildSectionedPrompt(sourceCode, llmCandidates) {
    const truncatedCode = this.truncateCode(sourceCode, 3000);

    let sections = [];

    // llm_with_regex 섹션
    if (llmCandidates.llm_with_regex.length > 0) {
      const regexSection = llmCandidates.llm_with_regex.map(item => {
        const candidateLines = item.candidates.map(c => `    - 라인 ${c.line}: ${c.content}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}
${item.rule.description || ''}
**의심 위치:**
${candidateLines}`;
      }).join('\n\n');

      sections.push(`## 1. 정규식 후보 검증 (llm_with_regex)
${regexSection}`);
    }

    // llm_contextual 섹션
    if (llmCandidates.llm_contextual.length > 0) {
      const contextSection = llmCandidates.llm_contextual.map(item => 
        `### [${item.rule.ruleId}] ${item.rule.title}
${item.rule.description || ''}
키워드: ${(item.rule.keywords || []).join(', ')}`
      ).join('\n\n');

      sections.push(`## 2. 컨텍스트 분석 (llm_contextual)
${contextSection}`);
    }

    // llm_with_ast 섹션
    if (llmCandidates.llm_with_ast.length > 0) {
      const astSection = llmCandidates.llm_with_ast.map(item => {
        const checkPoints = (item.rule.checkPoints || []).map(cp => `    - ${cp}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}
${item.rule.astDescription || item.rule.description || ''}
**체크포인트:**
${checkPoints}`;
      }).join('\n\n');

      sections.push(`## 3. AST 기반 분석 (llm_with_ast)
${astSection}`);
    }

    return `다음 Java 코드에서 제시된 규칙들의 위반 여부를 검사해주세요.

## 검사 대상 코드
\`\`\`java
${truncatedCode}
\`\`\`

${sections.join('\n\n')}

## 출력 형식 (JSON)
\`\`\`json
{
  "violations": [
    {
      "ruleId": "규칙 ID",
      "title": "규칙 제목",
      "violation": true,
      "line": 위반 라인 번호,
      "description": "구체적인 위반 내용",
      "suggestion": "수정 제안",
      "confidence": 0.9
    }
  ]
}
\`\`\`

## 주의사항
1. 확실한 위반만 보고하세요 (애매한 경우 제외)
2. violation이 false인 경우 포함하지 마세요
3. 위반이 없으면 violations를 빈 배열로 반환하세요

JSON만 출력하세요.`;
  }

  /**
   * LLM 실패 시 배치 폴백 (기존 guidelineChecker.js)
   */
  async fallbackBatchVerification(sourceCode, llmCandidates) {
    const violations = [];
    const allRules = [
      ...llmCandidates.llm_with_regex.map(i => i.rule),
      ...llmCandidates.llm_contextual.map(i => i.rule),
      ...llmCandidates.llm_with_ast.map(i => i.rule)
    ];

    if (allRules.length === 0) return violations;

    const batchSize = 3;
    for (let i = 0; i < allRules.length; i += batchSize) {
      const batch = allRules.slice(i, i + batchSize);
      try {
        const batchViolations = await this.checkRulesBatchLLM(sourceCode, batch);
        violations.push(...batchViolations);
      } catch (error) {
        logger.warn(`배치 폴백 실패: ${error.message}`);
      }

      if (i + batchSize < allRules.length) {
        await this._sleep(300);
      }
    }

    return violations;
  }

  /**
   * 규칙 배치 LLM 검사 (기존 guidelineChecker.js)
   */
  async checkRulesBatchLLM(sourceCode, rules) {
    const rulesDescription = rules.map(rule => {
      const goodExamples = rule.examples?.good || [];
      const badExamples = rule.examples?.bad || [];

      return `### ${rule.title} (${rule.ruleId})
${rule.description || ''}

올바른 예시:
${goodExamples.length > 0 ? goodExamples.map(ex => `- ${ex}`).join('\n') : '- (없음)'}

잘못된 예시:
${badExamples.length > 0 ? badExamples.map(ex => `- ${ex}`).join('\n') : '- (없음)'}`;
    }).join('\n---\n');

    const prompt = `다음 Java 코드가 제시된 개발 가이드라인들을 준수하는지 검사해주세요.

## 검사 대상 코드:
\`\`\`java
${this.truncateCode(sourceCode, 2000)}
\`\`\`

## 적용할 가이드라인들:
${rulesDescription}

## 검사 결과 형식 (JSON):
\`\`\`json
{
  "violations": [
    {
      "ruleId": "규칙 ID",
      "title": "규칙 제목",
      "violation": true,
      "line": 위반 라인 번호,
      "description": "구체적인 위반 내용",
      "suggestion": "수정 제안"
    }
  ]
}
\`\`\`

위반사항이 없으면 violations를 빈 배열로 반환해주세요.`;

    const response = await this.llmClient.generateCompletion(prompt, {
      temperature: 0.1,
      max_tokens: 1500
    });

    return this.parseBatchResponse(response, rules);
  }

  /**
   * 배치 응답 파싱 (기존 guidelineChecker.js)
   */
  parseBatchResponse(response, rules) {
    const violations = [];

    try {
      const parsed = this.llmClient.cleanAndExtractJSON(response);

      if (parsed && parsed.violations && Array.isArray(parsed.violations)) {
        for (const v of parsed.violations) {
          if (v.violation === true || v.violation === undefined) {
            const rule = rules.find(r => r.ruleId === v.ruleId);

            violations.push({
              ruleId: v.ruleId || 'UNKNOWN',
              title: v.title || rule?.title || '',
              line: v.line || 0,
              severity: rule?.severity || 'MEDIUM',
              description: v.description || '',
              suggestion: v.suggestion || '',
              category: rule?.category || 'general',
              checkType: rule?.checkType || 'llm_contextual',
              source: 'code_checker_batch'
            });
          }
        }
      }
    } catch (error) {
      logger.warn(`배치 응답 파싱 실패: ${error.message}`);
    }

    return violations;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 유틸리티 메서드
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 위반사항 중복 제거 (기존 guidelineChecker.js)
   */
  deduplicateViolations(violations) {
    const seen = new Map();

    return violations.filter(violation => {
      const key = `${violation.line}-${violation.ruleId}-${violation.column || 0}`;
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, true);
      return true;
    });
  }

  /**
   * 코드 길이 제한 (기존 guidelineChecker.js)
   */
  truncateCode(code, maxLength) {
    if (!code || code.length <= maxLength) {
      return code;
    }

    const half = Math.floor(maxLength / 2);
    const start = code.substring(0, half);
    const end = code.substring(code.length - half);

    return `${start}\n\n// ... (${code.length - maxLength} characters truncated) ...\n\n${end}`;
  }

  /**
   * 필터링 통계 조회
   */
  getFilteringStats() {
    return { ...this.filteringStats };
  }

  /**
   * 필터링 통계 리셋
   */
  resetFilteringStats() {
    this.filteringStats = {
      totalChecks: 0,
      pureRegexViolations: 0,
      llmCandidates: 0,
      llmCalls: 0,
      falsePositivesFiltered: 0
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

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════════

let instance = null;

export function getCodeChecker() {
  if (!instance) {
    instance = new CodeChecker();
  }
  return instance;
}

export function resetCodeChecker() {
  instance = null;
}

/**
 * CLI용 래퍼 함수
 */
export async function checkCode() {
  const checker = getCodeChecker();
  await checker.initialize();
  return await checker.checkAll();
}

export default CodeChecker;
