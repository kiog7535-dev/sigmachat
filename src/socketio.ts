import { Server, Socket } from "socket.io";
import { readDb, writeDb, uuidv4 } from "./db.js";

const onlineUsers = new Map<string, string>(); // socketId -> userId

function getUserIdFromSocket(socket: Socket): string | null {
  const session = (socket.request as { session?: { userId?: string } }).session;
  return session?.userId || null;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function isBanned(userId: string): boolean {
  const db = readDb();
  return db.bans.some((b) => b.userId === userId);
}

function isTimedOut(userId: string): boolean {
  const db = readDb();
  const timeout = db.timeouts.find((t) => t.userId === userId);
  if (!timeout) return false;
  if (new Date(timeout.expiresAt) <= new Date()) {
    const newDb = readDb();
    newDb.timeouts = newDb.timeouts.filter((t) => t.userId !== userId);
    writeDb(newDb);
    return false;
  }
  return true;
}

function safeUser(user: ReturnType<typeof readDb>["users"][0]) {
  const { password: _p, ...safe } = user;
  return safe;
}

function addNotification(userId: string, type: string, content: string, data: Record<string, unknown> = {}): void {
  const db = readDb();
  db.notifications.push({
    id: uuidv4(),
    userId,
    type,
    content,
    data,
    read: false,
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
}

export function setupSocketIO(io: Server): void {
  io.on("connection", (socket: Socket) => {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      socket.disconnect();
      return;
    }

    if (isBanned(userId)) {
      socket.disconnect();
      return;
    }

    onlineUsers.set(socket.id, userId);

    // Update status to online
    const db = readDb();
    const userIdx = db.users.findIndex((u) => u.id === userId);
    if (userIdx !== -1) {
      const prevStatus = db.users[userIdx]!.status;
      if (prevStatus === "offline") db.users[userIdx]!.status = "online";
      writeDb(db);
      io.emit("status-change", { userId, status: db.users[userIdx]!.status });
    }

    socket.on("join-server", (serverId: string) => {
      const db = readDb();
      const server = db.servers.find((s) => s.id === serverId);
      if (server && server.members.includes(userId)) {
        socket.join(`server:${serverId}`);
      }
    });

    socket.on("join-channel", (data: { serverId: string; channelId: string }) => {
      socket.rooms.forEach((room) => {
        if (room.startsWith("channel:")) socket.leave(room);
      });
      const db = readDb();
      const server = db.servers.find((s) => s.id === data.serverId);
      if (server && server.members.includes(userId)) {
        socket.join(`channel:${data.serverId}:${data.channelId}`);
      }
    });

    socket.on("send-message", (data: { serverId: string; channelId: string; content: string }) => {
      if (!data.content?.trim()) return;
      if (isBanned(userId) || isTimedOut(userId)) {
        socket.emit("error-message", { error: "You are not allowed to send messages" });
        return;
      }
      const db = readDb();
      const server = db.servers.find((s) => s.id === data.serverId);
      if (!server || !server.members.includes(userId)) return;
      const channel = db.channels.find((c) => c.id === data.channelId);
      if (!channel) return;
      const author = db.users.find((u) => u.id === userId);
      const msg = {
        id: uuidv4(),
        serverId: data.serverId,
        channelId: data.channelId,
        authorId: userId,
        content: escapeHtml(data.content.slice(0, 2000)),
        createdAt: new Date().toISOString(),
        edited: false,
      };
      db.messages.push(msg);
      writeDb(db);
      io.to(`channel:${data.serverId}:${data.channelId}`).emit("new-message", {
        ...msg,
        author: author ? safeUser(author) : null,
      });
    });

    socket.on("delete-message", (data: { messageId: string; serverId: string; channelId: string }) => {
      const db = readDb();
      const user = db.users.find((u) => u.id === userId);
      const msg = db.messages.find((m) => m.id === data.messageId);
      if (!msg) return;
      if (msg.authorId !== userId && !user?.isAdmin) return;
      db.messages = db.messages.filter((m) => m.id !== data.messageId);
      db.pinnedMessages = db.pinnedMessages.filter((p) => p.messageId !== data.messageId);
      writeDb(db);
      io.to(`channel:${data.serverId}:${data.channelId}`).emit("message-deleted", { messageId: data.messageId });
    });

    socket.on("pin-message", (data: { messageId: string; serverId: string; channelId: string }) => {
      const db = readDb();
      const msg = db.messages.find((m) => m.id === data.messageId);
      if (!msg) return;
      const already = db.pinnedMessages.find((p) => p.messageId === data.messageId);
      if (already) return;
      const pin = {
        id: uuidv4(),
        messageId: data.messageId,
        serverId: data.serverId,
        channelId: data.channelId,
        dmConversationId: null,
        groupId: null,
        pinnedBy: userId,
        messageData: msg,
        createdAt: new Date().toISOString(),
      };
      db.pinnedMessages.push(pin);
      writeDb(db);
      io.to(`channel:${data.serverId}:${data.channelId}`).emit("message-pinned", pin);
    });

    socket.on("unpin-message", (data: { messageId: string; serverId: string; channelId: string }) => {
      const db = readDb();
      db.pinnedMessages = db.pinnedMessages.filter((p) => p.messageId !== data.messageId);
      writeDb(db);
      io.to(`channel:${data.serverId}:${data.channelId}`).emit("message-unpinned", { messageId: data.messageId });
    });

    socket.on("typing-start", (data: { serverId: string; channelId: string }) => {
      const db = readDb();
      const user = db.users.find((u) => u.id === userId);
      socket.to(`channel:${data.serverId}:${data.channelId}`).emit("typing", {
        userId,
        username: user?.displayName || user?.username || "",
        channelId: data.channelId,
      });
    });

    socket.on("typing-stop", (data: { serverId: string; channelId: string }) => {
      socket.to(`channel:${data.serverId}:${data.channelId}`).emit("stop-typing", {
        userId,
        channelId: data.channelId,
      });
    });

    // DMs
    socket.on("join-dm", (otherUserId: string) => {
      const roomId = [userId, otherUserId].sort().join(":");
      socket.join(`dm:${roomId}`);
    });

    socket.on("send-dm", (data: { toUserId: string; content: string }) => {
      if (!data.content?.trim()) return;
      if (isBanned(userId) || isTimedOut(userId)) {
        socket.emit("error-message", { error: "You are not allowed to send messages" });
        return;
      }
      const db = readDb();
      const author = db.users.find((u) => u.id === userId);
      let conv = db.dms.find(
        (d) => d.participants.includes(userId) && d.participants.includes(data.toUserId),
      );
      if (!conv) {
        conv = { id: uuidv4(), participants: [userId, data.toUserId], createdAt: new Date().toISOString() };
        db.dms.push(conv);
      }
      const msg = {
        id: uuidv4(),
        conversationId: conv.id,
        authorId: userId,
        content: escapeHtml(data.content.slice(0, 2000)),
        createdAt: new Date().toISOString(),
      };
      db.dmMessages.push(msg);
      addNotification(data.toUserId, "new_dm", `New message from ${author?.displayName || author?.username}`, {
        fromId: userId,
        conversationId: conv.id,
      });
      writeDb(db);
      const roomId = [userId, data.toUserId].sort().join(":");
      io.to(`dm:${roomId}`).emit("new-dm", { ...msg, author: author ? safeUser(author) : null, conversationId: conv.id });
    });

    socket.on("typing-dm-start", (otherUserId: string) => {
      const db = readDb();
      const user = db.users.find((u) => u.id === userId);
      const roomId = [userId, otherUserId].sort().join(":");
      socket.to(`dm:${roomId}`).emit("typing-dm", { userId, username: user?.displayName || user?.username || "" });
    });

    socket.on("typing-dm-stop", (otherUserId: string) => {
      const roomId = [userId, otherUserId].sort().join(":");
      socket.to(`dm:${roomId}`).emit("stop-typing-dm", { userId });
    });

    // Groups
    socket.on("join-group", (groupId: string) => {
      const db = readDb();
      const group = db.groups.find((g) => g.id === groupId);
      if (group && group.members.includes(userId)) {
        socket.join(`group:${groupId}`);
      }
    });

    socket.on("send-group-message", (data: { groupId: string; content: string }) => {
      if (!data.content?.trim()) return;
      if (isBanned(userId) || isTimedOut(userId)) {
        socket.emit("error-message", { error: "You are not allowed to send messages" });
        return;
      }
      const db = readDb();
      const group = db.groups.find((g) => g.id === data.groupId);
      if (!group || !group.members.includes(userId)) return;
      const author = db.users.find((u) => u.id === userId);
      const msg = {
        id: uuidv4(),
        groupId: data.groupId,
        authorId: userId,
        content: escapeHtml(data.content.slice(0, 2000)),
        createdAt: new Date().toISOString(),
      };
      db.groupMessages.push(msg);
      group.members.forEach((mId) => {
        if (mId !== userId) {
          addNotification(mId, "group_message", `New message in ${group.name}`, { groupId: data.groupId });
        }
      });
      writeDb(db);
      io.to(`group:${data.groupId}`).emit("new-group-message", {
        ...msg,
        author: author ? safeUser(author) : null,
      });
    });

    socket.on("typing-group-start", (groupId: string) => {
      const db = readDb();
      const user = db.users.find((u) => u.id === userId);
      socket.to(`group:${groupId}`).emit("typing-group", { userId, username: user?.displayName || user?.username || "", groupId });
    });

    socket.on("typing-group-stop", (groupId: string) => {
      socket.to(`group:${groupId}`).emit("stop-typing-group", { userId, groupId });
    });

    socket.on("status-update", (status: string) => {
      if (!["online", "idle", "dnd", "offline"].includes(status)) return;
      const db = readDb();
      const idx = db.users.findIndex((u) => u.id === userId);
      if (idx !== -1) {
        db.users[idx]!.status = status as "online" | "idle" | "dnd" | "offline";
        writeDb(db);
        io.emit("status-change", { userId, status });
      }
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(socket.id);
      const stillOnline = [...onlineUsers.values()].includes(userId);
      if (!stillOnline) {
        const db = readDb();
        const idx = db.users.findIndex((u) => u.id === userId);
        if (idx !== -1 && db.users[idx]!.status === "online") {
          db.users[idx]!.status = "offline";
          writeDb(db);
          io.emit("status-change", { userId, status: "offline" });
        }
      }
    });
  });
}
