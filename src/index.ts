import express from "express";
import { createServer } from "http";
import indexRouter from "./route.js";
import { registerWebsocketServer } from "./websocket.js";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256mb" }));

app.use("/api", indexRouter);

app.use((req, res) => {
	res.status(404).json({ error: "Route not found." });
});

app.use(
	(
		error: Error,
		req: express.Request,
		res: express.Response,
		next: express.NextFunction
	) => {
		if (res.headersSent) {
			return next(error);
		}

		console.error(error);
		res.status(500).json({ error: "Internal server error." });
	}
);

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app);

registerWebsocketServer(server);

server.listen(port, () => {
	console.log(`[codex-agent-management] listening on port ${port}`);
});
