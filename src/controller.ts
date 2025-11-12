import type { Request, Response } from "express";
import { sessionManager, SessionManagerError, type Session } from "./sessionManager.js";
import { WorkspacePreparationError, prepareWorkspace } from "./utils/workspace.js";

const validateCreateSessionBody = (body: Record<string, unknown>) => {
	const errors: string[] = [];

	if (typeof body.probCategory !== "string" || body.probCategory.trim().length === 0) {
		errors.push("`probCategory` must be a non-empty string.");
	}
	if (typeof body.probTitle !== "string" || body.probTitle.trim().length === 0) {
		errors.push("`probTitle` must be a non-empty string.");
	}
	if (typeof body.probDescription !== "string" || body.probDescription.trim().length === 0) {
		errors.push("`probDescription` must be a non-empty string.");
	}

	if (body.probFile != null && typeof body.probFile !== "string") {
		errors.push("`probFile`, when provided, must be a string (e.g. base64 encoded content).");
	}

	return errors;
};

const serializeSession = (session: Session) => ({
	id: session.id,
	status: session.status,
	createdAt: session.createdAt,
	updatedAt: session.updatedAt,
	threadId: session.threadId,
	result: session.result,
	error: session.error ?? null,
	problem: session.problem,
	workspacePath: session.workspacePath,
	artifactPath: session.artifactPath,
	events: session.events,
});

export const requestSession = async (req: Request, res: Response) => {
	const validationErrors = validateCreateSessionBody(req.body ?? {});
	if (validationErrors.length > 0) {
		return res.status(400).json({
			error: "Invalid session request payload.",
			details: validationErrors,
		});
	}

	const { probCategory, probTitle, probDescription, probFile } = req.body as {
		probCategory: string;
		probTitle: string;
		probDescription: string;
		probFile?: string;
	};

	let workspace;
	try {
		workspace = await prepareWorkspace(probTitle, probFile ?? null);
	} catch (error) {
		if (error instanceof WorkspacePreparationError) {
			return res.status(400).json({ error: error.message });
		}

		console.error("Failed to prepare workspace", error);
		return res.status(500).json({ error: "Failed to prepare workspace." });
	}

	const session = sessionManager.createSession(
		{
			category: probCategory,
			title: probTitle,
			description: probDescription,
		},
		{
			workspacePath: workspace.workspacePath,
			artifactPath: workspace.artifactPath,
		},
	);

	return res.status(201).json({
		session: serializeSession(session),
	});
};

export const getSession = async (req: Request, res: Response) => {
	const sessionId = req.params.id;

	if (!sessionId) {
		return res.status(400).json({ error: "Session id is required." });
	}

	const session = sessionManager.getSession(sessionId);

	if (!session) {
		return res.status(404).json({ error: `Session ${sessionId} not found.` });
	}

	return res.json({
		session: serializeSession(session),
	});
};

export const deleteSession = async (req: Request, res: Response) => {
	const sessionId = req.params.id;

	if (!sessionId) {
		return res.status(400).json({ error: "Session id is required." });
	}

	const removed = await sessionManager.removeSession(sessionId);

	if (!removed) {
		return res.status(404).json({ error: `Session ${sessionId} not found.` });
	}

	return res.status(200).json({ message: `Session ${sessionId} cancelled.` });
};

export const submitHint = async (req: Request, res: Response) => {
	const sessionId = req.params.id;
	const { hint } = (req.body ?? {}) as { hint?: unknown };

	if (!sessionId) {
		return res.status(400).json({ error: "Session id is required." });
	}

	if (typeof hint !== "string" || hint.trim().length === 0) {
		return res.status(400).json({ error: "`hint` must be a non-empty string." });
	}

	try {
		await sessionManager.submitHint(sessionId, hint);
	} catch (error) {
		if (error instanceof SessionManagerError) {
			return res.status(error.statusCode).json({
				error: error.message,
				code: error.code,
			});
		}

		console.error(`[session:${sessionId}] Failed to submit hint`, error);
		return res.status(500).json({ error: "Failed to process hint." });
	}

	return res.status(202).json({ message: "Hint accepted." });
};
