/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  me: null,
  currentView: 'dm',    // 'dm' | 'server'
  currentServer: null,
  currentChannel: null,
  currentDMUser: null,
  currentGroup: null,
  servers: [],
  friends: [],
  friendRequests: [],
  dms: [],
  groups: [],
  notifications: [],
  typingTimeouts: {},
  typingUsers: {},
  memberListOpen: true,
};

const socket = io({ transports: ['websocket', 'polling'] });

/* ── API helpers ─────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ── Init ────────────────────────────────────────────────────────────── */
async function init() {
  try {
    const { user } = await api('GET', '/auth/me');
    state.me = user;
    document.getElementById('app').classList.remove('hidden');
    renderUserBar();
    await Promise.all([loadServers(), loadDMs(), loadNotifications()]);
    renderServerDock();
    showDMView();
    setupSocketHandlers();
  } catch {
    window.location.href = '/login.html';
  }
}

/* ── User bar ────────────────────────────────────────────────────────── */
function renderUserBar() {
  const u = state.me;
  document.getElementById('my-username').textContent = u.displayName || u.username;
  document.getElementById('my-tag').textContent = u.username;
  const av = document.getElementById('my-avatar');
  setAvatar(av, u);
  const dot = document.getElementById('my-status-dot');
  dot.className = `status-dot status-${u.status}`;
}

function setAvatar(el, user) {
  if (user.avatar) {
    el.innerHTML = `<img src="${user.avatar}" alt="" onerror="this.parentElement.textContent='${getInitial(user)}'" />`;
  } else {
    el.textContent = getInitial(user);
    el.style.background = strToColor(user.id);
  }
}

function getInitial(user) { return (user.displayName || user.username || '?').charAt(0).toUpperCase(); }
function strToColor(str) {
  const colors = ['#5865f2','#eb459e','#23a559','#f0b232','#e91e63','#9c27b0','#00bcd4','#ff5722'];
  let h = 0; for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

function getBadgesHtml(user) {
  let b = '';
  if (user.isAdmin) b += '<span class="badge badge-admin" title="Admin">🛡</span>';
  if (user.goldVerified) b += '<span class="badge badge-gold" title="Gold Verified">⭐</span>';
  if (user.verified) b += '<span class="badge badge-verified" title="Verified">✓</span>';
  return b;
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatFull(iso) {
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

/* ── Loaders ─────────────────────────────────────────────────────────── */
async function loadServers() {
  try {
    const { servers } = await api('GET', '/servers');
    state.servers = servers;
  } catch { state.servers = []; }
}

async function loadDMs() {
  try {
    const { conversations } = await api('GET', '/dms');
    state.dms = conversations;
    const { groups } = await api('GET', '/groups');
    state.groups = groups;
    const { friends, requests } = await api('GET', '/friends');
    state.friends = friends;
    state.friendRequests = requests;
  } catch { }
}

async function loadNotifications() {
  try {
    const { notifications } = await api('GET', '/notifications');
    state.notifications = notifications;
    updateNotifBadge();
  } catch { }
}

/* ── Server Dock ─────────────────────────────────────────────────────── */
function renderServerDock() {
  const list = document.getElementById('server-list');
  list.innerHTML = '';
  state.servers.forEach((srv) => {
    const div = document.createElement('div');
    div.className = `dock-item tooltip-wrap${state.currentServer?.id === srv.id ? ' active' : ''}`;
    div.dataset.serverId = srv.id;
    div.innerHTML = `
      <div class="dock-item-indicator"></div>
      <span class="dock-icon">${srv.icon || '🌐'}</span>
      <span class="tooltip-label">${srv.name}</span>
    `;
    div.addEventListener('click', () => selectServer(srv.id));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); showServerContextMenu(e, srv); });
    list.appendChild(div);
  });
}

async function selectServer(serverId) {
  try {
    const { server, members, channels } = await api('GET', `/servers/${serverId}`);
    state.currentServer = server;
    state.currentView = 'server';
    state.currentDMUser = null;
    state.currentGroup = null;
    renderServerDock();
    renderServerSidebar(server, channels, members);
    if (channels.length > 0) {
      selectChannel(channels[0]);
    } else {
      clearChat('No channels yet');
    }
    socket.emit('join-server', serverId);
  } catch (err) { showError(err.message); }
}

function renderServerSidebar(server, channels, members) {
  document.getElementById('sidebar-title').textContent = server.name;
  const btn = document.getElementById('btn-sidebar-action');
  const isOwner = server.owner === state.me.id || state.me.isAdmin;
  btn.textContent = isOwner ? '+' : '';
  btn.title = 'Create Channel';
  btn.onclick = isOwner ? () => showCreateChannelModal() : null;
  btn.style.visibility = isOwner ? 'visible' : 'hidden';

  const content = document.getElementById('sidebar-content');
  content.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sidebar-section-label';
  label.innerHTML = `<span>CHANNELS</span>${isOwner ? '<span class="sidebar-section-add" id="quick-add-channel" title="Create Channel">+</span>' : ''}`;
  content.appendChild(label);
  if (isOwner) {
    label.querySelector('#quick-add-channel')?.addEventListener('click', showCreateChannelModal);
  }

  channels.forEach((ch) => {
    const item = document.createElement('div');
    item.className = `sidebar-item${state.currentChannel?.id === ch.id ? ' active' : ''}`;
    item.innerHTML = `<span class="sidebar-item-icon">#</span><span class="sidebar-item-name">${ch.name}</span>`;
    item.addEventListener('click', () => selectChannel(ch));
    if (isOwner) {
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); showChannelContextMenu(e, ch); });
    }
    content.appendChild(item);
  });

  renderMemberList(members);
}

function selectChannel(channel) {
  state.currentChannel = channel;
  document.getElementById('chat-header-icon').textContent = '#';
  document.getElementById('chat-header-name').textContent = channel.name;
  document.getElementById('message-input').placeholder = `Message #${channel.name}`;
  updateActiveChannelInSidebar();
  loadChannelMessages(channel);
  socket.emit('join-channel', { serverId: state.currentServer.id, channelId: channel.id });
}

function updateActiveChannelInSidebar() {
  document.querySelectorAll('#sidebar-content .sidebar-item').forEach((el) => {
    const name = el.querySelector('.sidebar-item-name')?.textContent;
    el.classList.toggle('active', name === state.currentChannel?.name);
  });
}

async function loadChannelMessages(channel) {
  const list = document.getElementById('messages-list');
  list.innerHTML = '';
  clearTyping();
  const banner = document.createElement('div');
  banner.className = 'messages-start-banner';
  banner.innerHTML = `<div style="font-size:48px;margin-bottom:8px">#</div><h3>${channel.name}</h3><p>This is the beginning of the #${channel.name} channel.</p>`;
  list.appendChild(banner);
  try {
    const { messages } = await api('GET', `/messages/${state.currentServer.id}/${channel.id}`);
    renderMessages(messages, list);
  } catch { }
  scrollToBottom();
}

function renderMessages(msgs, container) {
  let prevAuthorId = null;
  msgs.forEach((msg) => {
    const isContinued = msg.authorId === prevAuthorId;
    container.appendChild(buildMessageEl(msg, isContinued));
    prevAuthorId = msg.authorId;
  });
}

