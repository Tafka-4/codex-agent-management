import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import {
	type AgentMessageItem,
	type CommandExecutionItem,
	type ItemCompletedEvent,
	type ItemStartedEvent,
	type ItemUpdatedEvent,
	type McpToolCallItem,
	type ThreadEvent,
} from "@openai/codex-sdk";
import {
	agentOutputSchema,
	buildThreadOptions,
	getCodexClient,
	parseAgentStructuredOutput,
	type AgentStructuredOutput,
} from "./utils/codex.js";
import { reqPrompt } from "./utils/makePrompt.js";

export type SessionStatus =
	| "pending"
	| "running"
	| "awaiting_hint"
	| "completed"
	| "cancelled"
	| "error";

export interface ProblemMetadata {
	category: string;
	title: string;
	description: string;
}

export interface SessionEventPayload {
	level: "info" | "task" | "warning" | "error";
	message: string;
	details?: Record<string, unknown>;
}

export interface SessionEvent extends SessionEventPayload {
	id: string;
	timestamp: number;
}

export interface Session {
	id: string;
	createdAt: number;
	updatedAt: number;
	status: SessionStatus;
	problem: ProblemMetadata;
	workspacePath: string;
	artifactPath: string | null;
	threadId: string | null;
	result: AgentStructuredOutput | null;
	events: SessionEvent[];
	error?: string | null;
}

type StreamController = {
	cancel: () => Promise<void>;
};

type ItemEventPhase = "started" | "updated" | "completed";

export class SessionManagerError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly code: string,
	) {
		super(message);
		this.name = "SessionManagerError";
	}
}

const truncate = (value: string, length = 600) => {
	if (value.length <= length) {
		return value;
	}

	return `${value.slice(0, length)}…`;
};

const clampConcurrency = (raw?: string) => {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		return 4;
	}
	return parsed;
};

export class SessionManager {
	private sessions = new Map<string, Session>();
	private clients = new Map<string, Set<WebSocket>>();
	private activeStreams = new Map<string, StreamController>();

	private readonly maxConcurrentAgents = clampConcurrency(process.env.AGENT_MAX_CONCURRENCY);
	private activeAgentCount = 0;
	private slotQueue: Array<() => void> = [];

	createSession(problem: ProblemMetadata, runtime: { workspacePath: string; artifactPath: string | null }) {
		const now = Date.now();
		const session: Session = {
			id: randomUUID(),
			createdAt: now,
			updatedAt: now,
			status: "pending",
			problem,
			workspacePath: runtime.workspacePath,
			artifactPath: runtime.artifactPath,
			threadId: null,
			result: null,
			events: [],
			error: null,
		};

		this.sessions.set(session.id, session);
		this.broadcastSnapshot(session.id);

		this.publishEvent(session.id, {
			level: "info",
			message: "Session created and workspace prepared.",
			details: {
				workspacePath: session.workspacePath,
				artifactPath: session.artifactPath,
			},
		});

		void this.runAgentSession(session.id, { source: "initial" });

		return session;
	}

	getSession(sessionId: string) {
		return this.sessions.get(sessionId);
	}

	async removeSession(sessionId: string) {
		const controller = this.activeStreams.get(sessionId);
		if (controller) {
			try {
				await controller.cancel();
			} catch (error) {
				console.warn(`[session:${sessionId}] Failed to cancel stream`, error);
			}
			this.activeStreams.delete(sessionId);
		}

		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		session.status = "cancelled";
		session.updatedAt = Date.now();
		this.broadcastSnapshot(session.id);

		this.sessions.delete(sessionId);

		const sockets = this.clients.get(sessionId);
		if (sockets) {
			for (const socket of sockets) {
				socket.close(1000, "Session cancelled");
			}
			this.clients.delete(sessionId);
		}

		return true;
	}

