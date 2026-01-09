/**
 * Java AST 파서
 * 
 * 기존 프로젝트의 검증된 로직을 기반으로 작성
 * - java-parser 대신 정규식 기반 분석 (fallback 방식)
 * - AST 시그니처 생성 (structural, semantic, behavioral)
 * - 리소스 누수, 보안 취약점, 성능 이슈 탐지
 * 
 * @module ast/javaAstParser
 */

import logger from '../utils/loggerUtils.js';

export class JavaASTParser {
  constructor() {
    // 레거시 프레임워크에서 자주 사용되는 기본 클래스들 (기존 로직)
    this.frameworkClasses = [
      'BaseService', 'DataAccessLayer', 'ConnectionManager',
      'BusinessProcessor', 'AbstractController', 'ServiceImpl'
    ];

    // 명시적으로 close()를 호출해야 하는 리소스 타입들 (기존 로직)
    this.resourceTypes = [
      'Connection', 'PreparedStatement', 'ResultSet', 'Statement',
      'FileInputStream', 'FileOutputStream', 'BufferedReader', 'BufferedWriter',
      'Socket', 'ServerSocket', 'HttpURLConnection', 'InputStream', 'OutputStream'
    ];

    // 보안 취약점이 발생할 수 있는 메서드들 (기존 로직)
    this.securitySensitiveApis = [
      'executeQuery', 'executeUpdate', 'execute',
      'getWriter', 'sendRedirect', 'setAttribute',
      'encrypt', 'decrypt', 'hash', 'getParameter'
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 메인 API (기존 호환)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Java 코드 분석 (기존 API - parseJavaCode)
   * 
   * @param {string} javaCode - Java 소스 코드
   * @returns {Object} 분석 결과 { success, ast, analysis, error }
   */
  parseJavaCode(javaCode) {
    try {
      if (!javaCode || typeof javaCode !== 'string') {
        return {
          success: false,
          ast: null,
          analysis: this.createEmptyAnalysis(),
          error: 'No code provided'
        };
      }

      // java-parser 라이브러리가 완전하지 않아 정규식 기반 분석 사용 (기존 주석)
      const fallbackAnalysis = this.fallbackAnalysis(javaCode);

      return {
        success: true,
        ast: null,
        analysis: fallbackAnalysis,
        error: null
      };
    } catch (error) {
      logger.warn('Java 코드 분석 실패:', error.message);

      return {
        success: false,
        ast: null,
        analysis: this.createEmptyAnalysis(),
        error: error.message
      };
    }
  }

  /**
   * 새 API (parse) - parseJavaCode 래핑
   */
  parse(code) {
    return this.parseJavaCode(code);
  }

  /**
   * 빈 분석 결과 생성 (기존 로직)
   */
  createEmptyAnalysis() {
    return {
      nodeTypes: [],
      nodeCount: 0,
      maxDepth: 1,
      cyclomaticComplexity: 1,
      
      classDeclarations: [],
      methodDeclarations: [],
      variableDeclarations: [],
      methodInvocations: [],
      constructorCalls: [],
      controlStructures: [],
      exceptionHandling: [],
      annotations: [],
      inheritancePatterns: [],
      
      resourceLifecycles: [],
      resourceLeakRisks: [],
      securityPatterns: [],
      sqlInjectionRisks: [],
      performanceIssues: [],
      loopAnalysis: [],
      codeSmells: [],
      designPatterns: []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 정규식 기반 분석 (기존 fallbackAnalysis 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 정규식 기반 폴백 분석 (기존 fallbackAnalysis 로직)
   */
  fallbackAnalysis(javaCode) {
    return {
      // 기본 구조 분석
      nodeTypes: this.extractNodeTypesRegex(javaCode),
      nodeCount: this.countNodesRegex(javaCode),
      maxDepth: this.estimateDepthRegex(javaCode),
      cyclomaticComplexity: this.calculateComplexityRegex(javaCode),

      // 선언 추출
      classDeclarations: this.extractClassesRegex(javaCode),
      methodDeclarations: this.extractMethodsRegex(javaCode),
      variableDeclarations: this.extractVariablesRegex(javaCode),
      methodInvocations: this.extractMethodCallsRegex(javaCode),
      annotations: this.extractAnnotationsRegex(javaCode),

      // 빈 배열 (AST 기반 분석 시에만 채워짐)
      controlStructures: [],
      exceptionHandling: this.analyzeExceptionHandlingRegex(javaCode),
      inheritancePatterns: [],

      // 이슈 분석
      resourceLifecycles: this.analyzeResourcesRegex(javaCode),
      resourceLeakRisks: [],
      securityPatterns: this.analyzeSecurityRegex(javaCode),
      sqlInjectionRisks: [],
      performanceIssues: this.analyzePerformanceRegex(javaCode),
      loopAnalysis: this.analyzeLoopsRegex(javaCode),
      codeSmells: [],
      designPatterns: []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 노드 타입 추출 (기존 로직)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 정규식으로 주요 구문 타입 추출 (기존 extractNodeTypesRegex)
   */
  extractNodeTypesRegex(code) {
    const patterns = {
      'ClassDeclaration': /class\s+\w+/g,
      'InterfaceDeclaration': /interface\s+\w+/g,
      'MethodDeclaration': /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+\w+\s*\([^)]*\)\s*(?:\{|throws)/g,
      'VariableDeclaration': /(?:private|public|protected)?\s*\w+\s+\w+\s*=/g,
      'IfStatement': /if\s*\(/g,
      'ForStatement': /for\s*\(/g,
      'WhileStatement': /while\s*\(/g,
      'TryStatement': /try\s*[\{\(]/g,
      'CatchClause': /catch\s*\(/g,
      'ThrowStatement': /throw\s+/g
    };

    const nodeTypes = [];
    for (const [type, pattern] of Object.entries(patterns)) {
      const matches = code.match(pattern) || [];
      for (let i = 0; i < matches.length; i++) {
        nodeTypes.push(type);
      }
    }

    return nodeTypes;
  }

  /**
   * 정규식으로 추출한 노드 타입의 총 개수 (기존 countNodesRegex)
   */
  countNodesRegex(code) {
    return this.extractNodeTypesRegex(code).length;
  }

  /**
   * 중괄호 쌍으로 코드 블록의 최대 중첩 깊이 계산 (기존 estimateDepthRegex)
   */
  estimateDepthRegex(code) {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of code) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  /**
   * if, for, while 등 분기 구문 개수로 순환 복잡도 추정 (기존 calculateComplexityRegex)
   */
  calculateComplexityRegex(code) {
    const complexityPatterns = /if|for|while|switch|case|catch|\?\s*:/g;
    const matches = code.match(complexityPatterns) || [];
    return matches.length + 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 선언 추출 (기존 로직 - 더 상세한 버전)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 클래스 선언문에서 이름, 상속, 구현 인터페이스 추출 (기존 extractClassesRegex)
   */
  extractClassesRegex(code) {
    const classPattern = /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    const classes = [];
    let match;

    while ((match = classPattern.exec(code)) !== null) {
      classes.push({
        name: match[1],
        extends: match[2] || null,
        implements: match[3] ? match[3].split(',').map(i => i.trim()) : []
      });
    }

    return classes;
  }

  /**
   * 메서드 선언문에서 반환 타입, 이름, 매개변수 추출 (기존 extractMethodsRegex)
   */
  extractMethodsRegex(code) {
    const methodPattern = /(?:public|private|protected)?\s*(?:static)?\s*(\w+)\s+(\w+)\s*\(([^)]*)\)/g;
    const methods = [];
    let match;

    while ((match = methodPattern.exec(code)) !== null) {
      // 'class', 'if', 'for' 등의 키워드 제외
      const excludeKeywords = ['class', 'interface', 'if', 'for', 'while', 'switch', 'catch', 'new'];
      if (!excludeKeywords.includes(match[2])) {
        methods.push({
          returnType: match[1],
          name: match[2],
          parameters: match[3].trim()
        });
      }
    }

    return methods;
  }

  /**
   * 변수 선언문에서 타입, 이름, 초기화 여부 추출 (기존 extractVariablesRegex)
   */
  extractVariablesRegex(code) {
    const varPattern = /(?:private|public|protected|final)?\s*(\w+)\s+(\w+)\s*(?:=([^;]+))?;/g;
    const variables = [];
    let match;

    // 키워드 제외 목록
    const excludeTypes = ['class', 'interface', 'return', 'throw', 'new', 'if', 'for', 'while'];

    while ((match = varPattern.exec(code)) !== null) {
      if (!excludeTypes.includes(match[1])) {
        variables.push({
          type: match[1],
          name: match[2],
          hasInitializer: !!match[3]
        });
      }
    }

    return variables;
  }

  /**
   * "객체.메서드(" 패턴으로 메서드 호출 추출 (기존 extractMethodCallsRegex)
   */
  extractMethodCallsRegex(code) {
    const callPattern = /(\w+)\.(\w+)\s*\(/g;
    const calls = [];
    let match;

    while ((match = callPattern.exec(code)) !== null) {
      calls.push({
        target: match[1],
        method: match[2]
      });
    }

    return calls;
  }

  /**
   * @어노테이션 패턴으로 어노테이션 추출 (기존 extractAnnotationsRegex)
   */
  extractAnnotationsRegex(code) {
    const annotationPattern = /@(\w+)(?:\([^)]*\))?/g;
    const annotations = [];
    let match;

    while ((match = annotationPattern.exec(code)) !== null) {
      annotations.push({
        name: match[1]
      });
    }

    return annotations;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 리소스/보안/성능 분석 (기존 로직 - 더 상세한 버전)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Connection, FileStream 등 리소스의 생성/해제 패턴 분석 (기존 analyzeResourcesRegex)
   */
  analyzeResourcesRegex(code) {
    const resources = [];

    for (const resourceType of this.resourceTypes) {
      const pattern = new RegExp(`${resourceType}\\s+(\\w+)\\s*=`, 'g');
      let match;

      while ((match = pattern.exec(code)) !== null) {
        const varName = match[1];

        // try-with-resources 구문 내에 있는지 확인
        const tryWithResourcesPattern = new RegExp(`try\\s*\\([^)]*${varName}[^)]*\\)`, 'g');
        const inTryWithResources = tryWithResourcesPattern.test(code);

        // 명시적 close() 호출이 있는지 확인
        const closePattern = new RegExp(`${varName}\\.close\\(\\)`, 'g');
        const hasCloseCall = closePattern.test(code);

        resources.push({
          type: resourceType,
          variable: varName,
          inTryWithResources,
          hasCloseCall,
          riskLevel: (!inTryWithResources && !hasCloseCall) ? 'HIGH' : 'LOW'
        });
      }
    }

    return resources;
  }

  /**
   * SQL 인젝션, XSS 등 보안 취약점 패턴 탐지 (기존 analyzeSecurityRegex)
   */
  analyzeSecurityRegex(code) {
    const securityIssues = [];

    // SQL 쿼리에서 문자열 연결(+) 사용 시 SQL 인젝션 위험
    if (code.includes('executeQuery') || code.includes('executeUpdate')) {
      const sqlConcatPattern = /["'].*\+.*["']/g;
      if (sqlConcatPattern.test(code)) {
        securityIssues.push({
          type: 'SQL_INJECTION',
          description: 'String concatenation in SQL query',
          severity: 'HIGH'
        });
      }
    }

    // 사용자 입력을 인코딩 없이 직접 출력 시 XSS 위험
    if (code.includes('getWriter') && code.includes('println')) {
      securityIssues.push({
        type: 'XSS',
        description: 'Direct output without encoding',
        severity: 'MEDIUM'
      });
    }

    // 하드코딩된 비밀번호
    if (/(?:password|passwd|pwd)\s*=\s*["'][^"']+["']/i.test(code)) {
      securityIssues.push({
        type: 'HARDCODED_PASSWORD',
        description: 'Hardcoded password detected',
        severity: 'HIGH'
      });
    }

    return securityIssues;
  }

  /**
   * 루프 내 데이터베이스 쿼리 등 성능 문제 패턴 탐지 (기존 analyzePerformanceRegex)
   */
  analyzePerformanceRegex(code) {
    const performanceIssues = [];

    // 반복문 안에서 데이터베이스 쿼리 실행 시 N+1 문제 발생
    const loopWithQueryPattern = /(for|while)\s*\([^)]*\)\s*\{[^}]*(?:executeQuery|find|get)[^}]*\}/g;
    if (loopWithQueryPattern.test(code)) {
      performanceIssues.push({
        type: 'N_PLUS_ONE_QUERY',
        description: 'Database query inside loop',
        severity: 'HIGH'
      });
    }

    // 루프 내 객체 생성
    const loopWithNewPattern = /(for|while)\s*\([^)]*\)\s*\{[^}]*new\s+\w+[^}]*\}/g;
    if (loopWithNewPattern.test(code)) {
      performanceIssues.push({
        type: 'OBJECT_CREATION_IN_LOOP',
        description: 'Object creation inside loop',
        severity: 'MEDIUM'
      });
    }

    return performanceIssues;
  }

  /**
   * 예외 처리 분석
   */
  analyzeExceptionHandlingRegex(code) {
    const issues = [];

    // 빈 catch 블록
    if (/catch\s*\([^)]+\)\s*\{\s*\}/s.test(code)) {
      issues.push({
        type: 'EMPTY_CATCH',
        description: 'Empty catch block',
        severity: 'MEDIUM'
      });
    }

    // 포괄적 예외 처리
    if (/catch\s*\(\s*Exception\s+\w+\s*\)/.test(code)) {
      issues.push({
        type: 'GENERIC_CATCH',
        description: 'Catching generic Exception',
        severity: 'LOW'
      });
    }

    // printStackTrace() 사용
    if (/\.printStackTrace\s*\(\s*\)/.test(code)) {
      issues.push({
        type: 'PRINT_STACK_TRACE',
        description: 'Using printStackTrace() instead of proper logging',
        severity: 'LOW'
      });
    }

    return issues;
  }

  /**
   * 루프 분석
   */
  analyzeLoopsRegex(code) {
    const loopInfo = {
      forCount: (code.match(/\bfor\s*\(/g) || []).length,
      whileCount: (code.match(/\bwhile\s*\(/g) || []).length,
      doWhileCount: (code.match(/\bdo\s*\{/g) || []).length,
      hasDbCallInLoop: false,
      hasNestedLoop: false
    };

    // 루프 내 DB 호출 감지
    loopInfo.hasDbCallInLoop = this.detectDbCallInLoop(code);

    // 중첩 루프 감지
    loopInfo.hasNestedLoop = this.detectNestedLoop(code);

    return loopInfo;
  }

  /**
   * 루프 내 DB 호출 감지
   */
  detectDbCallInLoop(code) {
    const loopPattern = /(?:for|while)\s*\([^)]*\)\s*\{/g;
    let match;

    while ((match = loopPattern.exec(code)) !== null) {
      const startIndex = match.index + match[0].length;
      const loopBlock = this.extractBlock(code, startIndex);

      const dbPatterns = [
        /\.executeQuery\s*\(/,
        /\.executeUpdate\s*\(/,
        /\.execute\s*\(/,
        /\.prepareStatement\s*\(/,
        /\.getConnection\s*\(/
      ];

      for (const pattern of dbPatterns) {
        if (pattern.test(loopBlock)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 중첩 루프 감지
   */
  detectNestedLoop(code) {
    const outerLoopPattern = /(?:for|while)\s*\([^)]*\)\s*\{/g;
    let match;

    while ((match = outerLoopPattern.exec(code)) !== null) {
      const startIndex = match.index + match[0].length;
      const block = this.extractBlock(code, startIndex);

      if (/(?:for|while)\s*\([^)]*\)\s*\{/.test(block)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 중괄호 블록 추출
   */
  extractBlock(code, startIndex) {
    let braceCount = 1;
    let endIndex = startIndex;

    while (endIndex < code.length && braceCount > 0) {
      if (code[endIndex] === '{') braceCount++;
      else if (code[endIndex] === '}') braceCount--;
      endIndex++;
    }

    return code.substring(startIndex, endIndex - 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // AST 시그니처 생성 (기존 generateASTSignature 로직 - 핵심!)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * AST 구조를 3가지 관점의 시그니처로 변환 (기존 generateASTSignature)
   * 코드 검색/비교용
   * 
   * @param {Object} astAnalysis - 분석 결과
   * @returns {Object} { structural, semantic, behavioral }
   */
  generateASTSignature(astAnalysis) {
    const signature = {
      // 구조적 시그니처: 노드 구성, 깊이, 복잡도
      structural: {
        nodePattern: this.generateNodePattern(astAnalysis.nodeTypes),
        depthPattern: astAnalysis.maxDepth,
        complexityPattern: astAnalysis.cyclomaticComplexity
      },

      // 의미론적 시그니처: 리소스 사용, 보안 패턴, 프레임워크 활용
      semantic: {
        resourcePattern: this.generateResourcePattern(astAnalysis.resourceLifecycles),
        securityPattern: this.generateSecurityPattern(astAnalysis.securityPatterns),
        frameworkPattern: this.generateFrameworkPattern(
          astAnalysis.annotations,
          astAnalysis.classDeclarations
        )
      },

      // 행동 패턴 시그니처: 메서드 호출 순서, 제어 흐름, 예외 처리
      behavioral: {
        methodCallPattern: this.generateMethodCallPattern(astAnalysis.methodInvocations),
        controlFlowPattern: this.generateControlFlowPattern(astAnalysis.controlStructures),
        exceptionPattern: this.generateExceptionPattern(astAnalysis.exceptionHandling)
      }
    };

    return signature;
  }

  /**
   * 상위 10개 노드를 화살표로 연결한 패턴 문자열 생성 (기존 generateNodePattern)
   */
  generateNodePattern(nodeTypes) {
    if (!nodeTypes || !Array.isArray(nodeTypes)) return '';
    return nodeTypes.slice(0, 10).join('->');
  }

  /**
   * "리소스타입:생명주기단계" 형식의 패턴 문자열 생성 (기존 generateResourcePattern)
   */
  generateResourcePattern(resourceLifecycles) {
    if (!resourceLifecycles || !Array.isArray(resourceLifecycles)) return '';
    return resourceLifecycles.map(r => {
      const stage = r.inTryWithResources ? 'auto' : (r.hasCloseCall ? 'manual' : 'leaked');
      return `${r.type}:${stage}`;
    }).join(',');
  }

  /**
   * 보안 패턴 타입들을 쉼표로 연결한 문자열 생성 (기존 generateSecurityPattern)
   */
  generateSecurityPattern(securityPatterns) {
    if (!securityPatterns || !Array.isArray(securityPatterns)) return '';
    return securityPatterns.map(p => p.type || p).join(',');
  }

  /**
   * 어노테이션과 상속 관계를 결합한 패턴 생성 (기존 generateFrameworkPattern)
   */
  generateFrameworkPattern(annotations, classDeclarations) {
    const patterns = [];

    if (annotations && Array.isArray(annotations)) {
      patterns.push(...annotations.map(a => `@${a.name || a}`));
    }

    if (classDeclarations && Array.isArray(classDeclarations)) {
      for (const cls of classDeclarations) {
        if (cls.extends) {
          patterns.push(`extends:${cls.extends}`);
        }
        if (cls.implements && cls.implements.length > 0) {
          patterns.push(...cls.implements.map(i => `implements:${i}`));
        }
      }
    }

    return patterns.join(',');
  }

  /**
   * 상위 5개 메서드 호출을 "객체.메서드" 형식으로 연결 (기존 generateMethodCallPattern)
   */
  generateMethodCallPattern(methodInvocations) {
    if (!methodInvocations || !Array.isArray(methodInvocations)) return '';
    return methodInvocations
      .slice(0, 5)
      .map(m => `${m.target || 'this'}.${m.method}`)
      .join('->');
  }

  /**
   * 제어 구조 타입들을 순서대로 화살표로 연결 (기존 generateControlFlowPattern)
   */
  generateControlFlowPattern(controlStructures) {
    if (!controlStructures || !Array.isArray(controlStructures)) return '';
    return controlStructures.map(cs => cs.type || cs).join('->');
  }

  /**
   * 예외 처리 타입들을 쉼표로 연결한 문자열 생성 (기존 generateExceptionPattern)
   */
  generateExceptionPattern(exceptionHandling) {
    if (!exceptionHandling || !Array.isArray(exceptionHandling)) return '';
    return exceptionHandling.map(eh => eh.type || eh).join(',');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton & Export
// ═══════════════════════════════════════════════════════════════════════════════

let instance = null;

/**
 * 싱글톤 인스턴스 반환
 */
export function getJavaAstParser() {
  if (!instance) {
    instance = new JavaASTParser();
  }
  return instance;
}

/**
 * 싱글톤 리셋 (테스트용)
 */
export function resetJavaAstParser() {
  instance = null;
}

// 하위 호환을 위한 alias
export { JavaASTParser as JavaAstParser };

export default JavaASTParser;
