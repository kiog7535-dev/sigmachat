import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readDb, writeDb, uuidv4 } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app: Express = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env["SESSION_SECRET"] || "sigma-chat-secret-key-2024";
export const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
});
app.use(sessionMiddleware);

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const db = readDb();
  const user = db.users.find((u) => u.id === req.session!.userId);
  if (!user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
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

function addNotification(userId: string, type: string, content: string, data: Record<string, unknown> = {}): void {
  const db = readDb();
  db.notifications.push({
    id: uuidv4(),
    userId,
    type,
    content: escapeHtml(content),
    data,
    read: false,
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
}

function safeUser(user: ReturnType<typeof readDb>["users"][0]) {
  const { password: _p, ...safe } = user;
  return safe;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post("/auth/register", async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }
  const clean = escapeHtml(username.trim());
  if (clean.length < 2 || clean.length > 32) {
    res.status(400).json({ error: "Username must be 2–32 characters" });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: "Password must be at least 4 characters" });
    return;
  }
  const db = readDb();
  if (db.users.find((u) => u.username.toLowerCase() === clean.toLowerCase())) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }
  const hashed = await bcrypt.hash(password, 12);
  const user = {
    id: uuidv4(),
    username: clean,
    displayName: clean,
    password: hashed,
    avatar: "",
    banner: "",
    bio: "",
    status: "online" as const,
    isAdmin: false,
    verified: false,
    goldVerified: false,
    joinDate: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    servers: [] as string[],
  };
  db.users.push(user);
  writeDb(db);
  req.session!.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post("/auth/login", async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }
  const db = readDb();
  const user = db.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (isBanned(user.id)) {
    res.status(403).json({ error: "Your account has been banned" });
    return;
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const fresh = readDb();
  const idx = fresh.users.findIndex((u) => u.id === user.id);
  if (idx !== -1) { fresh.users[idx]!.status = "online"; writeDb(fresh); }
  req.session!.userId = user.id;
  res.json({ user: safeUser(user) });
});

app.post("/auth/logout", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.session!.userId);
  if (idx !== -1) { db.users[idx]!.status = "offline"; writeDb(db); }
  req.session!.destroy(() => res.json({ ok: true }));
});

app.get("/auth/me", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.session!.userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ user: safeUser(user) });
});

// ─── Users ───────────────────────────────────────────────────────────────────

app.get("/users/search", requireAuth, (req: Request, res: Response): void => {
  const q = String(req.query["q"] || "").trim().toLowerCase();
  if (!q) { res.json({ users: [] }); return; }
  const db = readDb();
  const users = db.users
    .filter((u) => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
    .slice(0, 20)
    .map(safeUser);
  res.json({ users });
});

app.get("/users/:id", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params["id"]);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const myId = req.session!.userId;
  const isFriend = db.friendships.some(
    (f) => (f.userA === myId && f.userB === user.id) || (f.userB === myId && f.userA === user.id),
  );
  const friendCount = db.friendships.filter(
    (f) => f.userA === user.id || f.userB === user.id,
  ).length;
  const mutualFriends = db.friendships
    .filter((f) => (f.userA === myId || f.userB === myId))
    .map((f) => (f.userA === myId ? f.userB : f.userA))
    .filter((fId) =>
      db.friendships.some(
        (f2) => (f2.userA === user.id && f2.userB === fId) || (f2.userB === user.id && f2.userA === fId),
      ),
    ).length;
  res.json({ user: { ...safeUser(user), isFriend, friendCount, mutualFriends } });
});

app.put("/users/profile", requireAuth, (req: Request, res: Response): void => {
  const { displayName, bio, avatar, banner, status } = req.body as {
    displayName?: string;
    bio?: string;
    avatar?: string;
    banner?: string;
    status?: string;
  };
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.session!.userId);
  if (idx === -1) { res.status(404).json({ error: "User not found" }); return; }
  const user = db.users[idx]!;
  if (displayName !== undefined) user.displayName = escapeHtml(displayName.slice(0, 32));
  if (bio !== undefined) user.bio = escapeHtml(bio.slice(0, 300));
  if (avatar !== undefined) user.avatar = avatar;
  if (banner !== undefined) user.banner = banner;
  if (status && ["online", "idle", "dnd", "offline"].includes(status))
    user.status = status as "online" | "idle" | "dnd" | "offline";
  writeDb(db);
  res.json({ user: safeUser(user) });
});

