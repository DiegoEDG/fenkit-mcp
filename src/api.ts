import axios, { AxiosInstance, AxiosError } from 'axios';
import { loadConfig } from './config.js';

let client: AxiosInstance | null = null;

export function getApiClient(force = false): AxiosInstance {
  if (client && !force) return client;

  const config = loadConfig();

  let { apiUrl } = config;
  if (
    (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1')) &&
    !apiUrl.includes('/api/v1')
  ) {
    apiUrl = apiUrl.replace(/\/$/, '') + '/api/v1';
  }

  client = axios.create({
    baseURL: apiUrl,
    headers: {
      Authorization: `ApiKey ${config.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  return client;
}

export interface ApiErrorResult {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function formatApiError(error: unknown): ApiErrorResult {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const message =
        (error.response.data as Record<string, string>)?.message ||
        error.message;

      if (status === 401) {
        return {
          code: 'NOT_AUTHENTICATED',
          message: 'Authentication failed. Check your token or run `login`.',
        };
      }
      if (status === 404) {
        return {
          code: 'TASK_NOT_FOUND',
          message: `Not found: ${message}`,
        };
      }
      return {
        code: 'API_ERROR',
        message: `API Error (${status}): ${message}`,
      };
    }
    if (error.code === 'ECONNREFUSED') {
      return {
        code: 'API_ERROR',
        message: 'Cannot connect to the API server. Is it running?',
      };
    }
    return {
      code: 'API_ERROR',
      message: `Network error: ${error.message}`,
    };
  }

  if (error instanceof Error) {
    // Handle our custom auth/project errors
    if (error.message.startsWith('NOT_AUTHENTICATED:')) {
      return { code: 'NOT_AUTHENTICATED', message: error.message };
    }
    if (error.message.startsWith('NO_ACTIVE_PROJECT:')) {
      return { code: 'NO_ACTIVE_PROJECT', message: error.message };
    }
    return { code: 'INTERNAL_ERROR', message: error.message };
  }

  return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
}
