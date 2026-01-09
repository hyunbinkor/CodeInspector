/**
 * 결과 빌더
 * 
 * 점검 결과를 가공하고 리포트 형태로 구성
 * 
 * @module checker/resultBuilder
 */

import logger from '../utils/loggerUtils.js';

export class ResultBuilder {
  constructor() {
    // 심각도 우선순위
    this.severityOrder = {
      'CRITICAL': 0,
      'HIGH': 1,
      'MEDIUM': 2,
      'LOW': 3
    };
  }

  /**
   * 단일 파일 리포트 빌드
   * 
   * @param {Object} data - 점검 데이터
   * @returns {Object} 리포트
   */
  buildReport(data) {
    const { fileName, code, tags, matchedRules, issues, duration } = data;

    // 이슈 정렬 (심각도 → 라인 번호)
    const sortedIssues = this.sortIssues(issues);

    // 중복 제거
    const uniqueIssues = this.deduplicateIssues(sortedIssues);

    // 통계 계산
    const stats = this.calculateStats(uniqueIssues);

    return {
      success: true,
      fileName,
      lineCount: code ? code.split('\n').length : 0,
      tags,
      matchedRulesCount: matchedRules.length,
      issues: uniqueIssues,
      stats,
      duration
    };
  }

  /**
   * 전체 요약 빌드
   * 
   * @param {Object[]} reports - 리포트 배열
   * @returns {Object} 요약
   */
  buildSummary(reports) {
    const totalFiles = reports.length;
    const successFiles = reports.filter(r => r.success).length;
    const failedFiles = totalFiles - successFiles;

    // 전체 이슈 집계
    let totalIssues = 0;
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const byCategory = {};
    const byRule = {};

    for (const report of reports) {
      if (!report.issues) continue;

      for (const issue of report.issues) {
        totalIssues++;

        // 심각도별
        const severity = issue.severity || 'MEDIUM';
        bySeverity[severity] = (bySeverity[severity] || 0) + 1;

        // 카테고리별
        const category = issue.category || 'general';
        byCategory[category] = (byCategory[category] || 0) + 1;

        // 룰별
        const ruleId = issue.ruleId || 'UNKNOWN';
        if (!byRule[ruleId]) {
          byRule[ruleId] = {
            ruleId,
            title: issue.ruleTitle || ruleId,
            count: 0,
            severity: issue.severity
          };
        }
        byRule[ruleId].count++;
      }
    }

    // 상위 이슈 룰
    const topRules = Object.values(byRule)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 전체 소요 시간
    const totalDuration = reports.reduce((sum, r) => sum + (r.duration || 0), 0);

    return {
      totalFiles,
      successFiles,
      failedFiles,
      totalIssues,
      bySeverity,
      byCategory,
      topRules,
      totalDuration,
      averageDuration: totalFiles > 0 ? Math.round(totalDuration / totalFiles) : 0
    };
  }

  /**
   * 이슈 정렬
   */
  sortIssues(issues) {
    return [...issues].sort((a, b) => {
      // 심각도 우선
      const severityDiff = (this.severityOrder[a.severity] || 99) - (this.severityOrder[b.severity] || 99);
      if (severityDiff !== 0) return severityDiff;

      // 라인 번호
      return (a.line || 0) - (b.line || 0);
    });
  }

  /**
   * 중복 이슈 제거
   */
  deduplicateIssues(issues) {
    const seen = new Set();
    const unique = [];

    for (const issue of issues) {
      // 룰 ID + 라인 번호로 중복 판단
      const key = `${issue.ruleId}:${issue.line}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(issue);
      }
    }

    return unique;
  }

  /**
   * 통계 계산
   */
  calculateStats(issues) {
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const byCategory = {};

    for (const issue of issues) {
      const severity = issue.severity || 'MEDIUM';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;

      const category = issue.category || 'general';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    return {
      total: issues.length,
      bySeverity,
      byCategory
    };
  }

  /**
   * 콘솔 출력용 포맷
   */
  formatForConsole(report) {
    const lines = [];
    
    lines.push(`\n📄 ${report.fileName}`);
    lines.push(`   라인: ${report.lineCount}, 태그: ${report.tags?.length || 0}, 매칭 룰: ${report.matchedRulesCount}`);
    
    if (report.issues?.length > 0) {
      lines.push(`   🔍 이슈 ${report.issues.length}개:`);
      
      for (const issue of report.issues.slice(0, 10)) {
        const icon = this.getSeverityIcon(issue.severity);
        lines.push(`      ${icon} [${issue.ruleId}] L${issue.line}: ${issue.message.substring(0, 60)}`);
      }
      
      if (report.issues.length > 10) {
        lines.push(`      ... 외 ${report.issues.length - 10}개`);
      }
    } else {
      lines.push(`   ✅ 이슈 없음`);
    }
    
    lines.push(`   ⏱️ ${report.duration}ms`);

    return lines.join('\n');
  }

  /**
   * 요약 콘솔 출력
   */
  formatSummaryForConsole(summary) {
    const lines = [];
    
    lines.push('\n' + '='.repeat(60));
    lines.push('📊 점검 결과 요약');
    lines.push('='.repeat(60));
    
    lines.push(`\n📁 파일: ${summary.totalFiles}개 (성공: ${summary.successFiles}, 실패: ${summary.failedFiles})`);
    lines.push(`🔍 총 이슈: ${summary.totalIssues}개`);
    
    lines.push('\n심각도별:');
    lines.push(`   🔴 CRITICAL: ${summary.bySeverity.CRITICAL}`);
    lines.push(`   🟠 HIGH: ${summary.bySeverity.HIGH}`);
    lines.push(`   🟡 MEDIUM: ${summary.bySeverity.MEDIUM}`);
    lines.push(`   🟢 LOW: ${summary.bySeverity.LOW}`);
    
    if (summary.topRules?.length > 0) {
      lines.push('\n📋 빈발 이슈 TOP 5:');
      for (const rule of summary.topRules.slice(0, 5)) {
        lines.push(`   ${rule.count}건 - [${rule.ruleId}] ${rule.title}`);
      }
    }
    
    lines.push(`\n⏱️ 총 소요시간: ${summary.totalDuration}ms (평균: ${summary.averageDuration}ms/파일)`);
    lines.push('='.repeat(60));

    return lines.join('\n');
  }

  /**
   * 심각도 아이콘
   */
  getSeverityIcon(severity) {
    const icons = {
      'CRITICAL': '🔴',
      'HIGH': '🟠',
      'MEDIUM': '🟡',
      'LOW': '🟢'
    };
    return icons[severity] || '⚪';
  }
}

/**
 * 싱글톤 인스턴스
 */
let instance = null;

export function getResultBuilder() {
  if (!instance) {
    instance = new ResultBuilder();
  }
  return instance;
}

export default ResultBuilder;
