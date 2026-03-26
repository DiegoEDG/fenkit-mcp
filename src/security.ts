const DEFAULT_APP_URL = 'https://ickit-fe.vercel.app';
const DEFAULT_API_URL = 'https://ickit-be.vercel.app/api/v1';

const ALLOWED_APP_HOSTS = new Set<string>(['ickit-fe.vercel.app']);
const ALLOWED_API_HOSTS = new Set<string>(['ickit-be.vercel.app']);

const LOCALHOST_HOSTNAMES = new Set<string>(['localhost', '127.0.0.1', '::1']);

export type UrlType = 'app' | 'api';

export interface ValidatedUrl {
	url: string;
	origin: string;
	isLocalDev: boolean;
}

function isLocalhostHost(hostname: string): boolean {
	return LOCALHOST_HOSTNAMES.has(hostname);
}

function isLocalDevEnabled(): boolean {
	return process.env['FENKIT_ALLOW_LOCALHOST_DEV'] === 'true';
}

function normalizeApiUrl(url: URL): URL {
	if (isLocalhostHost(url.hostname) && !url.pathname.startsWith('/api/v1')) {
		const next = new URL(url.toString());
		next.pathname = `/api/v1${url.pathname === '/' ? '' : url.pathname}`;
		return next;
	}
	return url;
}

function getHostAllowlist(type: UrlType): Set<string> {
	return type === 'app' ? ALLOWED_APP_HOSTS : ALLOWED_API_HOSTS;
}

export function validateServiceUrl(input: string, type: UrlType): ValidatedUrl {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`${type}Url must be a valid absolute URL.`);
	}

	if (parsed.username || parsed.password) {
		throw new Error(`${type}Url cannot include credentials in the URL.`);
	}

	const isLocalDev = isLocalhostHost(parsed.hostname);
	if (isLocalDev) {
		if (!isLocalDevEnabled()) {
			throw new Error(
				'Localhost URLs are disabled. Set FENKIT_ALLOW_LOCALHOST_DEV=true to allow local development URLs.',
			);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`${type}Url must use HTTP or HTTPS for localhost development.`);
		}
	} else {
		if (parsed.protocol !== 'https:') {
			throw new Error(`${type}Url must use HTTPS.`);
		}
		const allowlist = getHostAllowlist(type);
		if (!allowlist.has(parsed.hostname)) {
			throw new Error(`${type}Url host is not in the allowlist.`);
		}
	}

	const normalized = type === 'api' ? normalizeApiUrl(parsed) : parsed;

	return {
		url: normalized.toString().replace(/\/$/, ''),
		origin: normalized.origin,
		isLocalDev,
	};
}

export function isAllowedApiOrigin(origin: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	const isLocalDev = isLocalhostHost(parsed.hostname);
	if (isLocalDev) {
		return isLocalDevEnabled();
	}
	if (parsed.protocol !== 'https:') {
		return false;
	}
	return ALLOWED_API_HOSTS.has(parsed.hostname);
}

export function getDefaultAppUrl(): string {
	return DEFAULT_APP_URL;
}

export function getDefaultApiUrl(): string {
	return DEFAULT_API_URL;
}
