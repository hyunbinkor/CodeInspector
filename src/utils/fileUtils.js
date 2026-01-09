/**
 * 파일 I/O 유틸리티
 * 
 * @module utils/fileUtils
 */

import fs from 'fs/promises';
import path from 'path';
import logger from './loggerUtils.js';

/**
 * JSON 파일 읽기
 * @param {string} filePath - 파일 경로
 * @returns {Promise<Object>} 파싱된 JSON 객체
 */
export async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error(`JSON 파일 읽기 실패: ${filePath}`, error.message);
    throw error;
  }
}

/**
 * JSON 파일 쓰기
 * @param {string} filePath - 파일 경로
 * @param {Object} data - 저장할 데이터
 */
export async function writeJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info(`파일 저장 완료: ${filePath}`);
  } catch (error) {
    logger.error(`JSON 파일 쓰기 실패: ${filePath}`, error.message);
    throw error;
  }
}

/**
 * 텍스트 파일 읽기
 * @param {string} filePath - 파일 경로
 * @returns {Promise<string>} 파일 내용
 */
export async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    logger.error(`텍스트 파일 읽기 실패: ${filePath}`, error.message);
    throw error;
  }
}

/**
 * 텍스트 파일 쓰기
 * @param {string} filePath - 파일 경로
 * @param {string} content - 저장할 내용
 */
export async function writeTextFile(filePath, content) {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    logger.info(`파일 저장 완료: ${filePath}`);
  } catch (error) {
    logger.error(`텍스트 파일 쓰기 실패: ${filePath}`, error.message);
    throw error;
  }
}

/**
 * 디렉토리 내 파일 목록 조회
 * @param {string} dirPath - 디렉토리 경로
 * @param {string} extension - 확장자 필터 (선택)
 * @returns {Promise<string[]>} 파일 경로 배열
 */
export async function listFiles(dirPath, extension = null) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let files = entries
      .filter(entry => entry.isFile())
      .map(entry => path.join(dirPath, entry.name));
    
    if (extension) {
      files = files.filter(file => file.endsWith(extension));
    }
    
    return files;
  } catch (error) {
    logger.error(`디렉토리 읽기 실패: ${dirPath}`, error.message);
    return [];
  }
}

/**
 * 파일 존재 여부 확인
 * @param {string} filePath - 파일 경로
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 디렉토리 생성 (재귀)
 * @param {string} dirPath - 디렉토리 경로
 */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    logger.error(`디렉토리 생성 실패: ${dirPath}`, error.message);
    throw error;
  }
}

export default {
  readJsonFile,
  writeJsonFile,
  readTextFile,
  writeTextFile,
  listFiles,
  fileExists,
  ensureDir
};
