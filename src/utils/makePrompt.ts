import { agentOutputSchema } from "./codex.js";

const schemaInstructions = JSON.stringify(agentOutputSchema, null, 2);

export const reqPrompt = async (
	probCategory: string,
	probTitle: string,
	probDescription: string,
	options?: { artifactPath?: string | null }
) => {
	const artifactNote = options?.artifactPath
		? `An auxiliary artifact is available at ${options.artifactPath}. Inspect or extract it if useful for solving the challenge.`
		: "No auxiliary files were provided for this challenge.";

	return [
		`[${probCategory}] ${probTitle}`,
		probDescription.trim(),
		"## Operating Context",
		"You are an autonomous CTF analyst. Combine static inspection, dynamic execution, and exploit development workflows to capture the flag or produce a working solution.",
		artifactNote,
		"Ensure that your actions remain reproducible and that any generated scripts are self-contained. You can use MCP tools such as pwndbg, ida-pro",
		"## Reporting Requirements",
		"1. Maintain a clear chain-of-thought internally but only expose actionable summaries through updates.",
		"2. Use the Codex planning tools to track progress (todo list, command execution records, file diffs).",
		"3. When you reach a conclusion, respond with JSON that conforms to the schema below.",
		"4. Populate `inferenceStatus` with `solved` once a verified flag or working exploit is ready. Use `awaiting_hint` when blocked or requiring more information. Use `failed` only for unrecoverable conditions.",
		"5. Include the primary exploit or solution artifacts via `solutionFiles` with inline content when feasible. Ensure any recovered flag is placed in the `flag` field verbatim.",
		"6. If awaiting hints, provide concrete `nextSteps` describing the assistance you need.",
		"## Structured Output Schema",
		schemaInstructions,
	].join("\n\n");
};