// ─── Servers ─────────────────────────────────────────────────────────────────

app.get("/servers", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.session!.userId);
  if (!user) { res.status(404).json({ error: "Not found" }); return; }
  const servers = db.servers.filter((s) => user.servers.includes(s.id));
  res.json({ servers });
});

app.get("/servers/discover", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.session!.userId);
  if (!user) { res.status(404).json({ error: "Not found" }); return; }
  const servers = db.servers.filter((s) => !user.servers.includes(s.id)).slice(0, 20);
  res.json({ servers });
});

app.post("/servers", requireAuth, (req: Request, res: Response): void => {
  const { name, description, icon } = req.body as { name?: string; description?: string; icon?: string };
  if (!name) { res.status(400).json({ error: "Server name required" }); return; }
  const db = readDb();
  const userId = req.session!.userId;
  const ch1 = uuidv4(); const ch2 = uuidv4(); const ch3 = uuidv4();
  const serverId = uuidv4();
  const server = {
    id: serverId,
    name: escapeHtml(name.slice(0, 50)),
    description: escapeHtml((description || "").slice(0, 200)),
    icon: icon || "🌐",
    owner: userId,
    members: [userId],
    channels: [ch1, ch2, ch3],
    createdAt: new Date().toISOString(),
  };
  db.servers.push(server);
  db.channels.push(
    { id: ch1, serverId, name: "general", createdAt: new Date().toISOString() },
    { id: ch2, serverId, name: "chat", createdAt: new Date().toISOString() },
    { id: ch3, serverId, name: "off-topic", createdAt: new Date().toISOString() },
  );
  const uIdx = db.users.findIndex((u) => u.id === userId);
  if (uIdx !== -1) db.users[uIdx]!.servers.push(serverId);
  writeDb(db);
  res.json({ server });
});

app.get("/servers/:id", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const server = db.servers.find((s) => s.id === req.params["id"]);
  if (!server) { res.status(404).json({ error: "Server not found" }); return; }
  const members = db.users.filter((u) => server.members.includes(u.id)).map(safeUser);
  const channels = db.channels.filter((c) => server.channels.includes(c.id));
  res.json({ server, members, channels });
});

app.delete("/servers/:id", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const user = db.users.find((u) => u.id === userId);
  const sIdx = db.servers.findIndex((s) => s.id === req.params["id"]);
  if (sIdx === -1) { res.status(404).json({ error: "Server not found" }); return; }
  const server = db.servers[sIdx]!;
  if (server.owner !== userId && !user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  db.servers.splice(sIdx, 1);
  db.channels = db.channels.filter((c) => c.serverId !== server.id);
  db.messages = db.messages.filter((m) => m.serverId !== server.id);
  db.users.forEach((u) => { u.servers = u.servers.filter((sid) => sid !== server.id); });
  writeDb(db);
  res.json({ ok: true });
});

app.post("/servers/:id/join", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const sIdx = db.servers.findIndex((s) => s.id === req.params["id"]);
  if (sIdx === -1) { res.status(404).json({ error: "Server not found" }); return; }
  const server = db.servers[sIdx]!;
  if (!server.members.includes(userId)) server.members.push(userId);
  const uIdx = db.users.findIndex((u) => u.id === userId);
  if (uIdx !== -1 && !db.users[uIdx]!.servers.includes(server.id))
    db.users[uIdx]!.servers.push(server.id);
  writeDb(db);
  res.json({ server });
});

app.post("/servers/:id/leave", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const sIdx = db.servers.findIndex((s) => s.id === req.params["id"]);
  if (sIdx === -1) { res.status(404).json({ error: "Server not found" }); return; }
  const server = db.servers[sIdx]!;
  if (server.owner === userId) { res.status(400).json({ error: "Owner cannot leave. Delete server instead." }); return; }
  server.members = server.members.filter((m) => m !== userId);
  const uIdx = db.users.findIndex((u) => u.id === userId);
  if (uIdx !== -1) db.users[uIdx]!.servers = db.users[uIdx]!.servers.filter((s) => s !== server.id);
  writeDb(db);
  res.json({ ok: true });
});

