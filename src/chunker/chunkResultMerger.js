/**
 * 청크 결과 통합 및 SARIF 출력
 * 
 * 청크별로 검사된 결과를 통합하고,
 * 라인 번호를 원본 파일 기준으로 변환하며,
 * SARIF 형식으로 출력
 * 
 * @module chunker/chunkResultMerger
 */

import logger from '../utils/loggerUtils.js';

export class ChunkResultMerger {
  constructor() {
    this.toolName = 'java-code-quality-checker';
    this.toolVersion = '4.2.0';
    this.toolUri = 'https://github.com/example/java-code-quality-checker';
  }

  /**
   * 청크별 결과를 통합
   * 
   * @param {Array} chunkResults - 청크별 검사 결과 배열
   * @param {Object} chunkingInfo - 청킹 정보 (chunks, metadata)
   * @param {Object} options - 옵션
   * @returns {Object} 통합된 결과
   */
  merge(chunkResults, chunkingInfo, options = {}) {
    const allIssues = [];
    const processedChunks = [];
    let totalLlmCalls = 0;
    let totalProcessingTime = 0;

    // 청크별 결과 수집
    for (const result of chunkResults) {
      if (!result) continue;

      const chunk = chunkingInfo.chunks.find(c => c.index === result.chunkIndex);
      if (!chunk) continue;

      // 라인 번호 변환 (청크 내 → 원본)
      const convertedIssues = this.convertLineNumbers(result.issues || [], chunk);
      
      // 컨텍스트 정보 추가
      const enrichedIssues = convertedIssues.map(issue => ({
        ...issue,
        context: {
          className: chunk.className,
          methodName: chunk.methodName,
          chunkIndex: chunk.index,
          chunkType: chunk.type
        }
      }));

      allIssues.push(...enrichedIssues);

      processedChunks.push({
        index: chunk.index,
        type: chunk.type,
        methodName: chunk.methodName,
        lineRange: chunk.lineRange,
        issuesFound: enrichedIssues.length,
        processingTime: result.processingTime || 0
      });

      totalLlmCalls += result.llmCalls || 0;
      totalProcessingTime += result.processingTime || 0;
    }

    // 중복 제거
    const uniqueIssues = this.deduplicateIssues(allIssues);

    // 정렬 (라인 번호 순)
    uniqueIssues.sort((a, b) => (a.line || 0) - (b.line || 0));

    // 요약 생성
    const summary = this.generateSummary(uniqueIssues, chunkingInfo);

    return {
      file: {
        name: chunkingInfo.metadata.fileName,
        totalLines: chunkingInfo.metadata.totalLines,
        className: chunkingInfo.className
      },
      processing: {
        chunked: true,
        totalChunks: chunkingInfo.metadata.totalChunks,
        processedChunks: processedChunks.length,
        totalMethods: chunkingInfo.metadata.totalMethods,
        processingTime: totalProcessingTime,
        llmCalls: totalLlmCalls
      },
      issues: uniqueIssues,
      chunks: processedChunks,
      summary
    };
  }

  /**
   * 라인 번호 변환 (청크 내 → 원본)
   */
  convertLineNumbers(issues, chunk) {
    return issues.map(issue => {
      // 청크 내 라인 번호를 원본 라인 번호로 변환
      const originalLine = issue.line 
        ? chunk.lineRange.start + issue.line - 1
        : chunk.lineRange.start;

      return {
        ...issue,
        line: originalLine,
        chunkLine: issue.line  // 원본 청크 내 라인 번호 보존
      };
    });
  }

