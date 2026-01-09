#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
/**
 * 코드 품질 점검 시스템 - CLI 진입점
 * 
 * 명령어:
 *   extract-guidelines - 개발 가이드에서 룰 추출 → Qdrant 저장
 *   extract-issues     - 이슈 CSV에서 룰 추출 → Qdrant 저장
 *   check              - 코드 점검
 * 
 * @module main
 */

import { extractGuidelines } from './extractor/guidelineExtractor.js';
import { extractIssues } from './extractor/issueExtractor.js';
import { checkCode } from './checker/codeChecker.js';
import { getResultBuilder } from './checker/resultBuilder.js';
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

      case 'check':
        await runCheck();
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
 * 코드 점검 실행
 */
async function runCheck() {
  console.log('\n🔍 코드 점검');
  console.log('-'.repeat(50));

  const result = await checkCode();
  const resultBuilder = getResultBuilder();

  // 개별 파일 결과 출력
  for (const report of result.reports || []) {
    console.log(resultBuilder.formatForConsole(report));
  }

  // 요약 출력
  if (result.summary) {
    console.log(resultBuilder.formatSummaryForConsole(result.summary));
  }

  console.log(`\n📁 리포트 저장: ${result.outputPath || 'N/A'}`);
}

/**
 * 도움말 출력
 */
function printHelp() {
  console.log(`
사용법: node src/main.js <command>

명령어:
  extract-guidelines    개발 가이드(docx)에서 룰 추출 → Qdrant 저장
                        입력: input/guidelines/*.docx
                        출력: output/rules/*.json + Qdrant

  extract-issues        이슈 CSV에서 룰 추출 → Qdrant 저장
                        입력: input/issues/*.csv
                        출력: output/rules/*.json + Qdrant

  check                 코드 점검 실행
                        입력: input/code/*.java
                        출력: output/reports/*.json

  help                  이 도움말 표시

예시:
  node src/main.js extract-guidelines
  node src/main.js extract-issues
  node src/main.js check

디렉토리 구조:
  input/
    guidelines/         docx 파일 위치
    issues/             csv 파일 위치
    code/               점검할 Java 파일 위치
  output/
    rules/              추출된 룰 JSON
    reports/            점검 결과 리포트
  `);
}

// 실행
main().catch(error => {
  console.error('치명적 오류:', error);
  process.exit(1);
});
