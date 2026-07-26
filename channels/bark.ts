/**
 * pi-agent-push — Bark (iOS) channel.
 *
 * Uses the `POST /:device_key` route with a JSON body, which bark-server
 * supports in both V1 and V2 (V2 registers it as a compatibility route), so
 * self-hosted servers keep working.
 */

import { applyApiStatus, httpRequest, localFailure, type HttpResult } from "../http.ts";
import type { BarkChannel, NotifyPayload } from "../types.ts";

const DEFAULT_SERVER = "https://api.day.app";

export async function sendBark(
	channel: BarkChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const deviceKey = (channel.deviceKey ?? "").trim();
	if (!deviceKey) return localFailure("bark: deviceKey 为空");

	const server = (channel.server ?? DEFAULT_SERVER).trim().replace(/\/+$/, "");
	const body: Record<string, unknown> = { title: payload.title, body: payload.text };
	if (channel.group) body.group = channel.group;
	if (channel.sound) body.sound = channel.sound;
	if (channel.level) body.level = channel.level;
	if (channel.icon) body.icon = channel.icon;
	if (channel.clickUrl) body.url = channel.clickUrl;

	const result = await httpRequest(
		`${server}/${encodeURIComponent(deviceKey)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		},
		timeoutMs,
	);

	return applyApiStatus(result, (data) => {
		const code = data.code;
		if (typeof code !== "number" || code === 200) return { ok: true };
		return { ok: false, message: `bark code=${code} ${String(data.message ?? "")}`.trim() };
	});
}
