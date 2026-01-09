/**
 * 가이드라인 추출기
 * 
 * docx 파일에서 코드 품질 규칙을 추출
 * 
 * @module extractor/guidelineExtractor
 */

import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import xml2js from 'xml2js';
import { getLLMClient } from '../clients/llmClient.js';
import { getQdrantClient } from '../clients/qdrantClient.js';
import { getRuleTagger } from '../tagger/ruleTagger.js';
import { writeJsonFile, listFiles } from '../utils/fileUtils.js';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

export class GuidelineExtractor {
  constructor() {
    this.llmClient = null;
    this.qdrantClient = null;
    this.ruleTagger = null;
    this.initialized = false;
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

    this.ruleTagger = getRuleTagger();
    await this.ruleTagger.initialize();

    this.initialized = true;
    logger.info('✅ GuidelineExtractor 초기화 완료');
  }

  /**
   * 입력 디렉토리의 모든 docx 파일에서 룰 추출
   * 
   * @returns {Promise<Object>} 추출 결과
   */
  async extractAll() {
    const inputDir = config.paths.input.guidelines;
    const files = await listFiles(inputDir, '.docx');

    if (files.length === 0) {
      logger.warn(`docx 파일 없음: ${inputDir}`);
      return { rules: [], files: 0 };
    }

    logger.info(`${files.length}개 docx 파일 발견`);

    const allRules = [];

    for (const filePath of files) {
      const rules = await this.extractFromFile(filePath);
      allRules.push(...rules);
    }

    logger.info(`총 ${allRules.length}개 룰 추출 완료`);

    // 태깅
    logger.info('룰 태깅 시작...');
    const taggedRules = await this.ruleTagger.tagRules(allRules);

    // Qdrant 저장
    logger.info('Qdrant 저장 시작...');
    await this.qdrantClient.storeRules(taggedRules);

    // 백업 JSON 저장
    const outputPath = path.join(
      config.paths.output.rules,
      `guidelines_${Date.now()}.json`
    );
    await writeJsonFile(outputPath, {
      extractedAt: new Date().toISOString(),
      source: 'guidelines',
      count: taggedRules.length,
      rules: taggedRules
    });

    return {
      rules: taggedRules,
      files: files.length,
      outputPath
    };
  }

  /**
   * 단일 docx 파일에서 룰 추출
   * 
   * @param {string} filePath - docx 파일 경로
   * @returns {Promise<Object[]>} 추출된 룰 배열
   */
  async extractFromFile(filePath) {
    logger.info(`파일 처리: ${path.basename(filePath)}`);

    try {
      // docx → 텍스트 변환
      const text = await this.parseDocx(filePath);

      if (!text || text.length < 100) {
        logger.warn(`텍스트 추출 실패 또는 내용 부족: ${filePath}`);
        return [];
      }

      // 섹션 분리
      const sections = this.splitIntoSections(text);
      logger.info(`${sections.length}개 섹션 발견`);

      // 각 섹션에서 룰 추출
      const rules = [];
      let ruleIndex = 1;

      for (const section of sections) {
        if (section.content.length < 50) continue;

        const extractedRules = await this.extractRulesFromSection(section, ruleIndex);
        rules.push(...extractedRules);
        ruleIndex += extractedRules.length;

        // API 부하 방지
        await this._sleep(200);
      }

      logger.info(`${rules.length}개 룰 추출: ${path.basename(filePath)}`);
      return rules;

    } catch (error) {
      logger.error(`파일 처리 실패: ${filePath}`, error.message);
      return [];
    }
  }

  /**
   * docx 파일 파싱 (jszip + xml2js)
   */
  async parseDocx(filePath) {
    const buffer = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);
    
