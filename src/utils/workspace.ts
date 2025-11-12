import { promises as fs } from "fs";
import os from "os";
import path from "path";

export class WorkspacePreparationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspacePreparationError";
	}
}

const sanitizeTitle = (title: string) => {
	const trimmed = title.trim().toLowerCase();
	const normalized = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized : `challenge-${Date.now()}`;
};

const getWorkspaceRoot = () => {
	if (process.env.WORKSPACE_ROOT) {
		return path.resolve(process.env.WORKSPACE_ROOT);
	}

	return path.join(os.homedir(), "workspace");
};

export const prepareWorkspace = async (title: string, base64Zip?: string | null) => {
	const workspaceRoot = getWorkspaceRoot();
	const directoryName = sanitizeTitle(title);
	const workspacePath = path.join(workspaceRoot, directoryName);

	await fs.mkdir(workspacePath, { recursive: true });

	const artifactPath = path.join(workspacePath, "prob.zip");

	if (base64Zip && base64Zip.length > 0) {
		let buffer: Buffer;
		try {
			buffer = Buffer.from(base64Zip, "base64");
		} catch {
			throw new WorkspacePreparationError("`probFile` must be valid base64.");
		}

		await fs.writeFile(artifactPath, buffer);
	} else {
		// Even if no file is provided, create an empty placeholder to satisfy downstream expectations.
		await fs.writeFile(artifactPath, Buffer.alloc(0));
	}

	return { workspacePath, artifactPath };
};
