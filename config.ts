/**
 * pi-agent-push — configuration loading.
 *
 * The config is re-read whenever `config.json` changes on disk (mtime + size
 * check), so editing it takes effect on the next notification without
 * `/reload`. A missing file is not an error: the extension simply stays quiet.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelConfig, NotifyConfig } from "./types.ts";

function resolveExtensionDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return join(homedir(), ".pi", "agent", "extensions", "pi-agent-push");
	}
}

export const EXTENSION_DIR = resolveExtensionDir();

export function configPath(): string {
	const override =
		process.env.PI_AGENT_PUSH_CONFIG?.trim() ||
		process.env.PI_PUSH_CONFIG?.trim(); // backward-compatible alias
	return override ? override : join(EXTENSION_DIR, "config.json");
}

export function logPath(): string {
	// Next to the config file, so PI_AGENT_PUSH_CONFIG keeps everything together.
	return join(dirname(configPath()), "push.log");
}

export const KNOWN_TYPES = ["bark", "feishu", "wecom", "dingtalk", "ntfy", "webhook"] as const;
export type KnownChannelType = (typeof KNOWN_TYPES)[number];
/** Whole-value reference: "$BARK_KEY" */
const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
/** Embedded reference: "Bearer ${MY_TOKEN}" */
const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve environment references in string values, recursively. */
function resolveEnv(value: unknown): unknown {
	if (typeof value === "string") {
		const match = ENV_REF.exec(value);
		if (match) return process.env[match[1]] ?? "";
		return value.replace(ENV_INTERPOLATION, (_full, name: string) => process.env[name] ?? "");
	}
	if (Array.isArray(value)) return value.map(resolveEnv);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = resolveEnv(item);
		}
		return out;
	}
	return value;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function strArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const items = value.filter((v): v is string => typeof v === "string" && v.length > 0);
	return items.length > 0 ? items : fallback;
}

export function defaultConfig(path: string): NotifyConfig {
	return {
		enabled: true,
		// Only the interactive TUI by default: pi subagents run `pi --mode json -p`,
		// and pushing for every one of those would be pure noise.
		modes: ["tui"],
		timeoutMs: 5000,
		shutdownTimeoutMs: 2000,
		dedupeMs: 3000,
		minDurationSec: 0,
		maxTextChars: 500,
		titleTemplate: "pi {{status}}",
		template: "pi {{status}} · {{reason}}",
		events: { idle: true, interrupted: true, needInput: true, exit: false },
		// Question-shaped tools block inside their own execute() waiting on the UI,
		// so agent_settled never fires while they wait — they need their own event.
		// ask_user_question: @juicesharp/rpiv-ask-user-question
		// plan_mode_question: @narumitw/pi-plan-mode
		needInputTools: ["ask_user_question", "plan_mode_question"],
		debug: false,
		channels: [],
		warnings: [],
		path,
		exists: false,
	};
}

function normalizeChannels(raw: unknown, warnings: string[]): ChannelConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		warnings.push('"channels" 必须是数组，已忽略');
		return [];
	}
	const channels: ChannelConfig[] = [];
	raw.forEach((item, index) => {
		if (!item || typeof item !== "object") {
			warnings.push(`channels[${index}] 不是对象，已忽略`);
			return;
		}
		const channel = resolveEnv(item) as ChannelConfig;
		if (typeof channel.type !== "string" || !KNOWN_TYPES.includes(channel.type)) {
			warnings.push(
				`channels[${index}] 未知类型 "${String(channel.type)}"，支持：${KNOWN_TYPES.join(", ")}`,
			);
			return;
		}
		channels.push(channel);
	});
	return channels;
}

let cache: { key: string; config: NotifyConfig } | undefined;

/** Load the config, reusing the previous parse while the file is unchanged. */
export function loadConfig(): NotifyConfig {
	const path = configPath();
	if (!existsSync(path)) {
		cache = undefined;
		return defaultConfig(path);
	}

	let key: string;
	try {
		const stat = statSync(path);
		key = `${path}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		key = `${path}:unstatable`;
	}
	if (cache && cache.key === key) return cache.config;

	const config = defaultConfig(path);
	config.exists = true;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch (error) {
		config.enabled = false;
		config.warnings.push(
			`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
		);
		cache = { key, config };
		return config;
	}

	config.enabled = bool(parsed.enabled, config.enabled);
	config.modes = strArray(parsed.modes, config.modes);
	config.timeoutMs = num(parsed.timeoutMs, config.timeoutMs, 200, 60_000);
	config.shutdownTimeoutMs = num(parsed.shutdownTimeoutMs, config.shutdownTimeoutMs, 200, 10_000);
	config.dedupeMs = num(parsed.dedupeMs, config.dedupeMs, 0, 600_000);
	config.minDurationSec = num(parsed.minDurationSec, config.minDurationSec, 0, 86_400);
	config.maxTextChars = num(parsed.maxTextChars, config.maxTextChars, 20, 4000);
	config.titleTemplate = str(parsed.titleTemplate, config.titleTemplate);
	config.template = str(parsed.template, config.template);
	config.needInputTools = strArray(parsed.needInputTools, config.needInputTools);
	config.debug = bool(parsed.debug, config.debug);

	if (parsed.events && typeof parsed.events === "object") {
		const events = parsed.events as Record<string, unknown>;
		config.events = {
			idle: bool(events.idle, config.events.idle),
			interrupted: bool(events.interrupted, config.events.interrupted),
			needInput: bool(events.needInput, config.events.needInput),
			exit: bool(events.exit, config.events.exit),
		};
	}

	config.channels = normalizeChannels(parsed.channels, config.warnings);
	if (config.enabled && config.channels.length === 0) {
		config.warnings.push("没有配置任何推送渠道");
	} else if (config.enabled && config.channels.every((c) => c.enabled === false)) {
		config.warnings.push("所有渠道都是 enabled:false，填好 key 后记得打开");
	}

	cache = { key, config };
	return config;
}

