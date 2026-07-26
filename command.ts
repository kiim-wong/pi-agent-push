/**
 * pi-agent-push — `/push` subcommand parsing and config mutations.
 */

import {
	CHANNEL_SETTABLE_FIELDS,
	formatChannelLabel,
	invalidateConfigCache,
	KNOWN_TYPES,
	loadConfig,
	loadRawConfig,
	maskSecret,
	resolveChannelIndex,
	saveRawConfig,
	type RawConfigFile,
} from "./config.ts";
import type { ChannelResult, NotifyConfig } from "./types.ts";

export interface CommandResult {
	ok: boolean;
	message: string;
	/** Handler should invoke sendTest. */
	runTest?: boolean;
	/** Optional channel selector to test only one channel. */
	testFilter?: string;
}

function usage(): string {
	return [
		"用法:",
		"  /push                         状态",
		"  /push list                    列出渠道",
		"  /push get <渠道>              查看渠道配置（密钥脱敏）",
		"  /push enable <渠道>           开启渠道并写回 config.json",
		"  /push disable <渠道>          关闭渠道",
		"  /push set <渠道> k=v [k=v…]   设置字段（topic/token/deviceKey/url…）",
		"  /push test [渠道]             测试（可只测一个渠道）",
		"  /push on | off                仅当前会话总开关（不写盘）",
		"  /push events [k=on|off…]      查看/设置全局事件开关",
		"  /push help                    帮助",
		"",
		"渠道选择器: type(ntfy) | name | type#N(ntfy#1) | 序号(1起)",
		"示例:",
		"  /push set ntfy topic=my-topic token=tk_xxx enabled=true",
		"  /push enable ntfy",
		"  /push set bark deviceKey=xxx server=https://api.day.app",
		"  /push disable feishu",
		"  /push test ntfy",
	].join("\n");
}

/** Split args on whitespace; supports simple "quoted values". */
export function tokenize(args: string): string[] {
	const out: string[] = [];
	const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
	for (const m of args.matchAll(re)) {
		let tok = m[0];
		if (
			(tok.startsWith('"') && tok.endsWith('"')) ||
			(tok.startsWith("'") && tok.endsWith("'"))
		) {
			tok = tok.slice(1, -1).replace(/\\([\\'"])/g, "$1");
		}
		out.push(tok);
	}
	return out;
}

function parseBool(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	if (["1", "true", "on", "yes", "开", "启用"].includes(v)) return true;
	if (["0", "false", "off", "no", "关", "禁用"].includes(v)) return false;
	throw new Error(`无法解析布尔值: ${raw}（用 true/false 或 on/off）`);
}

function coerceField(key: string, raw: string): unknown {
	if (key === "enabled") return parseBool(raw);
	if (key === "timeoutMs" || key === "priority") {
		if (/^\d+$/.test(raw)) return Number(raw);
		return raw;
	}
	if (key === "tags") {
		// Keep string form in config (ntfy accepts both); user can pass comma list.
		return raw;
	}
	return raw;
}

function ensureChannels(data: RawConfigFile): Array<Record<string, unknown>> {
	if (!Array.isArray(data.channels)) data.channels = [];
	return data.channels as Array<Record<string, unknown>>;
}

function applyPairs(
	channel: Record<string, unknown>,
	pairs: string[],
): string[] {
	const type = String(channel.type ?? "");
	const allowed = new Set([
		...(CHANNEL_SETTABLE_FIELDS[type] ?? ["enabled", "name", "timeoutMs"]),
		"enabled",
		"name",
		"timeoutMs",
	]);
	const changed: string[] = [];
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) throw new Error(`参数应为 key=value，收到: ${pair}`);
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1);
		if (!key) throw new Error(`参数应为 key=value，收到: ${pair}`);
		if (!allowed.has(key)) {
			const hint = [...allowed].sort().join(", ");
			throw new Error(`渠道 ${type} 不支持字段 "${key}"。可设: ${hint}`);
		}
		channel[key] = coerceField(key, value);
		changed.push(key);
	}
	if (changed.length === 0) throw new Error("请至少提供一个 key=value");
	return changed;
}

