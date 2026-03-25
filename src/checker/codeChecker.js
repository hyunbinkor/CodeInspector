/**
 * 코드 점검기 (통합 버전)
 *
 * 기존 프로젝트의 DevelopmentGuidelineChecker.js 핵심 로직 통합
 * - v4.0 checkType 기반 단계적 필터링
 * - pure_regex     : 정규식만으로 판정 (LLM 스킵)
 * - llm_with_regex : 정규식 후보 → LLM 검증
 * - llm_contextual : 태그/키워드 필터 → LLM 분석
 * - llm_with_ast   : AST 정보 + LLM 검증
 * - 3000줄 이상 자동 청킹 지원
 *
 * 변경사항:
 * - [Fix] checkCodeDirect(): limit 50 → 200, tags 누락 인수 추가
 * - [Fix] verifyWithLLM(): addLineNumbers()로 번호 붙인 코드 LLM 전달
 * - [Fix] buildSingleRulePrompt(): 라인번호 안내 추가
 * - [Fix] checkPureRegex() / findRegexCandidates() / matchesGoodPattern():
 *         new RegExp() → safeRegExp() 교체
 *         → LLM 생성 패턴의 (?s)/(?i)/(?m) 인라인 플래그 등
 *           JavaScript 비호환 PCRE 문법에 의한 "Invalid group" 에러 해소
 *
 * @module checker/codeChecker
 */

import path from 'path';
import { getCodeTagger }    from '../tagger/codeTagger.js';
import { getQdrantClient }  from '../clients/qdrantClient.js';
import { getLLMClient }     from '../clients/llmClient.js';
import { getJavaAstParser } from '../ast/javaAstParser.js';
import { getResultBuilder } from './resultBuilder.js';
import { MethodChunker }     from '../chunker/methodChunker.js';
import { ChunkResultMerger } from '../chunker/chunkResultMerger.js';
import { listFiles, readTextFile, writeJsonFile } from '../../utils/fileUtils.js';
import { addLineNumbers }    from '../../utils/codeUtils.js';
import { safeRegExp }        from '../../utils/regexUtils.js';   // ← [Fix] 추가
import { config }            from '../../config/index.js';
import logger                from '../../utils/loggerUtils.js';

const CHECK_TYPES = {
  PURE_REGEX:     'pure_regex',
  LLM_WITH_REGEX: 'llm_with_regex',
  LLM_CONTEXTUAL: 'llm_contextual',
  LLM_WITH_AST:   'llm_with_ast'
};

export class CodeChecker {
  constructor() {
    this.codeTagger        = null;
    this.qdrantClient      = null;
    this.llmClient         = null;
    this.astParser         = null;
    this.resultBuilder     = null;
    this.methodChunker     = null;
    this.chunkResultMerger = null;
    this.initialized       = false;

    this.chunkingConfig = {
      autoChunkThreshold: 3000,
      warnThreshold:      3000,
      hardLimit:          15000
    };

    this.validCheckTypes = ['pure_regex', 'llm_with_regex', 'llm_contextual', 'llm_with_ast'];

    this.filteringStats = {
      totalChecks:            0,
      pureRegexViolations:    0,
      llmCandidates:          0,
      llmCalls:               0,
      falsePositivesFiltered: 0
    };
  }