/** Drop the mtime cache — used by `/push` so status output is always fresh. */
export function invalidateConfigCache(): void {
	cache = undefined;
}


/** Sensitive keys — masked in `/push get` output. */
export const SECRET_KEYS = new Set([
	"deviceKey",
	"token",
	"secret",
	"url",
	"Authorization",
	"authorization",
]);

/** Per-type fields users can set via `/push set`. */
export const CHANNEL_SETTABLE_FIELDS: Record<string, string[]> = {
	bark: ["enabled", "name", "deviceKey", "server", "sound", "group", "level", "icon", "clickUrl", "timeoutMs"],
	feishu: ["enabled", "name", "url", "secret", "timeoutMs"],
	wecom: ["enabled", "name", "url", "timeoutMs"],
	dingtalk: ["enabled", "name", "url", "secret", "timeoutMs"],
	ntfy: ["enabled", "name", "topic", "server", "token", "priority", "tags", "clickUrl", "icon", "email", "timeoutMs"],
	webhook: ["enabled", "name", "url", "method", "timeoutMs"],
};

export interface RawConfigFile {
	enabled?: boolean;
	modes?: string[];
	timeoutMs?: number;
	shutdownTimeoutMs?: number;
	dedupeMs?: number;
	minDurationSec?: number;
	maxTextChars?: number;
	debug?: boolean;
	titleTemplate?: string;
	template?: string;
	events?: Record<string, boolean>;
	needInputTools?: string[];
	channels?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

/** Read config.json without env expansion — for in-place edits. */
export function loadRawConfig(): { path: string; exists: boolean; data: RawConfigFile } {
	const path = configPath();
	if (!existsSync(path)) {
		return {
			path,
			exists: false,
			data: {
				enabled: true,
				modes: ["tui"],
				events: { idle: true, interrupted: true, needInput: true, exit: false },
				channels: [],
			},
		};
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as RawConfigFile;
		if (!Array.isArray(data.channels)) data.channels = [];
		return { path, exists: true, data };
	} catch (error) {
		throw new Error(
			`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Atomically-ish write config.json and drop the mtime cache. */
export function saveRawConfig(data: RawConfigFile): string {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const body = `${JSON.stringify(data, null, "\t")}\n`;
	writeFileSync(path, body, "utf-8");
	invalidateConfigCache();
	return path;
}

export function maskSecret(key: string, value: unknown): string {
	if (value == null) return "";
	const text = String(value);
	if (!SECRET_KEYS.has(key) && !/token|secret|key|password|authorization/i.test(key)) {
		return text;
	}
	if (text.length === 0) return "(空)";
	if (text.startsWith("$")) return text; // env ref — safe to show
	if (text.length <= 4) return "****";
	return `${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}

/**
 * Resolve a channel selector to an index in raw.channels.
 * Accepts: type (`ntfy`), name, `type#N` (1-based among that type), or 1-based index.
 */
export function resolveChannelIndex(
	channels: Array<Record<string, unknown>>,
	selector: string,
): number {
	const sel = selector.trim();
	if (!sel) throw new Error("请指定渠道（type / name / type#N / 序号）");

	// pure number → 1-based index
	if (/^\d+$/.test(sel)) {
		const idx = Number(sel) - 1;
		if (idx < 0 || idx >= channels.length) {
			throw new Error(`渠道序号 ${sel} 超出范围 1..${channels.length || 0}`);
		}
		return idx;
	}

	// type#N
	const hash = /^(?<type>[A-Za-z][A-Za-z0-9_-]*)#(?<n>\d+)$/.exec(sel);
	if (hash?.groups) {
		const type = hash.groups.type.toLowerCase();
		const n = Number(hash.groups.n);
		const matches = channels
			.map((c, i) => ({ c, i }))
			.filter(({ c }) => String(c.type ?? "").toLowerCase() === type);
		if (matches.length === 0) throw new Error(`没有 type=${type} 的渠道`);
		if (n < 1 || n > matches.length) {
			throw new Error(`${type} 只有 ${matches.length} 个，无法选 #${n}`);
		}
		return matches[n - 1].i;
	}

	const lower = sel.toLowerCase();

	// exact name (case-insensitive)
	const byName = channels.findIndex(
		(c) => typeof c.name === "string" && c.name.toLowerCase() === lower,
	);
	if (byName >= 0) return byName;

	// unique type
	const byType = channels
		.map((c, i) => ({ c, i }))
		.filter(({ c }) => String(c.type ?? "").toLowerCase() === lower);
	if (byType.length === 1) return byType[0].i;
	if (byType.length > 1) {
		throw new Error(
			`type=${sel} 有 ${byType.length} 个，请用 ${sel}#1 或名称区分`,
		);
	}

	throw new Error(`找不到渠道 "${sel}"（可用 /push list 查看）`);
}

export function formatChannelLabel(channel: Record<string, unknown>, index: number): string {
	const type = String(channel.type ?? "?");
	const name = typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : "";
	const enabled = channel.enabled === false ? "关" : "开";
	const base = name ? `${name} (${type}#${index + 1})` : `${type}#${index + 1}`;
	return `${base} [${enabled}]`;
}