// ─── Channels ─────────────────────────────────────────────────────────────────

app.get("/channels/:serverId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const channels = db.channels.filter((c) => c.serverId === req.params["serverId"]);
  res.json({ channels });
});

app.post("/channels/:serverId", requireAuth, (req: Request, res: Response): void => {
  const { name } = req.body as { name?: string };
  if (!name) { res.status(400).json({ error: "Channel name required" }); return; }
  const db = readDb();
  const userId = req.session!.userId;
  const user = db.users.find((u) => u.id === userId);
  const server = db.servers.find((s) => s.id === req.params["serverId"]);
  if (!server) { res.status(404).json({ error: "Server not found" }); return; }
  if (server.owner !== userId && !user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const channel = {
    id: uuidv4(),
    serverId: server.id,
    name: escapeHtml(name.toLowerCase().replace(/\s+/g, "-").slice(0, 32)),
    createdAt: new Date().toISOString(),
  };
  db.channels.push(channel);
  server.channels.push(channel.id);
  writeDb(db);
  res.json({ channel });
});

app.delete("/channels/:serverId/:channelId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const user = db.users.find((u) => u.id === userId);
  const server = db.servers.find((s) => s.id === req.params["serverId"]);
  if (!server) { res.status(404).json({ error: "Server not found" }); return; }
  if (server.owner !== userId && !user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const cIdx = db.channels.findIndex((c) => c.id === req.params["channelId"]);
  if (cIdx !== -1) db.channels.splice(cIdx, 1);
  server.channels = server.channels.filter((c) => c !== req.params["channelId"]);
  db.messages = db.messages.filter((m) => m.channelId !== req.params["channelId"]);
  writeDb(db);
  res.json({ ok: true });
});

// ─── Messages ─────────────────────────────────────────────────────────────────

app.get("/messages/:serverId/:channelId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const limit = Math.min(Number(req.query["limit"] || 50), 100);
  const msgs = db.messages
    .filter((m) => m.serverId === req.params["serverId"] && m.channelId === req.params["channelId"])
    .slice(-limit)
    .map((m) => {
      const author = db.users.find((u) => u.id === m.authorId);
      return { ...m, author: author ? safeUser(author) : null };
    });
  res.json({ messages: msgs });
});

// ─── DMs ──────────────────────────────────────────────────────────────────────

app.get("/dms", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const convs = db.dms
    .filter((d) => d.participants.includes(userId))
    .map((d) => {
      const otherId = d.participants.find((p) => p !== userId)!;
      const other = db.users.find((u) => u.id === otherId);
      const lastMsg = db.dmMessages.filter((m) => m.conversationId === d.id).slice(-1)[0];
      return { ...d, other: other ? safeUser(other) : null, lastMessage: lastMsg || null };
    });
  res.json({ conversations: convs });
});

app.get("/dms/:userId/messages", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const otherId = req.params["userId"];
  const conv = db.dms.find(
    (d) => d.participants.includes(myId) && d.participants.includes(otherId),
  );
  if (!conv) { res.json({ messages: [], conversationId: null }); return; }
  const msgs = db.dmMessages
    .filter((m) => m.conversationId === conv.id)
    .slice(-100)
    .map((m) => {
      const author = db.users.find((u) => u.id === m.authorId);
      return { ...m, author: author ? safeUser(author) : null };
    });
  res.json({ messages: msgs, conversationId: conv.id });
});

app.post("/dms/:userId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const otherId = req.params["userId"];
  let conv = db.dms.find(
    (d) => d.participants.includes(myId) && d.participants.includes(otherId),
  );
  if (!conv) {
    conv = { id: uuidv4(), participants: [myId, otherId], createdAt: new Date().toISOString() };
    db.dms.push(conv);
    writeDb(db);
  }
  res.json({ conversation: conv });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

app.get("/groups", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const groups = db.groups.filter((g) => g.members.includes(userId));
  res.json({ groups });
});

