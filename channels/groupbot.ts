/**
 * pi-push — 飞书 / 企业微信 / 钉钉 group bots.
 *
 * All three send plain text (`msg_type`/`msgtype` = "text"). The two signing
 * schemes differ and are easy to mix up:
 *
 *   飞书:   key = `${timestampSec}\n${secret}`, message = ""            → body fields
 *   钉钉:   key = secret, message = `${timestampMs}\n${secret}`         → query params
 */

import { createHmac } from "node:crypto";
import { applyApiStatus, httpRequest, localFailure, type HttpResult } from "../http.ts";
import type {
	DingtalkChannel,
	FeishuChannel,
	NotifyPayload,
	WecomChannel,
} from "../types.ts";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export function feishuSign(timestampSec: string, secret: string): string {
	return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

export function dingtalkSign(timestampMs: string, secret: string): string {
	return createHmac("sha256", secret).update(`${timestampMs}\n${secret}`).digest("base64");
}

export async function sendFeishu(
	channel: FeishuChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const url = (channel.url ?? "").trim();
	if (!url) return localFailure("feishu: url 为空");

	const body: Record<string, unknown> = {
		msg_type: "text",
		content: { text: payload.text },
	};
	const secret = (channel.secret ?? "").trim();
	if (secret) {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		body.timestamp = timestamp;
		body.sign = feishuSign(timestamp, secret);
	}

	const result = await httpRequest(
		url,
		{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
		timeoutMs,
	);

	return applyApiStatus(result, (data) => {
		const code = typeof data.code === "number" ? data.code : data.StatusCode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		const message = data.msg ?? data.StatusMessage ?? "";
		return { ok: false, message: `feishu code=${code} ${String(message)}`.trim() };
	});
}

export async function sendWecom(
	channel: WecomChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const url = (channel.url ?? "").trim();
	if (!url) return localFailure("wecom: url 为空");

	const result = await httpRequest(
		url,
		{
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ msgtype: "text", text: { content: payload.text } }),
		},
		timeoutMs,
	);

	return applyApiStatus(result, (data) => {
		const code = data.errcode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		return { ok: false, message: `wecom errcode=${code} ${String(data.errmsg ?? "")}`.trim() };
	});
}

export async function sendDingtalk(
	channel: DingtalkChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const rawUrl = (channel.url ?? "").trim();
	if (!rawUrl) return localFailure("dingtalk: url 为空");

	let url = rawUrl;
	const secret = (channel.secret ?? "").trim();
	if (secret) {
		const timestamp = Date.now().toString();
		const sign = dingtalkSign(timestamp, secret);
		const separator = url.includes("?") ? "&" : "?";
		url = `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
	}

	const result = await httpRequest(
		url,
		{
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ msgtype: "text", text: { content: payload.text } }),
		},
		timeoutMs,
	);

	return applyApiStatus(result, (data) => {
		const code = data.errcode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		// errcode 310000 usually means the "keyword" security setting rejected it.
		return {
			ok: false,
			message: `dingtalk errcode=${code} ${String(data.errmsg ?? "")}`.trim(),
		};
	});
}
