/**
 * pi-agent-push — push pi's state changes to your phone / group chat.
 *
 * Event wiring (see DESIGN.md for the reasoning):
 *
 *   agent_start      → remember when the run started
 *   agent_end        → remember the terminal stopReason of this low-level run
 *                      (may be replaced by an auto-retry / auto-compaction run)
 *   agent_settled    → THE single send point: pi will not continue by itself
 *   tool_call        → pi is asking the user something (ask_user_question, …)
 *   session_shutdown → the session is going away (reason "quit" only)
 *
 * `agent_settled` is emitted from a `finally` block in pi's agent session, so
 * it fires for normal completion, for Esc-aborts and for errors alike, and
 * only after retries/compaction are done — which is exactly one notification
 * per user-visible "pi stopped doing things".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invalidateConfigCache, loadConfig } from "./config.ts";
import { filterConfigToChannel, handlePushCommand } from "./command.ts";
import { createNotifier, type PayloadInput } from "./notifier.ts";
import { summarizeError } from "./render.ts";
import type { ChannelResult, NotifyConfig } from "./types.ts";

interface RunState {
	startedAt: number;
	stopReason?: string;
	errorMessage?: string;
}

const ERROR_REASON_CHARS = 120;

function describeResults(results: ChannelResult[]): string {
	if (results.length === 0) return "没有匹配的渠道";
	return results
		.map((r) =>
			r.ok
				? `${r.channel} ok(${r.status}, ${r.ms}ms)`
				: `${r.channel} 失败(${r.error ?? "unknown"})`,
		)
		.join("; ");
}


export default function piNotify(pi: ExtensionAPI) {
	const notifier = createNotifier();
	let run: RunState | undefined;
	let runtimeEnabled = true;

	/** Config for the current context, or undefined when this run must stay quiet. */
	function activeConfig(mode: string): NotifyConfig | undefined {
		if (!runtimeEnabled) return undefined;
		const config = loadConfig();
		if (!config.enabled || !config.exists) return undefined;
		// Subagents run `pi --mode json -p`; pushing for each of those is noise.
		if (!config.modes.includes(mode)) return undefined;
		return config;
	}

	function baseInput(ctx: {
		cwd: string;
		sessionManager: { getSessionName(): string | undefined; getSessionFile(): string | undefined };
		model: { id: string; provider: string } | undefined;
	}): Pick<PayloadInput, "cwd" | "session" | "model"> {
		const file = ctx.sessionManager.getSessionFile();
		const session =
			ctx.sessionManager.getSessionName() ??
			(file ? file.split("/").pop()?.replace(/\.jsonl?$/, "") : undefined);
		return {
			cwd: ctx.cwd,
			session: session ?? "",
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
		};
	}

	pi.on("session_start", async () => {
		run = undefined;
		invalidateConfigCache();
	});

	pi.on("agent_start", async () => {
		run = { startedAt: Date.now() };
	});

	pi.on("agent_end", async (event) => {
		if (!run) run = { startedAt: Date.now() };
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role !== "assistant") continue;
			const assistant = message as { stopReason?: string; errorMessage?: string };
			run.stopReason = assistant.stopReason;
			run.errorMessage = assistant.errorMessage;
			return;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const state = run;
		run = undefined;

		const config = activeConfig(ctx.mode);
		if (!config) return;

		const durationMs = state ? Date.now() - state.startedAt : undefined;
		const stopReason = state?.stopReason;

		if (stopReason === "aborted" || stopReason === "error") {
			const reason =
				stopReason === "aborted"
					? "本轮被取消"
					: `运行出错：${summarizeError(state?.errorMessage, ERROR_REASON_CHARS) || "未知错误"}`;
			notifier.fire(config, {
				event: "interrupted",
				status: "已中断",
				reason,
				durationMs,
				...baseInput(ctx),
			});
			return;
		}

		// Short runs are usually the user still sitting at the keyboard.
		if (durationMs !== undefined && durationMs < config.minDurationSec * 1000) return;

		notifier.fire(config, {
			event: "idle",
			status: "已就绪",
			reason: "输出结束，等待输入",
			durationMs,
			...baseInput(ctx),
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		const config = activeConfig(ctx.mode);
		if (!config) return;
		if (!config.needInputTools.includes(event.toolName)) return;
		notifier.fire(config, {
			event: "needInput",
			status: "需要确认",
			reason: "pi 正在等你回答问题",
			durationMs: run ? Date.now() - run.startedAt : undefined,
			...baseInput(ctx),
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const config = activeConfig(ctx.mode);
		if (!config) {
			await notifier.flush(1000);
			return;
		}
		if (event.reason === "quit") {
			// pi awaits this handler with no timeout of its own, so the cap is ours.
			await notifier.fireBlocking(
				config,
				{ event: "exit", status: "已退出", reason: "会话结束", ...baseInput(ctx) },
				config.shutdownTimeoutMs,
			);
		}
		// Drain notifications that were fired moments before the exit.
		await notifier.flush(config.shutdownTimeoutMs);
	});

	pi.registerCommand("push", {
		description:
			"pi-agent-push: status|list|get|set|enable|disable|test|events|on|off|help",
		handler: async (args, ctx) => {
			let result;
			try {
				result = handlePushCommand(args, {
					runtimeEnabled,
					setRuntimeEnabled: (v) => {
						runtimeEnabled = v;
					},
					last: (() => {
						const last = notifier.lastResults();
						return last
							? { at: last.at, event: last.event, results: last.results }
							: undefined;
					})(),
					describeResults,
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (result.runTest) {
				invalidateConfigCache();
				let config = loadConfig();
				if (!config.exists && config.channels.length === 0) {
					ctx.ui.notify(`未找到配置文件：${config.path}`, "error");
					return;
				}
				try {
					if (result.testFilter) {
						config = filterConfigToChannel(config, result.testFilter);
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				const results = await notifier.sendTest(
					{ ...config, enabled: true },
					{
						event: "test",
						status: "测试",
						reason: result.testFilter
							? `pi-agent-push 测试 (${result.testFilter})`
							: "pi-agent-push 通道测试",
						durationMs: 0,
						...baseInput(ctx),
					},
				);
				const ok = results.length > 0 && results.every((r) => r.ok);
				ctx.ui.notify(`pi-agent-push 测试：${describeResults(results)}`, ok ? "info" : "error");
				return;
			}

			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});
}
