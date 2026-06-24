import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "database.json");

export interface User {
  id: string;
  username: string;
  displayName: string;
  password: string;
  avatar: string;
  banner: string;
  bio: string;
  status: "online" | "idle" | "dnd" | "offline";
  isAdmin: boolean;
  verified: boolean;
  goldVerified: boolean;
  joinDate: string;
  createdAt: string;
  servers: string[];
}

export interface ChatServer {
  id: string;
  name: string;
  description: string;
  icon: string;
  owner: string;
  members: string[];
  channels: string[];
  createdAt: string;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  createdAt: string;
}

export interface Message {
  id: string;
  serverId: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: string;
  edited: boolean;
}

export interface DMConversation {
  id: string;
  participants: string[];
  createdAt: string;
}

export interface DMMessage {
  id: string;
  conversationId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  icon: string;
  owner: string;
  members: string[];
  createdAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface FriendRequest {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface Friendship {
  id: string;
  userA: string;
  userB: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: string;
  content: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface Ban {
  id: string;
  userId: string;
  username: string;
  reason: string;
  bannedBy: string;
  createdAt: string;
}

export interface Timeout {
  id: string;
  userId: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
}

export interface PinnedMessage {
  id: string;
  messageId: string;
  serverId: string | null;
  channelId: string | null;
  dmConversationId: string | null;
  groupId: string | null;
  pinnedBy: string;
  messageData: Message | DMMessage | GroupMessage;
  createdAt: string;
}

export interface ModerationLog {
  id: string;
  action: string;
  targetId: string;
  targetUsername: string;
  performedBy: string;
  reason: string;
  createdAt: string;
}

export interface Database {
  users: User[];
  servers: ChatServer[];
  channels: Channel[];
  messages: Message[];
  dms: DMConversation[];
  dmMessages: DMMessage[];
  groups: Group[];
  groupMessages: GroupMessage[];
  friendRequests: FriendRequest[];
  friendships: Friendship[];
  notifications: Notification[];
  bans: Ban[];
  timeouts: Timeout[];
  pinnedMessages: PinnedMessage[];
  moderationLogs: ModerationLog[];
}

const defaultDb: Database = {
  users: [],
  servers: [],
  channels: [],
  messages: [],
  dms: [],
  dmMessages: [],
  groups: [],
  groupMessages: [],
  friendRequests: [],
  friendships: [],
  notifications: [],
  bans: [],
  timeouts: [],
  pinnedMessages: [],
  moderationLogs: [],
};

export function readDb(): Database {
  if (!existsSync(DB_PATH)) {
    writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2));
    return { ...defaultDb, users: [], servers: [], channels: [], messages: [], dms: [], dmMessages: [], groups: [], groupMessages: [], friendRequests: [], friendships: [], notifications: [], bans: [], timeouts: [], pinnedMessages: [], moderationLogs: [] };
  }
  try {
    const raw = readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaultDb, ...parsed };
  } catch {
    return { ...defaultDb };
  }
}

export function writeDb(data: Database): void {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export async function initDb(): Promise<void> {
  const db = readDb();
  if (!db.users.find((u) => u.username.toLowerCase() === "admin")) {
    const hashed = await bcrypt.hash("whatthesigma", 12);
    const adminId = uuidv4();
    const serverId = uuidv4();
    const ch1 = uuidv4();
    const ch2 = uuidv4();
    const ch3 = uuidv4();

    db.users.push({
      id: adminId,
      username: "Admin",
      displayName: "Admin",
      password: hashed,
      avatar: "",
      banner: "",
      bio: "Platform Administrator",
      status: "online",
      isAdmin: true,
      verified: true,
      goldVerified: true,
      joinDate: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      servers: [serverId],
    });

    db.servers.push({
      id: serverId,
      name: "Sigma Chat",
      description: "The official Sigma Chat server",
      icon: "🚀",
      owner: adminId,
      members: [adminId],
      channels: [ch1, ch2, ch3],
      createdAt: new Date().toISOString(),
    });

    db.channels.push(
      { id: ch1, serverId, name: "general", createdAt: new Date().toISOString() },
      { id: ch2, serverId, name: "gaming", createdAt: new Date().toISOString() },
      { id: ch3, serverId, name: "memes", createdAt: new Date().toISOString() },
    );

    writeDb(db);
  }
}

export { uuidv4 };
