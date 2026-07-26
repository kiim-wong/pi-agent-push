/**
 * pi-push — self test.
 *
 *   node test/run.ts        (Node >= 23, TypeScript is stripped natively)
 *
 * Spins up a local HTTP server that impersonates Bark / 飞书 / 企业微信 /
 * 钉钉 / a plain webhook, drives the extension through a fake ExtensionAPI and
 * asserts on the requests that arrive.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "pi-push-test-"));
const configFile = join(workDir, "config.json");
process.env.PI_PUSH_CONFIG = configFile;

const { invalidateConfigCache } = await import("../config.ts");
const { dingtalkSign, feishuSign } = await import("../channels/groupbot.ts");
const { summarizeError } = await import("../render.ts");
const piNotify = (await import("../index.ts")).default;
const { handlePushCommand } = await import("../command.ts");
const { loadRawConfig, saveRawConfig, resolveChannelIndex } = await import("../config.ts");

// ---------------------------------------------------------------- assertions

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		passed++;
		return;
	}
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// -------------------------------------------------------------- mock backend

interface Captured {
	path: string;
	method: string;
	headers: Record<string, string | string[] | undefined>;
	raw: string;
	json: Record<string, any> | undefined;
}

const captured: Captured[] = [];

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
	});
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const raw = await readBody(req);
	let json: Record<string, any> | undefined;
	try {
		json = raw ? JSON.parse(raw) : undefined;
	} catch {
		json = undefined;
	}
	const path = req.url ?? "";
	captured.push({ path, method: req.method ?? "", headers: req.headers, raw, json });

	const reply = (code: number, payload: unknown) => {
		res.writeHead(code, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	};

	if (path.startsWith("/slow")) {
		setTimeout(() => reply(200, { ok: true }), 3000);
		return;
	}
	if (path.startsWith("/feishu-badsign")) return reply(200, { code: 19021, msg: "sign match fail" });
	if (path.startsWith("/feishu")) return reply(200, { code: 0, msg: "success" });
	if (path.startsWith("/wecom")) return reply(200, { errcode: 0, errmsg: "ok" });
	if (path.startsWith("/dingtalk")) return reply(200, { errcode: 0, errmsg: "ok" });
	if (path.startsWith("/hook")) return reply(200, { ok: true });
	if (path.startsWith("/pi-topic") || path.startsWith("/ntfy-topic")) {
		return reply(200, { id: "msg1", event: "message", topic: "pi-topic" });
	}
	return reply(200, { code: 200, message: "success" }); // bark
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

// ------------------------------------------------------------------ harness

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

interface Harness {
	emit(event: any, ctx?: any): Promise<void>;
	command(args: string, ctx?: any): Promise<void>;
	ui: Array<{ message: string; type: string }>;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/home/ubuntu/demo-project",
		sessionManager: {
			getSessionName: () => "nightly-run",
			getSessionFile: () => "/sessions/abc123.jsonl",
		},
		model: { id: "claude-opus-5", provider: "my-new-api" },
		...overrides,
	};
}

function boot(): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const ui: Array<{ message: string; type: string }> = [];

	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool() {},
		registerShortcut() {},
		registerFlag() {},
	};

	piNotify(api as any);
	invalidateConfigCache();

	const uiCtx = (extra: Record<string, unknown> = {}) => ({
		...makeCtx(extra),
		ui: { notify: (message: string, type = "info") => ui.push({ message, type }) },
	});

	return {
		async emit(event, ctx) {
			for (const handler of handlers.get(event.type) ?? []) {
				await handler(event, ctx ?? uiCtx());
			}
		},
		async command(args, ctx) {
			await commands.get("push")?.handler(args, ctx ?? uiCtx());
		},
		ui,
	};
}

function writeConfig(config: Record<string, unknown>): void {
	writeFileSync(configFile, JSON.stringify(config, null, 2));
	invalidateConfigCache();
}

function allChannels(): unknown[] {
	return [
		{ type: "bark", deviceKey: "devkey", server: base },
		{ type: "feishu", url: `${base}/feishu`, secret: "testsecret" },
		{ type: "wecom", url: `${base}/wecom` },
		{ type: "dingtalk", url: `${base}/dingtalk`, secret: "testsecret" },
		{
			type: "ntfy",
			name: "ntfy-phone",
			topic: "pi-topic",
			server: base,
			token: "tk_test",
			priority: "high",
			tags: "pi,computer",
		},
		{
			type: "webhook",
			name: "my-hook",
			url: `${base}/hook`,
			headers: { "X-Project": "{{project}}" },
			body: { msg: "{{text}}", status: "{{status}}", event: "{{event}}" },
		},
	];
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

async function settle(h: Harness, stopReason: string, errorMessage?: string, ctx?: any) {
	await h.emit({ type: "agent_start" }, ctx);
	await h.emit(
		{
			type: "agent_end",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", stopReason, errorMessage, content: [] },
			],
		},
		ctx,
	);
	await h.emit({ type: "agent_settled" }, ctx);
}

function reset(): void {
	captured.length = 0;
}

// -------------------------------------------------------------------- tests

// 0. signature fixtures (values produced independently with python hmac)
check(
	"飞书签名匹配官方算法",
	feishuSign("1700000000", "testsecret") === "AOc8oJ7//5OlQlfWC3nRL0R+IkuzcD1FKcAyibRK9Q8=",
	feishuSign("1700000000", "testsecret"),
);
check(
	"钉钉签名匹配官方算法",
	dingtalkSign("1700000000000", "testsecret") === "d043yCasNZ+KC1N0lrVg+Aan0gEIKPvRfzRqMlUUwzk=",
	dingtalkSign("1700000000000", "testsecret"),
);

// 0b. 错误摘要（真实 pi 会把上游原始响应当作 errorMessage 丢出来）
check(
	"错误摘要: 提取 provider JSON 关键信息",
	summarizeError(
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_01"}',
		120,
	) === "401 authentication_error: invalid x-api-key",
	summarizeError(
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		120,
	),
);
check(
	"错误摘要: 非 JSON 回退到首行",
	summarizeError("connect ECONNREFUSED 127.0.0.1:443\nat TCPConnectWrap", 120) ===
		"connect ECONNREFUSED 127.0.0.1:443",
);
check("错误摘要: 过长截断", summarizeError("x".repeat(300), 40).length === 40);
check("错误摘要: 空值安全", summarizeError(undefined, 40) === "");

// 1. idle → every channel, correct per-channel payload shape
{
	reset();
	writeConfig({ channels: allChannels() });
	const h = boot();
	await settle(h, "stop");
	await waitFor(() => captured.length >= 6);

	check("idle: 6 个渠道都收到", captured.length === 6, `实际 ${captured.length}`);

	const bark = captured.find((c) => c.path.startsWith("/devkey"));
	check("bark: POST /:device_key", bark?.method === "POST", bark?.path);
	check("bark: title/body 为纯文本", bark?.json?.title === "pi 已就绪" && typeof bark?.json?.body === "string");
	check("bark: body 含状态与原因", (bark?.json?.body ?? "").includes("已就绪") && (bark?.json?.body ?? "").includes("输出结束"), bark?.json?.body);

	const feishu = captured.find((c) => c.path.startsWith("/feishu"));
	check("飞书: msg_type=text", feishu?.json?.msg_type === "text");
	check("飞书: content.text 存在", typeof feishu?.json?.content?.text === "string");
	check(
		"飞书: sign 与 timestamp 自洽",
		feishu?.json?.sign === feishuSign(String(feishu?.json?.timestamp), "testsecret"),
		String(feishu?.json?.sign),
	);

	const wecom = captured.find((c) => c.path.startsWith("/wecom"));
	check("企微: msgtype=text", wecom?.json?.msgtype === "text" && typeof wecom?.json?.text?.content === "string");

	const ding = captured.find((c) => c.path.startsWith("/dingtalk"));
	const dingUrl = new URL(`${base}${ding?.path ?? ""}`);
	check("钉钉: msgtype=text", ding?.json?.msgtype === "text");
	check(
		"钉钉: URL 带 timestamp+sign 且自洽",
		dingUrl.searchParams.get("sign") ===
			dingtalkSign(dingUrl.searchParams.get("timestamp") ?? "", "testsecret"),
		ding?.path,
	);

	const ntfy = captured.find((c) => c.path.startsWith("/pi-topic"));
	check("ntfy: POST /:topic", ntfy?.method === "POST", ntfy?.path);
	check(
		"ntfy: body 仅为 message 纯文本",
		typeof ntfy?.raw === "string" &&
			ntfy.raw.includes("已就绪") &&
			!ntfy.raw.trimStart().startsWith("{"),
		ntfy?.raw,
	);
	check(
		"ntfy: Bearer token",
		String(ntfy?.headers.authorization ?? "").toLowerCase() === "bearer tk_test",
		String(ntfy?.headers.authorization),
	);
	check(
		"ntfy: priority/tags 走 header",
		String(ntfy?.headers.priority ?? "") === "high" &&
			String(ntfy?.headers.tags ?? "").includes("pi"),
		JSON.stringify({ p: ntfy?.headers.priority, t: ntfy?.headers.tags }),
	);

	const hook = captured.find((c) => c.path.startsWith("/hook"));
	check("webhook: 对象模板渲染", hook?.json?.status === "已就绪" && hook?.json?.event === "idle", hook?.raw);
	check("webhook: header 占位符渲染", hook?.headers["x-project"] === "demo-project", String(hook?.headers["x-project"]));
}

// 2. Esc 取消 → interrupted
{
	reset();
	writeConfig({ channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	await settle(h, "aborted");
	await waitFor(() => captured.length >= 1);
	check("取消: event=interrupted", captured[0]?.json?.event === "interrupted", captured[0]?.raw);
	check("取消: 文案为「本轮被取消」", (captured[0]?.json?.text ?? "").includes("本轮被取消"), captured[0]?.json?.text);
}

// 3. 报错 → 只取首行，且字符串模板 JSON 转义正确
{
	reset();
	writeConfig({
		channels: [
			{
				type: "webhook",
				url: `${base}/hook`,
				body: '{"content":"{{text}}"}',
			},
		],
	});
	const h = boot();
	await settle(h, "error", 'Error: bad "quote"\nstack line 2\nstack line 3');
	await waitFor(() => captured.length >= 1);
	check("报错: 字符串模板仍是合法 JSON", captured[0]?.json !== undefined, captured[0]?.raw);
	check(
		"报错: 引号被正确转义并只取首行",
		(captured[0]?.json?.content ?? "").includes('bad "quote"') &&
			!(captured[0]?.json?.content ?? "").includes("stack line 2"),
		captured[0]?.json?.content,
	);
}

// 4. 去重
{
	reset();
	writeConfig({ dedupeMs: 5000, channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	await settle(h, "stop");
	await waitFor(() => captured.length >= 1);
	await settle(h, "stop");
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("去重: 窗口内重复只发一次", captured.length === 1, `实际 ${captured.length}`);
}

// 5. needInput 只对配置的工具触发
{
	reset();
	writeConfig({ channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	await h.emit({ type: "tool_call", toolName: "bash", input: {} });
	await new Promise((resolve) => setTimeout(resolve, 150));
	check("needInput: bash 不推送", captured.length === 0, `实际 ${captured.length}`);
	await h.emit({ type: "tool_call", toolName: "ask_user_question", input: {} });
	await waitFor(() => captured.length >= 1);
	check("needInput: ask_user_question 推送", captured[0]?.json?.event === "needInput", captured[0]?.raw);
}

// 6. 模式隔离（subagent 用 --mode json，不应打扰）
{
	reset();
	writeConfig({ channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	const jsonCtx = { ...makeCtx({ mode: "json" }), ui: { notify: () => {} } };
	await settle(h, "stop", undefined, jsonCtx);
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("模式: json 模式静默", captured.length === 0, `实际 ${captured.length}`);
}

// 7. 退出：只有 quit 推送，且 handler 在 cap 内返回
{
	reset();
	writeConfig({
		events: { idle: true, interrupted: true, needInput: true, exit: true },
		channels: [{ type: "webhook", url: `${base}/hook` }],
	});
	const h = boot();
	await h.emit({ type: "session_shutdown", reason: "new" });
	check("退出: /new 不推送", captured.length === 0, `实际 ${captured.length}`);
	const startedAt = Date.now();
	await h.emit({ type: "session_shutdown", reason: "quit" });
	const elapsed = Date.now() - startedAt;
	check("退出: quit 推送一次", captured.length === 1, `实际 ${captured.length}`);
	check("退出: 是阻塞发送（请求已完成）", captured[0]?.json?.event === "exit", captured[0]?.raw);
	check("退出: 未拖慢关机流程", elapsed < 2500, `${elapsed}ms`);
}

// 8. 超时不挂死，且失败被报告
{
	reset();
	writeConfig({
		timeoutMs: 300,
		channels: [{ type: "webhook", name: "slow-hook", url: `${base}/slow` }],
	});
	const h = boot();
	const startedAt = Date.now();
	await h.command("test");
	const elapsed = Date.now() - startedAt;
	const message = h.ui.at(-1)?.message ?? "";
	check("超时: 在 timeoutMs 附近返回", elapsed < 1500, `${elapsed}ms`);
	check("超时: 报告失败而非静默", message.includes("slow-hook") && message.includes("timeout"), message);
	check("超时: 提示为 error 级别", h.ui.at(-1)?.type === "error");
}

// 9. 渠道级 events 覆盖全局
{
	reset();
	writeConfig({
		events: { idle: false, interrupted: true, needInput: true, exit: false },
		channels: [
			{ type: "webhook", name: "quiet", url: `${base}/hook` },
			{ type: "webhook", name: "loud", url: `${base}/hook`, events: { idle: true } },
		],
	});
	const h = boot();
	await settle(h, "stop");
	await waitFor(() => captured.length >= 1);
	await new Promise((resolve) => setTimeout(resolve, 150));
	check("覆盖: 全局关但渠道开 → 只发 1 条", captured.length === 1, `实际 ${captured.length}`);
}

// 10. minDurationSec 降噪
{
	reset();
	writeConfig({ minDurationSec: 30, channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	await settle(h, "stop");
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("阈值: 短任务不推送", captured.length === 0, `实际 ${captured.length}`);
}

// 11. 关闭开关 / 非法配置
{
	reset();
	writeConfig({ enabled: false, channels: [{ type: "webhook", url: `${base}/hook` }] });
	const h = boot();
	await settle(h, "stop");
	await new Promise((resolve) => setTimeout(resolve, 150));
	check("开关: enabled=false 静默", captured.length === 0, `实际 ${captured.length}`);

	writeFileSync(configFile, "{ this is not json");
	invalidateConfigCache();
	const h2 = boot();
	await settle(h2, "stop");
	await new Promise((resolve) => setTimeout(resolve, 150));
	check("容错: 坏配置不崩溃且静默", captured.length === 0, `实际 ${captured.length}`);
}

// 12. /push 状态与开关
{
	reset();
	writeConfig({ channels: allChannels() });
	const h = boot();
	await h.command("");
	const status = h.ui.at(-1)?.message ?? "";
	check("命令: 状态含配置路径", status.includes(configFile), status);
	check("命令: 状态含渠道清单", status.includes("my-hook") && status.includes("ntfy-phone"), status);
	await h.command("off");
	await settle(h, "stop");
	await new Promise((resolve) => setTimeout(resolve, 150));
	check("命令: off 后静默", captured.length === 0, `实际 ${captured.length}`);
	await h.command("on");
	await settle(h, "stop");
	await waitFor(() => captured.length >= 6);
	check("命令: on 后恢复", captured.length === 6, `实际 ${captured.length}`);
}

// 13. 群机器人 HTTP 200 但业务失败要判为失败
{
	reset();
	writeConfig({ channels: [{ type: "feishu", name: "bad", url: `${base}/feishu-badsign` }] });
	const h = boot();
	await h.command("test");
	const message = h.ui.at(-1)?.message ?? "";
	check("业务码: code!=0 判为失败", message.includes("失败") && message.includes("19021"), message);
}

// 14. 环境变量引用（key 不落盘）
{
	reset();
	process.env.PI_PUSH_TEST_TOKEN = "s3cr3t";
	writeConfig({
		channels: [
			{
				type: "webhook",
				url: `${base}/hook`,
				headers: {
					"X-Whole": "$PI_PUSH_TEST_TOKEN",
					"X-Embedded": "Bearer ${PI_PUSH_TEST_TOKEN}",
					"X-Missing": "$PI_PUSH_NOT_SET",
				},
			},
		],
	});
	const h = boot();
	await settle(h, "stop");
	await waitFor(() => captured.length >= 1);
	const headers = captured[0]?.headers ?? {};
	check("env: \"$VAR\" 整体替换", headers["x-whole"] === "s3cr3t", String(headers["x-whole"]));
	check("env: \"${VAR}\" 嵌入替换", headers["x-embedded"] === "Bearer s3cr3t", String(headers["x-embedded"]));
	check("env: 未设置的变量为空串", headers["x-missing"] === "", String(headers["x-missing"]));
}

// 15. 随包发布的配置模板必须是合法 JSON（config.json 含密钥，不进仓库）
{
	const { readFileSync, existsSync } = await import("node:fs");
	const example = new URL("../config.example.json", import.meta.url).pathname;
	let ok = false;
	try {
		const parsed = JSON.parse(readFileSync(example, "utf-8")) as { channels?: unknown[] };
		ok = Array.isArray(parsed.channels);
	} catch {
		ok = false;
	}
	check("随包配置: config.example.json 合法", ok);

	// Local installs may have config.json; if present it must parse, but it is optional in the package.
	const local = new URL("../config.json", import.meta.url).pathname;
	if (existsSync(local)) {
		try {
			const parsed = JSON.parse(readFileSync(local, "utf-8")) as { channels?: unknown[] };
			check("本地 config.json 合法", Array.isArray(parsed.channels));
		} catch {
			check("本地 config.json 合法", false);
		}
	}
}


// 16. /push set|enable|get 写回 config.json
{
	reset();
	writeConfig({
		channels: [
			{ type: "ntfy", enabled: false, topic: "", server: "https://ntfy.sh" },
			{ type: "bark", enabled: false, deviceKey: "" },
		],
	});
	const setRes = handlePushCommand("set ntfy topic=hello-topic token=tk_secret enabled=true", {
		runtimeEnabled: true,
		setRuntimeEnabled: () => {},
		describeResults: () => "",
	});
	check("set: ok", setRes.ok, setRes.message);
	let raw = loadRawConfig();
	let ntfy = raw.data.channels?.find((c) => c.type === "ntfy") as Record<string, unknown>;
	check("set: topic 写入", ntfy?.topic === "hello-topic", String(ntfy?.topic));
	check("set: token 写入", ntfy?.token === "tk_secret", String(ntfy?.token));
	check("set: enabled 写入", ntfy?.enabled === true, String(ntfy?.enabled));

	const getRes = handlePushCommand("get ntfy", {
		runtimeEnabled: true,
		setRuntimeEnabled: () => {},
		describeResults: () => "",
	});
	check(
		"get: 脱敏 token",
		getRes.message.includes("token=") && !getRes.message.includes("tk_secret"),
		getRes.message,
	);

	handlePushCommand("disable bark", {
		runtimeEnabled: true,
		setRuntimeEnabled: () => {},
		describeResults: () => "",
	});
	raw = loadRawConfig();
	check(
		"disable: bark 关闭且 ntfy 仍开",
		raw.data.channels?.find((c) => c.type === "bark")?.enabled === false &&
			raw.data.channels?.find((c) => c.type === "ntfy")?.enabled === true,
	);

	const ev = handlePushCommand("events exit=on idle=off", {
		runtimeEnabled: true,
		setRuntimeEnabled: () => {},
		describeResults: () => "",
	});
	check("events: 写回", ev.ok && ev.message.includes("exit=on") && ev.message.includes("idle=off"), ev.message);
	raw = loadRawConfig();
	check("events: raw exit true", raw.data.events?.exit === true);
	check("events: raw idle false", raw.data.events?.idle === false);

	const help = handlePushCommand("help", {
		runtimeEnabled: true,
		setRuntimeEnabled: () => {},
		describeResults: () => "",
	});
	check("help: 含 set", help.message.includes("/push set"));
}

// ------------------------------------------------------------------ summary

server.close();

console.log(`\npi-push self test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
