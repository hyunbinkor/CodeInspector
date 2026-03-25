/**
 * JavaScript RegExp 호환 정규식 유틸리티
 *
 * LLM이 생성하는 antiPattern에는 Python/Java/PCRE 스타일 문법이
 * 포함되는 경우가 많음. JavaScript RegExp는 이를 지원하지 않으므로
 * 사전에 변환·정규화가 필요.
 *
 * 주요 변환 규칙:
 *   (?s)          → flags에 's' 추가 (DOTALL)
 *   (?i)          → flags에 'i' 추가 (IGNORECASE)
 *   (?m)          → flags에 'm' 추가 (MULTILINE)
 *   (?x)          → 제거 (VERBOSE - JS 미지원)
 *   (?-i) 등      → 제거 (비활성화 플래그 - JS 미지원)
 *   (?>...)       → (?:...) (atomic group → non-capturing group)
 *   (?P<n>...)    → (?<n>...) (Python named group)
 *   (?P=name)     → \k<name> (Python named backreference)
 *   \++, \*+, \?+ → +, *, ? (possessive quantifiers)
 *   \b(?:A|B)\b 내 긴 alternation → 그대로 유지
 *
 * @module utils/regexUtils
 */

import logger from './loggerUtils.js';

/**
 * 인라인 플래그 추출 및 제거
 *
 * (?s), (?i), (?m), (?x), (?-i), (?si) 등 처리
 *
 * @param {string} pattern - 원본 정규식 패턴
 * @param {string} flags   - 기존 플래그 문자열
 * @returns {{ pattern: string, flags: string }}
 */
export function extractInlineFlags(pattern, flags = '') {
  if (!pattern || typeof pattern !== 'string') return { pattern: '', flags };

  const flagSet = new Set(flags.split('').filter(Boolean));
  let p = pattern;

  // (?flags) 또는 (?-flags) 형태 처리
  p = p.replace(/\(\?([a-zA-Z\-]+)\)/g, (match, flagStr) => {
    let negate = false;
    for (const ch of flagStr) {
      if (ch === '-') { negate = true; continue; }
      if (negate) continue;           // (?-i) 비활성화 → 그냥 제거
      if (ch === 's') flagSet.add('s');
      else if (ch === 'i') flagSet.add('i');
      else if (ch === 'm') flagSet.add('m');
      // x(VERBOSE), u 등은 JS 미지원 → 무시
    }
    return '';  // 인라인 플래그 제거
  });

  return { pattern: p, flags: [...flagSet].join('') };
}

/**
 * PCRE/Python 전용 문법을 JS RegExp 호환 문법으로 변환
 *
 * @param {string} pattern - 정규식 패턴
 * @returns {string} 변환된 패턴
 */
