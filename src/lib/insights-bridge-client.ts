import axios, { type AxiosInstance } from 'axios';

export interface InsightsBridgeClientConfig {
	baseUrl?: string;
}

const DEFAULT_BRIDGE_URL = 'http://localhost:7438';

export class InsightsBridgeClient {
	private readonly http: AxiosInstance;

	constructor(config: InsightsBridgeClientConfig = {}) {
		this.http = axios.create({
			baseURL: config.baseUrl ?? DEFAULT_BRIDGE_URL,
			timeout: 15_000,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	async getHealth(): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/bridge/health');
		return data as Record<string, unknown>;
	}

	async getStatus(): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/bridge/status');
		return data as Record<string, unknown>;
	}

	async init(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { data } = await this.http.post('/bridge/init', input);
		return data as Record<string, unknown>;
	}

	async start(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { data } = await this.http.post('/bridge/start', input);
		return data as Record<string, unknown>;
	}

	async doctor(): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/bridge/doctor');
		return data as Record<string, unknown>;
	}

	async getContext(project: string): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/insights/context', { params: { project } });
		return data as Record<string, unknown>;
	}

	async search(project: string, query: string, limit = 20): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/insights/observations/search', {
			params: { project, q: query, limit }
		});
		return data as Record<string, unknown>;
	}

	async refresh(project: string): Promise<Record<string, unknown>> {
		const { data } = await this.http.post('/insights/refresh', { project });
		return data as Record<string, unknown>;
	}

	async deleteItem(id: string, type: 'observation' | 'prompt'): Promise<Record<string, unknown>> {
		const { data } = await this.http.delete(`/insights/items/${id}`, { params: { type } });
		return data as Record<string, unknown>;
	}

	async getSyncStatus(project: string): Promise<Record<string, unknown>> {
		const { data } = await this.http.get('/insights/sync/status', { params: { project } });
		return data as Record<string, unknown>;
	}

	async isReachable(): Promise<boolean> {
		try {
			await this.http.get('/bridge/health', { timeout: 3_000 });
			return true;
		} catch {
			return false;
		}
	}
}