function buildMessageEl(msg, continued = false) {
  const div = document.createElement('div');
  div.className = `message-group${continued ? ' msg-continued' : ''}`;
  div.dataset.messageId = msg.id;
  const author = msg.author || {};
  const isOwn = msg.authorId === state.me.id;
  const isAdmin = state.me.isAdmin;
  const canPin = !!(state.currentServer && (state.currentServer.owner === state.me.id || isAdmin));

  const actionsHtml = `
    <div class="msg-actions">
      ${canPin ? `<button class="msg-action-btn" onclick="pinMessage('${msg.id}')" title="Pin">📌</button>` : ''}
      ${(isOwn || isAdmin) ? `<button class="msg-action-btn danger" onclick="deleteMessage('${msg.id}')" title="Delete">🗑</button>` : ''}
      <button class="msg-action-btn" onclick="openProfile('${msg.authorId}')" title="Profile">👤</button>
    </div>`;

  div.innerHTML = `
    <div class="msg-avatar" onclick="openProfile('${msg.authorId}')">${getAvatarHtml(author)}</div>
    <div class="msg-content-wrap">
      <div class="msg-header">
        <span class="msg-author" onclick="openProfile('${msg.authorId}')">${author.displayName || author.username || 'Unknown'}</span>
        <span class="msg-badges">${getBadgesHtml(author)}</span>
        <span class="msg-time">${formatTime(msg.createdAt)}</span>
      </div>
      <div class="msg-text">${msg.content}</div>
    </div>
    ${actionsHtml}`;
  return div;
}

function getAvatarHtml(user) {
  if (!user || !user.id) return '?';
  if (user.avatar) return `<img src="${user.avatar}" alt="" onerror="this.style.display='none'" />`;
  const init = getInitial(user);
  return `<span style="background:${strToColor(user.id || '')};width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px">${init}</span>`;
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  setTimeout(() => { area.scrollTop = area.scrollHeight; }, 50);
}

function clearChat(msg = 'Select a channel to start chatting') {
  document.getElementById('messages-list').innerHTML = `<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-text">${msg}</div></div>`;
  document.getElementById('chat-header-name').textContent = 'Select a channel';
  document.getElementById('chat-header-icon').textContent = '';
}

/* ── DM View ─────────────────────────────────────────────────────────── */
function showDMView() {
  state.currentView = 'dm';
  state.currentServer = null;
  state.currentChannel = null;
  renderServerDock();
  renderDMSidebar();
  clearChat('Open a DM to start chatting');
  document.getElementById('members-content').innerHTML = '';
  document.getElementById('member-list').querySelector('.member-list-header').textContent = 'Active Now';
  document.getElementById('btn-home').classList.add('active');
}

function renderDMSidebar() {
  document.getElementById('sidebar-title').textContent = 'Direct Messages';
  document.getElementById('btn-sidebar-action').textContent = '✏';
  document.getElementById('btn-sidebar-action').title = 'New DM';
  document.getElementById('btn-sidebar-action').style.visibility = 'visible';
  document.getElementById('btn-sidebar-action').onclick = () => openSearchModal('dm');

  const content = document.getElementById('sidebar-content');
  content.innerHTML = '';

  // Friends section
  const flabel = document.createElement('div');
  flabel.className = 'sidebar-section-label';
  const pendingCount = state.friendRequests.filter(r => r.toId === state.me.id).length;
  flabel.innerHTML = `<span>FRIENDS ${pendingCount > 0 ? `<span class="sidebar-item-badge">${pendingCount}</span>` : ''}</span>`;
  content.appendChild(flabel);

  const friendsItem = document.createElement('div');
  friendsItem.className = 'sidebar-item';
  friendsItem.innerHTML = `<span class="sidebar-item-icon">👥</span><span class="sidebar-item-name">Friends</span>`;
  friendsItem.addEventListener('click', showFriendsView);
  content.appendChild(friendsItem);

  // Groups
  if (state.groups.length > 0) {
    const glabel = document.createElement('div');
    glabel.className = 'sidebar-section-label';
    glabel.innerHTML = `<span>GROUP CHATS</span><span class="sidebar-section-add" title="New Group">+</span>`;
    glabel.querySelector('span:last-child').addEventListener('click', showCreateGroupModal);
    content.appendChild(glabel);
    state.groups.forEach((g) => {
      const item = document.createElement('div');
      item.className = `sidebar-item${state.currentGroup?.id === g.id ? ' active' : ''}`;
      item.innerHTML = `<span class="sidebar-item-icon">${g.icon}</span><span class="sidebar-item-name">${g.name}</span>`;
      item.addEventListener('click', () => openGroupChat(g));
      content.appendChild(item);
    });
  }

  // DMs
  const dlabel = document.createElement('div');
  dlabel.className = 'sidebar-section-label';
  dlabel.innerHTML = `<span>DIRECT MESSAGES</span>`;
  content.appendChild(dlabel);

  if (state.dms.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 16px;color:var(--text-muted);font-size:13px;';
    empty.textContent = 'No DMs yet';
    content.appendChild(empty);
  } else {
    state.dms.forEach((conv) => {
      if (!conv.other) return;
      const item = document.createElement('div');
      item.className = `sidebar-item${state.currentDMUser?.id === conv.other.id ? ' active' : ''}`;
      const avatarDiv = document.createElement('div');
      avatarDiv.className = 'dm-item-avatar';
      setAvatar(avatarDiv, conv.other);
      item.appendChild(avatarDiv);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sidebar-item-name';
      nameSpan.textContent = conv.other.displayName || conv.other.username;
      item.appendChild(nameSpan);
      const dotSpan = document.createElement('span');
      dotSpan.className = `dm-status-dot status-${conv.other.status || 'offline'}`;
      item.appendChild(dotSpan);
      item.addEventListener('click', () => openDM(conv.other));
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); showDMContextMenu(e, conv.other); });
      content.appendChild(item);
    });
  }
}

async function openDM(user) {
  state.currentDMUser = user;
  state.currentGroup = null;
  state.currentChannel = null;
  renderDMSidebar();
  document.getElementById('chat-header-icon').textContent = '';
  document.getElementById('chat-header-name').innerHTML = `<span>${user.displayName || user.username}</span><span style="font-size:12px;color:var(--text-4);margin-left:6px;">${getBadgesHtml(user)}</span>`;
  document.getElementById('message-input').placeholder = `Message ${user.displayName || user.username}`;
  clearTyping();
  socket.emit('join-dm', user.id);
  await api('POST', `/dms/${user.id}`);
  try {
    const { messages, conversationId } = await api('GET', `/dms/${user.id}/messages`);
    const list = document.getElementById('messages-list');
    list.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'messages-start-banner';
    banner.innerHTML = `<div style="font-size:48px;margin-bottom:8px">💬</div><h3>@${user.username}</h3><p>Beginning of your DM with ${user.displayName || user.username}</p>`;
    list.appendChild(banner);
    renderDMMessages(messages);
    scrollToBottom();
    // Update state.dms with conversationId
    if (conversationId && !state.dms.find(d => d.id === conversationId)) {
      await loadDMs();
      renderDMSidebar();
    }
  } catch { }
  updateMemberListDM(user);
}