  /**
   * 중복 이슈 제거
   */
  deduplicateIssues(issues) {
    const seen = new Map();

    return issues.filter(issue => {
      const key = `${issue.ruleId}-${issue.line}-${issue.description?.substring(0, 50) || ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, true);
      return true;
    });
  }

  /**
   * 요약 생성
   */
  generateSummary(issues, chunkingInfo) {
    const bySeverity = {};
    const byClass = {};
    const byMethod = {};
    const byCategory = {};

    for (const issue of issues) {
      // 심각도별
      const severity = issue.severity || 'MEDIUM';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;

      // 클래스별
      const className = issue.context?.className || 'unknown';
      byClass[className] = (byClass[className] || 0) + 1;

      // 메서드별
      const methodName = issue.context?.methodName || 'unknown';
      if (methodName !== 'unknown') {
        byMethod[methodName] = (byMethod[methodName] || 0) + 1;
      }

      // 카테고리별
      const category = issue.category || 'general';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    return {
      totalIssues: issues.length,
      bySeverity,
      byClass,
      byMethod,
      byCategory
    };
  }

  /**
   * SARIF 형식으로 변환
   * 
   * @param {Object} mergedResult - merge() 결과
   * @param {Object} options - 변환 옵션
   * @returns {Object} SARIF JSON
   */
  toSARIF(mergedResult, options = {}) {
    const rules = this.extractRules(mergedResult.issues);
    const results = this.convertToSARIFResults(mergedResult.issues, mergedResult.file);

    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: this.toolName,
            version: this.toolVersion,
            informationUri: this.toolUri,
            rules: rules
          }
        },
        results: results,
        invocations: [{
          executionSuccessful: true,
          startTimeUtc: mergedResult.processing?.startTime || new Date().toISOString(),
          endTimeUtc: new Date().toISOString(),
          properties: {
            chunked: mergedResult.processing?.chunked || false,
            totalChunks: mergedResult.processing?.totalChunks || 1,
            totalMethods: mergedResult.processing?.totalMethods || 0,
            processingTimeMs: mergedResult.processing?.processingTime || 0,
            llmCalls: mergedResult.processing?.llmCalls || 0
          }
        }],
        properties: {
          summary: mergedResult.summary
        }
      }]
    };
  }

  /**
   * 이슈에서 규칙 정의 추출
   */
  extractRules(issues) {
    const rulesMap = new Map();

    for (const issue of issues) {
      if (!rulesMap.has(issue.ruleId)) {
        rulesMap.set(issue.ruleId, {
          id: issue.ruleId,
          name: this.ruleIdToName(issue.ruleId),
          shortDescription: {
            text: issue.title || issue.ruleId
          },
          fullDescription: {
            text: issue.description || issue.title || issue.ruleId
          },
          defaultConfiguration: {
            level: this.severityToLevel(issue.severity)
          },
          properties: {
            category: issue.category || 'general',
            tags: [issue.category || 'general', issue.checkType || 'llm']
          }
        });
      }
    }

    return Array.from(rulesMap.values());
  }

  /**
   * SARIF 결과 배열로 변환
   */
  convertToSARIFResults(issues, fileInfo) {
    return issues.map((issue, index) => ({
      ruleId: issue.ruleId,
      ruleIndex: this.getRuleIndex(issues, issue.ruleId),
      level: this.severityToLevel(issue.severity),
      message: {
        text: issue.description || issue.title || 'Unknown issue'
      },
      locations: [{
        physicalLocation: {
          artifactLocation: {
            uri: fileInfo.name,
            uriBaseId: '%SRCROOT%'
          },
          region: {
            startLine: issue.line || 1,
            startColumn: issue.column || 1,
            endLine: issue.endLine || issue.line || 1,
            endColumn: issue.endColumn || 1
          }
        },
        logicalLocations: this.buildLogicalLocations(issue, fileInfo)
      }],
      properties: {
        confidence: issue.confidence || 0.8,
        suggestion: issue.suggestion || null,
        context: issue.context || null,
        checkType: issue.checkType || 'llm'
      },
      fixes: issue.suggestion ? [{
        description: {
          text: issue.suggestion
        }
      }] : undefined
    }));
  }

  /**
   * 논리적 위치 빌드 (클래스, 메서드)
   */
  buildLogicalLocations(issue, fileInfo) {
    const locations = [];

    if (issue.context?.className) {
      locations.push({
        name: issue.context.className,
        kind: 'type',
        fullyQualifiedName: issue.context.className
      });
    }

    if (issue.context?.methodName) {
      locations.push({
        name: issue.context.methodName,
        kind: 'function',
        fullyQualifiedName: `${issue.context.className || fileInfo.className}.${issue.context.methodName}`
      });
    }

    return locations.length > 0 ? locations : undefined;
  }

  /**
   * 규칙 인덱스 조회
   */
  getRuleIndex(issues, ruleId) {
    const uniqueRuleIds = [...new Set(issues.map(i => i.ruleId))];
    return uniqueRuleIds.indexOf(ruleId);
  }

  /**
   * ruleId를 이름으로 변환
   */
  ruleIdToName(ruleId) {
    // ERR.3_2 → EmptyCatchBlock
    const parts = ruleId.split('.');
    if (parts.length >= 2) {
      return parts.join('_').replace(/[^a-zA-Z0-9_]/g, '');
    }
    return ruleId.replace(/[^a-zA-Z0-9]/g, '');
  }

  /**
   * 심각도를 SARIF 레벨로 변환
   */
  severityToLevel(severity) {
    const mapping = {
      'CRITICAL': 'error',
      'HIGH': 'error',
      'MEDIUM': 'warning',
      'LOW': 'note',
      'INFO': 'note'
    };
    return mapping[severity] || 'warning';
  }

  /**
   * GitHub Actions 어노테이션 형식으로 변환
   */
  toGitHubAnnotations(mergedResult) {
    const annotations = [];

    for (const issue of mergedResult.issues) {
      const level = this.severityToGitHubLevel(issue.severity);
      const file = mergedResult.file.name;
      const line = issue.line || 1;
      const col = issue.column || 1;
      const title = `${issue.title || issue.ruleId} (${issue.ruleId})`;
      const message = issue.description || issue.title;

      annotations.push(`::${level} file=${file},line=${line},col=${col},title=${title}::${message}`);
    }

    return annotations.join('\n');
  }

  /**
   * 심각도를 GitHub 레벨로 변환
   */
  severityToGitHubLevel(severity) {
    const mapping = {
      'CRITICAL': 'error',
      'HIGH': 'error',
      'MEDIUM': 'warning',
      'LOW': 'notice',
      'INFO': 'notice'
    };
    return mapping[severity] || 'warning';
  }

  /**
   * 간단한 JSON 형식으로 변환 (기존 호환)
   */
  toSimpleJSON(mergedResult) {
    return {
      fileName: mergedResult.file.name,
      totalLines: mergedResult.file.totalLines,
      chunked: mergedResult.processing.chunked,
      totalChunks: mergedResult.processing.totalChunks,
      totalMethods: mergedResult.processing.totalMethods,
      processingTime: mergedResult.processing.processingTime,
      llmCalls: mergedResult.processing.llmCalls,
      issues: mergedResult.issues.map(issue => ({
        ruleId: issue.ruleId,
        title: issue.title,
        line: issue.line,
        severity: issue.severity,
        description: issue.description,
        suggestion: issue.suggestion,
        category: issue.category,
        className: issue.context?.className,
        methodName: issue.context?.methodName
      })),
      summary: mergedResult.summary
    };
  }
}

// 싱글톤
let instance = null;

export function getChunkResultMerger() {
  if (!instance) {
    instance = new ChunkResultMerger();
  }
  return instance;
}

export default ChunkResultMerger;