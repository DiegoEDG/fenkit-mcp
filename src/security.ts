const PROD_APP_URL = 'https://ickit-fe.vercel.app';
const PROD_API_URL = 'https://ickit-be.vercel.app/api/v1';

const LOCAL_APP_URL = 'http://localhost:5173';
const LOCAL_API_URL = 'http://localhost:3000/api/v1';

const LOCALHOST_HOSTNAMES = new Set<string>(['localhost', '127.0.0.1', '::1']);

export type UrlType = 'app' | 'api';

export function isLocalDevEnabled(): boolean {
	return process.env['FENKIT_LOCAL'] === 'true';
}

function isLocalhostHost(hostname: string): boolean {
	return LOCALHOST_HOSTNAMES.has(hostname);
}

export function getActiveAppUrl(): string {
	return isLocalDevEnabled() ? LOCAL_APP_URL : PROD_APP_URL;
}

export function getActiveApiUrl(): string {
	return isLocalDevEnabled() ? LOCAL_API_URL : PROD_API_URL;
}

export function validateServiceUrl(input: string, type: UrlType): { url: string; origin: string } {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`${type}Url must be a valid absolute URL.`);
	}

	const activeUrl = type === 'app' ? getActiveAppUrl() : getActiveApiUrl();
	const activeParsed = new URL(activeUrl);

	// In the new world, we only allow the exactly "active" origin
	if (parsed.origin !== activeParsed.origin) {
		throw new Error(`${type}Url origin mismatch. Expected ${activeParsed.origin} but got ${parsed.origin}.`);
	}

	return {
		url: parsed.toString().replace(/\/$/, ''),
		origin: parsed.origin,
	};
}

export function isAllowedApiOrigin(origin: string): boolean {
	const activeApiUrl = getActiveApiUrl();
	const activeOrigin = new URL(activeApiUrl).origin;
	return origin === activeOrigin;
}

export function getDefaultAppUrl(): string {
	return getActiveAppUrl();
}

export function getDefaultApiUrl(): string {
	return getActiveApiUrl();
}
