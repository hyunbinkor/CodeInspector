/**
 * Qdrant 클라이언트 (통합 버전)
 * 
 * 기존 프로젝트의 vectorClient.js + qdrantAdapter.js 통합
 * - 태그 기반 룰 저장/조회
 * - checkType 검증 (pure_regex, llm_with_regex, llm_contextual, llm_with_ast)
 * - antiPatterns/goodPatterns 처리
 * - 태그 표현식 평가 (AND, OR, NOT)
 * 
 * @module clients/qdrantClient
 */

import { QdrantClient as Qdrant } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

/** @type {QdrantClient|null} */
let instance = null;

export class QdrantClient {
  /**
   * @param {Object} customConfig - 커스텀 설정 (테스트용)
   */
  constructor(customConfig = null) {
    const cfg = customConfig || config.qdrant;
    
    this.collectionName = cfg.collectionName || 'rules';
    this.vectorDimensions = cfg.vectorDimensions || 1536;
    
    // 유효한 checkType 목록 (v4.0)
    this.validCheckTypes = ['pure_regex', 'llm_with_regex', 'llm_contextual', 'llm_with_ast'];
    
    // 클라이언트 초기화 (기존 qdrantAdapter.js의 initializeClient 로직)
    this.client = this._initializeClient(cfg);
    
    this.initialized = false;
  }

  /**
   * Qdrant 클라이언트 초기화 (기존 qdrantAdapter.js 로직)
   * URL 파싱 포함
   * @private
   */
  _initializeClient(cfg) {
    let host = cfg.host;
    let port = cfg.port;
    let https = cfg.https || false;
    
    // URL이 제공된 경우 파싱 (기존 로직)
    if (!host && cfg.url) {
      try {
        const parsedUrl = new URL(cfg.url);
        host = parsedUrl.hostname;
        port = parseInt(parsedUrl.port) || (parsedUrl.protocol === 'https:' ? 443 : 6333);
        https = parsedUrl.protocol === 'https:';
      } catch (e) {
        logger.warn('⚠️ Qdrant URL 파싱 실패, 기본값 사용:', e.message);
        host = 'localhost';
        port = 6333;
        https = false;
      }
    }
    
    const clientOptions = {
      host: host || 'localhost',
      port: port || 6333,
      https: https,
      checkCompatibility: false
    };
    
    logger.info(`🔌 Qdrant 연결: ${clientOptions.https ? 'https' : 'http'}://${clientOptions.host}:${clientOptions.port}`);
    
    if (cfg.apiKey) {
      clientOptions.apiKey = cfg.apiKey;
      logger.info('🔐 Qdrant API Key 인증 사용');
    }
    
    return new Qdrant(clientOptions);
  }

  /**
   * 초기화 및 컬렉션 확인/생성
   */
  async initialize() {
    if (this.initialized) return true;
    
    try {
      await this.checkConnection();
      await this.ensureCollection();
      this.initialized = true;
      logger.info(`✅ Qdrant 클라이언트 초기화 완료: ${this.collectionName}`);
      return true;
    } catch (error) {
      logger.error('❌ Qdrant 초기화 실패:', error.message);
      throw error;
    }
  }

  /**
   * 연결 상태 확인 (기존 qdrantAdapter.js 로직)
   */
  async checkConnection() {
    try {
      await this.client.getCollections();
      logger.info('✅ Qdrant 연결 성공');
      return true;
    } catch (error) {
      logger.error('Qdrant 연결 실패:', error.message);
      throw new Error(`Qdrant 연결 실패: ${error.message}`);
    }
  }

  /**
   * 컬렉션 존재 확인 (기존 qdrantAdapter.js 로직)
   */
  async collectionExists(collectionName) {
    try {
      const collections = await this.client.getCollections();
      return collections.collections.some(c => c.name === collectionName);
    } catch (error) {
      logger.error(`컬렉션 존재 확인 오류 (${collectionName}):`, error.message);
      return false;
    }
  }