function renderDMMessages(msgs) {
  const list = document.getElementById('messages-list');
  let prevAuthorId = null;
  msgs.forEach((msg) => {
    const isContinued = msg.authorId === prevAuthorId;
    list.appendChild(buildDMMessageEl(msg, isContinued));
    prevAuthorId = msg.authorId;
  });
}

function buildDMMessageEl(msg, continued = false) {
  const div = document.createElement('div');
  div.className = `message-group${continued ? ' msg-continued' : ''}`;
  div.dataset.messageId = msg.id;
  const author = msg.author || {};
  div.innerHTML = `
    <div class="msg-avatar" onclick="openProfile('${msg.authorId}')">${getAvatarHtml(author)}</div>
    <div class="msg-content-wrap">
      <div class="msg-header">
        <span class="msg-author" onclick="openProfile('${msg.authorId}')">${author.displayName || author.username || 'Unknown'}</span>
        <span class="msg-badges">${getBadgesHtml(author)}</span>
        <span class="msg-time">${formatTime(msg.createdAt)}</span>
      </div>
      <div class="msg-text">${msg.content}</div>
    </div>`;
  return div;
}

function updateMemberListDM(user) {
  const members = document.getElementById('members-content');
  members.innerHTML = '';
  const header = document.getElementById('member-list').querySelector('.member-list-header');
  header.textContent = 'Members — 1';
  const item = document.createElement('div');
  item.className = 'member-item';
  const av = document.createElement('div');
  av.className = 'member-avatar';
  setAvatar(av, user);
  const dot = document.createElement('div');
  dot.className = `member-status-dot status-${user.status || 'offline'}`;
  av.appendChild(dot);
  const nameEl = document.createElement('span');
  nameEl.className = 'member-name';
  nameEl.textContent = user.displayName || user.username;
  item.appendChild(av);
  item.appendChild(nameEl);
  item.addEventListener('click', () => openProfile(user.id));
  members.appendChild(item);
}

async function openGroupChat(group) {
  state.currentGroup = group;
  state.currentDMUser = null;
  state.currentChannel = null;
  renderDMSidebar();
  document.getElementById('chat-header-icon').textContent = group.icon;
  document.getElementById('chat-header-name').textContent = group.name;
  document.getElementById('message-input').placeholder = `Message ${group.name}`;
  clearTyping();
  socket.emit('join-group', group.id);
  try {
    const { messages } = await api('GET', `/groups/${group.id}/messages`);
    const list = document.getElementById('messages-list');
    list.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'messages-start-banner';
    banner.innerHTML = `<div style="font-size:48px;margin-bottom:8px">${group.icon}</div><h3>${group.name}</h3><p>Beginning of ${group.name}</p>`;
    list.appendChild(banner);
    renderDMMessages(messages);
    scrollToBottom();
  } catch { }
}

/* ── Friends View ────────────────────────────────────────────────────── */
function showFriendsView() {
  state.currentDMUser = null; state.currentGroup = null; state.currentChannel = null;
  document.getElementById('chat-header-icon').textContent = '👥';
  document.getElementById('chat-header-name').textContent = 'Friends';
  const list = document.getElementById('messages-list');
  list.innerHTML = '';

  const incoming = state.friendRequests.filter(r => r.toId === state.me.id);
  const outgoing = state.friendRequests.filter(r => r.fromId === state.me.id);

  if (incoming.length > 0) {
    const section = document.createElement('div');
    section.innerHTML = `<div class="member-category">INCOMING REQUESTS — ${incoming.length}</div>`;
    incoming.forEach((req) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;';
      const av = document.createElement('div');
      av.className = 'member-avatar';
      if (req.from) { setAvatar(av, req.from); }
      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = `<div style="font-weight:600;color:var(--text-1)">${req.from?.displayName || req.from?.username || 'Unknown'}</div>`;
      const accept = document.createElement('button');
      accept.className = 'btn-primary'; accept.textContent = 'Accept';
      accept.style.cssText = 'padding:6px 14px;border-radius:4px;font-size:13px;font-weight:600;margin-right:4px;';
      accept.onclick = async () => {
        try {
          await api('POST', `/friends/accept/${req.id}`);
          await Promise.all([loadDMs(), loadNotifications()]);
          showFriendsView();
          renderDMSidebar();
        } catch(e) { showError(e.message); }
      };
      const reject = document.createElement('button');
      reject.className = 'btn-secondary'; reject.textContent = 'Decline';
      reject.style.cssText = 'padding:6px 14px;border-radius:4px;font-size:13px;font-weight:600;';
      reject.onclick = async () => {
        try {
          await api('POST', `/friends/reject/${req.id}`);
          await loadDMs(); showFriendsView(); renderDMSidebar();
        } catch(e) { showError(e.message); }
      };
      row.appendChild(av); row.appendChild(info); row.appendChild(accept); row.appendChild(reject);
      section.appendChild(row);
    });
    list.appendChild(section);
  }

  const friendsSection = document.createElement('div');
  friendsSection.innerHTML = `<div class="member-category">ALL FRIENDS — ${state.friends.length}</div>`;
  if (state.friends.length === 0) {
    friendsSection.innerHTML += '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No friends yet. Search for users to add!</div>';
  } else {
    state.friends.forEach(({ user }) => {
      if (!user) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;';
      const av = document.createElement('div');
      av.className = 'member-avatar';
      setAvatar(av, user);
      const dot = document.createElement('div');
      dot.className = `member-status-dot status-${user.status || 'offline'}`;
      av.appendChild(dot);
      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = `<div style="font-weight:600;color:var(--text-1)">${user.displayName || user.username}</div><div style="font-size:12px;color:var(--text-4)">${user.username}</div>`;
      const msgBtn = document.createElement('button');
      msgBtn.className = 'btn-primary'; msgBtn.textContent = 'Message';
      msgBtn.style.cssText = 'padding:6px 12px;border-radius:4px;font-size:12px;font-weight:600;margin-right:4px;';
      msgBtn.onclick = (e) => { e.stopPropagation(); openDM(user); };
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-danger'; removeBtn.textContent = 'Remove';
      removeBtn.style.cssText = 'padding:6px 12px;border-radius:4px;font-size:12px;font-weight:600;';
      removeBtn.onclick = async (e) => {
        e.stopPropagation();
        await api('DELETE', `/friends/${user.id}`);
        await loadDMs(); showFriendsView(); renderDMSidebar();
      };
      row.appendChild(av); row.appendChild(info); row.appendChild(msgBtn); row.appendChild(removeBtn);
      row.addEventListener('click', () => openProfile(user.id));
      friendsSection.appendChild(row);
    });
  }
  list.appendChild(friendsSection);

  const addSection = document.createElement('div');
  addSection.innerHTML = `<div class="member-category">ADD FRIEND</div>`;
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = 'Search users to add...';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.style.cssText = 'padding:8px 16px;border-radius:4px;font-size:13px;font-weight:600;white-space:nowrap;';
  addBtn.textContent = 'Search';
  searchWrap.appendChild(input); searchWrap.appendChild(addBtn);
  const results = document.createElement('div');
  results.className = 'search-results';
  addSection.appendChild(searchWrap); addSection.appendChild(results);
  addBtn.onclick = async () => {
    const q = input.value.trim(); if (!q) return;
    try {
      const { users } = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      users.filter(u => u.id !== state.me.id).forEach(u => {
        const row = buildSearchResult(u);
        results.appendChild(row);
      });
      if (users.length === 0) results.innerHTML = '<div style="color:var(--text-muted);padding:8px;font-size:13px;">No users found</div>';
    } catch { }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
  list.appendChild(addSection);
}

