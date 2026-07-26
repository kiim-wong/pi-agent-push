/**
 * pi-agent-push — channel registry.
 *
 * Adding a channel means adding one file and one line here.
 */

import type { HttpResult } from "../http.ts";
import { localFailure } from "../http.ts";
import type {
	BarkChannel,
	ChannelConfig,
	DingtalkChannel,
	FeishuChannel,
	NotifyPayload,
	NtfyChannel,
	WebhookChannel,
	WecomChannel,
} from "../types.ts";
import { sendBark } from "./bark.ts";
import { sendDingtalk, sendFeishu, sendWecom } from "./groupbot.ts";
import { sendNtfy } from "./ntfy.ts";
import { sendWebhook } from "./webhook.ts";

export function channelName(channel: ChannelConfig, index: number): string {
	return channel.name?.trim() || `${channel.type}#${index + 1}`;
}

export function sendToChannel(
	channel: ChannelConfig,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	switch (channel.type) {
		case "bark":
			return sendBark(channel as BarkChannel, payload, timeoutMs);
		case "feishu":
			return sendFeishu(channel as FeishuChannel, payload, timeoutMs);
		case "wecom":
			return sendWecom(channel as WecomChannel, payload, timeoutMs);
		case "dingtalk":
			return sendDingtalk(channel as DingtalkChannel, payload, timeoutMs);
		case "ntfy":
			return sendNtfy(channel as NtfyChannel, payload, timeoutMs);
		case "webhook":
			return sendWebhook(channel as WebhookChannel, payload, timeoutMs);
		default:
			return Promise.resolve(
				localFailure(`未知渠道类型: ${String((channel as ChannelConfig).type)}`),
			);
	}
}