  /**
   * 컬렉션 존재 확인 및 생성 (기존 initializeSchema 로직)
   */
  async ensureCollection() {
    try {
      const exists = await this.collectionExists(this.collectionName);
      
      if (!exists) {
        logger.info(`🔨 ${this.collectionName} 컬렉션 생성 중...`);
        
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorDimensions,
            distance: 'Cosine',
            hnsw_config: {
              m: 16,
              ef_construct: 100
            }
          },
          optimizers_config: {
            default_segment_number: 2
          },
          replication_factor: 1
        });
        
        // 인덱스 생성 (기존 로직)
        await this._createPayloadIndices();
        
        logger.info(`✅ ${this.collectionName} 컬렉션 생성 완료`);
      } else {
        logger.info(`✅ 기존 ${this.collectionName} 컬렉션 확인됨`);
      }
      
      return true;
    } catch (error) {
      logger.error('컬렉션 생성 실패:', error.message);
      throw error;
    }
  }

  /**
   * 페이로드 인덱스 생성 (기존 qdrantAdapter.js 로직)
   * @private
   */
  async _createPayloadIndices() {
    const indexFields = [
      'ruleId', 
      'category', 
      'severity', 
      'checkType',  // v4.0
      'isActive', 
      'source'
    ];
    
    for (const field of indexFields) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: 'keyword'
        });
        logger.debug(`인덱스 생성: ${field}`);
      } catch (error) {
        // 이미 존재하는 경우 무시
        logger.debug(`인덱스 생성 경고 (${field}): ${error.message}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 벡터/유틸리티 메서드 (기존 qdrantAdapter.js 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 더미 벡터 생성 (기존 로직)
   */
  createDummyVector() {
    return new Array(this.vectorDimensions).fill(0);
  }

  /**
   * 벡터 유효성 검사 (기존 로직)
   */
  validateVector(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
      return false;
    }
    return vector.every(v => typeof v === 'number' && !isNaN(v) && isFinite(v));
  }

  /**
   * JSON 파싱 헬퍼 (기존 로직)
   * @private
   */
  _parseJSON(str) {
    if (!str) return null;
    if (typeof str !== 'string') return str;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  /**
   * 패턴 배열 파싱 - RegExp 변환 포함 (PCRE → JavaScript 변환)
   * @private
   */
  _parsePatternArray(jsonStr) {
    if (!jsonStr) return [];
    
    try {
      const patterns = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      if (!Array.isArray(patterns)) return [];
      
      return patterns.map(p => {
        try {
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
          
          return {
            regex: new RegExp(patternStr, flags),
            description
          };
        } catch (e) {
          // 변환 실패 시 추가 정제 시도
          try {
            const sanitized = this._sanitizePattern(p.pattern || p);
            const flags = p.flags || 'g';
            return {
              regex: new RegExp(sanitized, flags),
              description: p.description || ''
            };
          } catch (e2) {
            logger.warn(`패턴 RegExp 변환 실패: ${JSON.stringify(p).substring(0, 80)}... - ${e.message}`);
            return null;
          }
        }
      }).filter(p => p !== null);
    } catch (e) {
      logger.warn(`패턴 배열 JSON 파싱 실패: ${e.message}`);
      return [];
    }
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
      
      if (inlineFlags.includes('i') && !newFlags.includes('i')) {
        newFlags += 'i';
      }
      if (inlineFlags.includes('m') && !newFlags.includes('m')) {
        newFlags += 'm';
      }
    }
    
    // 2. 패턴 중간의 inline flags도 제거
    newPattern = newPattern.replace(/\(\?[imsx]+:/g, '(?:');
    newPattern = newPattern.replace(/\(\?[imsx]+\)/g, '');
    
    // 3. Atomic groups (?>...) → (?:...)
    newPattern = newPattern.replace(/\(\?>/g, '(?:');
    
    // 4. Possessive quantifiers ++, *+, ?+ → +, *, ?
    newPattern = newPattern.replace(/\+\+/g, '+');
    newPattern = newPattern.replace(/\*\+/g, '*');
    newPattern = newPattern.replace(/\?\+/g, '?');
    
    // 5. Named groups (?P<n>...) → (?<n>...)
    newPattern = newPattern.replace(/\(\?P</g, '(?<');
    
    // 6. Named backreference (?P=name) → \k<n>
    newPattern = newPattern.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
    
    return { pattern: newPattern, flags: newFlags };
  }
  
  /**
   * 패턴 추가 정제
   * @private
   */
  _sanitizePattern(pattern) {
    if (typeof pattern !== 'string') return '';
    
    let sanitized = pattern;
    
    // PCRE inline flags 제거
    sanitized = sanitized.replace(/^\(\?[imsx]+\)/, '');
    sanitized = sanitized.replace(/\(\?[imsx]+:/g, '(?:');
    sanitized = sanitized.replace(/\(\?[imsx]+\)/g, '');
    
    // 짝이 맞지 않는 괄호 정리
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
    if (inBracket) sanitized += ']';
    
    return sanitized;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 룰 저장 (기존 storeGuideline 로직 기반)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 룰 저장 (기존 qdrantAdapter.js storeGuideline 로직)
   * 
   * @param {Object} rule - 룰 객체
   * @returns {Promise<string>} 저장된 ID
   */
  async storeRule(rule) {
    try {
      const id = uuidv4();
      
      // antiPatterns 처리 (기존 로직)
      const antiPatternsArray = this._normalizePatterns(rule.antiPatterns);
      
      // goodPatterns 처리 (기존 로직)
      const goodPatternsArray = this._normalizePatterns(rule.goodPatterns);
      
      // 벡터 준비 및 차원 검증 (기존 로직)
      let vector = rule.embedding || this.createDummyVector();
      if (vector.length !== this.vectorDimensions) {
        logger.warn(`⚠️ 벡터 차원 불일치: ${vector.length} -> ${this.vectorDimensions} (더미 벡터 사용)`);
        vector = this.createDummyVector();
      }
      if (!this.validateVector(vector)) {
        logger.warn('⚠️ 벡터 유효하지 않음, 더미 벡터 사용');
        vector = this.createDummyVector();
      }
      
      // checkType 검증 (기존 v4.0 로직)
      let checkType = rule.checkType || 'llm_contextual';
      if (!this.validCheckTypes.includes(checkType)) {
        logger.warn(`⚠️ 유효하지 않은 checkType: ${checkType} → llm_contextual로 변경`);
        checkType = 'llm_contextual';
      }
      
      const point = {
        id,
        vector,
        payload: {
          // 기본 필드
          ruleId: rule.ruleId,
          ruleTitle: rule.title,
          title: rule.title,
          category: rule.category,
          description: rule.description || '',
          keywords: JSON.stringify(rule.keywords || []),
          severity: rule.severity || 'MEDIUM',
          
          // checkType 관련 (v4.0)
          checkType: checkType,
          checkTypeReason: rule.checkTypeReason || null,
          originalCheckType: rule.originalCheckType || null,
          
          // 패턴 필드
          antiPatterns: JSON.stringify(antiPatternsArray),
          goodPatterns: JSON.stringify(goodPatternsArray),
          
          // AST 힌트
          astHints: JSON.stringify(rule.astHints || {}),
          astDescription: rule.astDescription || null,
          checkPoints: JSON.stringify(rule.checkPoints || []),
          
          // 태그 기반 필터링
          tagCondition: rule.tagCondition || null,
          requiredTags: JSON.stringify(rule.requiredTags || []),
          excludeTags: JSON.stringify(rule.excludeTags || []),
          
          // 메시지
          message: rule.message || '',
          suggestion: rule.suggestion || '',
          checkPrompt: rule.checkPrompt || null,
          
          // 메타
          source: rule.source || 'unknown',
          isActive: rule.isActive !== false,
          createdAt: new Date().toISOString(),
          
          // 예시
          examples: JSON.stringify(rule.examples || {})
        }
      };
      
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [point]
      });
      
      logger.info(`✅ 룰 저장 완료: ${rule.ruleId}`);
      logger.info(`   - checkType: ${checkType}`);
      logger.info(`   - antiPatterns: ${antiPatternsArray.length}, goodPatterns: ${goodPatternsArray.length}`);
      
      return id;
    } catch (error) {
      logger.error(`룰 저장 실패 (${rule.ruleId}):`, error.message);
      throw error;
    }
  }

  /**
   * 패턴 정규화 (저장용) - 유효성 검증 포함
   * @private
   */
  _normalizePatterns(patterns) {
    if (!patterns || !Array.isArray(patterns)) return [];
    
    return patterns.map(p => {
      let patternStr, flags, description;
      
      if (typeof p === 'string') {
        patternStr = p;
        flags = 'g';
        description = '';
      } else if (p instanceof RegExp) {
        patternStr = p.source;
        flags = p.flags || 'g';
        description = '';
      } else if (typeof p === 'object' && p.pattern) {
        patternStr = typeof p.pattern === 'string' ? p.pattern : p.pattern.source;
        flags = p.flags || (p.pattern && p.pattern.flags) || 'g';
        description = p.description || '';
      } else {
        return null;
      }
      
      // 🔧 유효성 검증: RegExp로 변환 가능한지 테스트
      try {
        new RegExp(patternStr, flags);
        return { pattern: patternStr, flags, description };
      } catch (e) {
        // 이스케이프가 필요한 특수문자 자동 처리 시도
        const escaped = this._escapeRegexSpecialChars(patternStr);
        try {
          new RegExp(escaped, flags);
          logger.debug(`패턴 자동 이스케이프: "${patternStr.substring(0, 50)}"`);
          return { pattern: escaped, flags, description };
        } catch (e2) {
          logger.warn(`⚠️ 유효하지 않은 패턴 제외: "${patternStr.substring(0, 50)}..." - ${e.message}`);
          return null;
        }
      }
    }).filter(p => p !== null);
  }
  
  /**
   * 정규식 특수문자 이스케이프 (저장 시 자동 보정)
   * @private
   */
  _escapeRegexSpecialChars(str) {
    // 정규식 특수문자를 이스케이프 (이미 이스케이프된 것은 유지)
    return str.replace(/(?<!\\)([.*+?^${}()|\[\]])/g, '\\$1');
  }

  /**
   * 룰 일괄 저장
   * 
   * @param {Object[]} rules - 룰 배열
   * @returns {Promise<number>} 저장된 개수
   */
  async storeRules(rules) {
    let count = 0;
    
    for (const rule of rules) {
      try {
        await this.storeRule(rule);
        count++;
      } catch (error) {
        logger.warn(`룰 저장 스킵: ${rule.ruleId} - ${error.message}`);
      }
    }
    
    logger.info(`총 ${count}/${rules.length}개 룰 저장 완료`);
    return count;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 룰 조회 (기존 searchGuidelines + findRulesByTags 통합)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 태그 기반 룰 조회 (기존 로직 + 태그 표현식 평가)
   * 
   * @param {string[]} tags - 코드에서 추출된 태그 배열
   * @param {Object} filters - 추가 필터
   * @returns {Promise<Object[]>} 매칭된 룰 배열
   */
  async findRulesByTags(tags, filters = {}) {
    try {
      const must = [
        { key: 'isActive', match: { value: true } }
      ];
      
      if (filters.category) {
        must.push({ key: 'category', match: { value: filters.category } });
      }
      
      if (filters.severity) {
        must.push({ key: 'severity', match: { value: filters.severity } });
      }
      
      // checkType 필터 (다중 지원 - 기존 v4.0 로직)
      if (filters.checkType) {
        if (Array.isArray(filters.checkType)) {
          if (filters.checkType.length === 1) {
            must.push({ key: 'checkType', match: { value: filters.checkType[0] } });
          } else if (filters.checkType.length > 1) {
            must.push({
              should: filters.checkType.map(ct => ({
                key: 'checkType',
                match: { value: ct }
              }))
            });
          }
        } else {
          must.push({ key: 'checkType', match: { value: filters.checkType } });
        }
      }
      
      // 전체 룰 조회 후 태그 조건 평가
      const result = await this.client.scroll(this.collectionName, {
        filter: must.length > 0 ? { must } : undefined,
        limit: filters.limit || 1000,
        with_payload: true,
        with_vector: false
      });
      
      const rules = result.points.map(point => this._parseRulePayload(point.payload));
      
      // 태그 조건 매칭
      const matchedRules = rules.filter(rule => this.evaluateTagCondition(rule, tags));
      
      logger.debug(`태그 매칭: ${tags.length}개 태그 → ${matchedRules.length}개 룰`);
      return matchedRules;
    } catch (error) {
      logger.error('태그 기반 룰 조회 실패:', error.message);
      return [];
    }
  }

  /**
   * 필터 기반 룰 검색 (기존 searchGuidelines 로직)
   * 
   * @param {Object} filters - 필터 조건
   * @returns {Promise<Object[]>} 룰 배열
   */
  async searchRules(filters = {}) {
    try {
      const must = [];
      
      if (filters.category) {
        must.push({ key: 'category', match: { value: filters.category } });
      }
      
      // 다중 checkType 지원 (기존 v4.0 로직)
      if (filters.checkType) {
        if (Array.isArray(filters.checkType)) {
          if (filters.checkType.length === 1) {
            must.push({ key: 'checkType', match: { value: filters.checkType[0] } });
          } else if (filters.checkType.length > 1) {
            must.push({
              should: filters.checkType.map(ct => ({
                key: 'checkType',
                match: { value: ct }
              }))
            });
          }
        } else {
          must.push({ key: 'checkType', match: { value: filters.checkType } });
        }
      }
      
      if (filters.severity) {
        must.push({ key: 'severity', match: { value: filters.severity } });
      }
      
      if (filters.isActive !== undefined) {
        must.push({ key: 'isActive', match: { value: filters.isActive } });
      }
      
      if (filters.source) {
        must.push({ key: 'source', match: { value: filters.source } });
      }
      
      const scrollResult = await this.client.scroll(this.collectionName, {
        filter: must.length > 0 ? { must } : undefined,
        limit: filters.limit || 1000,
        with_payload: true,
        with_vector: false
      });
      
      return scrollResult.points.map(point => this._parseRulePayload(point.payload));
    } catch (error) {
      logger.error('룰 검색 실패:', error.message);
      return [];
    }
  }

  /**
   * 전체 룰 조회
   * 
   * @param {Object} filters - 필터 조건
   * @returns {Promise<Object[]>} 룰 배열
   */
  async getAllRules(filters = {}) {
    return this.searchRules(filters);
  }

  /**
   * 페이로드를 룰 객체로 변환 (기존 parseGuidelinePayload 로직)
   * @private
   */
  _parseRulePayload(payload) {
    return {
      // 기본 필드
      ruleId: payload.ruleId,
      id: payload.ruleId,  // 하위 호환
      title: payload.ruleTitle || payload.title,
      category: payload.category,
      description: payload.description,
      keywords: this._parseJSON(payload.keywords) || [],
      severity: payload.severity,
      
      // checkType 관련 (v4.0)
      checkType: payload.checkType,
      checkTypeReason: payload.checkTypeReason || null,
      originalCheckType: payload.originalCheckType || null,
      
      // 패턴 필드 (RegExp 변환)
      antiPatterns: this._parsePatternArray(payload.antiPatterns),
      goodPatterns: this._parsePatternArray(payload.goodPatterns),
      
      // AST 힌트
      astHints: this._parseJSON(payload.astHints) || {},
      astDescription: payload.astDescription || null,
      checkPoints: this._parseJSON(payload.checkPoints) || [],
      
      // 태그 기반 필터링
      tagCondition: payload.tagCondition,
      requiredTags: this._parseJSON(payload.requiredTags) || [],
      excludeTags: this._parseJSON(payload.excludeTags) || [],
      
      // 메시지
      message: payload.message,
      suggestion: payload.suggestion,
      checkPrompt: payload.checkPrompt,
      
      // 메타
      source: payload.source,
      isActive: payload.isActive,
      
      // 예시
      examples: this._parseJSON(payload.examples) || {}
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 태그 조건 평가 (새 프로젝트 로직 유지)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 태그 조건 평가
   * 
   * @param {Object} rule - 룰 객체
   * @param {string[]} tags - 추출된 태그 배열
   * @returns {boolean} 매칭 여부
   */
  evaluateTagCondition(rule, tags) {
    const tagSet = new Set(tags);
    
    // excludeTags 체크 (하나라도 있으면 제외)
    const excludeTags = rule.excludeTags || [];
    if (excludeTags.some(tag => tagSet.has(tag))) {
      return false;
    }
    
    // requiredTags 체크 (모두 있어야 함)
    const requiredTags = rule.requiredTags || [];
    if (requiredTags.length > 0 && !requiredTags.every(tag => tagSet.has(tag))) {
      return false;
    }
    
    // tagCondition 표현식 평가
    if (rule.tagCondition) {
      return this.evaluateExpression(rule.tagCondition, tagSet);
    }
    
    // 조건 없으면 requiredTags만으로 판단
    return requiredTags.length === 0 || requiredTags.every(tag => tagSet.has(tag));
  }

  /**
   * 태그 표현식 평가 (AND, OR, NOT, 괄호 지원)
   * 
   * @param {string} expression - 태그 표현식 (예: "USES_CONNECTION && !HAS_TRY_WITH_RESOURCES")
   * @param {Set<string>} tagSet - 태그 Set
   * @returns {boolean}
   */
  evaluateExpression(expression, tagSet) {
    if (!expression || typeof expression !== 'string') {
      return true;
    }
    
    try {
      // 연산자 정규화
      let evalExpr = expression
        .replace(/&&/g, ' && ')
        .replace(/\|\|/g, ' || ')
        .replace(/!/g, ' ! ')
        .replace(/\s+/g, ' ')
        .trim();
      
      // 태그명을 boolean으로 치환
      const tagPattern = /\b([A-Z][A-Z0-9_]*)\b/g;
      evalExpr = evalExpr.replace(tagPattern, (match) => {
        return tagSet.has(match) ? 'true' : 'false';
      });
      
      // 안전한 평가 (Function 사용)
      const result = new Function(`return (${evalExpr})`)();
      return Boolean(result);
    } catch (error) {
      logger.warn(`표현식 평가 실패: ${expression}`, error.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 룰 삭제/관리
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 룰 삭제
   * 
   * @param {string} ruleId - 룰 ID
   */
  async deleteRule(ruleId) {
    try {
      await this.client.delete(this.collectionName, {
        filter: {
          must: [{ key: 'ruleId', match: { value: ruleId } }]
        }
      });
      logger.info(`룰 삭제 완료: ${ruleId}`);
    } catch (error) {
      logger.error(`룰 삭제 실패 (${ruleId}):`, error.message);
      throw error;
    }
  }

  /**
   * 컬렉션 초기화 (전체 삭제)
   */
  async clearCollection() {
    try {
      const exists = await this.collectionExists(this.collectionName);
      if (exists) {
        await this.client.deleteCollection(this.collectionName);
      }
      await this.ensureCollection();
      logger.info(`컬렉션 초기화 완료: ${this.collectionName}`);
    } catch (error) {
      logger.error('컬렉션 초기화 실패:', error.message);
      throw error;
    }
  }

  /**
   * 컬렉션 통계 조회
   */
  async getCollectionStats() {
    try {
      const info = await this.client.getCollection(this.collectionName);
      return {
        name: this.collectionName,
        pointsCount: info.points_count || 0,
        vectorsCount: info.vectors_count || 0,
        status: info.status
      };
    } catch (error) {
      logger.error('컬렉션 통계 조회 실패:', error.message);
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 싱글톤 인스턴스 반환
 */
export function getQdrantClient(customConfig = null) {
  if (!instance || customConfig) {
    instance = new QdrantClient(customConfig);
  }
  return instance;
}

/**
 * 싱글톤 리셋 (테스트용)
 */
export function resetQdrantClient() {
  instance = null;
}

export default QdrantClient;
