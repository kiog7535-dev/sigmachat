import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import app, { sessionMiddleware } from "./app.js";
import { setupSocketIO } from "./socketio.js";
import { initDb } from "./db.js";
import { logger } from "./lib/logger.js";

const port = Number(process.env["PORT"] || 8080);

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Share the Express session with Socket.IO so sockets can read req.session.userId
io.engine.use(sessionMiddleware);

setupSocketIO(io);
initDb().then(() => {
  logger.info("Database initialized");
});

httpServer.listen(port, () => {
  logger.info({ port }, "Sigma Chat server listening");
});
