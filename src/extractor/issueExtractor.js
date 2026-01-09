/**
 * 이슈 추출기
 * 
 * CSV 파일 → Issue 파싱 → Rule 변환 → RuleTagger(LLM 태깅) → Qdrant
 * 
 * GuidelineExtractor와 동일한 흐름:
 * 1. 원본 파싱 (CSV → Issue JSON)
 * 2. 기본 Rule로 변환 (필드 매핑)
 * 3. RuleTagger로 태깅 (LLM 기반)
 * 4. Qdrant 저장
 * 
 * @module extractor/issueExtractor
 */

import fs from 'fs/promises';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { getLLMClient } from '../clients/llmClient.js';
import { getQdrantClient } from '../clients/qdrantClient.js';
import { getRuleTagger } from '../tagger/ruleTagger.js';
import { writeJsonFile, listFiles } from '../utils/fileUtils.js';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

/**
 * 카테고리별 issueId prefix 매핑
 */
const CATEGORY_PREFIX_MAP = {
  'API 연동': 'API',
  '가이드 위반': 'GUIDE',
  '데이터 무결성': 'DATA-INT',
  '데이터베이스 이슈': 'DB',
  '동시성 이슈': 'CONCUR',
  '로깅/모니터링': 'LOG',
  '리소스 관리': 'RESOURCE',
  '메모리 누수': 'MEMORY',
  '메세지 큐': 'MQ',
  '배치 처리': 'BATCH',
  '보안 취약점': 'SEC',
  '비즈니스 로직 오류': 'BIZ',
  '성능 이슈': 'PERF',
  '예외 처리': 'EXCEPT',
  '유효성 검증 오류': 'VALID',
  '인코딩/디코딩': 'ENCODE',
  '트랜잭션 관리': 'TXN'
};

/**
 * 한글 카테고리 → 영문 카테고리 매핑
 */
const CATEGORY_NORMALIZE_MAP = {
  'API 연동': 'api_integration',
  '가이드 위반': 'guideline_violation',
  '데이터 무결성': 'data_integrity',
  '데이터베이스 이슈': 'database',
  '동시성 이슈': 'concurrency',
  '로깅/모니터링': 'logging',
  '리소스 관리': 'resource_management',
  '메모리 누수': 'memory_leak',
  '메세지 큐': 'message_queue',
  '배치 처리': 'batch_processing',
  '보안 취약점': 'security',
  '비즈니스 로직 오류': 'business_logic',
  '성능 이슈': 'performance',
  '예외 처리': 'exception_handling',
  '유효성 검증 오류': 'validation',
  '인코딩/디코딩': 'encoding',
  '트랜잭션 관리': 'transaction'
};

export class IssueExtractor {
  constructor() {
    this.llmClient = null;
    this.qdrantClient = null;
    this.ruleTagger = null;
    this.initialized = false;
    
    // 카테고리별 카운터
    this.categoryCounters = {};
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();

    // GuidelineExtractor와 동일하게 RuleTagger 사용
    this.ruleTagger = getRuleTagger();
    await this.ruleTagger.initialize();

    this.initialized = true;
    logger.info('✅ IssueExtractor 초기화 완료');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 1: CSV 파싱 → Issue JSON
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * BOM 제거
   */
  removeBOM(str) {
    if (!str) return str;
    return str.replace(/^\uFEFF/, '').trim();
  }

  /**
   * 컬럼명 정규화
   */
  normalizeColumnName(name) {
    if (!name) return '';
    return this.removeBOM(name).trim();
  }

  /**
   * row 객체의 키들을 정규화
   */
  normalizeRowKeys(row) {
    const normalizedRow = {};
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = this.normalizeColumnName(key);
      normalizedRow[normalizedKey] = value;
    }
    return normalizedRow;
  }

  /**
   * row에서 값 가져오기
   */
  getRowValue(row, columnName) {
    if (row[columnName] !== undefined) {
      return row[columnName] || '';
    }
    
    const normalizedColumnName = this.normalizeColumnName(columnName);
    for (const [key, value] of Object.entries(row)) {
      if (this.normalizeColumnName(key) === normalizedColumnName) {
        return value || '';
      }
    }
    
    const partialMatch = columnName.split('(')[0].trim();
    for (const [key, value] of Object.entries(row)) {
      if (this.normalizeColumnName(key).includes(partialMatch)) {
        return value || '';
      }
    }
    
    return '';
  }

  /**
   * 카테고리별 issueId 생성
   */
  generateIssueId(category) {
    const prefix = CATEGORY_PREFIX_MAP[category] || 'UNKNOWN';
    
    if (!this.categoryCounters[category]) {
      this.categoryCounters[category] = 0;
    }
    this.categoryCounters[category]++;
    
    const number = String(this.categoryCounters[category]).padStart(3, '0');
    return `${prefix}-${number}`;
  }