app.post("/groups", requireAuth, (req: Request, res: Response): void => {
  const { name, memberIds } = req.body as { name?: string; memberIds?: string[] };
  if (!name) { res.status(400).json({ error: "Group name required" }); return; }
  const db = readDb();
  const userId = req.session!.userId;
  const members = [userId, ...(memberIds || []).filter((id) => id !== userId)];
  const group = {
    id: uuidv4(),
    name: escapeHtml(name.slice(0, 50)),
    icon: "👥",
    owner: userId,
    members,
    createdAt: new Date().toISOString(),
  };
  db.groups.push(group);
  writeDb(db);
  res.json({ group });
});

app.put("/groups/:id", requireAuth, (req: Request, res: Response): void => {
  const { name, icon } = req.body as { name?: string; icon?: string };
  const db = readDb();
  const userId = req.session!.userId;
  const idx = db.groups.findIndex((g) => g.id === req.params["id"]);
  if (idx === -1) { res.status(404).json({ error: "Group not found" }); return; }
  const group = db.groups[idx]!;
  if (group.owner !== userId) { res.status(403).json({ error: "Forbidden" }); return; }
  if (name) group.name = escapeHtml(name.slice(0, 50));
  if (icon) group.icon = icon;
  writeDb(db);
  res.json({ group });
});

app.post("/groups/:id/members/:userId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const idx = db.groups.findIndex((g) => g.id === req.params["id"]);
  if (idx === -1) { res.status(404).json({ error: "Group not found" }); return; }
  const group = db.groups[idx]!;
  if (group.owner !== myId) { res.status(403).json({ error: "Forbidden" }); return; }
  const newMember = req.params["userId"];
  if (!group.members.includes(newMember)) group.members.push(newMember);
  writeDb(db);
  res.json({ group });
});

app.delete("/groups/:id/members/:userId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const idx = db.groups.findIndex((g) => g.id === req.params["id"]);
  if (idx === -1) { res.status(404).json({ error: "Group not found" }); return; }
  const group = db.groups[idx]!;
  if (group.owner !== myId && myId !== req.params["userId"]) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  group.members = group.members.filter((m) => m !== req.params["userId"]);
  if (group.members.length === 0) {
    db.groups.splice(idx, 1);
    db.groupMessages = db.groupMessages.filter((m) => m.groupId !== group.id);
  }
  writeDb(db);
  res.json({ ok: true });
});

app.get("/groups/:id/messages", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const group = db.groups.find((g) => g.id === req.params["id"]);
  if (!group) { res.status(404).json({ error: "Group not found" }); return; }
  if (!group.members.includes(userId)) { res.status(403).json({ error: "Forbidden" }); return; }
  const msgs = db.groupMessages
    .filter((m) => m.groupId === group.id)
    .slice(-100)
    .map((m) => {
      const author = db.users.find((u) => u.id === m.authorId);
      return { ...m, author: author ? safeUser(author) : null };
    });
  res.json({ messages: msgs });
});

// ─── Friends ──────────────────────────────────────────────────────────────────

app.get("/friends", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const friends = db.friendships
    .filter((f) => f.userA === userId || f.userB === userId)
    .map((f) => {
      const friendId = f.userA === userId ? f.userB : f.userA;
      const friend = db.users.find((u) => u.id === friendId);
      return friend ? { friendship: f, user: safeUser(friend) } : null;
    })
    .filter(Boolean);
  const requests = db.friendRequests.filter(
    (r) => (r.toId === userId || r.fromId === userId) && r.status === "pending",
  ).map((r) => {
    const from = db.users.find((u) => u.id === r.fromId);
    const to = db.users.find((u) => u.id === r.toId);
    return { ...r, from: from ? safeUser(from) : null, to: to ? safeUser(to) : null };
  });
  res.json({ friends, requests });
});

app.post("/friends/request/:userId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const toId = req.params["userId"];
  if (myId === toId) { res.status(400).json({ error: "Cannot friend yourself" }); return; }
  const existing = db.friendRequests.find(
    (r) => ((r.fromId === myId && r.toId === toId) || (r.fromId === toId && r.toId === myId)) && r.status === "pending",
  );
  if (existing) { res.status(409).json({ error: "Request already sent" }); return; }
  const alreadyFriends = db.friendships.some(
    (f) => (f.userA === myId && f.userB === toId) || (f.userB === myId && f.userA === toId),
  );
  if (alreadyFriends) { res.status(409).json({ error: "Already friends" }); return; }
  const request = {
    id: uuidv4(),
    fromId: myId,
    toId,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };
  db.friendRequests.push(request);
  writeDb(db);
  const me = db.users.find((u) => u.id === myId);
  addNotification(toId, "friend_request", `${me?.displayName || me?.username} sent you a friend request`, { requestId: request.id, fromId: myId });
  res.json({ request });
});

