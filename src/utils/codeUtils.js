/**
 * 코드 처리 유틸리티
 * 
 * @module utils/codeUtils
 */

/**
 * 코드에 라인 번호 추가
 * @param {string} code - 소스 코드
 * @param {number} startLine - 시작 라인 번호
 * @returns {string} 라인 번호가 추가된 코드
 */
export function addLineNumbers(code, startLine = 1) {
  if (!code) return '';
  return code.split('\n').map((line, index) => {
    const lineNum = (startLine + index).toString().padStart(4, ' ');
    return `${lineNum}: ${line}`;
  }).join('\n');
}

/**
 * LLM 응답에서 코드 블록 추출
 * @param {string} response - LLM 응답
 * @returns {string|null} 추출된 코드
 */
export function extractCodeFromResponse(response) {
  if (!response) return null;

  let code = response.trim();

  // <think> 태그 제거
  code = code.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 마크다운 코드 블록 제거
  code = code.replace(/```java\s*/gi, '');
  code = code.replace(/```\s*/g, '');

  // 볼드 텍스트 제거
  code = code.replace(/\*\*.*?\*\*/g, '');

  // 설명 텍스트 제거
  code = code.replace(/Explanation:[\s\S]*?(?=package|import|public|class|$)/gi, '');

  // Java 코드 시작점 찾기
  const packageIndex = code.indexOf('package ');
  const importIndex = code.indexOf('import ');
  const classIndex = code.indexOf('public class ');

  let startIndex = -1;
  if (packageIndex >= 0) startIndex = packageIndex;
  else if (importIndex >= 0) startIndex = importIndex;
  else if (classIndex >= 0) startIndex = classIndex;

  if (startIndex >= 0) {
    code = code.substring(startIndex);
  }

  // 마지막 중괄호 이후 설명 제거
  const lastBraceIndex = code.lastIndexOf('}');
  if (lastBraceIndex > 0) {
    code = code.substring(0, lastBraceIndex + 1);
  }

  // 연속된 빈 줄 제거
  code = code.replace(/\n\s*\n\s*\n/g, '\n\n');

  return code.trim() || null;
}

/**
 * Java 코드 기본 유효성 검증
 * @param {string} code - Java 코드
 * @returns {boolean} 유효 여부
 */
export function validateJavaSyntax(code) {
  if (!code || code.length < 10) return false;

  const hasMethodKeyword = /(public|private|protected)/.test(code);
  const hasOpenBrace = code.includes('{');
  const hasCloseBrace = code.includes('}');

  const openBraces = (code.match(/\{/g) || []).length;
  const closeBraces = (code.match(/\}/g) || []).length;
  const braceBalance = Math.abs(openBraces - closeBraces) <= 2;

  return hasMethodKeyword && hasOpenBrace && hasCloseBrace && braceBalance;
}

/**
 * 코드에서 클래스명 추출
 * @param {string} code - Java 코드
 * @returns {string} 클래스명 (없으면 'Unknown')
 */
export function extractClassName(code) {
  if (!code) return 'Unknown';
  const match = code.match(/class\s+(\w+)/);
  return match ? match[1] : 'Unknown';
}

/**
 * 코드에서 패키지명 추출
 * @param {string} code - Java 코드
 * @returns {string|null} 패키지명
 */
export function extractPackageName(code) {
  if (!code) return null;
  const match = code.match(/package\s+([\w.]+)/);
  return match ? match[1] : null;
}

/**
 * 코드에서 메서드 목록 추출 (간단 버전)
 * @param {string} code - Java 코드
 * @returns {string[]} 메서드명 배열
 */
export function extractMethodNames(code) {
  if (!code) return [];
  const regex = /\b(public|private|protected)\s+[\w<>\[\]]+\s+(\w+)\s*\(/g;
  const methods = [];
  let match;
  while ((match = regex.exec(code)) !== null) {
    methods.push(match[2]);
  }
  return methods;
}

/**
 * 코드 길이 제한 (truncate)
 * @param {string} code - 소스 코드
 * @param {number} maxLength - 최대 길이
 * @returns {string} 잘린 코드
 */
export function truncateCode(code, maxLength = 5000) {
  if (!code || code.length <= maxLength) return code;
  
  const truncated = code.substring(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  
  if (lastNewline > maxLength * 0.7) {
    return truncated.substring(0, lastNewline) + '\n// ... (truncated)';
  }
  return truncated + '\n// ... (truncated)';
}

/**
 * 주석 및 문자열 리터럴 제거
 * @param {string} code - 소스 코드
 * @returns {string} 정제된 코드
 */
export function removeCommentsAndStrings(code) {
  if (!code) return '';
  
  let result = code;
  
  // 블록 주석 제거
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // 라인 주석 제거
  result = result.replace(/\/\/.*$/gm, '');
  
  // 문자열 리터럴 제거 (단순 버전)
  result = result.replace(/"[^"\\]*(\\.[^"\\]*)*"/g, '""');
  result = result.replace(/'[^'\\]*(\\.[^'\\]*)*'/g, "''");
  
  return result;
}

export default {
  addLineNumbers,
  extractCodeFromResponse,
  validateJavaSyntax,
  extractClassName,
  extractPackageName,
  extractMethodNames,
  truncateCode,
  removeCommentsAndStrings
};