export function convertPcreToJs(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';

  let p = pattern;

  // 1. 패턴 중간의 인라인 플래그 그룹 제거 (?i:...) 형태
  //    (?i:...) → (?:...) — 플래그 정보는 extractInlineFlags에서 이미 처리
  p = p.replace(/\(\?[imsx]+:/g, '(?:');

  // 2. Atomic group (?>...) → (?:...)
  p = p.replace(/\(\?>/g, '(?:');

  // 3. Possessive quantifiers: ++, *+, ?+  →  +, *, ?
  p = p.replace(/\+\+/g, '+');
  p = p.replace(/\*\+/g, '*');
  p = p.replace(/\?\+/g, '?');

  // 4. Python named group (?P<name>...) → (?<name>...)
  p = p.replace(/\(\?P</g, '(?<');

  // 5. Python named backreference (?P=name) → \k<name>
  p = p.replace(/\(\?P=(\w+)\)/g, '\\k<$1>');

  // 6. \Z (Python end-of-string) → $
  p = p.replace(/\\Z/g, '$');

  // 7. 조건 그룹 (?(id)yes|no) → (?:yes|no) — 근사치 변환
  p = p.replace(/\(\?\(\d+\)([^|)]*)\|?([^)]*)\)/g, '(?:$1|$2)');

  return p;
}

/**
 * 불균형 괄호 보정
 *
 * 변환 과정에서 발생할 수 있는 짝이 안 맞는 괄호를 복구.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function balanceParentheses(pattern) {
  if (!pattern) return '';

  let open = 0;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const prev = i > 0 ? pattern[i - 1] : '';

    if (prev === '\\') continue;

    if (ch === '[' && !inCharClass) { inCharClass = true; continue; }
    if (ch === ']' && inCharClass)  { inCharClass = false; continue; }
    if (inCharClass) continue;

    if (ch === '(') open++;
    else if (ch === ')') {
      if (open > 0) open--;
      // open이 0인데 ')' 가 나오면 불균형 → 해당 문자 제거
      else {
        pattern = pattern.slice(0, i) + pattern.slice(i + 1);
        i--;
      }
    }
  }

  // 닫히지 않은 '(' 보정
  if (open > 0) pattern += ')'.repeat(open);

  return pattern;
}

/**
 * 정규식 패턴 전체 정규화
 *
 * extractInlineFlags → convertPcreToJs → balanceParentheses 순서로 적용.
 *
 * @param {string} pattern - 원본 패턴
 * @param {string} flags   - 기존 플래그
 * @returns {{ pattern: string, flags: string }}
 */
export function normalizeRegexPattern(pattern, flags = '') {
  if (!pattern || typeof pattern !== 'string') return { pattern: '', flags };

  // Step 1: 인라인 플래그 추출
  const step1 = extractInlineFlags(pattern, flags);

  // Step 2: PCRE → JS 변환
  const step2 = convertPcreToJs(step1.pattern);

  // Step 3: 괄호 균형 보정
  const step3 = balanceParentheses(step2);

  return { pattern: step3, flags: step1.flags };
}

/**
 * 안전한 RegExp 생성
 *
 * 정규화 후 생성 시도. 실패하면 단계적으로 fallback 처리.
 *
 * @param {string}  pattern - 정규식 패턴 문자열
 * @param {string}  flags   - 플래그 문자열 (기본 'g')
 * @param {string}  ruleId  - 로깅용 규칙 ID (선택)
 * @returns {RegExp|null} 성공 시 RegExp, 실패 시 null
 */
export function safeRegExp(pattern, flags = 'g', ruleId = '') {
  if (!pattern || typeof pattern !== 'string') return null;

  const prefix = ruleId ? `[${ruleId}]` : '[regexUtils]';

  // 시도 1: 정규화 후 생성
  try {
    const normalized = normalizeRegexPattern(pattern, flags);
    return new RegExp(normalized.pattern, normalized.flags);
  } catch (e1) {
    // 시도 2: 플래그만 's' 제거 후 재시도 (구버전 Node.js 대응)
    try {
      const normalized = normalizeRegexPattern(pattern, flags);
      const safeFlags  = normalized.flags.replace('s', '');
      return new RegExp(normalized.pattern, safeFlags);
    } catch (e2) {
      // 시도 3: 특수문자 이스케이프된 리터럴 검색으로 degradation
      try {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        logger.warn(`${prefix} 패턴 정규화 실패, 이스케이프 폴백 사용: "${pattern.substring(0, 60)}"`);
        return new RegExp(escaped, flags.replace(/[^gimy]/g, ''));
      } catch (e3) {
        logger.warn(`${prefix} 패턴 생성 완전 실패, 스킵: "${pattern.substring(0, 60)}" — ${e1.message}`);
        return null;
      }
    }
  }
}

/**
 * 패턴 배열 일괄 정규화 (저장 전처리용)
 *
 * guidelineExtractor / ruleTagger 에서 JSON 저장 전에 호출.
 * 이미 저장된 데이터는 codeChecker의 safeRegExp 가 런타임에 처리.
 *
 * @param {Array} patterns - antiPatterns / goodPatterns 배열
 * @returns {Array} 정규화된 배열
 */
export function normalizePatternArray(patterns) {
  if (!Array.isArray(patterns)) return [];

  return patterns
    .map(p => {
      if (!p) return null;

      let patternStr, flagsStr, description;

      if (typeof p === 'string') {
        patternStr  = p;
        flagsStr    = 'g';
        description = '';
      } else if (p instanceof RegExp) {
        patternStr  = p.source;
        flagsStr    = p.flags || 'g';
        description = '';
      } else if (typeof p === 'object' && p.pattern) {
        patternStr  = String(p.pattern);
        flagsStr    = p.flags || 'g';
        description = p.description || '';
      } else {
        return null;
      }

      // 정규화
      const { pattern: normalized, flags: normalizedFlags } = normalizeRegexPattern(patternStr, flagsStr);

      // 유효성 검증
      try {
        new RegExp(normalized, normalizedFlags);
      } catch {
        // 유효하지 않으면 null → 필터링됨
        logger.warn(`[normalizePatternArray] 유효하지 않은 패턴 제거: "${patternStr.substring(0, 60)}"`);
        return null;
      }

      return { pattern: normalized, flags: normalizedFlags, description };
    })
    .filter(Boolean);
}

export default { extractInlineFlags, convertPcreToJs, balanceParentheses, normalizeRegexPattern, safeRegExp, normalizePatternArray };