function buildSearchResult(u) {
  const row = document.createElement('div');
  row.className = 'search-result-item';
  const av = document.createElement('div');
  av.className = 'search-avatar'; setAvatar(av, u);
  const info = document.createElement('div');
  info.className = 'search-info';
  info.innerHTML = `<div class="search-name">${u.displayName || u.username}</div><div class="search-username">@${u.username}</div>`;
  const actions = document.createElement('div');
  actions.className = 'search-actions';
  const isFriend = state.friends.some(f => f.user?.id === u.id);
  const hasPendingOut = state.friendRequests.some(r => r.fromId === state.me.id && r.toId === u.id);
  if (!isFriend && !hasPendingOut) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-primary search-action-btn'; addBtn.textContent = 'Add Friend';
    addBtn.onclick = async (e) => { e.stopPropagation(); try { await api('POST', `/friends/request/${u.id}`); addBtn.textContent = 'Sent!'; addBtn.disabled = true; await loadDMs(); renderDMSidebar(); } catch(err) { showError(err.message); } };
    actions.appendChild(addBtn);
  } else if (hasPendingOut) {
    const pBtn = document.createElement('button');
    pBtn.className = 'btn-secondary search-action-btn'; pBtn.textContent = 'Pending'; pBtn.disabled = true;
    actions.appendChild(pBtn);
  }
  const msgBtn = document.createElement('button');
  msgBtn.className = 'btn-secondary search-action-btn'; msgBtn.textContent = 'Message';
  msgBtn.onclick = (e) => { e.stopPropagation(); closeModal('modal-search'); openDM(u); };
  actions.appendChild(msgBtn);
  const profileBtn = document.createElement('button');
  profileBtn.className = 'btn-secondary search-action-btn'; profileBtn.textContent = 'Profile';
  profileBtn.onclick = (e) => { e.stopPropagation(); openProfile(u.id); };
  actions.appendChild(profileBtn);
  row.appendChild(av); row.appendChild(info); row.appendChild(actions);
  return row;
}

/* ── Member list for servers ─────────────────────────────────────────── */
function renderMemberList(members) {
  const content = document.getElementById('members-content');
  const header = document.getElementById('member-list').querySelector('.member-list-header');
  content.innerHTML = '';
  const online = members.filter(m => m.status !== 'offline');
  const offline = members.filter(m => m.status === 'offline');
  header.textContent = `Members — ${members.length}`;
  if (online.length > 0) {
    const cat = document.createElement('div');
    cat.className = 'member-category';
    cat.innerHTML = `<span class="online-count">ONLINE — ${online.length}</span>`;
    content.appendChild(cat);
    online.forEach(m => content.appendChild(buildMemberEl(m)));
  }
  if (offline.length > 0) {
    const cat = document.createElement('div');
    cat.className = 'member-category';
    cat.innerHTML = `<span class="offline-count">OFFLINE — ${offline.length}</span>`;
    content.appendChild(cat);
    offline.forEach(m => content.appendChild(buildMemberEl(m)));
  }
}

function buildMemberEl(user) {
  const item = document.createElement('div');
  item.className = 'member-item';
  item.dataset.userId = user.id;
  const av = document.createElement('div');
  av.className = 'member-avatar';
  setAvatar(av, user);
  const dot = document.createElement('div');
  dot.className = `member-status-dot status-${user.status || 'offline'}`;
  av.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'member-name';
  name.textContent = user.displayName || user.username;
  const badges = document.createElement('div');
  badges.className = 'member-badges';
  badges.innerHTML = getBadgesHtml(user);
  item.appendChild(av); item.appendChild(name); item.appendChild(badges);
  item.addEventListener('click', () => openProfile(user.id));
  return item;
}

/* ── Sending messages ────────────────────────────────────────────────── */
function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  if (state.currentView === 'server' && state.currentServer && state.currentChannel) {
    socket.emit('send-message', { serverId: state.currentServer.id, channelId: state.currentChannel.id, content });
    socket.emit('typing-stop', { serverId: state.currentServer.id, channelId: state.currentChannel.id });
  } else if (state.currentDMUser) {
    socket.emit('send-dm', { toUserId: state.currentDMUser.id, content });
    socket.emit('typing-dm-stop', state.currentDMUser.id);
  } else if (state.currentGroup) {
    socket.emit('send-group-message', { groupId: state.currentGroup.id, content });
    socket.emit('typing-group-stop', state.currentGroup.id);
  } else {
    return;
  }
  input.value = '';
  input.style.height = 'auto';
}

let typingTimer = null;
function handleTyping() {
  if (typingTimer) { clearTimeout(typingTimer); }
  if (state.currentView === 'server' && state.currentServer && state.currentChannel) {
    socket.emit('typing-start', { serverId: state.currentServer.id, channelId: state.currentChannel.id });
    typingTimer = setTimeout(() => socket.emit('typing-stop', { serverId: state.currentServer.id, channelId: state.currentChannel.id }), 3000);
  } else if (state.currentDMUser) {
    socket.emit('typing-dm-start', state.currentDMUser.id);
    typingTimer = setTimeout(() => socket.emit('typing-dm-stop', state.currentDMUser.id), 3000);
  } else if (state.currentGroup) {
    socket.emit('typing-group-start', state.currentGroup.id);
    typingTimer = setTimeout(() => socket.emit('typing-group-stop', state.currentGroup.id), 3000);
  }
}

