import { createServer } from "vite";
import { startModelProviderServer } from "../../local-runtime/src/model-provider-server.mjs";

const startOrReuseModelProviderServer = async () => {
	try {
		return await startModelProviderServer();
	} catch (error) {
		if (error?.code !== "EADDRINUSE") throw error;

		let response;
		try {
			response = await fetch("http://127.0.0.1:5192/api/health", { signal: AbortSignal.timeout(2000) });
		} catch {
			throw new Error("本机 Pi Runtime 端口 5192 已被占用，但健康检查未能连接。请先停止旧的项目服务进程后再启动。", { cause: error });
		}

		let health;
		try {
			health = await response.json();
		} catch {
			health = null;
		}
		if (!response.ok || health?.status !== "ok" || health?.runtime !== "pi") {
			throw new Error("本机 Pi Runtime 端口 5192 已被其他服务占用。请停止占用进程后再启动。", { cause: error });
		}
		if (!Object.prototype.hasOwnProperty.call(health, "wpsOfficeMcp")) {
			throw new Error("检测到旧版本机 Pi Runtime 正占用端口 5192，尚未加载默认的 WPS Office MCP。请重启项目服务后再试。", { cause: error });
		}

		process.stdout.write("Reusing existing Pi Runtime on http://127.0.0.1:5192\n");
		return async () => {};
	}
};

const stopModelProviderServer = await startOrReuseModelProviderServer();
const server = await createServer();

const shutdown = async () => {
	await server.close();
	await stopModelProviderServer();
	process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
	await server.listen();
	server.printUrls();
} catch (error) {
	await stopModelProviderServer();
	if (error?.code === "EADDRINUSE") {
		error.message = "Web 应用端口 5173 已被占用。如果已有项目实例在运行，请直接访问 http://127.0.0.1:5173/；如需重启，请先停止旧实例。";
	}
	throw error;
}
