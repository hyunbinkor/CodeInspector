#!/usr/bin/env node
/**
 * 코드 품질 점검 시스템 - CLI 진입점
 * 
 * 명령어:
 *   extract-guidelines - 개발 가이드에서 룰 추출 → JSON 저장
 *   extract-issues     - 이슈 CSV에서 룰 추출 → JSON 저장
 *   sync-qdrant        - JSON에서 룰 로드 → Qdrant 동기화
 *   check              - 코드 점검
 *   clear-rules        - Qdrant의 모든 룰 삭제
 * 
 * @module main
 */

import { extractGuidelines } from './extractor/guidelineExtractor.js';
import { extractIssues } from './extractor/issueExtractor.js';
import { syncQdrant } from './sync/qdrantSync.js';
import { checkCode } from './checker/codeChecker.js';
import { getResultBuilder } from './checker/resultBuilder.js';
import { getQdrantClient } from './clients/qdrantClient.js';
import { writeJsonFile } from './utils/fileUtils.js';
import logger from './utils/loggerUtils.js';

/**
 * 메인 함수
 */
async function main() {
  const command = process.argv[2];
  const startTime = Date.now();

  console.log('\n🚀 코드 품질 점검 시스템');
  console.log('='.repeat(50));

  try {
    switch (command) {
      case 'extract-guidelines':
        await runExtractGuidelines();
        break;

      case 'extract-issues':
        await runExtractIssues();
        break;

      case 'sync-qdrant':
        await runSyncQdrant();
        break;

      case 'check':
        await runCheck();
        break;

      case 'clear-rules':
        await runClearRules();
        break;

      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;

      default:
        console.log(`\n❌ 알 수 없는 명령어: ${command || '(없음)'}`);
        printHelp();
        process.exit(1);
    }

    console.log(`\n✅ 완료 (${Date.now() - startTime}ms)`);
    console.log('='.repeat(50) + '\n');

  } catch (error) {
    console.error(`\n❌ 오류 발생: ${error.message}`);
    logger.error('상세 오류:', error);
    process.exit(1);
  }
}

/**
 * 가이드라인 추출 실행
 */
async function runExtractGuidelines() {
  console.log('\n📖 개발 가이드에서 룰 추출');
  console.log('-'.repeat(50));

  const result = await extractGuidelines();

  console.log(`\n📊 결과:`);
  console.log(`   - 처리 파일: ${result.files}개`);
  console.log(`   - 추출된 룰: ${result.rules?.length || 0}개`);
  console.log(`   - 저장 위치: ${result.outputPath || 'N/A'}`);
}

/**
 * 이슈 추출 실행
 */
async function runExtractIssues() {
  console.log('\n📋 이슈 CSV에서 룰 추출');
  console.log('-'.repeat(50));

  const result = await extractIssues();

  console.log(`\n📊 결과:`);
  console.log(`   - 처리 파일: ${result.files}개`);
  console.log(`   - 추출된 룰: ${result.rules?.length || 0}개`);
  console.log(`   - 저장 위치: ${result.outputPath || 'N/A'}`);
}

/**
 * Qdrant 동기화 실행
 */
async function runSyncQdrant() {
  console.log('\n🔄 Qdrant 동기화');
  console.log('-'.repeat(50));

  const result = await syncQdrant();

  if (result.success) {
    console.log(`\n📊 결과:`);
    console.log(`   - 가이드라인 룰: ${result.sources.guidelines}개`);
    console.log(`   - 이슈 룰: ${result.sources.issues}개`);
    console.log(`   - 저장 성공: ${result.successCount}개`);
    if (result.failCount > 0) {
      console.log(`   - 저장 실패: ${result.failCount}개`);
    }
  } else {
    console.log('\n⚠️ 동기화할 룰이 없습니다.');
    console.log('   먼저 extract-guidelines 또는 extract-issues를 실행하세요.');
  }
}

/**
 * 코드 점검 실행
 */