/* ── Profile Modal ───────────────────────────────────────────────────── */
async function openProfile(userId) {
  try {
    const { user } = await api('GET', `/users/${userId}`);
    const card = document.getElementById('profile-card');
    const banner = document.getElementById('profile-banner');
    if (user.banner) banner.style.backgroundImage = `url(${user.banner})`;
    else { banner.style.backgroundImage = ''; banner.style.background = strToColor(user.id); }
    const av = document.getElementById('profile-avatar');
    setAvatar(av, user);
    const statusDot = document.getElementById('profile-status-dot');
    statusDot.className = `status-dot status-${user.status}`;
    document.getElementById('profile-display-name').textContent = user.displayName || user.username;
    document.getElementById('profile-badges').innerHTML = getBadgesHtml(user);
    document.getElementById('profile-username').textContent = `@${user.username}`;
    document.getElementById('profile-bio').textContent = user.bio || '';
    document.getElementById('profile-joined').textContent = `Joined ${formatFull(user.joinDate || user.createdAt)}`;
    document.getElementById('profile-friends').textContent = `${user.friendCount || 0} friends`;
    if (user.mutualFriends > 0) document.getElementById('profile-mutual').textContent = `${user.mutualFriends} mutual`;
    else document.getElementById('profile-mutual').textContent = '';

    const actions = document.getElementById('profile-actions');
    actions.innerHTML = '';
    if (userId !== state.me.id) {
      const msgBtn = document.createElement('button');
      msgBtn.className = 'btn-primary'; msgBtn.textContent = 'Message';
      msgBtn.onclick = () => { card.classList.add('hidden'); openDM(user); };
      actions.appendChild(msgBtn);
      const isFriend = user.isFriend;
      const hasPending = state.friendRequests.some(r => r.fromId === state.me.id && r.toId === userId);
      if (isFriend) {
        const rfBtn = document.createElement('button');
        rfBtn.className = 'btn-secondary'; rfBtn.textContent = 'Remove Friend';
        rfBtn.onclick = async () => { await api('DELETE', `/friends/${userId}`); await loadDMs(); renderDMSidebar(); card.classList.add('hidden'); };
        actions.appendChild(rfBtn);
      } else if (!hasPending) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-secondary'; addBtn.textContent = 'Add Friend';
        addBtn.onclick = async () => { try { await api('POST', `/friends/request/${userId}`); addBtn.textContent = 'Sent!'; addBtn.disabled = true; await loadDMs(); renderDMSidebar(); } catch(e) { showError(e.message); } };
        actions.appendChild(addBtn);
      }
      if (state.me.isAdmin) {
        const banBtn = document.createElement('button');
        banBtn.className = 'btn-danger'; banBtn.textContent = 'Ban';
        banBtn.onclick = async () => {
          const reason = prompt('Ban reason:') || '';
          try { await api('POST', `/admin/ban/${userId}`, { reason }); showToast('User banned'); card.classList.add('hidden'); } catch(e) { showError(e.message); }
        };
        actions.appendChild(banBtn);
      }
    } else {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-secondary'; editBtn.textContent = 'Edit Profile';
      editBtn.onclick = () => { card.classList.add('hidden'); showEditProfileModal(); };
      actions.appendChild(editBtn);
    }

    card.classList.remove('hidden');
    card.style.top = '50%'; card.style.left = '50%'; card.style.transform = 'translate(-50%,-50%)';
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch(err) { showError(err.message); }
}

/* ── Create/Edit modals ──────────────────────────────────────────────── */
function showCreateServerModal() {
  openModal('modal-create-server');
  document.getElementById('new-server-name').value = '';
  document.getElementById('new-server-desc').value = '';
  document.getElementById('new-server-icon').value = '🚀';
}

function showCreateChannelModal() {
  openModal('modal-create-channel');
  document.getElementById('new-channel-name').value = '';
}

function showCreateGroupModal() {
  openModal('modal-create-group');
  document.getElementById('new-group-name').value = '';
  const picker = document.getElementById('group-friend-picker');
  picker.innerHTML = '';
  state.friends.forEach(({ user }) => {
    if (!user) return;
    const chip = document.createElement('div');
    chip.className = 'friend-chip';
    chip.dataset.userId = user.id;
    chip.textContent = user.displayName || user.username;
    chip.onclick = () => chip.classList.toggle('selected');
    picker.appendChild(chip);
  });
}

function showEditProfileModal() {
  openModal('modal-edit-profile');
  document.getElementById('edit-display-name').value = state.me.displayName || '';
  document.getElementById('edit-bio').value = state.me.bio || '';
  document.getElementById('edit-avatar').value = state.me.avatar || '';
  document.getElementById('edit-banner').value = state.me.banner || '';
}

function openSearchModal(mode) {
  openModal('modal-search');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-input').focus();
}

async function showDiscoverModal() {
  openModal('modal-discover');
  try {
    const { servers } = await api('GET', '/servers/discover');
    const list = document.getElementById('discover-list');
    list.innerHTML = '';
    if (servers.length === 0) {
      list.innerHTML = '<div class="notif-empty">No public servers to discover</div>';
      return;
    }
    servers.forEach((srv) => {
      const item = document.createElement('div');
      item.className = 'discover-item';
      item.innerHTML = `
        <div class="discover-icon">${srv.icon || '🌐'}</div>
        <div class="discover-info">
          <div class="discover-name">${srv.name}</div>
          <div class="discover-desc">${srv.description || ''}</div>
          <div class="discover-members">${srv.members.length} members</div>
        </div>
        <button class="btn-primary" style="padding:6px 14px;border-radius:4px;font-size:13px;font-weight:600;">Join</button>`;
      item.querySelector('button').onclick = async () => {
        try {
          await api('POST', `/servers/${srv.id}/join`);
          state.servers.push(srv);
          renderServerDock();
          closeModal('modal-discover');
          selectServer(srv.id);
        } catch(e) { showError(e.message); }
      };
      list.appendChild(item);
    });
  } catch { }
}

/* ── Notifications ───────────────────────────────────────────────────── */
function updateNotifBadge() {
  const unread = state.notifications.filter(n => !n.read).length;
  const existing = document.querySelector('#btn-notifications .notif-badge');
  if (existing) existing.remove();
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'notif-badge';
    badge.textContent = unread > 9 ? '9+' : unread;
    document.getElementById('btn-notifications').appendChild(badge);
  }
}

function toggleNotificationsPanel() {
  const panel = document.getElementById('notifications-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    renderNotifications();
  }
}

