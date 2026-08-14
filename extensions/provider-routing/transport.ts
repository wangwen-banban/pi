import { realpathSync } from "node:fs";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface FetchRoute {
	/** Route through this explicit HTTP(S) proxy. */
	proxyUrl?: string;
	/** Set to false only for endpoints whose private certificate is intentionally trusted. */
	rejectUnauthorized?: boolean;
}

interface CloseableDispatcher {
	close(): Promise<void>;
}

interface UndiciModule {
	Agent: new (options?: unknown) => CloseableDispatcher;
	ProxyAgent: new (url: string) => CloseableDispatcher;
	fetch: typeof globalThis.fetch;
}

export interface RoutedHttpTransportOptions {
	/** Dependency-injection seam used by the portability test. Errors are treated as an unavailable optional module. */
	loadUndici?: () => unknown;
}

export interface RoutedHttpTransport {
	readonly backend: "undici" | "node";
	fetch(input: RequestInfo | URL, init?: RequestInit, route?: FetchRoute): Promise<Response>;
	close(): Promise<void>;
}

/**
 * Resolve undici only as an optional optimization. In normal pi CLI runs,
 * process.argv[1] resolves through the npm bin symlink to pi's real entrypoint,
 * so a package-local direct dependency can be found without hard-coding an
 * installation path. A missing, bundled, or non-exported dependency simply
 * selects the Node-core transport below.
 */
function loadRuntimeUndici(): unknown {
	const anchors: Array<string | URL> = [import.meta.url];
	if (process.argv[1]) {
		try {
			anchors.push(realpathSync(process.argv[1]));
		} catch {
			anchors.push(process.argv[1]);
		}
	}

	const seen = new Set<string>();
	for (const anchor of anchors) {
		const key = String(anchor);
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			return createRequire(anchor)("undici");
		} catch {
			// Optional dependency: keep trying, then use Node core.
		}
	}
	return undefined;
}

function asUndiciModule(value: unknown): UndiciModule | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<UndiciModule>;
	if (
		typeof candidate.Agent !== "function" ||
		typeof candidate.ProxyAgent !== "function" ||
		typeof candidate.fetch !== "function"
	) {
		return undefined;
	}
	return candidate as UndiciModule;
}

function createUndiciTransport(undici: UndiciModule): RoutedHttpTransport {
	const dispatchers = new Set<CloseableDispatcher>();
	const proxies = new Map<string, CloseableDispatcher>();
	const direct = new undici.Agent();
	const insecure = new undici.Agent({ connect: { rejectUnauthorized: false } });
	dispatchers.add(direct);
	dispatchers.add(insecure);
	let closed = false;

	function dispatcherFor(route: FetchRoute): CloseableDispatcher {
		if (route.proxyUrl) {
			let dispatcher = proxies.get(route.proxyUrl);
			if (!dispatcher) {
				dispatcher = new undici.ProxyAgent(route.proxyUrl);
				proxies.set(route.proxyUrl, dispatcher);
				dispatchers.add(dispatcher);
			}
			return dispatcher;
		}
		return route.rejectUnauthorized === false ? insecure : direct;
	}

	return {
		backend: "undici",
		fetch(input, init = {}, route = {}) {
			if (closed) return Promise.reject(new TypeError("provider-routing transport is closed"));
			return undici.fetch(input, {
				...init,
				dispatcher: dispatcherFor(route),
			} as RequestInit & { dispatcher: CloseableDispatcher });
		},
		async close() {
			if (closed) return;
			closed = true;
			await Promise.all(Array.from(dispatchers, (dispatcher) => dispatcher.close()));
		},
	};
}

interface PreparedRequest {
	url: URL;
	method: string;
	headers: Headers;
	body?: Buffer;
	signal?: AbortSignal | null;
	redirect: RequestRedirect;
	redirectCount: number;
	redirected: boolean;
}

interface NativeState {
	closed: boolean;
	readonly directHttpAgent: http.Agent;
	readonly directHttpsAgent: https.Agent;
	readonly insecureHttpsAgent: https.Agent;
	readonly proxyHttpAgent: http.Agent;
	readonly proxyHttpsAgent: https.Agent;
	readonly transientAgents: Set<https.Agent>;
	readonly requests: Set<ClientRequest>;
	readonly sockets: Set<TLSSocket>;
}

function abortError(signal?: AbortSignal | null): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("This operation was aborted", "AbortError");
}