  async initialize() {
    if (this.initialized) return;

    logger.info('🔧 CodeChecker 초기화 중...');

    this.codeTagger = getCodeTagger();
    await this.codeTagger.initialize();

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.astParser     = getJavaAstParser();
    this.resultBuilder = getResultBuilder();

    this.methodChunker     = new MethodChunker(this.chunkingConfig);
    this.chunkResultMerger = new ChunkResultMerger();

    this.initialized = true;
    logger.info('✅ CodeChecker 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 메인 점검 메서드
  // ═══════════════════════════════════════════════════════════════════════════

  async checkAll() {
    const inputDir = config.paths.input.code;
    const files    = await listFiles(inputDir, '.java');

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

    const summary    = this.resultBuilder.buildSummary(allReports);
    const outputPath = path.join(
      config.paths.output.reports,
      `check_${Date.now()}.json`
    );
    await writeJsonFile(outputPath, {
      checkedAt: new Date().toISOString(),
      summary,
      reports:   allReports,
      stats:     this.filteringStats
    });

    logger.info(`점검 완료: ${allReports.length}개 파일`);
    logger.info(`총 이슈: ${summary.totalIssues}개`);

    return { reports: allReports, summary, files: files.length, outputPath, stats: this.filteringStats };
  }

  async checkFile(filePath) {
    const fileName = path.basename(filePath);
    logger.info(`점검: ${fileName}`);
    try {
      const code   = await readTextFile(filePath);
      const result = await this.checkCode(code, fileName);
      return { file: fileName, path: filePath, ...result };
    } catch (error) {
      logger.error(`파일 점검 실패: ${fileName}`, error.message);
      return { file: fileName, path: filePath, success: false, error: error.message, tags: [], issues: [] };
    }
  }

  /**
   * 코드 점검 메인 (일반 모드 / 청킹 모드 자동 분기)
   */
  async checkCode(code, fileName = 'unknown', options = {}) {
    const startTime  = Date.now();
    const onProgress = options.onProgress || (() => {});
    const lineCount  = code.split('\n').length;

    const needsChunking = options.forceChunk || this.methodChunker.needsChunking(code);

    onProgress({ stage: 'start', fileName, lineCount, chunked: needsChunking, timestamp: Date.now() });

    if (needsChunking) {
      logger.info(`[${fileName}] 대용량 파일 (${lineCount}줄) - 청킹 모드 활성화`);
      return this.checkCodeChunked(code, fileName, options);
    }

    // ─── 일반 모드 ─────────────────────────────────────────────────────────
    this.filteringStats.totalChecks++;

    logger.debug(`[${fileName}] 태깅 시작...`);
    const taggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const tags          = taggingResult.tags;
    logger.info(`[${fileName}] 태그 ${tags.length}개: ${tags.slice(0, 5).join(', ')}...`);

    onProgress({ stage: 'tagging', status: 'done', tagCount: tags.length, elapsed: Date.now() - startTime });

    const astResult   = this.astParser.parseJavaCode(code);
    const astAnalysis = astResult.analysis;

    logger.debug(`[${fileName}] 룰 조회...`);
    const matchedRules = await this.qdrantClient.findRulesByTags(tags, { limit: 200, scoreThreshold: 0.3 });
    logger.info(`[${fileName}] 매칭 룰: ${matchedRules.length}개`);

    onProgress({ stage: 'rules', status: 'done', matchedRules: matchedRules.length, elapsed: Date.now() - startTime });

    if (matchedRules.length === 0) {
      const report = this.resultBuilder.buildReport({ fileName, code, tags, matchedRules: [], issues: [], duration: Date.now() - startTime });
      return report;
    }

    const filterResult = this.preFilterRules(code, astAnalysis, matchedRules, tags);

    onProgress({
      stage:           'filtering',
      status:          'done',
      pureRegexIssues: filterResult.pureRegexViolations.length,
      llmCandidates:   filterResult.llmCandidates.total,
      elapsed:         Date.now() - startTime
    });

    const issues = [...filterResult.pureRegexViolations];

    if (filterResult.llmCandidates.total > 0) {
      const llmViolations = await this.verifyWithLLM(
        code, astAnalysis, filterResult.llmCandidates, fileName, tags, onProgress
      );
      issues.push(...llmViolations);
    }

    const uniqueIssues = this.deduplicateViolations(issues);

    const report = this.resultBuilder.buildReport({
      fileName, code, tags, matchedRules,
      issues:   uniqueIssues,
      duration: Date.now() - startTime
    });

    logger.info(`[${fileName}] 이슈 ${uniqueIssues.length}개 발견 (${Date.now() - startTime}ms)`);
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 청킹 모드
  // ═══════════════════════════════════════════════════════════════════════════

  async checkCodeChunked(code, fileName, options = {}) {
    const startTime    = Date.now();
    const outputFormat = options.outputFormat || 'sarif';
    const onProgress   = options.onProgress || (() => {});

    logger.info(`[${fileName}] 🔪 청킹 시작...`);

    const chunkingResult = this.methodChunker.chunk(code, { fileName });
    const { chunks, metadata: chunkMeta } = chunkingResult;

    logger.info(`[${fileName}] ${chunkMeta.totalChunks}개 청크 생성 (${chunkMeta.totalMethods}개 메서드)`);

    onProgress({
      stage: 'chunking', status: 'done',
      totalChunks: chunkMeta.totalChunks, totalMethods: chunkMeta.totalMethods,
      elapsed: Date.now() - startTime
    });

    const chunkResults = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      if (chunk.type === 'header' || chunk.type === 'footer') {
        logger.debug(`[${fileName}] 청크 ${i + 1}/${chunks.length} [${chunk.type}] 스킵`);
        chunkResults.push({ chunkIndex: chunk.index, issues: [], processingTime: 0, llmCalls: 0 });
        continue;
      }

      const chunkStartTime = Date.now();

      onProgress({
        stage: 'chunk_start', chunkIndex: i + 1, chunkTotal: chunks.length,
        methodName: chunk.methodName || `chunk_${i + 1}`, lineRange: chunk.lineRange || null
      });

      logger.info(`[${fileName}] 청크 ${i + 1}/${chunks.length} [${chunk.methodName}] 검사 중...`);

      try {
        const chunkCode = chunk.codeWithHeader || chunk.code;
        const result    = await this.checkCodeDirect(chunkCode, fileName, {
          onProgress: (event) => onProgress({ ...event, stage: 'chunk_llm' })
        });

        chunkResults.push({
          chunkIndex:     chunk.index,
          issues:         result.issues || [],
          processingTime: Date.now() - chunkStartTime,
          llmCalls:       result.stats?.llmCalls || 0
        });

        onProgress({
          stage: 'chunk_done', chunkIndex: i + 1, chunkTotal: chunks.length,
          methodName: chunk.methodName, issuesFound: result.issues?.length || 0,
          elapsed: Date.now() - chunkStartTime
        });

      } catch (error) {
        logger.error(`[${fileName}] 청크 ${i + 1} 검사 실패: ${error.message}`);
        chunkResults.push({ chunkIndex: chunk.index, issues: [], processingTime: 0, llmCalls: 0 });
      }
    }

    const totalElapsed = Date.now() - startTime;
    logger.info(`[${fileName}] 청킹 검사 완료 (${totalElapsed}ms)`);

    const mergedResult = this.chunkResultMerger.merge(chunkResults, chunkingResult, options);

    if (outputFormat === 'sarif') {
      const sarif = this.chunkResultMerger.toSARIF(mergedResult, options);
      return {
        success: true, chunked: true, format: 'sarif', sarif,
        issues: mergedResult.issues, summary: mergedResult.summary,
        stats: {
          ...this.filteringStats, processingTime: totalElapsed,
          chunksProcessed: mergedResult.processing.processedChunks,
          totalChunks:     mergedResult.processing.totalChunks
        }
      };
    } else if (outputFormat === 'github') {
      const annotations = this.chunkResultMerger.toGitHubAnnotations(mergedResult);
      return {
        success: true, chunked: true, format: 'github', annotations,
        issues: mergedResult.issues, summary: mergedResult.summary,
        stats: { ...this.filteringStats, processingTime: totalElapsed }
      };
    } else {
      const simple = this.chunkResultMerger.toSimpleJSON(mergedResult);
      return {
        success: true, chunked: true, format: 'json', ...simple,
        stats: { ...this.filteringStats, processingTime: totalElapsed }
      };
    }
  }

  /**
   * 직접 코드 검사 (청킹 없이 — 개별 청크 검사에 사용)
   */
  async checkCodeDirect(code, fileName, options = {}) {
    const startTime  = Date.now();
    const onProgress = options.onProgress || (() => {});
    this.filteringStats.totalChecks++;

    const taggingResult = await this.codeTagger.extractTags(code, { useLLM: false });
    const tags          = taggingResult.tags;

    const astResult   = this.astParser.parseJavaCode(code);
    const astAnalysis = astResult.analysis;

    // [Fix] limit 50 → 200
    const matchedRules = await this.qdrantClient.findRulesByTags(tags, {
      limit: 200, scoreThreshold: 0.3
    });

    if (matchedRules.length === 0) {
      return { success: true, issues: [], stats: { llmCalls: 0 } };
    }

    // [Fix] tags 인수 추가 (기존 누락 → llm_contextual 규칙 전부 스킵되던 버그)
    const filterResult = this.preFilterRules(code, astAnalysis, matchedRules, tags);

    const issues = [...filterResult.pureRegexViolations];

    if (filterResult.llmCandidates.total > 0) {
      const llmViolations = await this.verifyWithLLM(
        code, astAnalysis, filterResult.llmCandidates, fileName, tags, onProgress
      );
      issues.push(...llmViolations);
    }

    const uniqueIssues = this.deduplicateViolations(issues);

    return {
      success: true,
      issues:  uniqueIssues,
      stats:   { llmCalls: this.filteringStats.llmCalls, llmCandidates: filterResult.llmCandidates.total }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v4.0 사전 필터링
  // ═══════════════════════════════════════════════════════════════════════════

  preFilterRules(sourceCode, astAnalysis, rules, tags) {
    const pureRegexViolations = [];
    const llmCandidates = {
      llm_with_regex: [], llm_contextual: [], llm_with_ast: [], total: 0
    };

    const tagSet = new Set(tags);

    for (const rule of rules) {
      const checkType = rule.checkType || 'llm_contextual';

      switch (checkType) {
        case 'pure_regex': {
          const regexResult = this.checkPureRegex(sourceCode, rule);
          if (regexResult.violations.length > 0) {
            pureRegexViolations.push(...regexResult.violations);
          }
          break;
        }
        case 'llm_with_regex': {
          const candidates = this.findRegexCandidates(sourceCode, rule);
          if (candidates.length > 0) {
            llmCandidates.llm_with_regex.push({ rule, candidates });
            llmCandidates.total += 1;
          }
          break;
        }
        case 'llm_contextual':
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
          break;

        case 'llm_with_ast':
          if (this.matchesAstCondition(sourceCode, astAnalysis, rule)) {
            llmCandidates.llm_with_ast.push({ rule, astAnalysis });
            llmCandidates.total += 1;
          }
          break;

        default:
          if (this.matchesContextualCondition(sourceCode, rule, tagSet)) {
            llmCandidates.llm_contextual.push({ rule });
            llmCandidates.total += 1;
          }
      }
    }

    return { pureRegexViolations, llmCandidates };
  }

  // ─── pure_regex ─────────────────────────────────────────────────────────────

  /**
   * 순수 정규식 검사 (LLM 없음)
   *
   * [Fix] new RegExp() → safeRegExp()
   *   LLM 생성 antiPattern에 포함된 (?s)/(?i) 등 PCRE 인라인 플래그를
   *   JS 호환 flags로 변환하여 "Invalid group" RuntimeError 방지.
   *   변환 불가 패턴은 null 반환 → continue로 스킵.
   */
  checkPureRegex(sourceCode, rule) {
    const violations = [];
    const lines      = sourceCode.split('\n');

    if (!rule.antiPatterns || rule.antiPatterns.length === 0) return { violations };

    for (const antiPattern of rule.antiPatterns) {
      // ✅ [Fix] safeRegExp 사용
      const regex = antiPattern.regex instanceof RegExp
        ? antiPattern.regex
        : safeRegExp(
            antiPattern.pattern || antiPattern,
            antiPattern.flags   || 'g',
            rule.ruleId
          );

      if (!regex) {
        logger.warn(`[${rule.ruleId}] checkPureRegex: 유효하지 않은 패턴 스킵: "${String(antiPattern.pattern || antiPattern).substring(0, 60)}"`);
        continue;
      }

      try {
        let match;
        regex.lastIndex = 0;

        while ((match = regex.exec(sourceCode)) !== null) {
          const beforeMatch = sourceCode.substring(0, match.index);
          const lineNumber  = (beforeMatch.match(/\n/g) || []).length + 1;
          const lineContent = lines[lineNumber - 1] || '';

          if (this.matchesGoodPattern(lineContent, rule.goodPatterns)) continue;

          violations.push({
            ruleId:      rule.ruleId,
            title:       rule.title,
            line:        lineNumber,
            column:      match.index - beforeMatch.lastIndexOf('\n'),
            severity:    rule.severity || 'MEDIUM',
            description: antiPattern.description || rule.description,
            suggestion:  rule.examples?.good?.[0] || rule.suggestion || '패턴을 수정하세요',
            category:    rule.category  || 'general',
            checkType:   'pure_regex',
            source:      'code_checker_regex'
          });

          if (violations.filter(v => v.ruleId === rule.ruleId).length >= 5) break;
        }
      } catch (error) {
        logger.warn(`정규식 실행 오류 [${rule.ruleId}]: ${error.message}`);
      }
    }

    return { violations };
  }

  /**
   * goodPattern 매칭 여부 확인
   *
   * [Fix] new RegExp() → safeRegExp()
   */
  matchesGoodPattern(lineContent, goodPatterns) {
    if (!goodPatterns || goodPatterns.length === 0) return false;

    for (const gp of goodPatterns) {
      // ✅ [Fix] safeRegExp 사용
      const regex = gp.regex instanceof RegExp
        ? gp.regex
        : safeRegExp(gp.pattern || gp, gp.flags || 'g');

      if (!regex) continue;

      try {
        if (regex.test(lineContent)) return true;
      } catch {}
    }

    return false;
  }

  /**
   * 정규식으로 후보 탐지 (llm_with_regex용)
   *
   * [Fix] new RegExp() → safeRegExp()
   */
  findRegexCandidates(sourceCode, rule) {
    const candidates = [];
    const lines      = sourceCode.split('\n');

    if (!rule.antiPatterns || rule.antiPatterns.length === 0) return candidates;

    for (const antiPattern of rule.antiPatterns) {
      // ✅ [Fix] safeRegExp 사용
      const regex = antiPattern.regex instanceof RegExp
        ? antiPattern.regex
        : safeRegExp(
            antiPattern.pattern || antiPattern,
            antiPattern.flags   || 'g',
            rule.ruleId
          );

      if (!regex) {
        logger.warn(`[${rule.ruleId}] findRegexCandidates: 유효하지 않은 패턴 스킵: "${String(antiPattern.pattern || antiPattern).substring(0, 60)}"`);
        continue;
      }

      try {
        let match;
        regex.lastIndex = 0;

        while ((match = regex.exec(sourceCode)) !== null) {
          const beforeMatch = sourceCode.substring(0, match.index);
          const lineNumber  = (beforeMatch.match(/\n/g) || []).length + 1;
          const lineContent = lines[lineNumber - 1] || '';

          if (this.matchesGoodPattern(lineContent, rule.goodPatterns)) continue;

          candidates.push({
            line:               lineNumber,
            content:            lineContent.trim(),
            matchedText:        match[0],
            patternDescription: antiPattern.description || ''
          });

          if (candidates.length >= 10) break;
        }
      } catch (error) {
        logger.warn(`후보 탐지 실행 오류 [${rule.ruleId}]: ${error.message}`);
      }
    }

    return candidates;
  }

  matchesContextualCondition(sourceCode, rule, tagSet) {
    if (rule.keywords && rule.keywords.length > 0) {
      const lowerCode  = sourceCode.toLowerCase();
      const hasKeyword = rule.keywords.some(kw => lowerCode.includes(String(kw).toLowerCase()));
      if (hasKeyword) return true;
    }
    if (rule.requiredTags && rule.requiredTags.length > 0) {
      const allPresent = rule.requiredTags.every(tag => tagSet.has(tag));
      if (allPresent) return true;
    }
    if (rule.tagCondition) {
      return this.qdrantClient.evaluateExpression(rule.tagCondition, tagSet);
    }
    return false;
  }

  matchesAstCondition(sourceCode, astAnalysis, rule) {
    const astHints = rule.astHints || {};

    if (astHints.nodeTypes && astHints.nodeTypes.length > 0) {
      const presentNodeTypes = astAnalysis.nodeTypes || [];
      const hasRequired      = astHints.nodeTypes.some(nt => presentNodeTypes.includes(nt));
      if (!hasRequired) return false;
    }
    if (astHints.maxLineCount) {
      if (!this.hasAnyLongMethod(sourceCode, astHints.maxLineCount)) return false;
    }
    if (astHints.maxCyclomaticComplexity) {
      const complexity = astAnalysis.cyclomaticComplexity || 1;
      if (complexity <= astHints.maxCyclomaticComplexity) return false;
    }
    return true;
  }

  hasAnyLongMethod(sourceCode, maxLineCount) {
    const lines         = sourceCode.split('\n');
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      if (methodPattern.test(lines[i])) {
        const methodInfo = this.findMethodAtLine(lines, i + 1);
        if (methodInfo.found) {
          const length = methodInfo.endLine - methodInfo.startLine + 1;
          if (length > maxLineCount) return true;
        }
      }
    }
    return false;
  }

  findMethodAtLine(lines, targetLine) {
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;

    for (let i = Math.min(targetLine - 1, lines.length - 1); i >= 0; i--) {
      const match = lines[i].match(methodPattern);
      if (match) {
        let braceCount = 0;
        let endLine    = i;

        for (let j = i; j < lines.length; j++) {
          for (const char of lines[j]) {
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
          }
          if (braceCount === 0 && j > i) { endLine = j; break; }
        }
        return { found: true, name: match[1], startLine: i, endLine };
      }
    }
    return { found: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM 검증
  // ═══════════════════════════════════════════════════════════════════════════

  async verifyWithLLM(sourceCode, astAnalysis, llmCandidates, fileName, tags, onProgress = () => {}) {
    const violations = [];

    const allItems = [
      ...llmCandidates.llm_with_regex.map(i => ({ ...i, type: 'llm_with_regex' })),
      ...llmCandidates.llm_contextual.map(i => ({ ...i, type: 'llm_contextual' })),
      ...llmCandidates.llm_with_ast.map(i => ({ ...i, type: 'llm_with_ast' }))
    ];

    if (allItems.length === 0) return violations;

    const totalItems = allItems.length;
    logger.info(`[${fileName}] LLM 개별 검증 시작: ${allItems.length}개 규칙`);

    const truncatedCode = this.truncateCode(sourceCode, 4000);

    // [Fix] 라인 번호 붙인 코드 전달 → LLM이 정확한 라인 리포트
    const numberedCode = addLineNumbers(truncatedCode, 1);

    for (let i = 0; i < allItems.length; i++) {
      const item          = allItems[i];
      const rule          = item.rule;
      const ruleNum       = i + 1;
      const itemStartTime = Date.now();

      try {
        const prompt = this.buildSingleRulePrompt(numberedCode, item, astAnalysis, tags);

        const response = await this.llmClient.generateCompletion(prompt, {
          temperature: 0.1,
          max_tokens:  1000
        });

        this.filteringStats.llmCalls++;
        logger.debug(`[${fileName}] 규칙 ${ruleNum}/${allItems.length} [${rule.ruleId}]: ${Date.now() - itemStartTime}ms`);

        const parsed = this.llmClient.cleanAndExtractJSON(response);

        if (parsed) {
          const violationData = parsed.violation !== undefined
            ? parsed
            : (parsed.violations?.[0] || null);

          if (violationData && violationData.violation === true) {
            violations.push({
              ruleId:      rule.ruleId,
              title:       violationData.title || rule.title || '',
              line:        violationData.line   || 0,
              severity:    rule.severity        || 'MEDIUM',
              description: violationData.description || '',
              suggestion:  violationData.suggestion  || '',
              confidence:  violationData.confidence  || 0.8,
              category:    rule.category   || 'general',
              checkType:   rule.checkType  || item.type,
              source:      'code_checker_llm'
            });
            logger.info(`[${fileName}] ⚠️ 위반 발견: ${rule.ruleId} (라인 ${violationData.line || '?'})`);
          }
        }

        onProgress({
          stage: 'llm', current: i + 1, total: totalItems,
          ruleId: rule.ruleId, checkType: item.type,
          elapsed: Date.now() - itemStartTime
        });

        if (i < allItems.length - 1) await this._sleep(100);

      } catch (error) {
        logger.warn(`[${fileName}] 규칙 ${ruleNum} [${rule.ruleId}] LLM 실패: ${error.message}`);
        this.filteringStats.llmCalls++;

        onProgress({
          stage: 'llm', current: i + 1, total: totalItems,
          ruleId: rule.ruleId, checkType: item.type,
          elapsed: Date.now() - itemStartTime, error: error.message
        });
      }
    }

    logger.info(`[${fileName}] LLM 검증 완료: ${violations.length}개 위반 발견 (${this.filteringStats.llmCalls}회 호출)`);
    return violations;
  }

  // ─── 프롬프트 생성 ──────────────────────────────────────────────────────────

  /**
   * 단일 규칙 검증 프롬프트
   *
   * sourceCode는 addLineNumbers()로 번호가 붙어 있음.
   * [Fix] 코드 블록 헤더에 "줄 앞의 숫자 = 라인 번호" 안내 추가.
   */
  buildSingleRulePrompt(sourceCode, item, astAnalysis, tags) {
    const rule = item.rule;
    const type = item.type;

    const astSection            = this._buildAstSection(astAnalysis);
    const detectedIssuesSection = this._buildDetectedIssuesSection(astAnalysis, rule);
    const profileSection        = this._buildProfileSection(tags);
    const examplesSection       = this._buildExamplesSection(rule);
    const contextSection        = this._buildContextSection(item, type);
    const falsePositiveGuide    = this._buildFalsePositiveGuide();

    return `다음 Java 코드가 주어진 규칙을 위반하는지 검사하세요.
${astSection}
${detectedIssuesSection}
${profileSection}

## 검사 대상 코드 (각 줄 앞의 숫자가 실제 라인 번호입니다)
\`\`\`java
${sourceCode}
\`\`\`
주의: line 필드에는 위 코드에 표시된 라인 번호를 그대로 입력하세요.

## 검사할 규칙
- **규칙 ID:** ${rule.ruleId}
- **제목:** ${rule.title}
- **설명:** ${rule.description || '없음'}
- **카테고리:** ${rule.category || 'general'}
- **심각도:** ${rule.severity || 'MEDIUM'}
${examplesSection}
${contextSection}
${falsePositiveGuide}

## 출력 형식 (JSON)
\`\`\`json
{
  "violation": true 또는 false,
  "line": 위반 라인 번호 (위반인 경우, 위 코드의 줄 번호 그대로),
  "description": "구체적인 위반 내용",
  "suggestion": "수정 제안",
  "confidence": 0.0~1.0
}
\`\`\`

## 최종 판단 기준
1. **확실한 위반만** violation: true 반환 (confidence 0.8 이상)
2. 애매하거나 불확실하면 violation: false
3. goodPatterns에 매칭되면 violation: false
4. 거짓 양성 조건에 해당하면 violation: false
5. 위반이 아니면 간단히 {"violation": false} 반환

JSON만 출력하세요.`;
  }

  _buildAstSection(astAnalysis) {
    if (!astAnalysis) return '';

    const classes = astAnalysis.classDeclarations?.map(c => {
      let info = c.name;
      if (c.extends) info += ` extends ${c.extends}`;
      if (c.implements?.length) info += ` implements ${c.implements.join(', ')}`;
      return info;
    }).join(', ') || 'N/A';

    const methods = astAnalysis.methodDeclarations?.slice(0, 8).map(m =>
      `${m.returnType} ${m.name}(${m.parameters || ''})`
    ) || [];
    const methodList  = methods.length > 0 ? methods.map(m => `  - ${m}`).join('\n') : '  - N/A';
    const methodExtra = (astAnalysis.methodDeclarations?.length || 0) > 8
      ? `\n  - ... 외 ${astAnalysis.methodDeclarations.length - 8}개` : '';

    const annotations     = astAnalysis.annotations?.slice(0, 10).join(', ') || 'N/A';
    const annotationExtra = (astAnalysis.annotations?.length || 0) > 10
      ? `, ... 외 ${astAnalysis.annotations.length - 10}개` : '';

    return `
## 코드 구조 정보 (AST 분석)
- **클래스:** ${classes}
- **메서드:**
${methodList}${methodExtra}
- **어노테이션:** ${annotations}${annotationExtra}
- **복잡도:** 중첩 깊이 ${astAnalysis.maxDepth || 0}, 순환 복잡도 ${astAnalysis.cyclomaticComplexity || 1}`;
  }

  _buildDetectedIssuesSection(astAnalysis, rule) {
    if (!astAnalysis) return '';

    const relevantIssues = [];
    const combinedText   = `${rule.category || ''} ${rule.title || ''} ${rule.description || ''}`.toLowerCase();

    if (combinedText.includes('exception') || combinedText.includes('error') ||
        combinedText.includes('예외') || combinedText.includes('catch')) {
      if (astAnalysis.exceptionHandling?.length > 0) {
        relevantIssues.push(...astAnalysis.exceptionHandling.map(e => ({
          type: e.type, description: e.description, severity: e.severity || 'MEDIUM'
        })));
      }
    }
    if (combinedText.includes('resource') || combinedText.includes('memory') ||
        combinedText.includes('리소스') || combinedText.includes('close') ||
        combinedText.includes('connection') || combinedText.includes('stream')) {
      const leaks = (astAnalysis.resourceLifecycles || [])
        .filter(r => !r.hasCloseCall && !r.inTryWithResources);
      if (leaks.length > 0) {
        relevantIssues.push(...leaks.map(r => ({
          type: 'RESOURCE_LEAK_RISK', description: `${r.type} 리소스 해제 누락 가능성`, severity: 'HIGH'
        })));
      }
    }
    if (combinedText.includes('security') || combinedText.includes('보안') ||
        combinedText.includes('sql') || combinedText.includes('injection')) {
      if (astAnalysis.securityPatterns?.length > 0) {
        relevantIssues.push(...astAnalysis.securityPatterns);
      }
    }
    if (combinedText.includes('performance') || combinedText.includes('성능') ||
        combinedText.includes('loop') || combinedText.includes('반복')) {
      if (astAnalysis.performanceIssues?.length > 0) {
        relevantIssues.push(...astAnalysis.performanceIssues);
      }
      if (astAnalysis.loopAnalysis?.hasDbCallInLoop) {
        relevantIssues.push({ type: 'DB_CALL_IN_LOOP', description: '루프 내 DB 호출 감지 (N+1 쿼리 위험)', severity: 'HIGH' });
      }
      if (astAnalysis.loopAnalysis?.hasNestedLoop) {
        relevantIssues.push({ type: 'NESTED_LOOP', description: '중첩 루프 감지 (성능 저하 가능)', severity: 'MEDIUM' });
      }
    }

    if (relevantIssues.length === 0) return '';

    const issueList = relevantIssues.slice(0, 5).map(i =>
      `- **${i.type}**: ${i.description} (${i.severity})`
    ).join('\n');

    return `
## AST 자동 탐지 이슈 (참고)
${issueList}

위 이슈는 AST 분석으로 자동 탐지되었습니다. 규칙 위반 판단 시 참고하세요.`;
  }

  _buildProfileSection(tags) {
    if (!tags || tags.length === 0) return '';
    const displayTags = tags.slice(0, 15).join(', ');
    const extra       = tags.length > 15 ? `, ... 외 ${tags.length - 15}개` : '';
    return `\n## 코드 프로파일\n- **태그:** ${displayTags}${extra}`;
  }

  _buildExamplesSection(rule) {
    const parts    = [];
    const badCode  = rule.problematicCode || rule.badExample;
    const goodCode = rule.fixedCode       || rule.goodExample;

    if (badCode) {
      parts.push(`\n**잘못된 예 (피해야 할 코드):**\n\`\`\`java\n${this._truncateText(badCode, 500)}\n\`\`\``);
    }
    if (goodCode) {
      parts.push(`\n**올바른 예 (권장하는 코드):**\n\`\`\`java\n${this._truncateText(goodCode, 500)}\n\`\`\``);
    }

    return parts.length === 0 ? '' : `\n## 코드 예시\n${parts.join('\n')}`;
  }

  _buildContextSection(item, type) {
    const rule = item.rule;

    if (type === 'llm_with_regex') {
      const candidateLines = item.candidates?.slice(0, 10).map(c =>
        `- 라인 ${c.line}: \`${this._truncateText(c.content, 80)}\``
      ).join('\n') || '- 없음';

      const antiPatterns = rule.antiPatterns?.slice(0, 5).map(p =>
        `- \`${p.pattern}\`${p.description ? ` - ${p.description}` : ''}`
      ).join('\n') || '- 없음';

      const goodPatterns = rule.goodPatterns?.slice(0, 5).map(p =>
        `- \`${p.pattern}\`${p.description ? ` - ${p.description}` : ''}`
      ).join('\n') || '- 없음';

      return `
## 패턴 매칭 정보
**의심되는 위치 (정규식 탐지):**
${candidateLines}

**위반 패턴 (antiPatterns):**
${antiPatterns}

**예외 패턴 (goodPatterns) - 매칭 시 위반 아님:**
${goodPatterns}`;
    }

    if (type === 'llm_with_ast') {
      const checkPoints = rule.checkPoints?.map(cp => `- ${cp}`).join('\n') || '- 규칙 준수 여부 확인';
      return `\n## AST 분석 체크포인트\n${checkPoints}\n\n위 체크포인트와 코드 구조 정보를 기반으로 검증하세요.`;
    }

    const keywords = rule.keywords?.slice(0, 15).join(', ') || '없음';
    return `\n## 컨텍스트 분석\n- **관련 키워드:** ${keywords}\n\n코드 전체의 의미와 맥락을 분석하여 위반 여부를 판단하세요.`;
  }

  _buildFalsePositiveGuide() {
    return `
## 거짓 양성 필터링
다음 경우는 위반이 **아닙니다**:
1. 주석 내 코드 (\`//\` 또는 \`/* */\` 내부)
2. 문자열 리터럴 내 패턴 (\`"..."\` 내부)
3. 테스트 코드 (\`@Test\`, \`*Test.java\`, \`*Spec.java\`)
4. 의도적 예외 처리 (\`@SuppressWarnings\`, \`// NOSONAR\`, \`// NOPMD\`)
5. goodPatterns에 매칭되는 코드
6. import 문, package 선언문`;
  }

  // ─── 배치 폴백 ──────────────────────────────────────────────────────────────

  async fallbackBatchVerification(sourceCode, llmCandidates) {
    const violations = [];
    const allRules   = [
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
      if (i + batchSize < allRules.length) await this._sleep(300);
    }
    return violations;
  }

  async checkRulesBatchLLM(sourceCode, rules) {
    const rulesDescription = rules.map(rule => {
      const goodExamples = rule.examples?.good || [];
      const badExamples  = rule.examples?.bad  || [];
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

    const response = await this.llmClient.generateCompletion(prompt, { temperature: 0.1, max_tokens: 1500 });
    return this.parseBatchResponse(response, rules);
  }

  parseBatchResponse(response, rules) {
    const violations = [];
    try {
      const parsed = this.llmClient.cleanAndExtractJSON(response);
      if (parsed?.violations && Array.isArray(parsed.violations)) {
        for (const v of parsed.violations) {
          if (v.violation === true || v.violation === undefined) {
            const rule = rules.find(r => r.ruleId === v.ruleId);
            violations.push({
              ruleId:      v.ruleId   || 'UNKNOWN',
              title:       v.title    || rule?.title || '',
              line:        v.line     || 0,
              severity:    rule?.severity  || 'MEDIUM',
              description: v.description  || '',
              suggestion:  v.suggestion   || '',
              category:    rule?.category || 'general',
              checkType:   rule?.checkType || 'llm_contextual',
              source:      'code_checker_batch'
            });
          }
        }
      }
    } catch (error) {
      logger.warn(`배치 응답 파싱 실패: ${error.message}`);
    }
    return violations;
  }

  // ─── 유틸리티 ────────────────────────────────────────────────────────────────

  deduplicateViolations(violations) {
    const seen = new Map();
    return violations.filter(v => {
      const key = `${v.line}-${v.ruleId}-${v.column || 0}`;
      if (seen.has(key)) return false;
      seen.set(key, true);
      return true;
    });
  }

  truncateCode(code, maxLength) {
    if (!code || code.length <= maxLength) return code;
    const half  = Math.floor(maxLength / 2);
    const start = code.substring(0, half);
    const end   = code.substring(code.length - half);
    return `${start}\n\n// ... (${code.length - maxLength} characters truncated) ...\n\n${end}`;
  }

  _truncateText(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  }

  getFilteringStats()  { return { ...this.filteringStats }; }

  resetFilteringStats() {
    this.filteringStats = {
      totalChecks: 0, pureRegexViolations: 0,
      llmCandidates: 0, llmCalls: 0, falsePositivesFiltered: 0
    };
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  buildSectionedPrompt(sourceCode, llmCandidates) {
    const truncatedCode = this.truncateCode(sourceCode, 3000);
    const sections = [];

    if (llmCandidates.llm_with_regex.length > 0) {
      const regexSection = llmCandidates.llm_with_regex.map(item => {
        const candidateLines = item.candidates.map(c => `    - 라인 ${c.line}: ${c.content}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.description || ''}\n**의심 위치:**\n${candidateLines}`;
      }).join('\n\n');
      sections.push(`## 1. 정규식 후보 검증 (llm_with_regex)\n${regexSection}`);
    }
    if (llmCandidates.llm_contextual.length > 0) {
      const contextSection = llmCandidates.llm_contextual.map(item =>
        `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.description || ''}\n키워드: ${(item.rule.keywords || []).join(', ')}`
      ).join('\n\n');
      sections.push(`## 2. 컨텍스트 분석 (llm_contextual)\n${contextSection}`);
    }
    if (llmCandidates.llm_with_ast.length > 0) {
      const astSection = llmCandidates.llm_with_ast.map(item => {
        const checkPoints = (item.rule.checkPoints || []).map(cp => `    - ${cp}`).join('\n');
        return `### [${item.rule.ruleId}] ${item.rule.title}\n${item.rule.astDescription || item.rule.description || ''}\n**체크포인트:**\n${checkPoints}`;
      }).join('\n\n');
      sections.push(`## 3. AST 기반 분석 (llm_with_ast)\n${astSection}`);
    }

    return `다음 Java 코드에서 제시된 규칙들의 위반 여부를 검사해주세요.\n\n## 검사 대상 코드\n\`\`\`java\n${truncatedCode}\n\`\`\`\n\n${sections.join('\n\n')}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════════

let instance = null;

export function getCodeChecker() {
  if (!instance) instance = new CodeChecker();
  return instance;
}

export function resetCodeChecker() {
  instance = null;
}

export async function checkCode() {
  const checker = getCodeChecker();
  await checker.initialize();
  return await checker.checkAll();
}

export default CodeChecker;