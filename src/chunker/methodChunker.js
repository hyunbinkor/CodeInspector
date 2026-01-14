/**
 * Java 코드 메서드 단위 청킹
 * 
 * 대용량 Java 파일(3000줄+)을 메서드 단위로 분할하여
 * 각각 독립적으로 검사할 수 있게 함
 * 
 * 핵심 로직:
 * - braceDepth 기반 메서드 경계 감지
 * - 어노테이션/JavaDoc 보존
 * - 불완전 메서드 스킵
 * - 라인 매핑 테이블 생성
 * 
 * @module chunker/methodChunker
 */

import logger from '../utils/loggerUtils.js';

export class MethodChunker {
  constructor(options = {}) {
    this.options = {
      targetSize: options.targetSize || 300,
      maxSize: options.maxSize || 500,
      minSize: options.minSize || 50,
      preserveImports: options.preserveImports !== false,
      verbose: options.verbose || false,
      // 경고 임계값 - 이 값을 넘으면 경고하지만 메서드 완성까지 대기
      warnThreshold: options.warnThreshold || 3000,
      // 강제 중단 임계값 - 정말 비정상적인 경우에만
      hardLimit: options.hardLimit || 15000,
      // 자동 청킹 기준 라인 수
      autoChunkThreshold: options.autoChunkThreshold || 3000
    };
  }

  /**
   * 청킹 필요 여부 판단
   * 
   * @param {string} code - Java 소스 코드
   * @returns {boolean} 청킹 필요 여부
   */
  needsChunking(code) {
    const lineCount = code.split('\n').length;
    return lineCount > this.options.autoChunkThreshold;
  }

  /**
   * 코드를 메서드 단위로 청킹
   * 
   * @param {string} code - Java 소스 코드
   * @param {Object} metadata - 추가 메타데이터 (fileName 등)
   * @returns {Object} 청킹 결과
   */
  chunk(code, metadata = {}) {
    const lines = code.split('\n');
    const chunks = [];
    
    logger.info(`[MethodChunker] 청킹 시작: ${lines.length}줄`);

    // 1. Import/Package 블록 추출
    const { importBlock, codeStart } = this.extractImports(lines);

    // 2. 클래스 선언 추출
    const { classDeclarations, methodsStart, className } = this.extractClassDeclarations(lines, codeStart);

    // 3. 헤더 (import + 클래스 선언) 저장
    const header = [...importBlock, ...classDeclarations].join('\n');

    // 4. 헤더를 첫 번째 청크로
    if (header.trim().length > 0) {
      chunks.push({
        index: 0,
        code: header,
        lineRange: {
          start: 1,
          end: importBlock.length + classDeclarations.length
        },
        type: 'header',
        className: className,
        methodName: null,
        annotations: this.extractClassAnnotations(classDeclarations)
      });
    }

    // 5. 메서드 추출
    const methods = this.extractMethods(lines, methodsStart);

    if (this.options.verbose) {
      logger.info(`[MethodChunker] ${methods.length}개 메서드 발견`);
    }

    // 6. 메서드를 청크로 변환 (헤더 prefix 포함)
    methods.forEach((method, index) => {
      // 각 메서드 청크에 import/package는 포함하되 클래스 선언은 생략
      // (검사 시 컨텍스트 제공용)
      const methodCode = method.lines.join('\n');

      chunks.push({
        index: chunks.length,
        code: methodCode,
        codeWithHeader: `${importBlock.join('\n')}\n\n// Class: ${className}\n\n${methodCode}`,
        lineRange: {
          start: method.startLine + 1,  // 1-based
          end: method.endLine + 1
        },
        type: 'method',
        className: className,
        methodName: method.name,
        annotations: method.annotations,
        lineCount: method.lineCount
      });
    });

    // 7. 클래스 닫는 괄호 및 기타 처리
    const lastMethodEnd = methods.length > 0 
      ? methods[methods.length - 1].endLine 
      : methodsStart;
    
    if (lastMethodEnd < lines.length - 1) {
      const remainingLines = lines.slice(lastMethodEnd + 1);
      const remainingCode = remainingLines.join('\n').trim();
      
      if (remainingCode.length > 0 && remainingCode !== '}') {
        chunks.push({
          index: chunks.length,
          code: remainingCode,
          lineRange: {
            start: lastMethodEnd + 2,
            end: lines.length
          },
          type: 'footer',
          className: className,
          methodName: null,
          annotations: []
        });
      }
    }

    logger.info(`[MethodChunker] 청킹 완료: ${chunks.length}개 청크 생성`);

    return {
      chunks,
      header: importBlock.join('\n'),
      className,
      metadata: {
        fileName: metadata.fileName || 'unknown.java',
        totalLines: lines.length,
        totalChunks: chunks.length,
        totalMethods: methods.length,
        strategy: 'method-based',
        chunkedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Import 및 Package 블록 추출
   */
  extractImports(lines) {
    const importBlock = [];
    let codeStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('package ') ||
          line.startsWith('import ') ||
          line === '' ||
          line.startsWith('//') ||
          line.startsWith('/*') ||
          line.startsWith('*') ||
          line.startsWith('*/')) {
        importBlock.push(lines[i]);
        codeStart = i + 1;
      } else if (line.length > 0) {
        break;
      }
    }

    return { importBlock, codeStart };
  }

  /**
   * 클래스 선언 추출 (여러 클래스 지원)
   */
  extractClassDeclarations(lines, startFrom) {
    const classDeclarations = [];
    let methodsStart = startFrom;
    let className = null;
    let braceCount = 0;
    let foundClass = false;

    for (let i = startFrom; i < lines.length; i++) {
      const line = lines[i].trim();

      // JavaDoc, 어노테이션, 빈 줄
      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') ||
          line.startsWith('@') || line === '') {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
        continue;
      }

      // 클래스 선언 감지
      const classMatch = line.match(/(?:public|private|protected)?\s*(?:abstract|final)?\s*class\s+(\w+)/);
      if (classMatch) {
        className = classMatch[1];
        classDeclarations.push(lines[i]);
        foundClass = true;
        
        // 클래스 선언 라인에 { 가 있는지 확인
        if (line.includes('{')) {
          braceCount++;
          methodsStart = i + 1;
          break;
        }
        continue;
      }

      // 클래스 선언 후 { 찾기
      if (foundClass && line.includes('{')) {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
        break;
      }

      if (foundClass) {
        classDeclarations.push(lines[i]);
        methodsStart = i + 1;
      }

      if (line.length > 0 && !foundClass) {
        break;
      }
    }

    return { classDeclarations, methodsStart, className };
  }

