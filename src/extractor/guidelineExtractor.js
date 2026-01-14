/**
 * 가이드라인 추출기 V4.3 (다중 파일 지원)
 * 
 * 핵심 기능:
 * - 다중 DOCX 파일 → 단일 JSON (ruleId 충돌 방지)
 * - 파일별 고유 prefix 자동 생성
 * - 출처 추적 (sourceFile, sourcePrefix)
 * - DOCX 순서 보장 파싱 (preserveChildrenOrder + explicitChildren)
 * - 목차 기반 섹션 분리 (_Toc anchor)
 * - Bookmark 기반 정확한 섹션 추출
 * - 테이블 → Markdown 변환
 * - 이미지 관계 로드
 * - Context vs Guideline 분류
 * 
 * @module extractor/guidelineExtractor
 * @version 4.3
 */

import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { getLLMClient } from '../clients/llmClient.js';
import { getRuleTagger } from '../tagger/ruleTagger.js';
import { writeJsonFile, listFiles } from '../utils/fileUtils.js';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

export class GuidelineExtractor {
  constructor() {
    this.llmClient = null;
    this.ruleTagger = null;
    this.initialized = false;

    // DOCX 파싱 상태
    this.docxZip = null;
    this.tableOfContents = new Map();
    this.imageRelations = new Map();
    this.guidelines = [];
    this.contextRules = [];

    // 현재 처리 중인 파일 정보 (V4.3)
    this.currentFileInfo = {
      filename: null,
      prefix: 'GEN'
    };
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    logger.info('🚀 가이드라인 추출기 V4.3 초기화 중...');

    this.llmClient = getLLMClient();
    await this.llmClient.initialize();

    this.ruleTagger = getRuleTagger();
    await this.ruleTagger.initialize();

    this.initialized = true;
    logger.info('✅ GuidelineExtractor 초기화 완료');
  }

  /**
   * 입력 디렉토리의 모든 docx 파일에서 룰 추출 (V4.3 - 다중 파일 지원)
   * 
   * 개선사항:
   * - 파일별 고유 prefix 생성 (ruleId 충돌 방지)
   * - sources 메타데이터로 출처 추적
   * - 파일별 통계 수집
   */
  async extractAll() {
    const inputDir = config.paths.input.guidelines;
    const files = await listFiles(inputDir, '.docx');

    if (files.length === 0) {
      logger.warn(`docx 파일 없음: ${inputDir}`);
      return { rules: [], files: 0 };
    }

    logger.info(`${files.length}개 docx 파일 발견`);

    // 파일별 prefix 생성 (중복 방지)
    const prefixMap = this.generatePrefixMap(files);
    logger.info('📌 파일별 Prefix 할당:');
    for (const [filePath, prefix] of prefixMap.entries()) {
      logger.info(`   - ${path.basename(filePath)} → ${prefix}`);
    }

    const allRules = [];
    const sources = [];

    for (const filePath of files) {
      const filename = path.basename(filePath);
      const prefix = prefixMap.get(filePath);
      const fileStartTime = new Date();

      const result = await this.extractFromFile(filePath, { prefix, filename });
      
      allRules.push(...result.guidelines);

      // 파일별 통계 수집
      sources.push({
        filename,
        prefix,
        rulesCount: result.guidelines.length,
        contextRulesCount: result.contextRules?.length || 0,
        extractedAt: fileStartTime.toISOString()
      });
    }

    logger.info(`총 ${allRules.length}개 룰 추출 완료`);

    // 태깅
    logger.info('룰 태깅 시작...');
    const taggedRules = await this.ruleTagger.tagRules(allRules);

    // 고정 경로에 JSON 저장 (V4.3 스키마)
    const outputPath = config.paths.output.guidelinesJson;
    await writeJsonFile(outputPath, {
      metadata: {
        source: 'guideline',
        extractedAt: new Date().toISOString(),
        version: '4.3',
        totalCount: taggedRules.length,
        filesProcessed: files.length,
        sources
      },
      rules: taggedRules
    });

    logger.info(`✅ ${taggedRules.length}개 룰 저장 완료: ${outputPath}`);

    return {
      rules: taggedRules,
      files: files.length,
      sources,
      outputPath
    };
  }