function fetchError(error: unknown): Error {
	if (error instanceof Error && error.name === "AbortError") return error;
	if (error instanceof TypeError && error.message.startsWith("fetch failed")) return error;
	const cause = error instanceof Error ? error : new Error(String(error));
	const code = "code" in cause && typeof cause.code === "string" ? `${cause.code}: ` : "";
	return new TypeError(`fetch failed: ${code}${cause.message}`, { cause });
}

function proxyAuthorization(proxy: URL): string | undefined {
	if (!proxy.username && !proxy.password) return undefined;
	let username: string;
	let password: string;
	try {
		username = decodeURIComponent(proxy.username);
		password = decodeURIComponent(proxy.password);
	} catch {
		username = proxy.username;
		password = proxy.password;
	}
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function proxyProtocol(proxy: URL): "http:" | "https:" {
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
		throw new TypeError(`Unsupported proxy protocol: ${proxy.protocol}`);
	}
	return proxy.protocol;
}

function targetAuthority(target: URL): string {
	const hostname = target.hostname.includes(":") && !target.hostname.startsWith("[")
		? `[${target.hostname}]`
		: target.hostname;
	return `${hostname}:${target.port || "443"}`;
}

function trackRequest(state: NativeState, request: ClientRequest): ClientRequest {
	state.requests.add(request);
	request.once("close", () => state.requests.delete(request));
	return request;
}

function connectThroughProxy(
	state: NativeState,
	target: URL,
	proxy: URL,
	rejectUnauthorized: boolean,
	signal?: AbortSignal | null,
): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		if (state.closed) {
			reject(new TypeError("provider-routing transport is closed"));
			return;
		}
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}

		const protocol = proxyProtocol(proxy);
		const headers: Record<string, string> = { Host: targetAuthority(target) };
		const authorization = proxyAuthorization(proxy);
		if (authorization) headers["Proxy-Authorization"] = authorization;

		const requestFn = protocol === "https:" ? https.request : http.request;
		const request = trackRequest(state, requestFn({
			protocol,
			hostname: proxy.hostname,
			port: proxy.port || (protocol === "https:" ? 443 : 80),
			method: "CONNECT",
			path: targetAuthority(target),
			headers,
			agent: false,
			signal: signal ?? undefined,
		}));

		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		request.once("error", fail);
		request.once("response", (response) => {
			response.resume();
			fail(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? "unknown"}`));
		});
		request.once("connect", (response, socket, head) => {
			if (settled) {
				socket.destroy();
				return;
			}
			if (response.statusCode !== 200) {
				socket.destroy();
				fail(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? "unknown"}`));
				return;
			}
			if (head.length > 0) socket.unshift(head);

			const secureSocket = tls.connect({
				socket,
				servername: isIP(target.hostname.replace(/^\[|\]$/g, "")) ? undefined : target.hostname,
				rejectUnauthorized,
			});
			state.sockets.add(secureSocket);
			secureSocket.once("close", () => state.sockets.delete(secureSocket));
			secureSocket.once("error", fail);
			secureSocket.once("secureConnect", () => {
				if (settled) return;
				settled = true;
				resolve(secureSocket);
			});
		});
		request.end();
	});
}

function responseHeaders(message: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.append(name, String(value));
		}
	}
	return headers;
}

function decodedBody(message: IncomingMessage, headers: Headers): Readable {
	const encoding = headers.get("content-encoding")?.trim().toLowerCase();
	let decoder: Readable | undefined;
	if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
	else if (encoding === "deflate") decoder = createInflate();
	else if (encoding === "br") decoder = createBrotliDecompress();
	if (!decoder) return message;
	headers.delete("content-encoding");
	headers.delete("content-length");
	message.pipe(decoder);
	return decoder;
}

function hasResponseBody(method: string, status: number): boolean {
	return method !== "HEAD" && status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function makeResponse(
	message: IncomingMessage,
	request: PreparedRequest,
): Response {
	const status = message.statusCode ?? 500;
	const headers = responseHeaders(message);
	let body: ReadableStream<Uint8Array> | null = null;
	if (hasResponseBody(request.method, status)) {
		body = Readable.toWeb(decodedBody(message, headers)) as ReadableStream<Uint8Array>;
	} else {
		message.resume();
	}
	const response = new Response(body, {
		status,
		statusText: message.statusMessage,
		headers,
	});
	// Response constructed from a stream has no network URL metadata. The SDKs
	// occasionally inspect these fields while formatting HTTP errors.
	try {
		Object.defineProperties(response, {
			url: { configurable: true, value: request.url.href },
			redirected: { configurable: true, value: request.redirected },
		});
	} catch {
		// Metadata is best-effort; body/status/header semantics remain intact.
	}
	return response;
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function drain(message: IncomingMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		message.once("end", resolve);
		message.once("error", reject);
		message.resume();
	});
}

