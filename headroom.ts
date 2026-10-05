import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const proxy = process.env.OMP_HEADROOM_URL ?? `http://127.0.0.1:${process.env.OMP_HEADROOM_PORT ?? "8787"}`;

async function healthy(): Promise<boolean> {
	try {
		return (await fetch(`${proxy}/health`, { signal: AbortSignal.timeout(2000) })).ok;
	} catch {
		return false;
	}
}

function fail(reason: string): never {
	console.error(`omp-headroom: ${reason}; see ~/.headroom/logs/launcher.log`);
	process.exit(1);
}

async function start(): Promise<void> {
	let spawnError: Error | undefined;
	try {
		const port = new URL(proxy).port || "8787";
		const logDir = join(homedir(), ".headroom", "logs");
		mkdirSync(logDir, { recursive: true });
		const log = openSync(join(logDir, "launcher.log"), "a");
		console.error("omp-headroom: starting Headroom proxy; first start can take minutes...");
		const child = spawn("headroom", ["proxy", "--host", "127.0.0.1", "--port", port], {
			detached: true,
			stdio: ["ignore", log, log],
			env: {
				...process.env,
				HEADROOM_BEACON: "off",
				HEADROOM_TELEMETRY: "on",
				HEADROOM_THINKING_PRESERVING_MUTATIONS: "0",
			},
		});
		closeSync(log);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.unref();
	} catch (error) {
		fail(`cannot start Headroom proxy: ${(error as Error).message}`);
	}
	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		await sleep(1000);
		if (spawnError) fail(`cannot start Headroom proxy: ${spawnError.message}`);
		if (await healthy()) return;
	}
	fail(`proxy at ${proxy} did not become healthy within 240s`);
}

export default async function headroom(pi: ExtensionAPI): Promise<void> {
	if (!(await healthy())) await start();

	const providerUrls = process.env.OMP_HEADROOM_PROVIDER_URLS;
	if (!providerUrls) return;

	const parsed: unknown = JSON.parse(providerUrls);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		fail("OMP_HEADROOM_PROVIDER_URLS must be a JSON object");
	}
	for (const [name, baseUrl] of Object.entries(parsed)) {
		if (typeof baseUrl !== "string") {
			fail(`OMP_HEADROOM_PROVIDER_URLS.${name} must be a URL string`);
		}
		pi.registerProvider(name, { baseUrl });
	}
}