  /**
   * 파일 목록에서 고유 prefix 맵 생성
   * 
   * @param {string[]} files - 파일 경로 배열
   * @returns {Map<string, string>} 파일경로 → prefix 맵
   */
  generatePrefixMap(files) {
    const prefixMap = new Map();
    const usedPrefixes = new Set();

    for (const filePath of files) {
      const filename = path.basename(filePath);
      let prefix = this.generatePrefix(filename);
      
      // 중복 시 숫자 추가
      prefix = this.ensureUniquePrefix(prefix, usedPrefixes);
      
      prefixMap.set(filePath, prefix);
      usedPrefixes.add(prefix);
    }

    return prefixMap;
  }

  /**
   * 파일명에서 prefix 생성
   * 
   * @param {string} filename - 파일명
   * @returns {string} prefix (대문자)
   */
  generatePrefix(filename) {
    const name = filename.toLowerCase().replace(/\.docx$/i, '');

    // 키워드 → prefix 매핑
    const mappings = [
      { keywords: ['개발표준', '개발_표준', 'dev_standard', 'development'], prefix: 'DEV' },
      { keywords: ['보안', 'security', 'sec_guide'], prefix: 'SEC' },
      { keywords: ['성능', 'performance', 'perf'], prefix: 'PERF' },
      { keywords: ['아키텍처', 'architecture', 'arch'], prefix: 'ARCH' },
      { keywords: ['코딩', 'coding', 'style', '스타일'], prefix: 'STY' },
      { keywords: ['에러', 'error', 'exception', '예외'], prefix: 'ERR' },
      { keywords: ['리소스', 'resource', '자원'], prefix: 'RES' },
      { keywords: ['네이밍', 'naming', '명명'], prefix: 'NAM' },
      { keywords: ['문서', 'document', 'doc'], prefix: 'DOC' },
      { keywords: ['테스트', 'test', 'testing'], prefix: 'TST' },
      { keywords: ['데이터', 'data', 'db', 'database'], prefix: 'DAT' },
      { keywords: ['api', 'rest', 'endpoint'], prefix: 'API' },
    ];

    for (const { keywords, prefix } of mappings) {
      if (keywords.some(kw => name.includes(kw))) {
        return prefix;
      }
    }

    // 매핑 실패 시: 파일명에서 추출
    // 한글 → 영문 앞글자, 영문 → 대문자 변환
    const extracted = this.extractPrefixFromName(name);
    return extracted || 'GEN';
  }

  /**
   * 파일명에서 prefix 추출 (키워드 매핑 실패 시)
   */
  extractPrefixFromName(name) {
    // 언더스코어/하이픈으로 분리된 단어의 첫 글자
    const parts = name.split(/[_\-\s]+/);
    
    if (parts.length >= 2) {
      // 각 파트의 첫 글자 조합 (최대 4자)
      const prefix = parts
        .slice(0, 4)
        .map(p => p.charAt(0).toUpperCase())
        .join('');
      
      if (prefix.length >= 2) {
        return prefix;
      }
    }

    // 단일 단어: 앞 3글자
    const cleaned = name.replace(/[^a-zA-Z0-9가-힣]/g, '');
    if (cleaned.length >= 3) {
      return cleaned.substring(0, 3).toUpperCase();
    }

    return null;
  }

  /**
   * prefix 중복 방지
   * 
   * @param {string} prefix - 원본 prefix
   * @param {Set<string>} usedPrefixes - 이미 사용된 prefix 집합
   * @returns {string} 고유한 prefix
   */
  ensureUniquePrefix(prefix, usedPrefixes) {
    if (!usedPrefixes.has(prefix)) {
      return prefix;
    }

    // 숫자 추가하여 고유화
    let counter = 2;
    while (usedPrefixes.has(`${prefix}${counter}`)) {
      counter++;
    }

    return `${prefix}${counter}`;
  }

