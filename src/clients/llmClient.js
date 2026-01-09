/**
 * LLM 클라이언트 (vLLM 전용)
 * 
 * 기존 프로젝트의 검증된 로직을 기반으로 작성
 * - vLLM OpenAI-compatible API 사용
 * - fetch API + AbortController 타임아웃
 * - 싱글톤 패턴
 * - 재시도 로직 (지수 백오프)
 * - 정교한 JSON 추출 (여러 후보 중 최선 선택)
 * 
 * @module clients/llmClient
 */

import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

/** @type {LLMClient|null} */
let instance = null;

export class LLMClient {
  /**
   * @param {Object} customConfig - 커스텀 설정 (테스트용)
   */
  constructor(customConfig = null) {
    const cfg = customConfig || config.llm;
    
    this.baseUrl = cfg.baseUrl;
    this.model = cfg.model;
    this.timeout = cfg.timeout || 180000;
    this.maxRetries = cfg.maxRetries || 3;
    
    this.initialized = false;
    
    logger.info(`🔧 LLMClient 초기화`);
    logger.info(`   🤖 모델: ${this.model}`);
    logger.info(`   🔗 서버: ${this.baseUrl}`);
  }

  /**
   * 클라이언트 초기화 및 연결 확인
   */
  async initialize() {
    if (this.initialized) return true;
    
    try {
      const connected = await this.checkConnection();
      if (!connected) {
        throw new Error('vLLM 서버 연결 실패');
      }
      this.initialized = true;
      logger.info('✅ LLMClient 초기화 완료');
      return true;
    } catch (error) {
      logger.error('❌ LLM 클라이언트 초기화 실패:', error.message);
      throw error;
    }
  }

