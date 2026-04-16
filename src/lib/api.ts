import axios, { AxiosInstance, AxiosError } from 'axios';
import { loadConfig, loadConfigAsync } from './config.js';
import { getActiveApiUrl, isAllowedApiOrigin, validateServiceUrl } from './security.js';
import { createLogger } from './logger.js';

let client: AxiosInstance | null = null;
const logger = createLogger('api');

export function createApiClient(options: { apiUrl: string; token: string }): AxiosInstance {
  const validatedApi = validateServiceUrl(options.apiUrl, 'api');

  const nextClient = axios.create({
    baseURL: validatedApi.url,
    headers: {
      Authorization: `ApiKey ${options.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  const FORBIDDEN_METADATA_KEYS = [
    'implementationMetadata',
    'executionMetadata',
    'execution_metadata',
    'lastExecution',
    'history',
  ];

  function sanitizeObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(sanitizeObject);
    }
    if (obj !== null && typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (!FORBIDDEN_METADATA_KEYS.includes(key)) {
          sanitized[key] = sanitizeObject(value);
        }
      }
      return sanitized;
    }
    return obj;
  }

  nextClient.interceptors.request.use((requestConfig) => {
    const baseUrl = requestConfig.baseURL ?? validatedApi.url;
    const requestUrl = requestConfig.url ?? '/';
    const absoluteUrl = new URL(requestUrl, baseUrl);

    if (!isAllowedApiOrigin(absoluteUrl.origin)) {
      throw new Error(
        `Blocked request to non-allowed API origin: ${absoluteUrl.origin}`,
      );
    }

    // Sanitize data (body)
    if (requestConfig.data) {
      requestConfig.data = sanitizeObject(requestConfig.data);
    }

    // Sanitize params (query string)
    if (requestConfig.params) {
      requestConfig.params = sanitizeObject(requestConfig.params);
    }

    logger.debug('Axios interceptor request', {
      method: requestConfig.method,
      url: requestConfig.url,
      hasData: Boolean(requestConfig.data),
      hasParams: Boolean(requestConfig.params),
    });
    if (requestConfig.data) logger.debug('Axios interceptor data', requestConfig.data);
    if (requestConfig.params) logger.debug('Axios interceptor params', requestConfig.params);

    return requestConfig;
  });

  return nextClient;
}

/**
 * Get or create the shared API client.
 * Prefer getApiClientAsync() in hot paths to avoid blocking.
 */
export function getApiClient(force = false): AxiosInstance {
  if (client && !force) return client;

  const config = loadConfig();
  client = createApiClient({ apiUrl: getActiveApiUrl(), token: config.token });

  return client;
}

/**
 * Async version of getApiClient.
 * Uses non-blocking config loading to avoid stalling event loop.
 */
export async function getApiClientAsync(force = false): Promise<AxiosInstance> {
  if (client && !force) return client;

  const config = await loadConfigAsync();
  client = createApiClient({ apiUrl: getActiveApiUrl(), token: config.token });

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