  /**
   * 클래스 어노테이션 추출
   */
  extractClassAnnotations(classDeclarations) {
    const annotations = [];
    for (const line of classDeclarations) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@')) {
        const match = trimmed.match(/@(\w+)/);
        if (match) {
          annotations.push(match[1]);
        }
      }
    }
    return annotations;
  }

  /**
   * 메서드 시작 감지 (향상된 버전)
   */
  isMethodStart(line, lines, currentIndex) {
    const trimmed = line.trim();

    // 어노테이션으로 시작하는 경우
    if (trimmed.startsWith('@')) {
      for (let i = currentIndex + 1; i < Math.min(currentIndex + 10, lines.length); i++) {
        const nextLine = lines[i].trim();
        if (nextLine && !nextLine.startsWith('@') && !nextLine.startsWith('/**') &&
            !nextLine.startsWith('*') && !nextLine.startsWith('*/')) {
          if (/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>[\],\s]+\s+\w+\s*\(/.test(nextLine)) {
            return true;
          }
          break;
        }
      }
      return false;
    }

    // JavaDoc은 메서드 시작이 아님
    if (trimmed.startsWith('/**')) {
      return false;
    }

    // 메서드 시그니처 패턴
    if (/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>[\],\s]+\s+\w+\s*\(/.test(line)) {
      // 필드 선언 제외 (= 또는 ; 로 끝나는 경우)
      if (/[=;]\s*$/.test(trimmed) && !trimmed.includes('{')) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * 모든 메서드 추출 (기존 로직)
   * 
   * 클래스 끝을 별도로 감지하지 않고 파일 끝까지 진행
   * 각 메서드의 braceDepth는 extractSingleMethod() 내에서 개별 계산
   */
  extractMethods(lines, startFrom) {
    const methods = [];
    let i = startFrom;

    while (i < lines.length) {
      const line = lines[i].trim();

      // 메서드 시작 감지
      if (this.isMethodStart(line, lines, i)) {
        const method = this.extractSingleMethod(lines, i);
        if (method) {
          methods.push(method);
          i = method.endLine + 1;

          if (this.options.verbose) {
            logger.debug(`[MethodChunker] 메서드 추출: ${method.name} (${method.lineCount}줄)`);
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return methods;
  }

  /**
   * 단일 메서드 추출 (완전성 보장)
   */
  extractSingleMethod(lines, startIndex) {
    const methodLines = [];
    const annotations = [];
    let methodName = null;
    let braceDepth = 0;
    let foundMethodSignature = false;
    let currentIndex = startIndex;
    let warned = false;
    let inBlockComment = false;  // 블록 주석 상태 추적

    // 1. 어노테이션과 JavaDoc 수집
    while (currentIndex < lines.length) {
      const line = lines[currentIndex].trim();

      // 어노테이션
      if (line.startsWith('@')) {
        const match = line.match(/@(\w+)/);
        if (match) {
          annotations.push(match[1]);
        }
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      // JavaDoc
      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/')) {
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      // 빈 줄
      if (line === '') {
        methodLines.push(lines[currentIndex]);
        currentIndex++;
        continue;
      }

      // 메서드 시그니처
      if (/(?:public|private|protected)\s+/.test(line)) {
        foundMethodSignature = true;
        break;
      }

      break;
    }

    if (!foundMethodSignature) {
      return null;
    }

    // 2. 메서드 시그니처와 본문 수집
    let signatureComplete = false;
    const methodStartIndex = currentIndex;

    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      const trimmedLine = line.trim();

      // 다음 메서드 시작 감지 (현재 메서드 불완전)
      if (signatureComplete && braceDepth > 0 && currentIndex > methodStartIndex + 5) {
        if (this.isMethodStart(trimmedLine, lines, currentIndex)) {
          logger.warn(`[MethodChunker] 불완전 메서드 감지 (라인 ${startIndex}), 스킵`);
          return null;
        }
      }

      methodLines.push(line);

      // 메서드 이름 추출
      if (!methodName) {
        const match = trimmedLine.match(/\s+(\w+)\s*\(/);
        if (match) {
          methodName = match[1];
        }
      }

      // 중괄호 카운팅 (문자열/주석 내 중괄호 무시)
      const braceResult = this.countBraces(line, inBlockComment);
      inBlockComment = braceResult.inBlockComment;  // 블록 주석 상태 업데이트
      
      if (braceResult.open > 0) {
        signatureComplete = true;
      }
      braceDepth += braceResult.open - braceResult.close;

      currentIndex++;

      // 메서드 완료 감지
      if (signatureComplete && braceDepth === 0) {
        if (this.options.verbose && warned) {
          logger.info(`[MethodChunker] 대형 메서드 완료: ${methodName} (${currentIndex - startIndex}줄)`);
        }
        break;
      }

      // 경고 임계값
      if (!warned && (currentIndex - startIndex) > this.options.warnThreshold) {
        logger.warn(`[MethodChunker] 대형 메서드 감지: ${methodName || 'unknown'} (${currentIndex - startIndex}줄)`);
        warned = true;
      }

      // 강제 중단
      if ((currentIndex - startIndex) > this.options.hardLimit) {
        if (braceDepth === 0 && signatureComplete) {
          logger.warn(`[MethodChunker] 초대형 메서드 완료: ${methodName}`);
          break;
        } else {
          logger.error(`[MethodChunker] 메서드 너무 큼, 불완전 (라인 ${startIndex}), 스킵`);
          return null;
        }
      }
    }

    // 3. 완전성 검증
    if (signatureComplete && braceDepth !== 0) {
      logger.warn(`[MethodChunker] 메서드 불완전 (라인 ${startIndex}), braceDepth=${braceDepth}, 스킵`);
      return null;
    }

    if (!methodName || methodLines.length < 3) {
      return null;
    }

    return {
      name: methodName,
      annotations,
      lines: methodLines,
      startLine: startIndex,
      endLine: currentIndex - 1,
      lineCount: methodLines.length
    };
  }

  /**
   * 중괄호 카운팅 (문자열/주석 내 중괄호 무시)
   * 
   * @param {string} line - 코드 라인
   * @param {boolean} inBlockComment - 블록 주석 내부 여부
   * @returns {Object} { open, close, inBlockComment }
   */
  countBraces(line, inBlockComment = false) {
    let open = 0;
    let close = 0;
    let inString = false;
    let inChar = false;
    let stringChar = '';
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = i < line.length - 1 ? line[i + 1] : '';

      // 블록 주석 끝 감지
      if (inBlockComment) {
        if (char === '*' && nextChar === '/') {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // 블록 주석 시작 감지
      if (!inString && !inChar && char === '/' && nextChar === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }

      // 라인 주석 시작 → 나머지 무시
      if (!inString && !inChar && char === '/' && nextChar === '/') {
        break;
      }

      // 이스케이프 문자 처리
      if (i > 0 && line[i - 1] === '\\' && !this.isEscapedBackslash(line, i - 1)) {
        i++;
        continue;
      }

      // 문자열 시작/끝 (")
      if (char === '"' && !inChar) {
        if (!inString) {
          inString = true;
          stringChar = '"';
        } else if (stringChar === '"') {
          inString = false;
        }
        i++;
        continue;
      }

      // 문자 리터럴 시작/끝 (')
      if (char === "'" && !inString) {
        if (!inChar) {
          inChar = true;
        } else {
          inChar = false;
        }
        i++;
        continue;
      }

      // 문자열/문자 리터럴/주석 밖에서만 중괄호 카운트
      if (!inString && !inChar) {
        if (char === '{') open++;
        else if (char === '}') close++;
      }

      i++;
    }

    return { open, close, inBlockComment };
  }

  /**
   * 백슬래시가 이스케이프된 백슬래시인지 확인
   * (\\인 경우 true)
   */
  isEscapedBackslash(line, index) {
    let count = 0;
    for (let i = index; i >= 0 && line[i] === '\\'; i--) {
      count++;
    }
    // 백슬래시가 짝수 개면 이스케이프된 것
    return count % 2 === 0;
  }
}

// 싱글톤 인스턴스
let instance = null;

export function getMethodChunker(options = {}) {
  if (!instance) {
    instance = new MethodChunker(options);
  }
  return instance;
}

export function resetMethodChunker() {
  instance = null;
}

export default MethodChunker;