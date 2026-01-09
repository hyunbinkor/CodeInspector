/**
 * Qdrant 동기화
 * 
 * JSON 파일에서 룰을 로드하여 Qdrant에 저장
 * - 컬렉션 초기화 (기존 데이터 삭제)
 * - guidelines.json + issues.json 로드
 * - 병합 후 Qdrant 저장
 * 
 * @module sync/qdrantSync
 */

import fs from 'fs/promises';
import path from 'path';
import { getQdrantClient } from '../clients/qdrantClient.js';
import { config } from '../config/config.js';
import logger from '../utils/loggerUtils.js';

export class QdrantSync {
  constructor() {
    this.qdrantClient = null;
    this.initialized = false;
  }

  /**
   * 초기화
   */
  async initialize() {
    if (this.initialized) return;

    this.qdrantClient = getQdrantClient();
    await this.qdrantClient.initialize();

    this.initialized = true;
    logger.info('✅ QdrantSync 초기화 완료');
  }

  /**
   * JSON 파일 로드
   * 
   * @param {string} filePath - JSON 파일 경로
   * @returns {Promise<Object[]>} 룰 배열
   */
  async loadRulesFromFile(filePath) {
    try {
      const fullPath = path.resolve(filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const data = JSON.parse(content);
      
      const rules = data.rules || [];
      logger.info(`📄 ${path.basename(filePath)}: ${rules.length}개 룰 로드`);
      
      return rules;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn(`⚠️ 파일 없음: ${filePath}`);
        return [];
      }
      throw error;
    }
  }

  /**
   * 전체 동기화 실행
   * 
   * 1. 컬렉션 초기화 (기존 데이터 삭제)
   * 2. guidelines.json 로드
   * 3. issues.json 로드
   * 4. 병합 후 Qdrant 저장
   */
  async syncAll() {
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('🔄 Qdrant 동기화 시작');
    logger.info('═══════════════════════════════════════════════════════════');

    // Step 1: 룰 파일 로드 (config 고정 경로 사용)
    const guidelinesPath = config.paths.output.guidelinesJson;
    const issuesPath = config.paths.output.issuesJson;

    const guidelineRules = await this.loadRulesFromFile(guidelinesPath);
    const issueRules = await this.loadRulesFromFile(issuesPath);

    const allRules = [...guidelineRules, ...issueRules];

    if (allRules.length === 0) {
      logger.warn('⚠️ 저장할 룰이 없습니다.');
      logger.warn(`   - guidelines.json: ${guidelinesPath}`);
      logger.warn(`   - issues.json: ${issuesPath}`);
      return { success: false, count: 0 };
    }

    logger.info(`\n📊 로드된 룰:`);
    logger.info(`   - 가이드라인: ${guidelineRules.length}개`);
    logger.info(`   - 이슈: ${issueRules.length}개`);
    logger.info(`   - 합계: ${allRules.length}개`);

    // Step 2: 컬렉션 초기화
    logger.info('\n🗑️ 컬렉션 초기화 중...');
    await this.qdrantClient.clearCollection();
    logger.info('✅ 컬렉션 초기화 완료');

    // Step 3: 룰 저장
    logger.info('\n💾 Qdrant 저장 시작...');
    
    let successCount = 0;
    let failCount = 0;

    for (const rule of allRules) {
      try {
        await this.qdrantClient.storeRule(rule);
        successCount++;
      } catch (error) {
        logger.warn(`⚠️ 룰 저장 실패 (${rule.ruleId}): ${error.message}`);
        failCount++;
      }
    }

    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('✅ Qdrant 동기화 완료');
    logger.info(`   - 성공: ${successCount}개`);
    if (failCount > 0) {
      logger.info(`   - 실패: ${failCount}개`);
    }
    logger.info('═══════════════════════════════════════════════════════════');

    return {
      success: true,
      total: allRules.length,
      successCount,
      failCount,
      sources: {
        guidelines: guidelineRules.length,
        issues: issueRules.length
      }
    };
  }

  /**
   * 통계 조회
   */
  async getStats() {
    const stats = await this.qdrantClient.getCollectionStats();
    return stats;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════

let instance = null;

export function getQdrantSync() {
  if (!instance) {
    instance = new QdrantSync();
  }
  return instance;
}

export function resetQdrantSync() {
  instance = null;
}

/**
 * CLI용 래퍼 함수
 */
export async function syncQdrant() {
  const sync = getQdrantSync();
  await sync.initialize();
  return await sync.syncAll();
}

export default QdrantSync;