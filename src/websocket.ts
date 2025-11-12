import { Server } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { sessionManager } from "./sessionManager.js";

const WS_SESSION_PREFIX = "/ws/session/";

const sendHttpError = (socket: Duplex, status: number, message: string) => {
	socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
	socket.destroy();
};

export const registerWebsocketServer = (server: Server) => {
	const wss = new WebSocketServer({ noServer: true });

	const decodeMessage = (data: WebSocket.RawData) => {
		if (typeof data === "string") {
			return data;
		}

		if (data instanceof ArrayBuffer) {
			return Buffer.from(data).toString("utf8");
		}

		if (Array.isArray(data)) {
			return Buffer.concat(data).toString("utf8");
		}

		return data.toString("utf8");
	};

	server.on("upgrade", (request, socket, head) => {
		if (!request.url) {
			sendHttpError(socket, 400, "Bad Request");
			return;
		}

		const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
		const { pathname } = url;

		if (!pathname.startsWith(WS_SESSION_PREFIX)) {
			sendHttpError(socket, 404, "Not Found");
			return;
		}

		const sessionId = pathname.slice(WS_SESSION_PREFIX.length);
		if (!sessionId) {
			sendHttpError(socket, 400, "Bad Request");
			return;
		}

		if (!sessionManager.getSession(sessionId)) {
			sendHttpError(socket, 404, "Not Found");
			return;
		}

		wss.handleUpgrade(request, socket, head, (webSocket) => {
			sessionManager.registerClient(sessionId, webSocket);
			wss.emit("connection", webSocket, request);
		});
	});

	wss.on("connection", (socket: WebSocket) => {
		socket.on("message", (message: WebSocket.RawData) => {
			try {
				const parsed = JSON.parse(decodeMessage(message));
				if (parsed?.type === "ping") {
					socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
				}
			} catch {
				socket.send(
					JSON.stringify({
						type: "error",
						message: "Invalid JSON payload.",
					}),
				);
			}
		});
	});
};