function redirectedRequest(request: PreparedRequest, status: number, location: string): PreparedRequest {
	if (request.redirectCount >= 20) throw new TypeError("fetch failed: redirect count exceeded");
	const url = new URL(location, request.url);
	const headers = new Headers(request.headers);
	let method = request.method;
	let body = request.body;
	if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
		method = "GET";
		body = undefined;
		headers.delete("content-length");
		headers.delete("content-type");
		headers.delete("transfer-encoding");
	}
	if (url.origin !== request.url.origin) {
		headers.delete("authorization");
		headers.delete("cookie");
		headers.delete("proxy-authorization");
	}
	return {
		...request,
		url,
		method,
		headers,
		body,
		redirectCount: request.redirectCount + 1,
		redirected: true,
	};
}

function requestPath(url: URL): string {
	return `${url.pathname || "/"}${url.search}`;
}

function cleanAbsoluteUrl(url: URL): string {
	const clean = new URL(url);
	clean.username = "";
	clean.password = "";
	return clean.href;
}

function requestOptions(
	state: NativeState,
	request: PreparedRequest,
	route: FetchRoute,
): {
	requestFn: typeof http.request | typeof https.request;
	options: http.RequestOptions | https.RequestOptions;
	transientAgent?: https.Agent;
} {
	const target = request.url;
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new TypeError(`Unsupported URL protocol: ${target.protocol}`);
	}
	const headers = Object.fromEntries(request.headers.entries());
	const rejectUnauthorized = route.rejectUnauthorized !== false;

	if (!route.proxyUrl) {
		if (target.protocol === "https:") {
			return {
				requestFn: https.request,
				options: {
					hostname: target.hostname,
					port: target.port || 443,
					path: requestPath(target),
					method: request.method,
					headers,
					agent: rejectUnauthorized ? state.directHttpsAgent : state.insecureHttpsAgent,
					signal: request.signal ?? undefined,
				},
			};
		}
		return {
			requestFn: http.request,
			options: {
				hostname: target.hostname,
				port: target.port || 80,
				path: requestPath(target),
				method: request.method,
				headers,
				agent: state.directHttpAgent,
				signal: request.signal ?? undefined,
			},
		};
	}

	const proxy = new URL(route.proxyUrl);
	const protocol = proxyProtocol(proxy);
	if (target.protocol === "http:") {
		headers.host = target.host;
		const authorization = proxyAuthorization(proxy);
		if (authorization) headers["proxy-authorization"] = authorization;
		return {
			requestFn: protocol === "https:" ? https.request : http.request,
			options: {
				protocol,
				hostname: proxy.hostname,
				port: proxy.port || (protocol === "https:" ? 443 : 80),
				path: cleanAbsoluteUrl(target),
				method: request.method,
				headers,
				agent: protocol === "https:" ? state.proxyHttpsAgent : state.proxyHttpAgent,
				signal: request.signal ?? undefined,
			},
		};
	}

	const transientAgent = new https.Agent({ keepAlive: false });
	transientAgent.createConnection = (_options, callback) => {
		void connectThroughProxy(state, target, proxy, rejectUnauthorized, request.signal).then(
			(socket) => callback(null, socket),
			(error) => callback(error as Error),
		);
		return undefined as unknown as TLSSocket;
	};
	state.transientAgents.add(transientAgent);
	return {
		requestFn: https.request,
		options: {
			hostname: target.hostname,
			port: target.port || 443,
			path: requestPath(target),
			method: request.method,
			headers,
			agent: transientAgent,
			signal: request.signal ?? undefined,
		},
		transientAgent,
	};
}

function performNativeRequest(
	state: NativeState,
	request: PreparedRequest,
	route: FetchRoute,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		if (state.closed) {
			reject(new TypeError("provider-routing transport is closed"));
			return;
		}
		if (request.signal?.aborted) {
			reject(abortError(request.signal));
			return;
		}

		let setup: ReturnType<typeof requestOptions>;
		try {
			setup = requestOptions(state, request, route);
		} catch (error) {
			reject(fetchError(error));
			return;
		}

		let settled = false;
		const clientRequest = trackRequest(state, setup.requestFn(setup.options, (message) => {
			const status = message.statusCode ?? 0;
			const location = message.headers.location;
			if (location && isRedirect(status)) {
				if (request.redirect === "error") {
					message.resume();
					settled = true;
					reject(new TypeError("fetch failed: redirect mode is set to error"));
					return;
				}
				if (request.redirect !== "manual") {
					let next: PreparedRequest;
					try {
						next = redirectedRequest(request, status, location);
					} catch (error) {
						message.resume();
						settled = true;
						reject(fetchError(error));
						return;
					}
					settled = true;
					void drain(message)
						.then(() => performNativeRequest(state, next, route))
						.then(resolve, (error) => reject(fetchError(error)));
					return;
				}
			}
			settled = true;
			resolve(makeResponse(message, request));
		}));
		if (setup.transientAgent) {
			clientRequest.once("close", () => {
				setup.transientAgent?.destroy();
				state.transientAgents.delete(setup.transientAgent!);
			});
		}
		clientRequest.once("error", (error) => {
			if (!settled) {
				settled = true;
				reject(fetchError(error));
			}
		});
		clientRequest.end(request.body);
	});
}