function describeChannel(channel: Record<string, unknown>, index: number): string {
	const lines = [formatChannelLabel(channel, index)];
	const type = String(channel.type ?? "");
	const fields = CHANNEL_SETTABLE_FIELDS[type] ?? Object.keys(channel);
	for (const key of fields) {
		if (!(key in channel) && key !== "enabled") continue;
		const value = key === "enabled" ? channel.enabled !== false : channel[key];
		if (value === undefined) continue;
		const shown =
			typeof value === "boolean"
				? value
					? "true"
					: "false"
				: maskSecret(key, value);
		lines.push(`  ${key}=${shown}`);
	}
	return lines.join("\n");
}

function statusText(
	config: NotifyConfig,
	runtimeEnabled: boolean,
	last?: { at: number; event: string; results: ChannelResult[] },
	describeResults?: (r: ChannelResult[]) => string,
): string {
	const lines = [
		`pi-agent-push: ${runtimeEnabled && config.enabled ? "已启用" : "已停用"}${config.exists ? "" : "（无配置文件）"}`,
		`配置: ${config.path}`,
		`渠道: ${
			config.channels.length === 0
				? "(空)"
				: config.channels
						.map((c, i) => {
							const label = c.name?.trim() || `${c.type}#${i + 1}`;
							return `${label}${c.enabled === false ? "(关)" : ""}`;
						})
						.join(", ")
		}`,
		`事件: ${(["idle", "interrupted", "needInput", "exit"] as const)
			.map((k) => `${k}=${config.events[k] ? "on" : "off"}`)
			.join(" ")}`,
		`模式: ${config.modes.join(",")} `,
	];
	if (last && describeResults) {
		lines.push(
			`上次推送: ${new Date(last.at).toTimeString().slice(0, 8)} ${last.event} → ${describeResults(last.results)}`,
		);
	} else {
		lines.push("上次推送: (无)");
	}
	if (config.warnings.length > 0) lines.push(`警告: ${config.warnings.join("; ")}`);
	lines.push("提示: /push help");
	return lines.join("\n");
}

export function handlePushCommand(
	args: string,
	options: {
		runtimeEnabled: boolean;
		setRuntimeEnabled: (v: boolean) => void;
		last?: { at: number; event: string; results: ChannelResult[] };
		describeResults: (r: ChannelResult[]) => string;
	},
): CommandResult {
	const tokens = tokenize(args.trim());
	const action = (tokens[0] ?? "").toLowerCase();

	// bare /push → status
	if (!action) {
		invalidateConfigCache();
		const config = loadConfig();
		return {
			ok: true,
			message: statusText(config, options.runtimeEnabled, options.last, options.describeResults),
		};
	}

	if (action === "help" || action === "-h" || action === "--help") {
		return { ok: true, message: usage() };
	}

	if (action === "on" || action === "off") {
		options.setRuntimeEnabled(action === "on");
		return {
			ok: true,
			message: `pi-agent-push 已${action === "on" ? "开启" : "关闭"}（仅当前会话，不写 config.json）`,
		};
	}

	if (action === "list") {
		const { data } = loadRawConfig();
		const channels = ensureChannels(data);
		if (channels.length === 0) return { ok: true, message: "没有配置任何渠道" };
		const lines = channels.map((c, i) => {
			const type = String(c.type ?? "?");
			const extra =
				type === "ntfy" && c.topic
					? ` topic=${maskSecret("topic", c.topic)}`
					: type === "bark" && c.deviceKey
						? ` deviceKey=${maskSecret("deviceKey", c.deviceKey)}`
						: type === "webhook" && c.url
							? ` url=${maskSecret("url", c.url)}`
							: c.url
								? ` url=${maskSecret("url", c.url)}`
								: "";
			return `${i + 1}. ${formatChannelLabel(c, i)}${extra}`;
		});
		return { ok: true, message: lines.join("\n") };
	}

	if (action === "get") {
		const sel = tokens[1];
		if (!sel) return { ok: false, message: "用法: /push get <渠道>\n" + usage() };
		const { data } = loadRawConfig();
		const channels = ensureChannels(data);
		const idx = resolveChannelIndex(channels, sel);
		return { ok: true, message: describeChannel(channels[idx], idx) };
	}

	if (action === "enable" || action === "disable") {
		const sel = tokens[1];
		if (!sel) {
			return { ok: false, message: `用法: /push ${action} <渠道>\n` + usage() };
		}
		const raw = loadRawConfig();
		const channels = ensureChannels(raw.data);
		const idx = resolveChannelIndex(channels, sel);
		channels[idx].enabled = action === "enable";
		const path = saveRawConfig(raw.data);
		const label = formatChannelLabel(channels[idx], idx);
		return {
			ok: true,
			message: `已${action === "enable" ? "开启" : "关闭"} ${label}\n已写入 ${path}`,
		};
	}

	if (action === "set") {
		const sel = tokens[1];
		const pairs = tokens.slice(2);
		if (!sel || pairs.length === 0) {
			return {
				ok: false,
				message: "用法: /push set <渠道> key=value [key=value…]\n" + usage(),
			};
		}
		const raw = loadRawConfig();
		const channels = ensureChannels(raw.data);
		const idx = resolveChannelIndex(channels, sel);
		const changed = applyPairs(channels[idx], pairs);
		// If user sets credentials but forgets enabled, leave as-is; don't auto-enable
		// unless they pass enabled=true explicitly.
		const path = saveRawConfig(raw.data);
		const label = formatChannelLabel(channels[idx], idx);
		const summary = changed
			.map((k) => `${k}=${maskSecret(k, channels[idx][k])}`)
			.join(" ");
		return {
			ok: true,
			message: `已更新 ${label}\n${summary}\n已写入 ${path}`,
		};
	}

	if (action === "events") {
		const pairs = tokens.slice(1);
		const raw = loadRawConfig();
		if (!raw.data.events || typeof raw.data.events !== "object") {
			raw.data.events = { idle: true, interrupted: true, needInput: true, exit: false };
		}
		const events = raw.data.events as Record<string, boolean>;
		if (pairs.length === 0) {
			const line = ["idle", "interrupted", "needInput", "exit"]
				.map((k) => `${k}=${events[k] ? "on" : "off"}`)
				.join(" ");
			return { ok: true, message: `事件: ${line}` };
		}
		for (const pair of pairs) {
			const eq = pair.indexOf("=");
			if (eq <= 0) throw new Error(`参数应为 event=on|off，收到: ${pair}`);
			const key = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1);
			if (!["idle", "interrupted", "needInput", "exit"].includes(key)) {
				throw new Error(`未知事件 "${key}"（idle|interrupted|needInput|exit）`);
			}
			events[key] = parseBool(value);
		}
		const path = saveRawConfig(raw.data);
		const line = ["idle", "interrupted", "needInput", "exit"]
			.map((k) => `${k}=${events[k] ? "on" : "off"}`)
			.join(" ");
		return { ok: true, message: `事件已更新: ${line}\n已写入 ${path}` };
	}

	if (action === "test") {
		const filter = tokens[1];
		return {
			ok: true,
			message: "",
			runTest: true,
			testFilter: filter || undefined,
		};
	}

	// Unknown action — if it looks like a channel selector with enable-ish words, hint
	if (KNOWN_TYPES.includes(action as (typeof KNOWN_TYPES)[number]) && tokens.length >= 2) {
		return {
			ok: false,
			message: `请使用子命令。试试:\n  /push set ${action} ${tokens.slice(1).join(" ")}\n  /push enable ${action}\n\n` + usage(),
		};
	}

	return { ok: false, message: `未知子命令 "${action}"\n` + usage() };
}

/**
 * After `/push set`/`enable`, optionally restrict test to one raw channel index
 * by temporarily flipping other channels' enabled flag in the *loaded* config
 * object (not written to disk).
 */
export function filterConfigToChannel(
	config: NotifyConfig,
	selector: string,
): NotifyConfig {
	const raw = loadRawConfig();
	const channels = ensureChannels(raw.data);
	const idx = resolveChannelIndex(channels, selector);
	if (config.channels.length !== channels.length) {
		// Fall back: enable by type/name match only.
		const target = channels[idx];
		const type = String(target.type ?? "");
		const name = typeof target.name === "string" ? target.name : undefined;
		return {
			...config,
			channels: config.channels.map((ch) => ({
				...ch,
				enabled:
					(name && ch.name === name) ||
					(!name && ch.type === type)
						? true
						: false,
			})),
		};
	}
	return {
		...config,
		channels: config.channels.map((ch, i) => ({
			...ch,
			enabled: i === idx,
		})),
	};
}
