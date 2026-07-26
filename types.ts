/**
 * pi-push — shared types.
 *
 * Kept free of runtime imports so the module can be loaded by jiti (pi) and by
 * plain `node` type-stripping (tests) without any dependency resolution.
 */

/** Notification trigger kinds. */
export type NotifyEvent = "idle" | "interrupted" | "needInput" | "exit" | "test";

/** Per-event on/off switches. Missing keys fall back to the global config. */
export interface EventToggles {
	idle?: boolean;
	interrupted?: boolean;
	needInput?: boolean;
	exit?: boolean;
}

export interface BaseChannel {
	type: string;
	/** Display name used in logs and `/push` output. Defaults to `type`. */
	name?: string;
	enabled?: boolean;
	/** Overrides the global `events` switches for this channel only. */
	events?: EventToggles;
	/** Overrides the global `timeoutMs` for this channel only. */
	timeoutMs?: number;
}

export interface BarkChannel extends BaseChannel {
	type: "bark";
	deviceKey: string;
	/** Self-hosted bark-server base URL. Defaults to https://api.day.app */
	server?: string;
	sound?: string;
	group?: string;
	/** critical | active | timeSensitive | passive */
	level?: string;
	icon?: string;
	/** URL opened when the notification is tapped. */
	clickUrl?: string;
}

export interface FeishuChannel extends BaseChannel {
	type: "feishu";
	url: string;
	/** Signing secret (飞书 "签名校验"). Optional. */
	secret?: string;
}

export interface WecomChannel extends BaseChannel {
	type: "wecom";
	url: string;
}

export interface DingtalkChannel extends BaseChannel {
	type: "dingtalk";
	url: string;
	/** Signing secret (钉钉 "加签", starts with SEC). Optional. */
	secret?: string;
}


export interface NtfyChannel extends BaseChannel {
	type: "ntfy";
	/** Topic name (essentially the password on public servers). */
	topic: string;
	/** Self-hosted or public base URL. Defaults to https://ntfy.sh */
	server?: string;
	/** Access token (sent as Authorization: Bearer …). Optional. */
	token?: string;
	/** 1-5 or min|low|default|high|max */
	priority?: string | number;
	/** Comma-separated string or array of tags/emojis. */
	tags?: string | string[];
	/** URL opened when the notification is tapped. */
	clickUrl?: string;
	icon?: string;
	/** Optional email forwarding address (ntfy server feature). */
	email?: string;
}

export interface WebhookChannel extends BaseChannel {
	type: "webhook";
	url: string;
	/** Defaults to POST. */
	method?: string;
	headers?: Record<string, string>;
	/**
	 * Request body.
	 * - object  → placeholders substituted per string value, then JSON.stringify
	 *             (no manual escaping needed — this is the recommended form)
	 * - string  → raw template; values are escaped for `contentType`
	 * - omitted → a default JSON envelope is sent
	 */
	body?: unknown;
	/** Defaults to application/json; charset=utf-8 */
	contentType?: string;
}

export type ChannelConfig =
	| BarkChannel
	| FeishuChannel
	| WecomChannel
	| DingtalkChannel
	| NtfyChannel
	| WebhookChannel;

export interface NotifyConfig {
	enabled: boolean;
	/** pi run modes that may push. Defaults to ["tui"] — see README. */
	modes: string[];
	timeoutMs: number;
	/** Hard cap for the blocking send during session_shutdown. */
	shutdownTimeoutMs: number;
	/** Identical notifications inside this window are dropped. */
	dedupeMs: number;
	/** `idle` pushes are skipped when the run was shorter than this. */
	minDurationSec: number;
	maxTextChars: number;
	titleTemplate: string;
	template: string;
	events: Required<EventToggles>;
	/** Tool names that mean "pi is asking the user something". */
	needInputTools: string[];
	debug: boolean;
	channels: ChannelConfig[];
	/** Populated by the loader; never read from disk. */
	warnings: string[];
	/** Absolute path the config was loaded from (or would be loaded from). */
	path: string;
	/** False when no config file exists yet. */
	exists: boolean;
}

export interface NotifyPayload {
	event: NotifyEvent;
	status: string;
	reason: string;
	title: string;
	text: string;
	vars: Record<string, string>;
}

export interface ChannelResult {
	channel: string;
	ok: boolean;
	status: number;
	error?: string;
	ms: number;
}