  /**
   * tags 배열 생성 (도메인, 레이어)
   */
  createBaseTags(domain, layer) {
    const tags = [];
    
    if (domain && domain.trim() && domain !== '도메인 (선택)' && domain.length > 1) {
      const domains = domain.split(',').map(tag => tag.trim()).filter(tag => tag && tag.length > 1);
      tags.push(...domains);
    }
    
    if (layer && layer.trim() && layer !== '아키텍처 레이어' && layer.length > 1) {
      const layers = layer.split(',').map(tag => tag.trim()).filter(tag => tag && tag.length > 1);
      tags.push(...layers);
    }
    
    return tags;
  }

  /**
   * CSV 파일 파싱 → Issue JSON 배열
   * 
   * @param {string} filePath - CSV 파일 경로
   * @returns {Promise<Object[]>} Issue 객체 배열
   */
  async parseCSV(filePath) {
    logger.info(`📄 CSV 파싱: ${path.basename(filePath)}`);
    
    this.categoryCounters = {};
    
    let content = await fs.readFile(filePath, 'utf-8');
    content = this.removeBOM(content);
    
    const records = csvParse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true
    });
    
    logger.info(`   레코드 수: ${records.length}개`);
    
    const issues = [];
    const warnings = [];
    
    for (let i = 0; i < records.length; i++) {
      const rawRow = records[i];
      const row = this.normalizeRowKeys(rawRow);
      
      const title = this.getRowValue(row, '이슈 제목 (200자 이내)');
      const category = this.getRowValue(row, '카테고리');
      const severity = this.getRowValue(row, '심각도');
      const domain = this.getRowValue(row, '도메인 (선택)');
      const layer = this.getRowValue(row, '아키텍처 레이어');
      const description = this.getRowValue(row, '원인 (500자 이내)');
      const problematicCode = this.getRowValue(row, '이슈 코드 (1000자 이하, 문제가 있는 코드 전체)');
      const fixedCode = this.getRowValue(row, '올바른 코드 (1000자 이내, 수정된 코드 전체)');
      
      if (!title || !category || title === '이슈 제목 (200자 이내)') {
        continue;
      }
      
      const issueId = this.generateIssueId(category);
      
      const issue = {
        issueId,
        title,
        description,
        problematicCode,
        fixedCode,
        category,
        severity: severity || 'MEDIUM',
        baseTags: this.createBaseTags(domain, layer)
      };
      
      if (title.length > 200) {
        warnings.push(`[${issueId}] title이 200자 초과 (${title.length}자)`);
      }
      if (description.length > 500) {
        warnings.push(`[${issueId}] description이 500자 초과 (${description.length}자)`);
      }
      
      issues.push(issue);
    }
    
    if (warnings.length > 0) {
      logger.warn(`   ⚠️ 경고 ${warnings.length}건`);
      warnings.slice(0, 5).forEach(w => logger.warn(`      ${w}`));
    }
    
    logger.info(`   파싱 완료: ${issues.length}개 이슈`);
    return issues;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 2: Issue → 기본 Rule 변환 (필드 매핑)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Issue 배열을 기본 Rule 배열로 변환
   * (태깅은 RuleTagger가 담당 - GuidelineExtractor와 동일)
   * 
   * @param {Object[]} issues - Issue 객체 배열
   * @returns {Object[]} 기본 Rule 객체 배열
   */
  convertIssuesToBaseRules(issues) {
    logger.info(`🔄 Issue → 기본 Rule 변환: ${issues.length}개`);
    
    const rules = issues.map(issue => this.issueToBaseRule(issue));
    
    logger.info(`   변환 완료: ${rules.length}개 룰`);
    return rules;
  }

  /**
   * 단일 Issue를 기본 Rule로 변환
   * 
   * @param {Object} issue - Issue 객체
   * @returns {Object} 기본 Rule 객체 (태그 없음)
   */
  issueToBaseRule(issue) {
    // 카테고리 정규화
    const normalizedCategory = CATEGORY_NORMALIZE_MAP[issue.category] || 'general';
    
    // 심각도 정규화
    const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const severity = validSeverities.includes(issue.severity?.toUpperCase())
      ? issue.severity.toUpperCase()
      : 'MEDIUM';
    
    return {
      ruleId: issue.issueId,
      title: issue.title,
      description: issue.description || issue.title,
      category: normalizedCategory,
      severity,
      
      // 이슈 고유 정보 (가이드라인에는 없는 것)
      problematicCode: issue.problematicCode || '',
      fixedCode: issue.fixedCode || '',
      
      // 메시지
      message: issue.title,
      suggestion: issue.fixedCode 
        ? `수정 예시:\n${issue.fixedCode.substring(0, 300)}` 
        : '해당 패턴을 검토하고 개선하세요.',
      
      // 메타 정보
      source: `issue:${issue.category}`,
      baseTags: issue.baseTags || [],  // 도메인/레이어 태그 (RuleTagger에서 참고)
      isActive: true
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 3: RuleTagger로 태깅 (GuidelineExtractor와 동일)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * RuleTagger를 사용하여 룰에 태그 부여
   * GuidelineExtractor와 완전히 동일한 방식
   * 
   * @param {Object[]} rules - 기본 Rule 배열
   * @returns {Promise<Object[]>} 태그가 부여된 Rule 배열
   */
  async tagRules(rules) {
    logger.info(`🏷️ RuleTagger로 태깅: ${rules.length}개 룰`);
    
    // RuleTagger.tagRules() 사용 (GuidelineExtractor와 동일)
    const taggedRules = await this.ruleTagger.tagRules(rules);
    
    logger.info(`   태깅 완료: ${taggedRules.length}개 룰`);
    return taggedRules;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 4: Qdrant 저장 (GuidelineExtractor와 동일)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Rule 배열을 Qdrant에 저장
   */
  async storeRules(rules) {
    logger.info(`💾 Qdrant 저장: ${rules.length}개 룰`);
    
    const count = await this.qdrantClient.storeRules(rules);
    
    logger.info(`   저장 완료: ${count}개`);
    return count;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 메인 API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 전체 추출 프로세스 실행
   * 
   * 흐름 (GuidelineExtractor와 동일):
   * 1. CSV 파싱 → Issue JSON
   * 2. Issue → 기본 Rule 변환
   * 3. RuleTagger로 태깅 (LLM 기반)
   * 4. Qdrant 저장
   */
  async extractAll() {
    const inputDir = config.paths.input.issues;
    const files = await listFiles(inputDir, '.csv');

    if (files.length === 0) {
      logger.warn(`CSV 파일 없음: ${inputDir}`);
      return { rules: [], files: 0 };
    }

    logger.info(`📁 ${files.length}개 CSV 파일 발견`);

    const allIssues = [];
    const allRules = [];

    for (const filePath of files) {
      // Stage 1: CSV → Issue JSON
      const issues = await this.parseCSV(filePath);
      allIssues.push(...issues);
      
      // Stage 2: Issue → 기본 Rule 변환
      const baseRules = this.convertIssuesToBaseRules(issues);
      allRules.push(...baseRules);
    }

    // Stage 3: RuleTagger로 태깅 (GuidelineExtractor와 동일)
    logger.info('룰 태깅 시작...');
    const taggedRules = await this.tagRules(allRules);

    // Stage 4: Qdrant 저장
    logger.info('Qdrant 저장 시작...');
    await this.storeRules(taggedRules);

    // 백업 JSON 저장 - Issues (중간 결과)
    const issuesOutputPath = path.join(
      config.paths.output.rules,
      `issues_parsed_${Date.now()}.json`
    );
    await writeJsonFile(issuesOutputPath, {
      parsedAt: new Date().toISOString(),
      source: 'csv',
      count: allIssues.length,
      issues: allIssues
    });
    logger.info(`📄 Issue JSON 저장: ${issuesOutputPath}`);

    // 백업 JSON 저장 - Rules (최종 결과)
    const rulesOutputPath = path.join(
      config.paths.output.rules,
      `rules_from_issues_${Date.now()}.json`
    );
    await writeJsonFile(rulesOutputPath, {
      extractedAt: new Date().toISOString(),
      source: 'issues',
      count: taggedRules.length,
      rules: taggedRules
    });
    logger.info(`📄 Rule JSON 저장: ${rulesOutputPath}`);

    return {
      issues: allIssues,
      rules: taggedRules,
      files: files.length,
      outputPath: rulesOutputPath
    };
  }

  /**
   * 단일 파일 처리
   */
  async extractFromFile(filePath) {
    // Stage 1: CSV → Issue
    const issues = await this.parseCSV(filePath);
    
    // Stage 2: Issue → 기본 Rule
    const baseRules = this.convertIssuesToBaseRules(issues);
    
    // Stage 3: 태깅
    const taggedRules = await this.tagRules(baseRules);
    
    return { issues, rules: taggedRules };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════

let instance = null;

export function getIssueExtractor() {
  if (!instance) {
    instance = new IssueExtractor();
  }
  return instance;
}

export function resetIssueExtractor() {
  instance = null;
}

/**
 * CLI용 래퍼 함수
 */
export async function extractIssues() {
  const extractor = getIssueExtractor();
  await extractor.initialize();
  return await extractor.extractAll();
}

export default IssueExtractor;
