/**
 * pi-push — HTTP transport.
 *
 * Every request carries its own `AbortSignal.timeout`. It must never use the
 * agent's `ctx.signal`: on the "interrupted" path that signal is already
 * aborted, so the notification about the cancellation would cancel itself.
 */

import type { ChannelResult } from "./types.ts";

export interface HttpResult {
	ok: boolean;
	status: number;
	body: string;
	error?: string;
	ms: number;
}

export interface HttpRequestInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

const MAX_BODY_ECHO = 300;

export async function httpRequest(
	url: string,
	init: HttpRequestInit,
	timeoutMs: number,
): Promise<HttpResult> {
	const startedAt = Date.now();
	try {
		const response = await fetch(url, {
			method: init.method ?? "POST",
			headers: init.headers,
			body: init.body,
			// Deliberately NOT ctx.signal — see file header.
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			body: text.slice(0, MAX_BODY_ECHO),
			error: response.ok ? undefined : `HTTP ${response.status}`,
			ms: Date.now() - startedAt,
		};
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const message =
			name === "TimeoutError" || name === "AbortError"
				? `timeout after ${timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error);
		return { ok: false, status: 0, body: "", error: message, ms: Date.now() - startedAt };
	}
}

/** A local failure (bad config) shaped like an HttpResult. */
export function localFailure(message: string): HttpResult {
	return { ok: false, status: 0, body: "", error: message, ms: 0 };
}

export function toChannelResult(name: string, result: HttpResult): ChannelResult {
	return {
		channel: name,
		ok: result.ok,
		status: result.status,
		error: result.error,
		ms: result.ms,
	};
}

/**
 * Group-bot endpoints answer HTTP 200 even when they reject the message
 * (missing keyword, bad signature, rate limit). Fold that into `ok`.
 */
export function applyApiStatus(
	result: HttpResult,
	pick: (payload: Record<string, unknown>) => { ok: boolean; message?: string } | undefined,
): HttpResult {
	if (!result.ok || !result.body) return result;
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(result.body) as Record<string, unknown>;
	} catch {
		return result;
	}
	const verdict = pick(payload);
	if (!verdict || verdict.ok) return result;
	return { ...result, ok: false, error: verdict.message ?? "API 返回失败" };
}