async function runCheck() {
  console.log('\n🔍 코드 점검');
  console.log('-'.repeat(50));

  // CLI 옵션 파싱
  const args = process.argv.slice(3);
  let outputFormat = 'json';  // 기본값
  let outputFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format' && args[i + 1]) {
      outputFormat = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '-o' && args[i + 1]) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i].startsWith('--format=')) {
      outputFormat = args[i].split('=')[1].toLowerCase();
    } else if (args[i].startsWith('-o=')) {
      outputFile = args[i].split('=')[1];
    }
  }

  // 출력 형식 검증
  const validFormats = ['json', 'sarif', 'github'];
  if (!validFormats.includes(outputFormat)) {
    console.log(`\n⚠️ 지원하지 않는 형식: ${outputFormat}`);
    console.log(`   지원 형식: ${validFormats.join(', ')}`);
    outputFormat = 'json';
  }

  console.log(`   출력 형식: ${outputFormat.toUpperCase()}`);

  const result = await checkCode();
  const resultBuilder = getResultBuilder();

  // 청킹된 경우 별도 처리
  if (result.reports?.some(r => r.chunked)) {
    console.log('\n📦 청킹 모드로 검사됨');
    
    for (const report of result.reports) {
      if (report.chunked) {
        console.log(`\n📄 ${report.file || 'unknown'}`);
        console.log(`   - 총 청크: ${report.stats?.totalChunks || 0}개`);
        console.log(`   - 발견 이슈: ${report.summary?.totalIssues || 0}개`);
        console.log(`   - 처리 시간: ${report.stats?.processingTime || 0}ms`);

        // SARIF 형식 저장
        if (outputFormat === 'sarif' && report.sarif) {
          const sarifPath = outputFile || result.outputPath?.replace('.json', '.sarif.json');
          if (sarifPath) {
            await writeJsonFile(sarifPath, report.sarif);
            console.log(`   - SARIF 저장: ${sarifPath}`);
          }
        }

        // GitHub 어노테이션 출력
        if (outputFormat === 'github' && report.annotations) {
          console.log('\n--- GitHub Actions Annotations ---');
          console.log(report.annotations);
          console.log('--- End ---');
        }
      } else {
        // 일반 리포트 출력
        console.log(resultBuilder.formatForConsole(report));
      }
    }
  } else {
    // 일반 모드 출력
    for (const report of result.reports || []) {
      console.log(resultBuilder.formatForConsole(report));
    }
  }

  // 요약 출력
  if (result.summary) {
    console.log(resultBuilder.formatSummaryForConsole(result.summary));
  }

  console.log(`\n📁 리포트 저장: ${result.outputPath || 'N/A'}`);
}

/**
 * 룰 전체 삭제 실행
 */
async function runClearRules() {
  console.log('\n🗑️  Qdrant 룰 전체 삭제');
  console.log('-'.repeat(50));

  const qdrantClient = getQdrantClient();
  await qdrantClient.initialize();

  // 현재 통계 조회
  const statsBefore = await qdrantClient.getCollectionStats();
  console.log(`   현재 저장된 룰: ${statsBefore?.pointsCount || 0}개`);

  if (!statsBefore || statsBefore.pointsCount === 0) {
    console.log('   ⚠️ 삭제할 룰이 없습니다.');
    return;
  }

  // 확인 메시지
  console.log('\n   ⚠️ 이 작업은 되돌릴 수 없습니다!');
  
  // 삭제 실행
  await qdrantClient.clearCollection();
  
  console.log(`\n   ✅ ${statsBefore.pointsCount}개 룰 삭제 완료`);
}

/**
 * 도움말 출력
 */
function printHelp() {
  console.log(`
사용법: node src/main.js <command> [options]

명령어:
  extract-guidelines    개발 가이드(docx)에서 룰 추출 → JSON 저장
                        입력: input/guidelines/*.docx
                        출력: output/rules/guidelines.json

  extract-issues        이슈 CSV에서 룰 추출 → JSON 저장
                        입력: input/issues/*.csv
                        출력: output/rules/issues.json

  sync-qdrant           JSON에서 룰 로드 → Qdrant 동기화
                        입력: output/rules/guidelines.json
                              output/rules/issues.json
                        동작: Qdrant 초기화 후 저장

  check [options]       코드 점검 실행
                        입력: input/code/*.java
                        출력: output/reports/*.json
                        
                        옵션:
                          --format <type>   출력 형식 (json|sarif|github)
                          -o <file>         출력 파일 경로
                        
                        ※ 3000줄 이상 파일은 자동 청킹

  clear-rules           Qdrant의 모든 룰 삭제 (주의!)

  help                  이 도움말 표시

워크플로우:
  1. extract-guidelines   # 가이드라인 → JSON
  2. extract-issues       # 이슈 → JSON (선택)
  3. sync-qdrant          # JSON → Qdrant
  4. check                # 코드 점검

예시:
  node src/main.js extract-guidelines
  node src/main.js extract-issues
  node src/main.js sync-qdrant
  node src/main.js check
  node src/main.js check --format sarif
  node src/main.js check --format github
  node src/main.js check --format sarif -o result.sarif.json

출력 형식:
  json      기본 JSON 형식
  sarif     SARIF 2.1.0 (IDE/CI 통합용)
  github    GitHub Actions 어노테이션

디렉토리 구조:
  input/
    guidelines/         docx 파일 위치
    issues/             csv 파일 위치
    code/               점검할 Java 파일 위치
  output/
    rules/              추출된 룰 JSON
      guidelines.json   가이드라인 룰
      issues.json       이슈 룰
    reports/            점검 결과 리포트
  `);
}

// 실행
main().catch(error => {
  console.error('치명적 오류:', error);
  process.exit(1);
});