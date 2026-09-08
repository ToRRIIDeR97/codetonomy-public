import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { dashboardHtml } from "@agent-harness/dashboard";
import { EvaluationStore } from "@agent-harness/evals";

export interface DashboardServer {
	url: string;
	token: string;
	close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
};

const tokenMatches = (candidate: string | undefined, expected: string): boolean => {
	if (!candidate) return false;
	const left = Buffer.from(candidate);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
};

export async function startDashboardServer(options: { databasePath: string; port?: number; token?: string }): Promise<DashboardServer> {
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Dashboard port must be 0-65535");
	const token = options.token ?? randomBytes(32).toString("base64url");
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Dashboard token must be 32-128 URL-safe characters");
	const store = new EvaluationStore(options.databasePath);
	const nonce = randomBytes(18).toString("base64url");
	const server = createServer((request, response) => {
		response.setHeader("x-content-type-options", "nosniff");
		response.setHeader("x-frame-options", "DENY");
		response.setHeader("referrer-policy", "no-referrer");
		response.setHeader("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
		if (!request.url || request.url.length > 4_096 || request.method !== "GET") {
			json(response, request.method === "GET" ? 414 : 405, { error: "Unsupported request" });
			return;
		}
		const url = new URL(request.url, "http://127.0.0.1");
		if (url.pathname === "/health") {
			json(response, 200, { ok: true });
			return;
		}
		const queryToken = url.pathname === "/" ? url.searchParams.get("token") ?? undefined : undefined;
		const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
		if (!tokenMatches(queryToken ?? bearer, token)) {
			json(response, 401, { error: "Unauthorized" });
			return;
		}
		try {
			if (url.pathname === "/") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				response.end(dashboardHtml(nonce));
				return;
			}
			if (url.pathname === "/api/summary") {
				json(response, 200, store.summary());
				return;
			}
			if (url.pathname === "/api/runs") {
				const raw = url.searchParams.get("limit") ?? "100";
				if (!/^\d{1,4}$/.test(raw)) throw new Error("Invalid run limit");
				json(response, 200, store.listRuns(Number(raw)));
				return;
			}
			if (url.pathname === "/api/benchmarks") {
				json(response, 200, store.benchmarkReports());
				return;
			}
			const match = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9-]{1,128})$/);
			if (match) {
				json(response, 200, store.runDetails(match[1]!));
				return;
			}
			json(response, 404, { error: "Not found" });
		} catch (error) {
			json(response, error instanceof Error && error.message.startsWith("Unknown run") ? 404 : 400, { error: error instanceof Error ? error.message : "Request failed" });
		}
	});
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	server.keepAliveTimeout = 5_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	}).catch((error) => {
		store.close();
		throw error;
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Dashboard did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`,
		token,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => {
			store.close();
			if (error) reject(error); else resolve();
		})),
	};
}