  /**
   * 단일 docx 파일에서 룰 추출 (V4.3 - prefix 지원)
   * 
   * @param {string} filePath - 파일 경로
   * @param {Object} options - 옵션 { prefix, filename }
   */
  async extractFromFile(filePath, options = {}) {
    const filename = options.filename || path.basename(filePath);
    const prefix = options.prefix || 'GEN';

    logger.info(`📄 파일 처리: ${filename} [${prefix}]`);

    try {
      // 상태 초기화
      this.tableOfContents = new Map();
      this.imageRelations = new Map();
      this.guidelines = [];
      this.contextRules = [];

      // 현재 파일 정보 저장 (하위 메서드에서 사용)
      this.currentFileInfo = { filename, prefix };

      return await this.extractFromDOCX(filePath);

    } catch (error) {
      logger.error(`❌ 파일 처리 실패: ${filePath}`, error.message);
      return { contextRules: [], guidelines: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCX 파싱 (V4.3 - 다중 파일 지원)
  // ═══════════════════════════════════════════════════════════════════════════

  async extractFromDOCX(docxPath) {
    logger.info('📘 DOCX 파싱 시작 (V4.3)...');

    try {
      // Step 1: ZIP 로드
      const buffer = await fs.readFile(docxPath);
      this.docxZip = await JSZip.loadAsync(buffer);

      const documentXml = await this.docxZip.file('word/document.xml').async('string');

      // 🔑 순서 보장 옵션 (기존 로직 100% 유지)
      const doc = await parseStringPromise(documentXml, {
        preserveChildrenOrder: true,
        explicitChildren: true,
        charsAsChildren: false
      });

      const body = doc['w:document']['w:body'][0];

      // Step 2: 이미지 관계 로드
      await this.loadImageRelations();

      // Step 3: 목차 파싱
      logger.info('\n📋 Step 1/3: 목차 파싱 중...');
      this.parseTableOfContents(body);
      logger.info(`✅ 목차 ${this.tableOfContents.size}개 항목 파싱 완료`);

      // Step 4: Bookmark 기반 섹션 추출 (순서 보장)
      logger.info('\n📑 Step 2/3: Bookmark 기반 섹션 추출 중...');
      const sections = await this.extractSectionsByBookmarks(body);
      logger.info(`✅ 총 ${sections.length}개 섹션 추출 완료`);

      // 테이블 통계
      const sectionsWithTables = sections.filter(s =>
        s.contentElements.some(e => e.type === 'table')
      );
      const totalTables = sections.reduce((sum, s) =>
        sum + s.contentElements.filter(e => e.type === 'table').length, 0
      );
      logger.info(`📊 테이블이 있는 섹션: ${sectionsWithTables.length}개, 총 테이블: ${totalTables}개`);

      // Step 5: Context vs Guidelines 분류
      const contextSections = sections.filter(s => s.isContext);
      const guidelineSections = sections.filter(s => !s.isContext);

      logger.info(`  📋 Context Rules: ${contextSections.length}개`);
      logger.info(`  📜 Guidelines: ${guidelineSections.length}개`);

      // Step 6: Context Rules 처리
      this.contextRules = contextSections.map(ctx => ({
        ruleId: `ctx.${ctx.contextType}`,
        title: ctx.title,
        sectionNumber: ctx.sectionNumber,
        level: ctx.level,
        content: this.extractSectionTextOnly(ctx),
        appliesTo: ctx.appliesTo,
        contextType: ctx.contextType
      }));

      // Step 7: Guideline 처리 (LLM 배치)
      logger.info('\n📦 Step 3/3: Guideline 구조화 중...');
      this.guidelines = [];
      const batchSize = 5;

      for (let i = 0; i < guidelineSections.length; i += batchSize) {
        const batch = guidelineSections.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(guidelineSections.length / batchSize);

        logger.info(`  📦 배치 ${batchNum}/${totalBatches} 처리 중...`);

        await Promise.all(batch.map(section => this.convertToGuideline(section)));

        // API 부하 방지
        await this._sleep(200);
      }

      this.sortGuidelines();

      logger.info(`\n✅ 총 ${this.contextRules.length}개 Context + ${this.guidelines.length}개 Guideline 추출 완료`);

      return {
        contextRules: this.contextRules,
        guidelines: this.guidelines
      };

    } catch (error) {
      logger.error(`❌ DOCX 파싱 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * 이미지 관계 로드
   */
  async loadImageRelations() {
    try {
      const relsXml = await this.docxZip.file('word/_rels/document.xml.rels').async('string');
      const rels = await parseStringPromise(relsXml);

      const relationships = rels['Relationships']['Relationship'];
      for (const rel of relationships) {
        const id = rel.$['Id'];
        const target = rel.$['Target'];
        const type = rel.$['Type'];

        if (type && type.includes('image')) {
          this.imageRelations.set(id, target);
        }
      }

      logger.info(`✅ 이미지 관계 ${this.imageRelations.size}개 로드 완료`);
    } catch (error) {
      logger.warn('⚠️ 이미지 관계 파일 없음');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 목차 파싱 ($$ 구조 대응)
  // ═══════════════════════════════════════════════════════════════════════════

  parseTableOfContents(body) {
    let tocStarted = false;
    let tocEnded = false;

    const children = body.$$ || [];

    for (const child of children) {
      if (tocEnded) break;

      const tagName = child['#name'];
      if (tagName !== 'w:p') continue;

      const hyperlinks = this.findChildrenByName(child, 'w:hyperlink');

      if (hyperlinks.length === 0) {
        if (tocStarted) {
          const bookmarks = this.findBookmarkStarts(child);
          if (bookmarks.length > 0) {
            tocEnded = true;
            break;
          }
        }
        continue;
      }

      for (const hyperlink of hyperlinks) {
        const anchor = hyperlink.$?.['w:anchor'];
        if (!anchor) continue;

        if (anchor.startsWith('_Toc')) {
          tocStarted = true;
        }

        if (!tocStarted) continue;

        const pPr = this.findChildByName(child, 'w:pPr');
        const pStyleNode = pPr ? this.findChildByName(pPr, 'w:pStyle') : null;
        const pStyle = pStyleNode?.$?.['w:val'];

        let level = null;
        if (pStyle === '12') level = 1;
        else if (pStyle === '21') level = 2;
        else if (pStyle === '31') level = 3;
        else if (pStyle === '41') level = 4;

        if (level === null) continue;

        const title = this.extractTextFromElement(hyperlink);

        this.tableOfContents.set(anchor, {
          level,
          title: title.trim(),
          anchor
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bookmark 기반 섹션 추출 (순서 보장)
  // ═══════════════════════════════════════════════════════════════════════════

  async extractSectionsByBookmarks(body) {
    const sections = [];
    let currentSection = null;
    let skipUntilTocEnd = true;

    const orderedElements = this.getOrderedBodyElements(body);

    logger.info(`📋 순서 보장 요소: ${orderedElements.length}개`);

    for (const { type, element } of orderedElements) {
      if (type === 'w:p') {
        const bookmarkStarts = this.findBookmarkStarts(element);

        for (const bookmark of bookmarkStarts) {
          const bookmarkName = bookmark.$?.['w:name'];
          if (!bookmarkName) continue;

          const tocEntry = this.tableOfContents.get(bookmarkName);
          if (tocEntry) {
            skipUntilTocEnd = false;

            if (currentSection && this.isValidSection(currentSection)) {
              sections.push(currentSection);
            }

            currentSection = {
              level: tocEntry.level,
              sectionNumber: this.inferSectionNumber(tocEntry.title),
              title: tocEntry.title,
              anchor: bookmarkName,
              contentElements: [],
              isContext: false,
              contextType: null,
              appliesTo: null
            };

            const contextInfo = this.identifyContextSection(currentSection);
            if (contextInfo) {
              currentSection.isContext = true;
              currentSection.contextType = contextInfo.contextType;
              currentSection.appliesTo = contextInfo.appliesTo;
            }
          }
        }

        if (skipUntilTocEnd) continue;

        if (currentSection && bookmarkStarts.length === 0) {
          currentSection.contentElements.push({ type: 'paragraph', element });
        }
      }

      else if (type === 'w:tbl') {
        if (skipUntilTocEnd) continue;

        if (currentSection) {
          currentSection.contentElements.push({ type: 'table', element });

          const tblInfo = this.extractTableData(element);
          logger.debug(`  📊 테이블 → "${currentSection.title.substring(0, 30)}" (${tblInfo.rows}×${tblInfo.cols})`);
        }
      }
    }

    if (currentSection && this.isValidSection(currentSection)) {
      sections.push(currentSection);
    }

    return sections;
  }

  /**
   * 순서 보장된 body 요소 추출
   */
  getOrderedBodyElements(body) {
    const elements = [];

    // $$ 구조 우선 사용 (순서 보장)
    if (body.$$) {
      for (const child of body.$$) {
        const tagName = child['#name'];
        if (tagName === 'w:p' || tagName === 'w:tbl') {
          elements.push({ type: tagName, element: child });
        }
      }
      logger.debug(`✅ 순서 보장 파싱: ${elements.length}개 요소`);
      return elements;
    }

    // 폴백: 키 기반 추출 (순서 보장 불가)
    logger.warn('⚠️ body.$$ 없음 - 순서 보장 불가!');

    for (const [key, value] of Object.entries(body)) {
      if ((key === 'w:p' || key === 'w:tbl') && Array.isArray(value)) {
        for (const element of value) {
          elements.push({ type: key, element });
        }
      }
    }

    return elements;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // XML 헬퍼 메소드
  // ═══════════════════════════════════════════════════════════════════════════

  findBookmarkStarts(element) {
    const bookmarks = [];

    if (element.$$) {
      for (const child of element.$$) {
        if (child['#name'] === 'w:bookmarkStart') {
          bookmarks.push(child);
        }
      }
    }

    if (bookmarks.length === 0 && element['w:bookmarkStart']) {
      bookmarks.push(...element['w:bookmarkStart']);
    }

    return bookmarks;
  }

  findChildrenByName(element, name) {
    const children = [];

    if (element.$$) {
      for (const child of element.$$) {
        if (child['#name'] === name) {
          children.push(child);
        }
      }
    }

    if (children.length === 0 && element[name]) {
      if (Array.isArray(element[name])) {
        children.push(...element[name]);
      } else {
        children.push(element[name]);
      }
    }

    return children;
  }

  findChildByName(element, name) {
    if (element.$$) {
      for (const child of element.$$) {
        if (child['#name'] === name) {
          return child;
        }
      }
    }

    if (element[name]) {
      return Array.isArray(element[name]) ? element[name][0] : element[name];
    }

    return null;
  }

  /**
   * 재귀적 텍스트 추출 (기존 로직 100%)
   */
  extractTextFromElement(element) {
    const texts = [];

    const extractRecursive = (el) => {
      if (el['#name'] === 'w:t') {
        if (el._) {
          texts.push(el._);
        }
      }

      if (el.$$) {
        for (const child of el.$$) {
          extractRecursive(child);
        }
      }
    };

    extractRecursive(element);

    // 폴백: $$ 없는 경우
    if (texts.length === 0) {
      const runs = element['w:r'] || [];
      for (const run of runs) {
        const tElements = run['w:t'];
        if (!tElements) continue;
        for (const t of tElements) {
          if (typeof t === 'string') texts.push(t);
          else if (t && t._) texts.push(t._);
        }
      }
    }

    return texts.join('');
  }

  extractTextFromParagraph(para) {
    return this.extractTextFromElement(para);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 섹션 처리
  // ═══════════════════════════════════════════════════════════════════════════

  inferSectionNumber(title) {
    const match = title.match(/^([\d.]+)\s+/);
    return match ? match[1] : '0';
  }

  identifyContextSection(section) {
    const keywords = ['개요', 'Consensus', '대상', '용어', '아키텍처'];
    const lowerTitle = section.title.toLowerCase();

    const hasKeyword = keywords.some(kw => lowerTitle.includes(kw.toLowerCase()));
    if (!hasKeyword) return null;

    let contextType = 'general';
    if (lowerTitle.includes('개요')) contextType = 'overview';
    else if (lowerTitle.includes('consensus')) contextType = 'consensus';
    else if (lowerTitle.includes('대상')) contextType = 'scope';
    else if (lowerTitle.includes('용어')) contextType = 'terminology';
    else if (lowerTitle.includes('아키텍처')) contextType = 'architecture';

    let appliesTo = 'all';
    if (section.level === 2) {
      const l1Number = section.sectionNumber.split('.')[0];
      appliesTo = `section_${l1Number}`;
    }

    return { contextType, appliesTo };
  }

  isValidSection(section) {
    if (section.isContext) return true;
    if (section.contentElements.length === 0) return false;
    return true;
  }

  extractSectionTextOnly(section) {
    const textLines = [];

    for (const item of section.contentElements) {
      if (item.type === 'paragraph') {
        const text = this.extractTextFromParagraph(item.element);
        if (text) textLines.push(text);
      }
    }

    return textLines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 테이블 처리
  // ═══════════════════════════════════════════════════════════════════════════

  extractTableData(tableElement) {
    let rows = this.findChildrenByName(tableElement, 'w:tr');

    if (rows.length === 0) {
      return { type: 'empty', content: '', markdown: '', rows: 0, cols: 0 };
    }

    const tableData = [];

    for (const row of rows) {
      const cells = this.findChildrenByName(row, 'w:tc');
      const rowData = [];

      for (const cell of cells) {
        const cellParas = this.findChildrenByName(cell, 'w:p');
        const cellTexts = [];

        for (const para of cellParas) {
          const text = this.extractTextFromParagraph(para);
          if (text) cellTexts.push(text);
        }

        rowData.push({
          text: cellTexts.join(' '),
          gridSpan: 1,
          vMerge: null
        });
      }

      tableData.push(rowData);
    }

    // 단일 셀 → 텍스트박스로 처리
    if (tableData.length === 1 && tableData[0].length === 1) {
      return {
        type: 'textbox',
        content: tableData[0][0].text,
        markdown: '',
        rows: 1,
        cols: 1
      };
    }

    const markdown = this.convertTableToMarkdown(tableData);

    return {
      type: 'table',
      rows: tableData.length,
      cols: tableData[0]?.length || 0,
      content: '',
      markdown
    };
  }

  convertTableToMarkdown(tableData) {
    if (tableData.length === 0) return '';

    const lines = [];

    const headerRow = tableData[0];
    const headerCells = headerRow.map(cell => cell.text || '');
    lines.push('| ' + headerCells.join(' | ') + ' |');

    const separator = headerCells.map(() => '---').join(' | ');
    lines.push('| ' + separator + ' |');

    for (let i = 1; i < tableData.length; i++) {
      const row = tableData[i];
      const cells = row.map(cell => cell.text || '');
      lines.push('| ' + cells.join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Guideline 변환 (LLM 활용)
  // ═══════════════════════════════════════════════════════════════════════════

  async extractSectionContent(section) {
    const content = {
      text: '',
      tables: [],
      images: []
    };

    const textLines = [];

    for (const item of section.contentElements) {
      if (item.type === 'paragraph') {
        const text = this.extractTextFromParagraph(item.element);
        if (text) textLines.push(text);
      }

      else if (item.type === 'table') {
        const table = this.extractTableData(item.element);
        content.tables.push(table);

        if (table.type === 'textbox') {
          textLines.push(`\n[텍스트박스] ${table.content}\n`);
        } else {
          textLines.push('\n' + table.markdown + '\n');
        }
      }
    }

    content.text = textLines.join('\n');

    return content;
  }

  async convertToGuideline(section) {
    try {
      const content = await this.extractSectionContent(section);
      const ruleText = `${section.sectionNumber} ${section.title}\n\n${content.text}`;

      const prompt = this.buildExtractionPrompt(section, content);

      const response = await this.llmClient.generateCompletion(prompt, {
        temperature: 0.1,
        max_tokens: 2000,
        system_prompt: 'You are an expert at extracting code quality rules from documentation. Respond only in valid JSON format.'
      });

      const result = this.llmClient.cleanAndExtractJSON(response);

      if (!result) {
        const guideline = this.createFallbackGuideline(section, content, ruleText);
        this.guidelines.push(guideline);
        return;
      }

      const guideline = this.normalizeGuideline(result, section, content, ruleText);
      this.guidelines.push(guideline);

      logger.debug(`  ✅ [${guideline.ruleId}] 변환 완료`);

    } catch (error) {
      logger.error(`  ❌ 변환 실패: ${section.sectionNumber} - ${error.message}`);
      const guideline = this.createFallbackGuideline(section, { text: '', tables: [], images: [] }, '');
      this.guidelines.push(guideline);
    }
  }

  buildExtractionPrompt(section, content) {
    return `다음 개발 가이드라인 섹션에서 코드 품질 규칙을 추출해주세요.

## 섹션 정보
- 번호: ${section.sectionNumber}
- 제목: ${section.title}
- 레벨: ${section.level}

## 섹션 내용
${content.text.substring(0, 4000)}

## 출력 형식 (JSON)
{
  "title": "규칙 제목 (간결하게)",
  "description": "규칙 설명 (상세하게)",
  "category": "카테고리 (resource_management, security, exception_handling, performance, architecture, code_style 중 택1)",
  "severity": "심각도 (CRITICAL, HIGH, MEDIUM, LOW 중 택1)",
  "message": "위반 시 표시할 메시지",
  "suggestion": "개선 제안",
  "badExample": "문서에 있는 나쁜 코드 예시 (있는 경우만, 원문 그대로)",
  "goodExample": "문서에 있는 좋은 코드 예시 (있는 경우만, 원문 그대로)",
  "keywords": ["관련", "키워드", "목록"]
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

JSON만 출력하세요.`;
  }

  normalizeGuideline(result, section, content, ruleText) {
    // 카테고리 정규화
    const validCategories = [
      'resource_management', 'security', 'exception_handling',
      'performance', 'architecture', 'code_style', 'naming_convention',
      'documentation', 'general'
    ];
    const category = validCategories.includes(result.category?.toLowerCase())
      ? result.category.toLowerCase()
      : this.inferCategory(section.title, ruleText);

    // 심각도 정규화
    const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const severity = validSeverities.includes(result.severity?.toUpperCase())
      ? result.severity.toUpperCase()
      : this.inferSeverity(section.title, ruleText);

    // 카테고리 접두사
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

    const catPrefix = categoryPrefix[category] || 'GEN';
    const docPrefix = this.currentFileInfo.prefix;
    
    // V4.3: ruleId에 문서 prefix 추가
    // 형식: {docPrefix}.{categoryPrefix}.{sectionNumber}
    // 예: DEV.ERR.3_2, SEC.RES.4_1
    const ruleId = `${docPrefix}.${catPrefix}.${section.sectionNumber.replace(/\./g, '_')}`;

    return {
      ruleId,
      sectionNumber: section.sectionNumber,
      title: result.title || section.title,
      level: section.level,
      category,
      severity,
      description: result.description || ruleText.substring(0, 500),
      message: result.message || result.title || section.title,
      suggestion: result.suggestion || '',
      source: `guideline:${section.sectionNumber}`,
      // V4.3: 출처 추적 필드
      sourceFile: this.currentFileInfo.filename,
      sourcePrefix: docPrefix,
      isActive: true,
      // 코드 예시 (RuleTagger에서 활용)
      problematicCode: result.badExample || null,
      fixedCode: result.goodExample || null,
      keywords: result.keywords || this.extractKeywordsFromText(section.title, ruleText),
      // 문서 컨텍스트
      hasTables: content.tables.length > 0,
      hasImages: content.images?.length > 0,
      tables: content.tables,
      metadata: {
        createdAt: new Date().toISOString(),
        source: `${section.sectionNumber} ${section.title}`,
        sourceFile: this.currentFileInfo.filename,
        version: '4.3'
      }
    };
  }

  createFallbackGuideline(section, content, ruleText) {
    const category = this.inferCategory(section.title, ruleText || '');

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

    const catPrefix = categoryPrefix[category] || 'GEN';
    const docPrefix = this.currentFileInfo.prefix;
    
    // V4.3: ruleId에 문서 prefix 추가
    const ruleId = `${docPrefix}.${catPrefix}.${section.sectionNumber.replace(/\./g, '_')}`;

    return {
      ruleId,
      sectionNumber: section.sectionNumber,
      title: section.title,
      level: section.level,
      category,
      severity: this.inferSeverity(section.title, ruleText || ''),
      description: ruleText?.substring(0, 500) || section.title,
      message: `${section.title} 규칙을 위반했습니다`,
      source: `guideline:${section.sectionNumber}`,
      // V4.3: 출처 추적 필드
      sourceFile: this.currentFileInfo.filename,
      sourcePrefix: docPrefix,
      isActive: true,
      keywords: this.extractKeywordsFromText(section.title, ruleText || ''),
      metadata: {
        createdAt: new Date().toISOString(),
        source: `${section.sectionNumber} ${section.title}`,
        sourceFile: this.currentFileInfo.filename,
        version: '4.3',
        isFallback: true
      },
      hasTables: content.tables?.length > 0,
      tables: content.tables || []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 유틸리티
  // ═══════════════════════════════════════════════════════════════════════════

  inferCategory(title, content) {
    const lowerTitle = title.toLowerCase();
    const lowerContent = content.toLowerCase();

    if (lowerTitle.includes('명명') || lowerTitle.includes('이름')) return 'naming_convention';
    if (lowerTitle.includes('주석') || lowerContent.includes('javadoc')) return 'documentation';
    if (lowerTitle.includes('들여쓰기') || lowerTitle.includes('공백')) return 'code_style';
    if (lowerContent.includes('exception') || lowerContent.includes('try') || lowerContent.includes('catch')) return 'exception_handling';
    if (lowerContent.includes('connection') || lowerContent.includes('resource') || lowerContent.includes('close')) return 'resource_management';
    if (lowerContent.includes('security') || lowerContent.includes('injection') || lowerContent.includes('sql')) return 'security';
    if (lowerContent.includes('controller') || lowerContent.includes('service') || lowerContent.includes('layer')) return 'architecture';
    if (lowerContent.includes('performance') || lowerContent.includes('성능')) return 'performance';

    return 'general';
  }

  inferSeverity(title, content) {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('필수') || lowerContent.includes('반드시') || lowerContent.includes('금지')) return 'HIGH';
    if (lowerContent.includes('보안') || lowerContent.includes('security') || lowerContent.includes('injection')) return 'CRITICAL';
    if (lowerContent.includes('권장') || lowerContent.includes('가급적')) return 'MEDIUM';

    return 'LOW';
  }

  extractKeywordsFromText(title, content) {
    const keywords = [];
    const text = `${title} ${content}`.toLowerCase();

    // Java 관련 키워드
    const javaKeywords = [
      'exception', 'try', 'catch', 'finally', 'throw',
      'connection', 'stream', 'resource', 'close',
      'sql', 'injection', 'security', 'validation',
      'controller', 'service', 'repository', 'dao',
      'annotation', 'interface', 'abstract', 'class',
      'static', 'final', 'synchronized', 'volatile'
    ];

    for (const kw of javaKeywords) {
      if (text.includes(kw)) {
        keywords.push(kw);
      }
    }

    return keywords;
  }

  sortGuidelines() {
    this.guidelines.sort((a, b) => {
      const parseSection = (s) => s.split('.').map(n => parseInt(n, 10) || 0);
      const aParts = parseSection(a.sectionNumber);
      const bParts = parseSection(b.sectionNumber);

      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (aVal !== bVal) return aVal - bVal;
      }
      return 0;
    });
  }

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