async function bodyBuffer(body: BodyInit | null | undefined, headers: Headers): Promise<Buffer | undefined> {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof URLSearchParams) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
		}
		return Buffer.from(body.toString());
	}
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
		return Buffer.from(await body.arrayBuffer());
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const encoded = new Response(body);
		if (!headers.has("content-type")) {
			const contentType = encoded.headers.get("content-type");
			if (contentType) headers.set("content-type", contentType);
		}
		return Buffer.from(await encoded.arrayBuffer());
	}
	if (body instanceof ReadableStream || Symbol.asyncIterator in Object(body)) {
		const chunks: Buffer[] = [];
		for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}
	throw new TypeError(`Unsupported request body: ${Object.prototype.toString.call(body)}`);
}

async function prepareRequest(input: RequestInfo | URL, init: RequestInit = {}): Promise<PreparedRequest> {
	const inputRequest = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
	const url = new URL(inputRequest ? inputRequest.url : input instanceof URL ? input.href : String(input));
	const method = (init.method ?? inputRequest?.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers ?? inputRequest?.headers);
	const signal = init.signal ?? inputRequest?.signal;
	let sourceBody = init.body;
	if (sourceBody === undefined && inputRequest && method !== "GET" && method !== "HEAD") {
		sourceBody = await inputRequest.arrayBuffer();
	}
	const body = await bodyBuffer(sourceBody, headers);
	if ((method === "GET" || method === "HEAD") && body !== undefined) {
		throw new TypeError("Request with GET/HEAD method cannot have body");
	}
	if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
		headers.set("content-length", String(body.byteLength));
	}
	if (!headers.has("accept")) headers.set("accept", "*/*");
	if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
	return {
		url,
		method,
		headers,
		body,
		signal,
		redirect: init.redirect ?? inputRequest?.redirect ?? "follow",
		redirectCount: 0,
		redirected: false,
	};
}

function createNativeTransport(): RoutedHttpTransport {
	const state: NativeState = {
		closed: false,
		directHttpAgent: new http.Agent({ keepAlive: true }),
		directHttpsAgent: new https.Agent({ keepAlive: true }),
		insecureHttpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
		proxyHttpAgent: new http.Agent({ keepAlive: true }),
		proxyHttpsAgent: new https.Agent({ keepAlive: true }),
		transientAgents: new Set(),
		requests: new Set(),
		sockets: new Set(),
	};

	return {
		backend: "node",
		async fetch(input, init = {}, route = {}) {
			if (state.closed) throw new TypeError("provider-routing transport is closed");
			try {
				return await performNativeRequest(state, await prepareRequest(input, init), route);
			} catch (error) {
				throw fetchError(error);
			}
		},
		async close() {
			if (state.closed) return;
			state.closed = true;
			const error = new Error("provider-routing transport closed");
			for (const request of state.requests) request.destroy(error);
			for (const socket of state.sockets) socket.destroy(error);
			for (const agent of state.transientAgents) agent.destroy();
			state.directHttpAgent.destroy();
			state.directHttpsAgent.destroy();
			state.insecureHttpsAgent.destroy();
			state.proxyHttpAgent.destroy();
			state.proxyHttpsAgent.destroy();
		},
	};
}

export function createRoutedHttpTransport(options: RoutedHttpTransportOptions = {}): RoutedHttpTransport {
	let loaded: unknown;
	try {
		loaded = options.loadUndici ? options.loadUndici() : loadRuntimeUndici();
	} catch {
		loaded = undefined;
	}
	const undici = asUndiciModule(loaded);
	if (undici) {
		try {
			return createUndiciTransport(undici);
		} catch {
			// An incompatible optional undici must not prevent extension loading.
		}
	}
	return createNativeTransport();
}
