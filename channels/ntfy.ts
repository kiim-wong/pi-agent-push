/**
 * pi-agent-push — ntfy channel (https://ntfy.sh / self-hosted).
 *
 * Body is plain text only (`message` / payload.text). No JSON envelope.
 * Optional priority / tags / click / icon go as HTTP headers so they do not
 * pollute the notification body.
 */

import { httpRequest, localFailure, type HttpResult } from "../http.ts";
import type { NotifyPayload, NtfyChannel } from "../types.ts";

const DEFAULT_SERVER = "https://ntfy.sh";

export async function sendNtfy(
	channel: NtfyChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const topic = (channel.topic ?? "").trim();
	if (!topic) return localFailure("ntfy: topic 为空");

	const server = (channel.server ?? DEFAULT_SERVER).trim().replace(/\/+$/, "");
	const headers: Record<string, string> = {
		"Content-Type": "text/plain; charset=utf-8",
	};

	const token = (channel.token ?? "").trim();
	if (token) {
		headers.Authorization = token.toLowerCase().startsWith("bearer ")
			? token
			: `Bearer ${token}`;
	}

	// Metadata via headers only — body stays pure message text.
	if (channel.priority != null && channel.priority !== "") {
		headers.Priority = String(channel.priority);
	}
	if (channel.tags != null) {
		const tags = Array.isArray(channel.tags)
			? channel.tags.join(",")
			: String(channel.tags);
		if (tags.trim()) headers.Tags = tags;
	}
	if (channel.clickUrl) headers.Click = channel.clickUrl;
	if (channel.icon) headers.Icon = channel.icon;
	if (channel.email) headers.Email = channel.email;

	const url = `${server}/${encodeURIComponent(topic)}`;
	const body = payload.text;

	const result = await httpRequest(
		url,
		{ method: "POST", headers, body },
		timeoutMs,
	);

	if (!result.ok) {
		let detail = result.error ?? `HTTP ${result.status}`;
		if (result.body) {
			try {
				const data = JSON.parse(result.body) as { error?: string; message?: string };
				detail = data.error || data.message || detail;
			} catch {
				detail = result.body.slice(0, 200) || detail;
			}
		}
		return { ...result, error: `ntfy ${detail}` };
	}
	return result;
}