    // word/document.xml 추출
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) {
      throw new Error('document.xml not found in docx');
    }
    
    // XML 파싱
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(documentXml);
    
    // 텍스트 추출
    const body = result['w:document']?.['w:body'];
    if (!body) {
      throw new Error('Invalid docx structure');
    }
    
    return this.extractTextFromBody(body);
  }

  /**
   * docx body에서 텍스트 추출
   */
  extractTextFromBody(body) {
    const texts = [];
    const paragraphs = body['w:p'];
    
    if (!paragraphs) return '';
    
    const paraArray = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
    
    for (const para of paraArray) {
      const paraText = this.extractTextFromParagraph(para);
      if (paraText) {
        texts.push(paraText);
      }
    }
    
    return texts.join('\n');
  }

  /**
   * 단일 문단에서 텍스트 추출
   */
  extractTextFromParagraph(para) {
    if (!para) return '';
    
    const runs = para['w:r'];
    if (!runs) return '';
    
    const runArray = Array.isArray(runs) ? runs : [runs];
    const textParts = [];
    
    for (const run of runArray) {
      const textNode = run['w:t'];
      if (textNode) {
        // textNode가 객체인 경우 (속성이 있는 경우)
        const text = typeof textNode === 'string' ? textNode : textNode._ || textNode;
        if (text) {
          textParts.push(text);
        }
      }
    }
    
    return textParts.join('');
  }

  /**
   * 텍스트를 섹션으로 분리
   */
  splitIntoSections(text) {
    const sections = [];
    
    // 섹션 헤더 패턴 (예: "1.2.3 제목", "제1장", "### 제목" 등)
    const sectionPattern = /(?:^|\n)((?:\d+\.)+\d*\s+[^\n]+|제\d+[장절항]\s*[^\n]*|#{1,3}\s+[^\n]+)/g;
    
    let lastIndex = 0;
    let lastHeader = '서문';
    let match;

    while ((match = sectionPattern.exec(text)) !== null) {
      // 이전 섹션 저장
      if (lastIndex > 0 || match.index > 0) {
        const content = text.substring(lastIndex, match.index).trim();
        if (content.length > 50) {
          sections.push({
            header: lastHeader,
            content: content
          });
        }
      }

      lastHeader = match[1].trim();
      lastIndex = match.index + match[0].length;
    }

    // 마지막 섹션
    const lastContent = text.substring(lastIndex).trim();
    if (lastContent.length > 50) {
      sections.push({
        header: lastHeader,
        content: lastContent
      });
    }

    // 섹션이 없으면 전체를 하나의 섹션으로
    if (sections.length === 0 && text.length > 100) {
      sections.push({
        header: '전체 문서',
        content: text
      });
    }

    return sections;
  }

  /**
   * 섹션에서 룰 추출 (LLM 사용)
   */
  async extractRulesFromSection(section, startIndex) {
    const prompt = this.buildExtractionPrompt(section);

    try {
      const response = await this.llmClient.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 2000,
        system_prompt: 'You are an expert at extracting code quality rules from documentation. Respond only in valid JSON format.'
      });

      const result = this.llmClient.cleanAndExtractJSON(response);

      if (!result || !Array.isArray(result.rules)) {
        logger.warn(`룰 추출 실패 (JSON): ${section.header}`);
        return [];
      }

      // 룰 ID 생성 및 정규화
      return result.rules.map((rule, idx) => this.normalizeRule(rule, startIndex + idx, section.header));

    } catch (error) {
      logger.error(`섹션 처리 실패: ${section.header}`, error.message);
      return [];
    }
  }

  /**
   * 추출 프롬프트 생성
   * 
   * 코드 예시가 있는 경우 함께 추출 (RuleTagger에서 패턴 생성에 활용)
   */
  buildExtractionPrompt(section) {
    return `다음 개발 가이드라인 섹션에서 코드 품질 규칙을 추출해주세요.

## 섹션 제목
${section.header}

## 섹션 내용
${section.content.substring(0, 4000)}

## 출력 형식 (JSON)
{
  "rules": [
    {
      "title": "규칙 제목 (간결하게)",
      "description": "규칙 설명 (상세하게)",
      "category": "카테고리 (resource_management, security, exception_handling, performance, architecture, code_style 중 택1)",
      "severity": "심각도 (CRITICAL, HIGH, MEDIUM, LOW 중 택1)",
      "message": "위반 시 표시할 메시지",
      "suggestion": "개선 제안",
      "badExample": "문서에 있는 나쁜 코드 예시 (있는 경우만, 원문 그대로)",
      "goodExample": "문서에 있는 좋은 코드 예시 (있는 경우만, 원문 그대로)"
    }
  ]
}

## 추출 기준
1. 명확한 금지 사항 (예: "~하지 마라", "금지")
2. 권장 사항 (예: "~해야 한다", "권장")
3. 코드 작성 규칙
4. 보안 관련 지침
5. 성능 관련 지침

## 코드 예시 추출 (중요!)
- 문서에 코드 예시가 있으면 반드시 추출하세요
- badExample: 피해야 할 코드, 잘못된 코드, 안티패턴
- goodExample: 권장하는 코드, 올바른 코드, 개선된 코드
- 코드 블록, 인라인 코드, 예시 코드 모두 해당
- 코드가 없으면 해당 필드를 생략하거나 null

규칙이 없으면 빈 배열을 반환하세요.
JSON만 출력하세요.`;
  }

  /**
   * 추출된 룰 정규화
   * 
   * 코드 예시가 있는 경우 problematicCode/fixedCode로 매핑
   * → RuleTagger가 패턴 추출에 활용
   */
  normalizeRule(rule, index, source) {
    // 카테고리 정규화
    const validCategories = [
      'resource_management', 'security', 'exception_handling',
      'performance', 'architecture', 'code_style', 'naming_convention',
      'documentation', 'general'
    ];
    const category = validCategories.includes(rule.category?.toLowerCase())
      ? rule.category.toLowerCase()
      : 'general';

    // 심각도 정규화
    const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const severity = validSeverities.includes(rule.severity?.toUpperCase())
      ? rule.severity.toUpperCase()
      : 'MEDIUM';

    // 카테고리 접두사 생성
    const categoryPrefix = {
      'resource_management': 'RES',
      'security': 'SEC',
      'exception_handling': 'ERR',
      'performance': 'PERF',
      'architecture': 'ARCH',
      'code_style': 'STY',
      'naming_convention': 'NAM',
      'documentation': 'DOC',
      'general': 'GEN'
    };

    const prefix = categoryPrefix[category] || 'GEN';
    const ruleId = `${prefix}-${String(index).padStart(3, '0')}`;

    // 코드 예시 매핑 (있는 경우만)
    // badExample → problematicCode, goodExample → fixedCode
    // RuleTagger가 이 필드를 보고 패턴 추출
    const hasCodeExamples = rule.badExample || rule.goodExample;
    
    if (hasCodeExamples) {
      logger.debug(`  📝 [${ruleId}] 코드 예시 발견 → 패턴 추출에 활용`);
    }

    return {
      ruleId,
      title: rule.title || '제목 없음',
      description: rule.description || '',
      category,
      severity,
      message: rule.message || rule.title || '',
      suggestion: rule.suggestion || '',
      source: `guideline:${source}`,
      isActive: true,
      // 코드 예시 (RuleTagger에서 활용)
      problematicCode: rule.badExample || null,
      fixedCode: rule.goodExample || null
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

export function getGuidelineExtractor() {
  if (!instance) {
    instance = new GuidelineExtractor();
  }
  return instance;
}

/**
 * CLI용 래퍼 함수
 */
export async function extractGuidelines() {
  const extractor = getGuidelineExtractor();
  await extractor.initialize();
  return await extractor.extractAll();
}

export default GuidelineExtractor;
