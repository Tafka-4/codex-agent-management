import {
	Codex,
	type ApprovalMode,
	type CodexOptions,
	type SandboxMode,
	type ThreadOptions,
} from "@openai/codex-sdk";

export type AgentInferenceStatus = "solved" | "awaiting_hint" | "failed";

export interface AgentGeneratedFile {
	path: string;
	content?: string | null;
	description?: string | null;
}

export interface AgentStructuredOutput {
	inferenceStatus: AgentInferenceStatus;
	summary: string;
	flag: string | null;
	solveCode: string | null;
	writeUp: string | null;
	solutionFiles: AgentGeneratedFile[] | null;
	nextSteps: string[] | null;
}

export const agentOutputSchema = {
	type: "object",
	properties: {
		inferenceStatus: {
			type: "string",
			description:
				"Overall outcome of the attempt. Use `solved` if a working exploit or flag is obtained. Use `awaiting_hint` if additional information or hints are required. Use `failed` only when blockers are unrecoverable without outside intervention.",
			enum: ["solved", "awaiting_hint", "failed"],
		},
		summary: {
			type: "string",
			description: "Concise status update summarizing the agent's findings or blockers.",
		},
		flag: {
			type: ["string", "null"],
			description: "Captured flag value when available. Null until confirmed.",
		},
		solveCode: {
			type: ["string", "null"],
			description:
				"Inline source code or exploit script that demonstrates the solution. Provide the exact script used once solved; use null if still working.",
		},
		writeUp: {
			type: ["string", "null"],
			description:
				"Concise write-up that explains the vulnerability, methodology, and reproduction steps. Populate once findings are concrete; use null while pending.",
		},
			solutionFiles: {
			type: ["array", "null"],
			description:
				"Artifacts generated while solving the challenge. Include the primary exploit script or supporting files with inline contents when feasible.",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: {
						type: ["string", "null"],
						description:
							"Inline representation of the file content. Prefer base64 encoding for binary content.",
					},
					description: {
						type: ["string", "null"],
						description: "Short explanation of the file's purpose.",
					},
				},
				required: ["path", "content", "description"],
				additionalProperties: false,
			},
		},
			nextSteps: {
			type: ["array", "null"],
			description: "If awaiting hints, list concrete next actions that would benefit from user guidance.",
			items: { type: "string" },
		},
	},
	required: ["inferenceStatus", "summary", "flag", "solveCode", "writeUp", "solutionFiles", "nextSteps"],
	additionalProperties: false,
} as const;

let codexClient: Codex | null = null;

const isSandboxMode = (value: string): value is SandboxMode => {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
};

const isApprovalMode = (value: string): value is ApprovalMode => {
	return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted";
};

const getBooleanEnv = (value: string | undefined): boolean | undefined => {
	if (value == null) {
		return undefined;
	}

	if (value.toLowerCase() === "true") {
		return true;
	}

	if (value.toLowerCase() === "false") {
		return false;
	}

	return undefined;
};

export const getCodexClient = () => {
	if (!codexClient) {
		const options: CodexOptions = {};

		if (process.env.CODEX_BASE_URL) {
			options.baseUrl = process.env.CODEX_BASE_URL;
		}

		if (process.env.CODEX_API_KEY) {
			options.apiKey = process.env.CODEX_API_KEY;
		}

		codexClient = new Codex(options);
	}

	return codexClient;
};

export const buildThreadOptions = (overrides: Partial<ThreadOptions> = {}): ThreadOptions => {
	const options: ThreadOptions = {
		skipGitRepoCheck: process.env.CODEX_SKIP_GIT_CHECK !== "false",
	};

	const sandboxMode = process.env.CODEX_SANDBOX_MODE;
	if (sandboxMode && isSandboxMode(sandboxMode)) {
		options.sandboxMode = sandboxMode;
	}

	const approvalPolicy = process.env.CODEX_APPROVAL_POLICY;
	if (approvalPolicy && isApprovalMode(approvalPolicy)) {
		options.approvalPolicy = approvalPolicy;
	}

	if (process.env.CODEX_WORKING_DIRECTORY) {
		options.workingDirectory = process.env.CODEX_WORKING_DIRECTORY;
	} else {
		options.workingDirectory = process.cwd();
	}

	const networkAccess = getBooleanEnv(process.env.CODEX_NETWORK_ACCESS);
	if (networkAccess !== undefined) {
		options.networkAccessEnabled = networkAccess;
	}

	const webSearchAccess = getBooleanEnv(process.env.CODEX_WEB_SEARCH);
	if (webSearchAccess !== undefined) {
		options.webSearchEnabled = webSearchAccess;
	}

	const reasoningEffort = process.env.CODEX_MODEL_REASONING_EFFORT;
	if (
		reasoningEffort === "minimal" ||
		reasoningEffort === "low" ||
		reasoningEffort === "medium" ||
		reasoningEffort === "high"
	) {
		options.modelReasoningEffort = reasoningEffort;
	}

	const model = process.env.CODEX_MODEL;
	if (model) {
		options.model = model;
	}

	return { ...options, ...overrides };
};

const isAgentGeneratedFile = (value: unknown): value is AgentGeneratedFile => {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const maybeFile = value as Record<string, unknown>;
	if (typeof maybeFile.path !== "string" || maybeFile.path.length === 0) {
		return false;
	}

	if (
		maybeFile.content != null &&
		typeof maybeFile.content !== "string" &&
		maybeFile.content !== null
	) {
		return false;
	}

	if (
		maybeFile.description != null &&
		typeof maybeFile.description !== "string" &&
		maybeFile.description !== null
	) {
		return false;
	}

	return true;
};

const isAgentStructuredOutput = (value: unknown): value is AgentStructuredOutput => {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const record = value as Record<string, unknown>;
	if (record.inferenceStatus !== "solved" && record.inferenceStatus !== "awaiting_hint" && record.inferenceStatus !== "failed") {
		return false;
	}

	if (typeof record.summary !== "string" || record.summary.length === 0) {
		return false;
	}

	if (!("flag" in record)) {
		return false;
	}

	if (
		record.flag !== null &&
		typeof record.flag !== "string"
	) {
		return false;
	}

	if (!("solveCode" in record)) {
		return false;
	}

	if (
		record.solveCode !== null &&
		typeof record.solveCode !== "string"
	) {
		return false;
	}

	if (!("writeUp" in record)) {
		return false;
	}

	if (
		record.writeUp !== null &&
		typeof record.writeUp !== "string"
	) {
		return false;
	}

	if (!("solutionFiles" in record)) {
		return false;
	}

	if (record.solutionFiles !== null) {
		if (!Array.isArray(record.solutionFiles)) {
			return false;
		}

		if (!record.solutionFiles.every(isAgentGeneratedFile)) {
			return false;
		}
	}

	if (!("nextSteps" in record)) {
		return false;
	}

	if (record.nextSteps !== null) {
		if (!Array.isArray(record.nextSteps)) {
			return false;
		}

		if (!record.nextSteps.every((item) => typeof item === "string")) {
			return false;
		}
	}

	return true;
};

export const parseAgentStructuredOutput = (raw: string) => {
	try {
		const parsed = JSON.parse(raw);
		if (isAgentStructuredOutput(parsed)) {
			return parsed;
		}
	} catch {
		// fall through
	}

	return null;
};