function renderNotifications() {
  const list = document.getElementById('notif-list');
  list.innerHTML = '';
  if (state.notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  state.notifications.slice(0, 30).forEach((n) => {
    const item = document.createElement('div');
    item.className = `notif-item${n.read ? '' : ' unread'}`;
    item.innerHTML = `<div class="notif-item-content">${n.content}</div><div class="notif-item-time">${formatTime(n.createdAt)}</div>`;
    item.onclick = async () => {
      await api('PUT', `/notifications/${n.id}/read`);
      n.read = true; item.classList.remove('unread');
      updateNotifBadge();
    };
    list.appendChild(item);
  });
}

/* ── Pinned messages ─────────────────────────────────────────────────── */
async function togglePinnedPanel() {
  const panel = document.getElementById('pinned-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  try {
    let pins = [];
    if (state.currentServer && state.currentChannel) {
      const { pinned } = await api('GET', `/pinned/${state.currentServer.id}/${state.currentChannel.id}`);
      pins = pinned;
    } else if (state.currentDMUser) {
      const { conversations } = await api('GET', '/dms');
      const conv = conversations.find(c => c.other?.id === state.currentDMUser.id);
      if (conv) { const { pinned } = await api('GET', `/pinned/dm/${conv.id}`); pins = pinned; }
    } else if (state.currentGroup) {
      const { pinned } = await api('GET', `/pinned/group/${state.currentGroup.id}`);
      pins = pinned;
    }
    const list = document.getElementById('pinned-list');
    list.innerHTML = '';
    if (pins.length === 0) { list.innerHTML = '<div class="pinned-empty">No pinned messages</div>'; }
    else {
      pins.forEach((p) => {
        const card = document.createElement('div');
        card.className = 'pinned-msg-card';
        const msgData = p.messageData || {};
        card.innerHTML = `
          <div class="pinned-msg-author">${msgData.authorId || 'Unknown'}</div>
          <div class="pinned-msg-text">${msgData.content || ''}</div>
          <div class="pinned-msg-meta">Pinned by ${p.pinner?.username || 'Unknown'} · ${formatTime(p.createdAt)}</div>`;
        list.appendChild(card);
      });
    }
    panel.classList.remove('hidden');
  } catch { }
}

async function pinMessage(msgId) {
  if (!state.currentServer || !state.currentChannel) return;
  socket.emit('pin-message', { messageId: msgId, serverId: state.currentServer.id, channelId: state.currentChannel.id });
  showToast('Message pinned');
}

async function deleteMessage(msgId) {
  if (!confirm('Delete this message?')) return;
  if (state.currentServer && state.currentChannel) {
    socket.emit('delete-message', { messageId: msgId, serverId: state.currentServer.id, channelId: state.currentChannel.id });
  }
}

/* ── Status picker ───────────────────────────────────────────────────── */
function toggleStatusPicker() {
  const picker = document.getElementById('status-picker');
  picker.classList.toggle('hidden');
}

/* ── Admin Panel ─────────────────────────────────────────────────────── */
async function showAdminPanel() {
  openModal('admin-panel');
  loadAdminUsers();
}

let adminTab = 'users';
async function loadAdminUsers() {
  const content = document.getElementById('admin-content');
  const searchInput = document.getElementById('admin-search');
  const q = searchInput.value.toLowerCase();
  content.innerHTML = '<div style="color:var(--text-4);text-align:center;padding:20px;">Loading...</div>';
  try {
    if (adminTab === 'users') {
      const { users } = await api('GET', '/admin/users');
      content.innerHTML = '';
      const filtered = q ? users.filter(u => u.username.toLowerCase().includes(q) || u.displayName?.toLowerCase().includes(q)) : users;
      filtered.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'admin-user-row';
        const av = document.createElement('div');
        av.className = 'member-avatar'; setAvatar(av, u);
        const info = document.createElement('div');
        info.className = 'admin-user-info';
        info.innerHTML = `<div class="admin-user-name">${u.displayName || u.username} ${getBadgesHtml(u)}</div><div class="admin-user-meta">@${u.username} · ${u.isBanned ? '🚫 Banned' : u.timeout ? '⏱ Timed out' : u.status}</div>`;
        const acts = document.createElement('div');
        acts.className = 'admin-actions';
        if (!u.isBanned) {
          const banBtn = document.createElement('button');
          banBtn.className = 'admin-btn admin-btn-ban'; banBtn.textContent = 'Ban';
          banBtn.onclick = async () => {
            const reason = prompt('Ban reason:') || '';
            try { await api('POST', `/admin/ban/${u.id}`, { reason }); showToast('Banned'); loadAdminUsers(); } catch(e) { showError(e.message); }
          };
          acts.appendChild(banBtn);
        } else {
          const unbanBtn = document.createElement('button');
          unbanBtn.className = 'admin-btn admin-btn-unban'; unbanBtn.textContent = 'Unban';
          unbanBtn.onclick = async () => { await api('DELETE', `/admin/ban/${u.id}`); showToast('Unbanned'); loadAdminUsers(); };
          acts.appendChild(unbanBtn);
        }
        const timeoutBtn = document.createElement('button');
        timeoutBtn.className = 'admin-btn admin-btn-timeout'; timeoutBtn.textContent = 'Timeout';
        timeoutBtn.onclick = async () => {
          const mins = prompt('Timeout minutes (5,10,60,1440):', '10');
          if (!mins) return;
          try { await api('POST', `/admin/timeout/${u.id}`, { minutes: parseInt(mins), reason: '' }); showToast('Timed out'); loadAdminUsers(); } catch(e) { showError(e.message); }
        };
        acts.appendChild(timeoutBtn);
        const vBtn = document.createElement('button');
        vBtn.className = 'admin-btn admin-btn-verify'; vBtn.textContent = u.verified ? 'Remove ✓' : 'Verify ✓';
        vBtn.onclick = async () => { const m = u.verified ? 'DELETE' : 'POST'; await api(m, `/admin/verify/${u.id}/blue`); loadAdminUsers(); };
        acts.appendChild(vBtn);
        const gBtn = document.createElement('button');
        gBtn.className = 'admin-btn admin-btn-gold'; gBtn.textContent = u.goldVerified ? 'Remove ⭐' : 'Gold ⭐';
        gBtn.onclick = async () => { const m = u.goldVerified ? 'DELETE' : 'POST'; await api(m, `/admin/verify/${u.id}/gold`); loadAdminUsers(); };
        acts.appendChild(gBtn);
        row.appendChild(av); row.appendChild(info); row.appendChild(acts);
        content.appendChild(row);
      });
    } else if (adminTab === 'bans') {
      const { bans } = await api('GET', '/admin/bans');
      content.innerHTML = '';
      if (bans.length === 0) { content.innerHTML = '<div class="notif-empty">No banned users</div>'; return; }
      bans.forEach((ban) => {
        const row = document.createElement('div');
        row.className = 'admin-log-row';
        row.innerHTML = `<span class="admin-log-action">BANNED</span> <span class="admin-log-target">${ban.username}</span> — <span class="admin-log-by">${ban.reason || 'No reason'}</span> <span class="admin-log-time">${formatTime(ban.createdAt)}</span>`;
        const unbanBtn = document.createElement('button');
        unbanBtn.className = 'admin-btn admin-btn-unban'; unbanBtn.textContent = 'Unban';
        unbanBtn.style.marginLeft = '8px';
        unbanBtn.onclick = async () => { await api('DELETE', `/admin/ban/${ban.userId}`); loadAdminUsers(); };
        row.appendChild(unbanBtn);
        content.appendChild(row);
      });
    } else if (adminTab === 'logs') {
      const { logs } = await api('GET', '/admin/logs');
      content.innerHTML = '';
      if (logs.length === 0) { content.innerHTML = '<div class="notif-empty">No moderation logs</div>'; return; }
      logs.forEach((log) => {
        const row = document.createElement('div');
        row.className = 'admin-log-row';
        row.innerHTML = `<span class="admin-log-action">${log.action.toUpperCase()}</span> <span class="admin-log-target">${log.targetUsername}</span> by <span class="admin-log-by">${log.performedBy}</span> <span class="admin-log-time">${formatTime(log.createdAt)}</span>`;
        content.appendChild(row);
      });
    }
  } catch(e) { content.innerHTML = `<div style="color:var(--red);padding:16px;">${e.message}</div>`; }
}

/* ── Context menus ───────────────────────────────────────────────────── */
function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  const container = document.getElementById('context-items');
  container.innerHTML = '';
  items.forEach((item) => {
    if (item === 'sep') {
      const sep = document.createElement('div'); sep.className = 'ctx-separator'; container.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = `ctx-item${item.danger ? ' danger' : ''}`;
      el.innerHTML = `${item.icon || ''} ${item.label}`;
      el.onclick = () => { hideContextMenu(); item.action(); };
      container.appendChild(el);
    }
  });
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 10)}px`;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() { document.getElementById('context-menu').classList.add('hidden'); }

function showServerContextMenu(e, srv) {
  const items = [
    { icon: '📋', label: 'Copy Server ID', action: () => copyText(srv.id) },
  ];
  if (srv.owner === state.me.id || state.me.isAdmin) {
    items.push('sep');
    items.push({ icon: '🗑', label: 'Delete Server', danger: true, action: async () => {
      if (!confirm(`Delete "${srv.name}"?`)) return;
      try { await api('DELETE', `/servers/${srv.id}`); state.servers = state.servers.filter(s => s.id !== srv.id); renderServerDock(); showDMView(); } catch(e) { showError(e.message); }
    }});
  } else {
    items.push({ icon: '🚪', label: 'Leave Server', danger: true, action: async () => {
      if (!confirm(`Leave "${srv.name}"?`)) return;
      try { await api('POST', `/servers/${srv.id}/leave`); state.servers = state.servers.filter(s => s.id !== srv.id); renderServerDock(); showDMView(); } catch(e) { showError(e.message); }
    }});
  }
  showContextMenu(e.clientX, e.clientY, items);
}

function showChannelContextMenu(e, ch) {
  showContextMenu(e.clientX, e.clientY, [
    { icon: '📋', label: 'Copy Channel ID', action: () => copyText(ch.id) },
    'sep',
    { icon: '🗑', label: 'Delete Channel', danger: true, action: async () => {
      if (!confirm(`Delete #${ch.name}?`)) return;
      try {
        await api('DELETE', `/channels/${state.currentServer.id}/${ch.id}`);
        selectServer(state.currentServer.id);
      } catch(e) { showError(e.message); }
    }},
  ]);
}