  /**
   * vLLM 서버 연결 테스트
   * /v1/models 엔드포인트로 사용 가능한 모델 목록 조회
   */
  async checkConnection() {
    try {
      logger.info('🔍 vLLM 서버 연결 테스트 중...');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data && data.data) {
        const modelIds = data.data.map(m => m.id);
        logger.info(`✅ vLLM 서버 연결 성공. 사용 가능한 모델: ${modelIds.slice(0, 3).join(', ')}${modelIds.length > 3 ? '...' : ''}`);
        
        const modelExists = modelIds.includes(this.model);
        if (modelExists) {
          logger.info(`✅ 설정된 모델 '${this.model}' 사용 가능`);
        } else {
          logger.warn(`⚠️ 설정된 모델 '${this.model}'을 찾을 수 없습니다. 사용 가능: ${modelIds.join(', ')}`);
        }
        return true;
      }
      
      return false;
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.warn('⚠️ vLLM 서버 연결 타임아웃');
      } else {
        logger.warn(`⚠️ vLLM 서버 연결 실패: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * LLM Completion 생성
   * 재시도 로직 + 지수 백오프 (기존 generateVllmCompletion 로직)
   * 
   * @param {string} prompt - 사용자 프롬프트
   * @param {Object} options - 옵션
   * @returns {Promise<string>} 생성된 텍스트
   */
  async generateCompletion(prompt, options = {}) {
    const maxRetries = this.maxRetries;
    const baseTimeout = options.timeout || this.timeout;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🔄 vLLM API 호출 시도 ${attempt}/${maxRetries}...`);
        
        // 재시도 시 타임아웃 증가 (기존 로직)
        const timeoutMs = Math.min(baseTimeout + (attempt * 60000), 600000);
        
        const requestBody = this._buildRequestParams(prompt, options);
        
        logger.debug(`   📊 요청 설정: 프롬프트 ${prompt.length}자, 최대 토큰 ${requestBody.max_tokens}, 타임아웃 ${timeoutMs}ms`);
        
        const content = await this._callVLLM(requestBody, timeoutMs);
        
        if (!content || content.trim() === '') {
          throw new Error('빈 응답 수신');
        }
        
        logger.info(`✅ vLLM API 호출 성공 (시도 ${attempt})`);
        logger.info(`📏 응답 길이: ${content.length}자`);
        
        return content;
        
      } catch (error) {
        logger.error(`❌ 시도 ${attempt} 실패: ${this._getErrorDescription(error)}`);
        
        if (attempt < maxRetries) {
          // 지수 백오프 (기존 로직: 3000 * 2^(attempt-1))
          const delay = 3000 * Math.pow(2, attempt - 1);
          logger.info(`⏳ ${delay / 1000}초 후 재시도...`);
          await this._sleep(delay);
        } else {
          throw new Error(`vLLM 생성 실패 (${maxRetries}번 시도): ${error.message}`);
        }
      }
    }
  }

  /**
   * 요청 파라미터 빌드 (기존 llmAbstractionLayer.js 로직)
   * @private
   */
  _buildRequestParams(prompt, options) {
    const maxTokens = options.max_tokens || options.num_predict || 2000;
    const temperature = options.temperature ?? 0.1;
    
    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: options.system_prompt || 'You are an expert software developer.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: temperature,
      max_tokens: maxTokens,
      top_p: options.top_p ?? 0.95,
      frequency_penalty: options.frequency_penalty ?? 0.0,
      presence_penalty: options.presence_penalty ?? 0.0,
      stop: options.stop || null,
      stream: false
    };
  }

  /**
   * vLLM API 호출 (기존 callVLLM 로직)
   * @private
   */
  async _callVLLM(params, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(params),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`vLLM API 오류: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json();
      
      // vLLM (OpenAI 호환) 응답 형식: { choices: [{ message: { content: "..." } }] }
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid or empty response from vLLM');
      }
      
      return data.choices[0].message.content || '';
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`요청 타임아웃 (${timeoutMs}ms)`);
      }
      throw error;
    }
  }

  /**
   * LLM 응답에서 JSON 추출 (기존 cleanAndExtractJSON + extractJSONFromText 통합)
   * 
   * @param {string} response - LLM 응답 텍스트
   * @returns {Object|null} 파싱된 JSON 또는 null
   */
  cleanAndExtractJSON(response) {
    if (!response) return null;
    
    logger.debug('🔍 JSON 추출 시작...');
    
    // 1. 응답 정제 (기존 cleanCommonResponse 로직)
    let cleaned = this._cleanResponse(response);
    
    // 2. JSON 추출 (기존 extractJSONFromText 로직)
    return this._extractJSONFromText(cleaned);
  }

  /**
   * 응답 정제 (기존 cleanCommonResponse 로직)
   * @private
   */
  _cleanResponse(response) {
    let cleaned = response;
    
    // 마크다운 코드 블록 제거
    cleaned = cleaned.replace(/```json\s*/gi, '');
    cleaned = cleaned.replace(/```javascript\s*/gi, '');
    cleaned = cleaned.replace(/```\s*/g, '');
    cleaned = cleaned.replace(/`{3,}/g, '');
    cleaned = cleaned.trim();
    
    // JSON 시작점 찾기
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const jsonObjStart = cleaned.indexOf('{');
      const jsonArrStart = cleaned.indexOf('[');
      
      if (jsonObjStart !== -1 && (jsonArrStart === -1 || jsonObjStart < jsonArrStart)) {
        cleaned = cleaned.substring(jsonObjStart);
      } else if (jsonArrStart !== -1) {
        cleaned = cleaned.substring(jsonArrStart);
      }
    }
    
    // JSON 끝점 찾기
    if (!cleaned.endsWith('}') && !cleaned.endsWith(']')) {
      const jsonObjEnd = cleaned.lastIndexOf('}');
      const jsonArrEnd = cleaned.lastIndexOf(']');
      const endIndex = Math.max(jsonObjEnd, jsonArrEnd);
      
      if (endIndex > 0) {
        cleaned = cleaned.substring(0, endIndex + 1);
      }
    }
    
    return cleaned.trim();
  }

  /**
   * 텍스트에서 JSON 추출 (기존 extractJSONFromText 로직)
   * 여러 JSON 후보 중 가장 완전한 구조를 가진 것 선택
   * @private
   */
  _extractJSONFromText(text) {
    if (!text) {
      logger.debug('⚠️ 추출할 텍스트가 비어있습니다.');
      return null;
    }
    
    try {
      // 1. 전체 텍스트 직접 파싱 시도
      const trimmed = text.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          logger.debug('✅ 전체 텍스트 직접 파싱 성공');
          return parsed;
        } catch {
          logger.debug('전체 텍스트 직접 파싱 실패, 다른 방법 시도...');
        }
      }
      
      // 2. JSON 후보 찾기 (기존 로직)
      const jsonCandidates = [];
      let searchStart = 0;
      
      while (true) {
        const openIndex = text.indexOf('{', searchStart);
        if (openIndex === -1) break;
        
        let braceCount = 0;
        let endIndex = openIndex;
        
        for (let i = openIndex; i < text.length; i++) {
          if (text[i] === '{') braceCount++;
          if (text[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIndex = i;
            break;
          }
        }
        
        if (braceCount === 0 && endIndex > openIndex) {
          const candidate = text.substring(openIndex, endIndex + 1);
          try {
            const parsed = JSON.parse(candidate);
            const fieldCount = this._countJSONFields(parsed);
            jsonCandidates.push({
              parsed: parsed,
              length: candidate.length,
              fieldCount: fieldCount
            });
          } catch {
            // 파싱 실패한 후보는 무시
          }
        }
        searchStart = openIndex + 1;
      }
      
      // 3. 배열 형태도 시도
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        try {
          const arrCandidate = text.substring(firstBracket, lastBracket + 1);
          const parsed = JSON.parse(arrCandidate);
          jsonCandidates.push({
            parsed: parsed,
            length: arrCandidate.length,
            fieldCount: Array.isArray(parsed) ? parsed.length : 0
          });
        } catch {
          // 무시
        }
      }
      
      if (jsonCandidates.length === 0) {
        logger.debug('❌ 유효한 JSON 후보를 찾을 수 없습니다.');
        return null;
      }
      
      // 4. 가장 좋은 후보 선택 (필드 수가 많은 것)
      jsonCandidates.sort((a, b) => b.fieldCount - a.fieldCount);
      logger.debug(`✅ JSON 추출 성공 (${jsonCandidates.length}개 후보 중 최선 선택)`);
      return jsonCandidates[0].parsed;
      
    } catch (error) {
      logger.warn(`⚠️ JSON 추출 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * JSON 객체의 필드 수 계산 (재귀)
   * @private
   */
  _countJSONFields(obj) {
    if (obj === null || typeof obj !== 'object') {
      return 0;
    }
    
    if (Array.isArray(obj)) {
      return obj.reduce((sum, item) => sum + this._countJSONFields(item), obj.length);
    }
    
    let count = Object.keys(obj).length;
    for (const value of Object.values(obj)) {
      count += this._countJSONFields(value);
    }
    return count;
  }

  /**
   * 에러 설명 생성 (기존 getErrorDescription 로직)
   * @private
   */
  _getErrorDescription(error) {
    if (error.message.includes('ECONNREFUSED')) {
      return '연결 거부됨 - 서버가 실행 중인지 확인';
    } else if (error.message.includes('ECONNRESET')) {
      return '연결 리셋됨';
    } else if (error.message.includes('ETIMEDOUT')) {
      return '연결 시간 초과';
    } else if (error.message.includes('timeout')) {
      return '타임아웃';
    } else if (error.message.includes('fetch failed')) {
      return '네트워크 연결 실패';
    } else if (error.code) {
      return `${error.code}: ${error.message}`;
    }
    return error.message;
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
// Singleton
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 싱글톤 인스턴스 반환
 * @param {Object} customConfig - 커스텀 설정 (선택)
 * @returns {LLMClient}
 */
export function getLLMClient(customConfig = null) {
  if (!instance || customConfig) {
    instance = new LLMClient(customConfig);
  }
  return instance;
}

/**
 * 싱글톤 인스턴스 리셋 (테스트용)
 */
export function resetLLMClient() {
  instance = null;
}

export default LLMClient;
