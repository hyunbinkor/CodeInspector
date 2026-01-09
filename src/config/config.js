/**
 * 설정 파일 (vLLM + Qdrant)
 * 
 * @module config/config
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ES 모듈에서 __dirname 구하기
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 프로젝트 루트의 .env 파일 로드
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

export const config = {
  // vLLM 설정
  llm: {
    baseUrl: process.env.VLLM_BASE_URL || 'http://localhost:8000',
    model: process.env.VLLM_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
    timeout: parseInt(process.env.VLLM_TIMEOUT) || 180000,
    maxRetries: parseInt(process.env.VLLM_MAX_RETRIES) || 3,
    defaultSystemPrompt: 'You are an expert software developer specializing in Java code analysis.'
  },

  // Qdrant 설정
  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT) || 6333,
    collectionName: process.env.QDRANT_COLLECTION || 'rules',
    vectorDimensions: 1536  // 필요시 조정
  },

  // 경로 설정
  paths: {
    input: {
      guidelines: './input/guidelines',
      issues: './input/issues',
      code: './input/code'
    },
    output: {
      rules: './output/rules',
      reports: './output/reports',
      // 고정 JSON 경로 (sync-rules에서 사용)
      guidelinesJson: './output/rules/guidelines.json',
      issuesJson: './output/rules/issues.json'
    },
    assets: {
      tags: './assets/tags',
      schema: './assets/schema'
    }
  },

  // 로깅 설정
  logging: {
    level: process.env.LOG_LEVEL || 'info'
  }
};

export default config;