app.post("/friends/accept/:requestId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const rIdx = db.friendRequests.findIndex((r) => r.id === req.params["requestId"]);
  if (rIdx === -1) { res.status(404).json({ error: "Request not found" }); return; }
  const req2 = db.friendRequests[rIdx]!;
  if (req2.toId !== userId) { res.status(403).json({ error: "Forbidden" }); return; }
  req2.status = "accepted";
  const friendship = { id: uuidv4(), userA: req2.fromId, userB: req2.toId, createdAt: new Date().toISOString() };
  db.friendships.push(friendship);
  writeDb(db);
  const me = db.users.find((u) => u.id === userId);
  addNotification(req2.fromId, "friend_accepted", `${me?.displayName || me?.username} accepted your friend request`, { friendId: userId });
  res.json({ friendship });
});

app.post("/friends/reject/:requestId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const rIdx = db.friendRequests.findIndex((r) => r.id === req.params["requestId"]);
  if (rIdx === -1) { res.status(404).json({ error: "Request not found" }); return; }
  const req2 = db.friendRequests[rIdx]!;
  if (req2.toId !== userId) { res.status(403).json({ error: "Forbidden" }); return; }
  req2.status = "rejected";
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/friends/:userId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const myId = req.session!.userId;
  const otherId = req.params["userId"];
  db.friendships = db.friendships.filter(
    (f) => !((f.userA === myId && f.userB === otherId) || (f.userB === myId && f.userA === otherId)),
  );
  writeDb(db);
  res.json({ ok: true });
});

// ─── Notifications ────────────────────────────────────────────────────────────

app.get("/notifications", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const notifs = db.notifications.filter((n) => n.userId === userId).slice(-50).reverse();
  res.json({ notifications: notifs });
});

app.put("/notifications/read-all", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  db.notifications.forEach((n) => { if (n.userId === userId) n.read = true; });
  writeDb(db);
  res.json({ ok: true });
});

app.put("/notifications/:id/read", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const userId = req.session!.userId;
  const n = db.notifications.find((n) => n.id === req.params["id"] && n.userId === userId);
  if (n) { n.read = true; writeDb(db); }
  res.json({ ok: true });
});

// ─── Pinned Messages ──────────────────────────────────────────────────────────

app.get("/pinned/:serverId/:channelId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const pins = db.pinnedMessages
    .filter((p) => p.serverId === req.params["serverId"] && p.channelId === req.params["channelId"])
    .map((p) => {
      const pinner = db.users.find((u) => u.id === p.pinnedBy);
      return { ...p, pinner: pinner ? safeUser(pinner) : null };
    });
  res.json({ pinned: pins });
});

app.get("/pinned/dm/:conversationId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const pins = db.pinnedMessages.filter((p) => p.dmConversationId === req.params["conversationId"]);
  res.json({ pinned: pins });
});