	registerClient(sessionId: string, socket: WebSocket) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			socket.send(JSON.stringify({ type: "error", message: "Session not found" }));
			socket.close(1008, "Session not found");
			return;
		}

		const clients = this.clients.get(sessionId) ?? new Set<WebSocket>();
		clients.add(socket);
		this.clients.set(sessionId, clients);

		socket.on("close", () => {
			clients.delete(socket);
			if (clients.size === 0) {
				this.clients.delete(sessionId);
			}
		});

		socket.on("error", () => {
			clients.delete(socket);
		});

		socket.send(
			JSON.stringify({
				type: "snapshot",
				session: this.serializeSession(session),
			}),
		);
	}

	async submitHint(sessionId: string, hint: string) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new SessionManagerError(`Session ${sessionId} not found.`, 404, "SESSION_NOT_FOUND");
		}

		if (!session.threadId) {
			throw new SessionManagerError(
				"Session has not established a Codex thread yet. Wait for the initial run to finish.",
				409,
				"SESSION_THREAD_UNAVAILABLE",
			);
		}

		if (this.activeStreams.has(sessionId)) {
			throw new SessionManagerError(
				"Session is already processing. Try again after the current run completes.",
				409,
				"SESSION_BUSY",
			);
		}

		const normalizedHint = hint.trim();

		this.publishEvent(sessionId, {
			level: "task",
			message: "Operator hint received.",
			details: {
				hint: truncate(normalizedHint, 400),
			},
		});

		this.updateStatus(sessionId, "pending");
		this.updateSessionMetadata(sessionId, (state) => {
			state.result = null;
		});

		void this.runAgentSession(sessionId, { source: "hint", hint: normalizedHint });
	}

	publishEvent(sessionId: string, payload: SessionEventPayload) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Cannot publish event: session ${sessionId} not found.`);
		}

		const event: SessionEvent = {
			id: randomUUID(),
			timestamp: Date.now(),
			...payload,
		};

		session.updatedAt = event.timestamp;
		session.events.push(event);

		this.broadcast(sessionId, {
			type: "event",
			event,
		});

		return event;
	}

	updateStatus(sessionId: string, status: SessionStatus) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Cannot update status: session ${sessionId} not found.`);
		}

		session.status = status;
		session.updatedAt = Date.now();

		this.broadcast(sessionId, {
			type: "status",
			status,
			timestamp: session.updatedAt,
		});
	}

	private async runAgentSession(
		sessionId: string,
		options: { source: "initial" | "hint"; hint?: string },
	) {
		if (this.activeStreams.has(sessionId)) {
			return;
		}

		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const isHint = options.source === "hint";

		if (isHint && !session.threadId) {
			throw new SessionManagerError(
				"Cannot run hint without an established thread.",
				409,
				"SESSION_THREAD_UNAVAILABLE",
			);
		}

		const queued = this.activeAgentCount >= this.maxConcurrentAgents;
		if (queued) {
			this.publishEvent(sessionId, {
				level: "info",
				message: "Agent run queued awaiting available execution slot.",
				details: { maxConcurrentAgents: this.maxConcurrentAgents },
			});
		}

		await this.acquireAgentSlot();

		try {
			const currentSession = this.sessions.get(sessionId);
			if (!currentSession) {
				return;
			}

			const prompt =
				isHint && options.hint
					? this.buildHintPrompt(currentSession, options.hint)
					: await reqPrompt(
							currentSession.problem.category,
							currentSession.problem.title,
							currentSession.problem.description,
							{ artifactPath: currentSession.artifactPath },
						);

			this.updateStatus(sessionId, "running");
			this.updateSessionMetadata(sessionId, (state) => {
				state.error = null;
				if (isHint) {
					state.result = null;
				}
			});

			this.publishEvent(sessionId, {
				level: "info",
				message: isHint ? "Processing operator hint with Codex agent." : "Starting Codex agent run.",
				details: {
					source: options.source,
				},
			});

			const threadOptions = buildThreadOptions({
				workingDirectory: currentSession.workspacePath,
			});

			const codex = getCodexClient();
			const thread = currentSession.threadId
				? codex.resumeThread(currentSession.threadId, threadOptions)
				: codex.startThread(threadOptions);

			let cancelled = false;
			const { events } = await thread.runStreamed(prompt, {
				outputSchema: agentOutputSchema,
			});

			const controller: StreamController = {
				cancel: async () => {
					cancelled = true;
					if (typeof events.return === "function") {
						try {
							await events.return(undefined);
						} catch {
							// Swallow cancellation errors.
						}
					}
				},
			};

			this.activeStreams.set(sessionId, controller);

			try {
				for await (const event of events) {
					if (!this.sessions.has(sessionId)) {
						cancelled = true;
						break;
					}
					this.handleThreadEvent(sessionId, event);
				}
			} catch (error) {
				if (cancelled || !this.sessions.has(sessionId)) {
					return;
				}

				const message =
					error instanceof Error ? error.message : "Unexpected Codex streaming error.";
				this.publishEvent(sessionId, {
					level: "error",
					message,
				});
				this.updateStatus(sessionId, "awaiting_hint");
				this.updateSessionMetadata(sessionId, (state) => {
					state.error = message;
				});
			} finally {
				this.activeStreams.delete(sessionId);

				if (!cancelled && this.sessions.has(sessionId)) {
					const latest = this.sessions.get(sessionId);
					if (latest && latest.status === "running") {
						this.updateStatus(sessionId, "awaiting_hint");
					}
					this.broadcastSnapshot(sessionId);
				}
			}
		} finally {
			this.releaseAgentSlot();
		}
	}

	private async acquireAgentSlot() {
		if (this.activeAgentCount < this.maxConcurrentAgents) {
			this.activeAgentCount += 1;
			return;
		}

		await new Promise<void>((resolve) => {
			this.slotQueue.push(resolve);
		});
		this.activeAgentCount += 1;
	}

	private releaseAgentSlot() {
		this.activeAgentCount = Math.max(0, this.activeAgentCount - 1);
		const next = this.slotQueue.shift();
		if (next) {
			next();
		}
	}

	private handleThreadEvent(sessionId: string, event: ThreadEvent) {
		switch (event.type) {
			case "thread.started": {
				this.updateSessionMetadata(sessionId, (session) => {
					session.threadId = event.thread_id;
				});
				this.publishEvent(sessionId, {
					level: "info",
					message: "Codex thread established.",
					details: { threadId: event.thread_id },
				});
				this.broadcastSnapshot(sessionId);
				break;
			}

			case "turn.started": {
				this.publishEvent(sessionId, {
					level: "task",
					message: "Agent turn started.",
				});
				break;
			}

			case "turn.completed": {
				this.publishEvent(sessionId, {
					level: "info",
					message: "Agent turn completed.",
					details: event.usage,
				});
				break;
			}

			case "turn.failed": {
				this.publishEvent(sessionId, {
					level: "error",
					message: "Agent turn failed.",
					details: event.error,
				});
				this.updateStatus(sessionId, "awaiting_hint");
				this.updateSessionMetadata(sessionId, (session) => {
					session.error = event.error.message;
				});
				break;
			}

			case "item.started":
				this.handleItemEvent(sessionId, event, "started");
				break;

			case "item.updated":
				this.handleItemEvent(sessionId, event, "updated");
				break;

			case "item.completed":
				this.handleItemEvent(sessionId, event, "completed");
				break;

			case "error":
				this.publishEvent(sessionId, {
					level: "error",
					message: event.message,
				});
				this.updateStatus(sessionId, "awaiting_hint");
				break;

			default:
				break;
		}
	}

	private handleItemEvent(
		sessionId: string,
		event: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent,
		phase: ItemEventPhase,
	) {
		const { item } = event;

		switch (item.type) {
			case "command_execution":
				this.handleCommandExecution(sessionId, item, phase);
				break;

			case "file_change":
				if (phase === "completed") {
					this.publishEvent(sessionId, {
						level: "info",
						message: "Agent applied file changes.",
						details: {
							status: item.status,
							changes: item.changes,
						},
					});
				}
				break;

			case "mcp_tool_call":
				this.handleMcpToolCall(sessionId, item, phase);
				break;

			case "todo_list":
				this.publishEvent(sessionId, {
					level: "info",
					message: phase === "completed" ? "Agent plan finalised." : "Agent plan updated.",
					details: {
						items: item.items,
						phase,
					},
				});
				break;

			case "agent_message":
				if (phase === "completed") {
					this.handleAgentMessage(sessionId, item);
				} else {
					this.publishEvent(sessionId, {
						level: "info",
						message: "Agent update",
						details: {
							content: truncate(item.text, 400),
							phase,
						},
					});
				}
				break;

			case "reasoning":
				this.publishEvent(sessionId, {
					level: "info",
					message: "Agent reasoning update.",
					details: {
						content: truncate(item.text, 400),
						phase,
					},
				});
				break;

			case "web_search":
				this.publishEvent(sessionId, {
					level: "task",
					message: "Agent performing web search.",
					details: {
						query: item.query,
						phase,
					},
				});
				break;

			case "error":
				this.publishEvent(sessionId, {
					level: "error",
					message: "Agent reported an error.",
					details: { message: item.message },
				});
				this.updateStatus(sessionId, "awaiting_hint");
				break;

			default:
				break;
		}
	}

	private handleCommandExecution(
		sessionId: string,
		item: CommandExecutionItem,
		phase: ItemEventPhase,
	) {
		const baseDetails: Record<string, unknown> = {
			command: item.command,
			status: item.status,
		};

		if (item.aggregated_output) {
			baseDetails.output = truncate(item.aggregated_output);
		}

		if (item.exit_code != null) {
			baseDetails.exitCode = item.exit_code;
		}

		const level: SessionEventPayload["level"] =
			item.status === "failed" ? "error" : "task";

		this.publishEvent(sessionId, {
			level,
			message:
				phase === "started"
					? `Executing command: ${item.command}`
					: `Command ${phase}: ${item.command}`,
			details: baseDetails,
		});
	}

	private handleMcpToolCall(
		sessionId: string,
		item: McpToolCallItem,
		phase: ItemEventPhase,
	) {
		const level: SessionEventPayload["level"] =
			item.status === "failed" ? "error" : "info";

		const details: Record<string, unknown> = {
			server: item.server,
			tool: item.tool,
			status: item.status,
			phase,
		};

		if (item.result) {
			details.result = item.result;
		}

		if (item.error) {
			details.error = item.error;
		}

		this.publishEvent(sessionId, {
			level,
			message: `MCP tool call ${phase}: ${item.tool}`,
			details,
		});
	}

	private handleAgentMessage(sessionId: string, item: AgentMessageItem) {
		const structured = parseAgentStructuredOutput(item.text);
		if (!structured) {
			this.publishEvent(sessionId, {
				level: "info",
				message: "Agent response",
				details: { content: truncate(item.text, 600) },
			});
			return;
		}

		this.updateSessionMetadata(sessionId, (session) => {
			session.result = structured;
			session.error = null;
		});

		const level: SessionEventPayload["level"] =
			structured.inferenceStatus === "solved"
				? "info"
				: structured.inferenceStatus === "failed"
					? "error"
					: "warning";

		const detailPayload: Record<string, unknown> = {
			inferenceStatus: structured.inferenceStatus,
			summary: structured.summary,
			flag: structured.flag ?? null,
			solveCodePath: structured.solveCodePath ?? null,
			writeUpPath: structured.writeUpPath ?? null,
		};

		if (structured.solutionFiles) {
			detailPayload.solutionFiles = structured.solutionFiles;
		}

		if (structured.nextSteps) {
			detailPayload.nextSteps = structured.nextSteps;
		}

		this.publishEvent(sessionId, {
			level,
			message: `Agent reported status: ${structured.inferenceStatus}`,
			details: detailPayload,
		});

		this.broadcast(sessionId, {
			type: "agent_result",
			result: structured,
		});

		this.broadcastSnapshot(sessionId);

		if (structured.inferenceStatus === "solved") {
			this.updateStatus(sessionId, "completed");
		} else if (structured.inferenceStatus === "failed") {
			this.updateStatus(sessionId, "awaiting_hint");
		} else {
			this.updateStatus(sessionId, "awaiting_hint");
		}
	}

	private buildHintPrompt(session: Session, hint: string) {
		return [
			`Operator follow-up hint for [${session.problem.category}] ${session.problem.title}:`,
			hint.trim(),
			"Integrate this guidance, continue progressing toward the flag, and respond exclusively with JSON that matches the previously provided schema.",
			"Summaries must remain concise and include any new artifacts or flags discovered.",
		].join("\n\n");
	}

	private broadcast(sessionId: string, payload: unknown) {
		const clients = this.clients.get(sessionId);
		if (!clients) {
			return;
		}

		const message = JSON.stringify(payload);

		for (const socket of clients) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(message);
			} else if (
				socket.readyState === WebSocket.CLOSING ||
				socket.readyState === WebSocket.CLOSED
			) {
				clients.delete(socket);
			}
		}
	}

	private broadcastSnapshot(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		this.broadcast(sessionId, {
			type: "snapshot",
			session: this.serializeSession(session),
		});
	}

	private serializeSession(session: Session) {
		return {
			id: session.id,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			status: session.status,
			threadId: session.threadId,
			result: session.result,
			error: session.error ?? null,
			problem: {
				category: session.problem.category,
				title: session.problem.title,
				description: session.problem.description,
			},
			workspacePath: session.workspacePath,
			artifactPath: session.artifactPath,
			events: session.events,
		};
	}

	private updateSessionMetadata(
		sessionId: string,
		mutator: (session: Session) => void,
	) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		mutator(session);
		session.updatedAt = Date.now();
	}
}

export const sessionManager = new SessionManager();