function showDMContextMenu(e, user) {
  showContextMenu(e.clientX, e.clientY, [
    { icon: '👤', label: 'View Profile', action: () => openProfile(user.id) },
    { icon: '💬', label: 'Message', action: () => openDM(user) },
  ]);
}

/* ── Emoji picker ────────────────────────────────────────────────────── */
const EMOJIS = ['😀','😂','🥲','😊','😍','🤩','😎','🤔','😅','😭','😡','🤯','🥳','😴','🤮','👍','👎','❤️','🔥','✨','💯','🎉','🎊','👏','🙏','💪','🤝','✌️','🫡','🥺','😏','😒','🙄','🤦','🤷','💀','👻','🎮','🎵','🎨','📱','💻','🖥️','⚡','🌟','🌈','🦋','🐱','🐶','🍕','🍔','☕','🧋','🍺','🎯','🏆','💎','🚀','🌙'];
function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  picker.classList.toggle('hidden');
  if (!picker.classList.contains('hidden')) {
    const grid = document.getElementById('emoji-grid');
    if (grid.children.length === 0) {
      EMOJIS.forEach(e => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn'; btn.textContent = e;
        btn.onclick = () => { const input = document.getElementById('message-input'); input.value += e; input.focus(); picker.classList.add('hidden'); };
        grid.appendChild(btn);
      });
    }
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  const anyOpen = document.querySelectorAll('.modal:not(.hidden)').length > 0;
  if (!anyOpen) document.getElementById('modal-overlay').classList.add('hidden');
}
function showError(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:70px;right:16px;background:var(--red);color:#fff;padding:10px 16px;border-radius:8px;z-index:9999;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.4);animation:fadeUp .2s ease;';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:70px;right:16px;background:var(--green);color:#fff;padding:10px 16px;border-radius:8px;z-index:9999;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.4);animation:fadeUp .2s ease;';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
function copyText(text) { navigator.clipboard.writeText(text).then(() => showToast('Copied!')); }
function clearTyping() {
  state.typingUsers = {};
  document.getElementById('typing-indicator').classList.add('hidden');
  document.getElementById('typing-indicator').textContent = '';
}

function updateTypingIndicator() {
  const users = Object.values(state.typingUsers).filter(Boolean);
  const el = document.getElementById('typing-indicator');
  if (users.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const names = users.join(', ');
  el.innerHTML = `<div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>${names} ${users.length === 1 ? 'is' : 'are'} typing...`;
}

/* ── Socket handlers ─────────────────────────────────────────────────── */
function setupSocketHandlers() {
  socket.on('new-message', (msg) => {
    if (state.currentServer?.id === msg.serverId && state.currentChannel?.id === msg.channelId) {
      const list = document.getElementById('messages-list');
      const lastGroup = list.querySelector('.message-group:last-child');
      const lastAuthorId = lastGroup?.dataset?.authorId || lastGroup?.querySelector('[onclick*="openProfile"]')?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
      const isContinued = lastAuthorId === msg.authorId && !lastGroup?.classList.contains('msg-continued-first');
      const el = buildMessageEl(msg, false);
      list.appendChild(el);
      scrollToBottom();
      delete state.typingUsers[msg.authorId];
      updateTypingIndicator();
    }
  });

  socket.on('new-dm', (msg) => {
    const isActiveDM = state.currentDMUser && (msg.authorId === state.currentDMUser.id || (msg.authorId === state.me.id && state.currentDMUser));
    if (isActiveDM) {
      const list = document.getElementById('messages-list');
      list.appendChild(buildDMMessageEl(msg, false));
      scrollToBottom();
      delete state.typingUsers[msg.authorId];
      updateTypingIndicator();
    }
    loadDMs().then(() => renderDMSidebar());
  });

  socket.on('new-group-message', (msg) => {
    if (state.currentGroup?.id === msg.groupId) {
      const list = document.getElementById('messages-list');
      list.appendChild(buildDMMessageEl(msg, false));
      scrollToBottom();
      delete state.typingUsers[msg.authorId];
      updateTypingIndicator();
    }
  });

  socket.on('typing', ({ userId, username, channelId }) => {
    if (userId === state.me.id) return;
    if (state.currentChannel?.id !== channelId) return;
    state.typingUsers[userId] = username;
    updateTypingIndicator();
    clearTimeout(state.typingTimeouts[userId]);
    state.typingTimeouts[userId] = setTimeout(() => { delete state.typingUsers[userId]; updateTypingIndicator(); }, 5000);
  });

  socket.on('stop-typing', ({ userId }) => {
    delete state.typingUsers[userId];
    updateTypingIndicator();
  });

  socket.on('typing-dm', ({ userId, username }) => {
    if (userId === state.me.id) return;
    if (state.currentDMUser?.id !== userId) return;
    state.typingUsers[userId] = username;
    updateTypingIndicator();
    clearTimeout(state.typingTimeouts[userId]);
    state.typingTimeouts[userId] = setTimeout(() => { delete state.typingUsers[userId]; updateTypingIndicator(); }, 5000);
  });

  socket.on('stop-typing-dm', ({ userId }) => {
    delete state.typingUsers[userId];
    updateTypingIndicator();
  });

  socket.on('typing-group', ({ userId, username, groupId }) => {
    if (userId === state.me.id) return;
    if (state.currentGroup?.id !== groupId) return;
    state.typingUsers[userId] = username;
    updateTypingIndicator();
    clearTimeout(state.typingTimeouts[userId]);
    state.typingTimeouts[userId] = setTimeout(() => { delete state.typingUsers[userId]; updateTypingIndicator(); }, 5000);
  });

  socket.on('stop-typing-group', ({ userId }) => {
    delete state.typingUsers[userId];
    updateTypingIndicator();
  });

  socket.on('status-change', ({ userId, status }) => {
    // Update state.me if it's us
    if (userId === state.me.id) { state.me.status = status; renderUserBar(); }
    // Update member list
    document.querySelectorAll(`.member-item[data-user-id="${userId}"] .member-status-dot`).forEach(d => {
      d.className = `member-status-dot status-${status}`;
    });
    // Update friends list status dots
    const friend = state.friends.find(f => f.user?.id === userId);
    if (friend?.user) friend.user.status = status;
  });

  socket.on('message-deleted', ({ messageId }) => {
    const el = document.querySelector(`.message-group[data-message-id="${messageId}"]`);
    if (el) el.remove();
  });

  socket.on('message-pinned', (pin) => {
    showToast('Message pinned!');
  });

  socket.on('notification', (notif) => {
    state.notifications.unshift(notif);
    updateNotifBadge();
  });

  socket.on('error-message', ({ error }) => { showError(error); });

  socket.on('disconnect', () => { console.log('Disconnected'); });
  socket.on('connect', () => { console.log('Connected'); });
}

/* ── Event listeners ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Send message on Enter
  const input = document.getElementById('message-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    else { handleTyping(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
  document.getElementById('btn-send').addEventListener('click', sendMessage);

  // Home button
  document.getElementById('btn-home').addEventListener('click', () => {
    document.querySelectorAll('.dock-item').forEach(d => d.classList.remove('active'));
    document.getElementById('btn-home').classList.add('active');
    showDMView();
  });

  // Add server
  document.getElementById('btn-add-server').addEventListener('click', showCreateServerModal);
  document.getElementById('btn-discover').addEventListener('click', showDiscoverModal);

  // Create server
  document.getElementById('confirm-create-server').addEventListener('click', async () => {
    const name = document.getElementById('new-server-name').value.trim();
    if (!name) return;
    try {
      const { server } = await api('POST', '/servers', {
        name, description: document.getElementById('new-server-desc').value.trim(),
        icon: document.getElementById('new-server-icon').value || '🌐'
      });
      state.servers.push(server);
      renderServerDock();
      closeModal('modal-create-server');
      selectServer(server.id);
    } catch(e) { showError(e.message); }
  });
  document.getElementById('cancel-create-server').addEventListener('click', () => closeModal('modal-create-server'));

  // Create channel
  document.getElementById('confirm-create-channel').addEventListener('click', async () => {
    const name = document.getElementById('new-channel-name').value.trim();
    if (!name || !state.currentServer) return;
    try {
      const { channel } = await api('POST', `/channels/${state.currentServer.id}`, { name });
      closeModal('modal-create-channel');
      await selectServer(state.currentServer.id);
    } catch(e) { showError(e.message); }
  });
  document.getElementById('cancel-create-channel').addEventListener('click', () => closeModal('modal-create-channel'));

  // Create group
  document.getElementById('confirm-create-group').addEventListener('click', async () => {
    const name = document.getElementById('new-group-name').value.trim();
    if (!name) return;
    const memberIds = [...document.querySelectorAll('#group-friend-picker .friend-chip.selected')].map(el => el.dataset.userId);
    try {
      const { group } = await api('POST', '/groups', { name, memberIds });
      state.groups.push(group);
      closeModal('modal-create-group');
      renderDMSidebar();
      openGroupChat(group);
    } catch(e) { showError(e.message); }
  });
  document.getElementById('cancel-create-group').addEventListener('click', () => closeModal('modal-create-group'));

  // Search
  document.getElementById('btn-search-users').addEventListener('click', () => openSearchModal());
  let searchDebounce;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const q = e.target.value.trim();
      if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
      try {
        const { users } = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
        const results = document.getElementById('search-results');
        results.innerHTML = '';
        users.filter(u => u.id !== state.me?.id).forEach(u => results.appendChild(buildSearchResult(u)));
        if (users.length === 0) results.innerHTML = '<div style="color:var(--text-muted);padding:8px;font-size:13px;">No users found</div>';
      } catch { }
    }, 300);
  });
  document.getElementById('cancel-search').addEventListener('click', () => closeModal('modal-search'));
  document.getElementById('cancel-discover').addEventListener('click', () => closeModal('modal-discover'));

  // Pinned
  document.getElementById('btn-pinned').addEventListener('click', togglePinnedPanel);
  document.getElementById('close-pinned').addEventListener('click', () => document.getElementById('pinned-panel').classList.add('hidden'));

  // Member list toggle
  document.getElementById('btn-members').addEventListener('click', () => {
    const ml = document.getElementById('member-list');
    ml.classList.toggle('hidden');
    state.memberListOpen = !state.memberListOpen;
  });

  // Notifications
  document.getElementById('btn-notifications').addEventListener('click', (e) => { e.stopPropagation(); toggleNotificationsPanel(); });
  document.getElementById('btn-read-all').addEventListener('click', async () => {
    await api('PUT', '/notifications/read-all');
    state.notifications.forEach(n => n.read = true);
    renderNotifications(); updateNotifBadge();
  });

  // Status picker
  document.getElementById('btn-toggle-status').addEventListener('click', (e) => { e.stopPropagation(); toggleStatusPicker(); });
  document.querySelectorAll('.status-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const status = opt.dataset.status;
      socket.emit('status-update', status);
      document.getElementById('status-picker').classList.add('hidden');
    });
  });

  // Settings / admin
  document.getElementById('btn-settings').addEventListener('click', () => {
    if (state.me.isAdmin) showAdminPanel();
    else showEditProfileModal();
  });

  // My profile
  document.getElementById('btn-my-profile').addEventListener('click', () => openProfile(state.me.id));

  // Edit profile
  document.getElementById('confirm-edit-profile').addEventListener('click', async () => {
    try {
      const { user } = await api('PUT', '/users/profile', {
        displayName: document.getElementById('edit-display-name').value,
        bio: document.getElementById('edit-bio').value,
        avatar: document.getElementById('edit-avatar').value,
        banner: document.getElementById('edit-banner').value,
      });
      state.me = { ...state.me, ...user };
      renderUserBar();
      closeModal('modal-edit-profile');
      showToast('Profile updated!');
    } catch(e) { showError(e.message); }
  });
  document.getElementById('cancel-edit-profile').addEventListener('click', () => closeModal('modal-edit-profile'));

  // Profile close
  document.getElementById('close-profile').addEventListener('click', () => {
    document.getElementById('profile-card').classList.add('hidden');
    const anyOpen = document.querySelectorAll('.modal:not(.hidden)').length > 0;
    if (!anyOpen) document.getElementById('modal-overlay').classList.add('hidden');
  });

  // Admin tabs
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      adminTab = tab.dataset.tab;
      document.getElementById('admin-search-wrap').style.display = adminTab === 'users' ? 'block' : 'none';
      loadAdminUsers();
    });
  });
  document.getElementById('close-admin').addEventListener('click', () => closeModal('admin-panel'));
  document.getElementById('admin-search').addEventListener('input', loadAdminUsers);

  // Emoji
  document.getElementById('btn-emoji').addEventListener('click', (e) => { e.stopPropagation(); toggleEmojiPicker(); });

  // Close panels on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notifications-panel') && !e.target.closest('#btn-notifications'))
      document.getElementById('notifications-panel').classList.add('hidden');
    if (!e.target.closest('#status-picker') && !e.target.closest('#btn-toggle-status'))
      document.getElementById('status-picker').classList.add('hidden');
    if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji'))
      document.getElementById('emoji-picker').classList.add('hidden');
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });

  // Overlay click closes modals
  document.getElementById('modal-overlay').addEventListener('click', () => {
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    document.getElementById('profile-card').classList.add('hidden');
    document.getElementById('modal-overlay').classList.add('hidden');
  });

  // Logout via title click (hidden feature for testing)
  document.getElementById('btn-home').addEventListener('dblclick', async () => {
    await api('POST', '/auth/logout');
    window.location.href = '/login.html';
  });
});