app.get("/pinned/group/:groupId", requireAuth, (req: Request, res: Response): void => {
  const db = readDb();
  const pins = db.pinnedMessages.filter((p) => p.groupId === req.params["groupId"]);
  res.json({ pinned: pins });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

app.get("/admin/users", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const users = db.users.map((u) => {
    const isBannedUser = db.bans.some((b) => b.userId === u.id);
    const timeout = db.timeouts.find((t) => t.userId === u.id);
    return { ...safeUser(u), isBanned: isBannedUser, timeout: timeout || null };
  });
  res.json({ users });
});

app.post("/admin/ban/:userId", requireAdmin, (req: Request, res: Response): void => {
  const { reason } = req.body as { reason?: string };
  const db = readDb();
  const adminId = req.session!.userId;
  const admin = db.users.find((u) => u.id === adminId);
  const target = db.users.find((u) => u.id === req.params["userId"]);
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  if (db.bans.some((b) => b.userId === target.id)) {
    res.status(409).json({ error: "User already banned" }); return;
  }
  db.bans.push({
    id: uuidv4(),
    userId: target.id,
    username: target.username,
    reason: escapeHtml(reason || "No reason provided"),
    bannedBy: adminId,
    createdAt: new Date().toISOString(),
  });
  db.moderationLogs.push({
    id: uuidv4(),
    action: "ban",
    targetId: target.id,
    targetUsername: target.username,
    performedBy: admin?.username || adminId,
    reason: reason || "",
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/admin/ban/:userId", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const adminId = req.session!.userId;
  const admin = db.users.find((u) => u.id === adminId);
  const target = db.users.find((u) => u.id === req.params["userId"]);
  db.bans = db.bans.filter((b) => b.userId !== req.params["userId"]);
  db.moderationLogs.push({
    id: uuidv4(),
    action: "unban",
    targetId: req.params["userId"]!,
    targetUsername: target?.username || req.params["userId"]!,
    performedBy: admin?.username || adminId,
    reason: "",
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
  res.json({ ok: true });
});

app.post("/admin/timeout/:userId", requireAdmin, (req: Request, res: Response): void => {
  const { minutes, reason } = req.body as { minutes?: number; reason?: string };
  const db = readDb();
  const adminId = req.session!.userId;
  const admin = db.users.find((u) => u.id === adminId);
  const target = db.users.find((u) => u.id === req.params["userId"]);
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  db.timeouts = db.timeouts.filter((t) => t.userId !== target.id);
  const expiresAt = new Date(Date.now() + (minutes || 5) * 60 * 1000).toISOString();
  db.timeouts.push({
    id: uuidv4(),
    userId: target.id,
    reason: escapeHtml(reason || ""),
    expiresAt,
    createdAt: new Date().toISOString(),
  });
  db.moderationLogs.push({
    id: uuidv4(),
    action: "timeout",
    targetId: target.id,
    targetUsername: target.username,
    performedBy: admin?.username || adminId,
    reason: reason || "",
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/admin/timeout/:userId", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  db.timeouts = db.timeouts.filter((t) => t.userId !== req.params["userId"]);
  writeDb(db);
  res.json({ ok: true });
});

app.post("/admin/verify/:userId/blue", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.params["userId"]);
  if (idx === -1) { res.status(404).json({ error: "User not found" }); return; }
  db.users[idx]!.verified = true;
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/admin/verify/:userId/blue", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.params["userId"]);
  if (idx === -1) { res.status(404).json({ error: "User not found" }); return; }
  db.users[idx]!.verified = false;
  writeDb(db);
  res.json({ ok: true });
});

app.post("/admin/verify/:userId/gold", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.params["userId"]);
  if (idx === -1) { res.status(404).json({ error: "User not found" }); return; }
  db.users[idx]!.goldVerified = true;
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/admin/verify/:userId/gold", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === req.params["userId"]);
  if (idx === -1) { res.status(404).json({ error: "User not found" }); return; }
  db.users[idx]!.goldVerified = false;
  writeDb(db);
  res.json({ ok: true });
});

app.delete("/admin/message/:messageId", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  const adminId = req.session!.userId;
  const admin = db.users.find((u) => u.id === adminId);
  const msg = db.messages.find((m) => m.id === req.params["messageId"]);
  db.messages = db.messages.filter((m) => m.id !== req.params["messageId"]);
  db.moderationLogs.push({
    id: uuidv4(),
    action: "delete_message",
    targetId: req.params["messageId"]!,
    targetUsername: msg?.authorId || "",
    performedBy: admin?.username || adminId,
    reason: "Admin deletion",
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
  res.json({ ok: true });
});

app.get("/admin/logs", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  res.json({ logs: db.moderationLogs.slice(-200).reverse() });
});

app.get("/admin/bans", requireAdmin, (req: Request, res: Response): void => {
  const db = readDb();
  res.json({ bans: db.bans });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/healthz", (_req: Request, res: Response): void => { res.json({ ok: true }); });

// ─── Static files (serve last) ────────────────────────────────────────────────
app.use(express.static(join(__dirname, "..", "public")));

app.get("/{*path}", (_req: Request, res: Response): void => {
  res.sendFile(join(__dirname, "..", "public", "index.html"));
});

export default app;
