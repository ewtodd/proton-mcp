/**
 * IMAP client for Proton Bridge — reading and sorting only.
 *
 * Messages are addressed by (folder, uid). IMAP UIDs are stable: they do not
 * shift when other messages are moved out of the folder, unlike sequence
 * numbers. A message gets a new UID when it is moved to another folder.
 *
 * This module deliberately has no way to delete mail: it never sets the
 * \Deleted flag, never expunges, and refuses to move messages into Trash or
 * Spam (Proton can auto-empty both).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

// Destinations that lead to deletion (Proton can auto-empty these folders).
const FORBIDDEN_DEST_ATTRIBS = ['\\Trash', '\\Junk'];
const FORBIDDEN_DEST_NAMES = ['trash', 'spam'];

// Folders that are views over other folders rather than real locations.
// Every Proton message lives in exactly one non-virtual folder.
const VIRTUAL_ATTRIBS = ['\\All', '\\Flagged'];
const VIRTUAL_NAMES = ['all mail', 'starred'];

const HEADER_FIELDS = 'HEADER.FIELDS (FROM TO CC DATE SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES)';

// --- Connection helpers ---

/**
 * Open a short-lived IMAP connection, run `fn`, then close.
 */
function withImap(config, fn) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.username,
      password: config.password,
      host: config.imap_host || '127.0.0.1',
      port: config.imap_port || 1143,
      tls: false,
      authTimeout: 10000,
    });
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(result);
    };

    imap.once('ready', () => {
      fn(imap)
        .then((result) => { imap.end(); finish(null, result); })
        .catch((err) => { imap.end(); finish(err); });
    });
    imap.once('error', (err) => finish(new Error(`IMAP error: ${err.message}. Is Proton Bridge running?`)));
    imap.once('end', () => finish(new Error('IMAP connection closed unexpectedly')));
    imap.connect();
  });
}

function call(imap, method, ...args) {
  return new Promise((resolve, reject) => {
    imap[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function getFolderList(imap) {
  const boxes = await call(imap, 'getBoxes');
  const folders = [];
  (function walk(obj, prefix) {
    for (const [name, box] of Object.entries(obj)) {
      const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
      folders.push({ name: fullName, attribs: box.attribs || [] });
      if (box.children) walk(box.children, fullName);
    }
  })(boxes, '');
  return folders;
}

const isSelectable = (f) => !f.attribs.includes('\\Noselect') && !f.attribs.includes('\\NonExistent');
const isLabel = (f) => /^labels\//i.test(f.name);
const isVirtual = (f) => isLabel(f)
  || f.attribs.some((a) => VIRTUAL_ATTRIBS.includes(a))
  || VIRTUAL_NAMES.includes(f.name.toLowerCase());
const isForbiddenDest = (f) => f.attribs.some((a) => FORBIDDEN_DEST_ATTRIBS.includes(a))
  || FORBIDDEN_DEST_NAMES.includes(f.name.toLowerCase());

/**
 * Resolve a user-supplied folder name to a real mailbox. Accepts the exact
 * name, a case-insensitive match, or a bare name under Folders/ or Labels/
 * (so "Work" finds "Folders/Work").
 */
function resolveFolder(folders, name) {
  const selectable = folders.filter(isSelectable);
  const lower = String(name).toLowerCase();
  const match = selectable.find((f) => f.name === name)
    || selectable.find((f) => f.name.toLowerCase() === lower)
    || selectable.find((f) => f.name.toLowerCase() === `folders/${lower}`)
    || selectable.find((f) => f.name.toLowerCase() === `labels/${lower}`);
  if (!match) {
    throw new Error(`Folder "${name}" not found. Available: ${selectable.map((f) => f.name).join(', ')}`);
  }
  return match;
}

async function openFolder(imap, name, readOnly = true) {
  const folder = resolveFolder(await getFolderList(imap), name);
  const box = await call(imap, 'openBox', folder.name, readOnly);
  return { folder, box };
}

/**
 * Return the subset of `ids` that exist in the open folder, erroring if none do.
 * Membership is checked against SEARCH ALL: Proton Bridge only returns the
 * first UID from a `UID <set>` search criterion.
 */
async function requireExisting(imap, ids, folderName) {
  const found = new Set(await call(imap, 'search', ['ALL']));
  const existing = ids.filter((id) => found.has(id));
  const missing = ids.filter((id) => !found.has(id));
  if (existing.length === 0) {
    throw new Error(`No message with id ${ids.join(', ')} in ${folderName}. Ids are per-folder and change when a message is moved; list the folder again to get current ids.`);
  }
  return { existing, missing };
}

// --- Fetching ---

function hasAttachments(struct) {
  if (!Array.isArray(struct)) return false;
  return struct.some((part) => {
    if (Array.isArray(part)) return hasAttachments(part);
    const disp = part.disposition?.type?.toLowerCase();
    return disp === 'attachment' || (disp === 'inline' && part.type !== 'text');
  });
}

/**
 * Fetch messages by UID. `bodies` is the IMAP body section to parse
 * (HEADER_FIELDS for summaries, '' for the full message).
 * Returns [{ uid, flags, struct, parsed }] in the order of `uids`, with
 * parsed = null for any message the server did not deliver.
 */
function fetchRaw(imap, uids, bodies) {
  return new Promise((resolve, reject) => {
    if (uids.length === 0) { resolve([]); return; }
    const records = [];
    const f = imap.fetch(uids, { bodies, struct: true });

    f.on('message', (msg) => {
      const rec = { uid: null, flags: [], struct: null, raw: '' };
      records.push(rec);
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { rec.raw += chunk.toString('binary'); });
      });
      msg.once('attributes', (attrs) => {
        rec.uid = attrs.uid;
        rec.flags = attrs.flags || [];
        rec.struct = attrs.struct;
      });
    });
    f.once('error', reject);
    f.once('end', async () => {
      const byUid = new Map(records.filter((r) => r.uid != null).map((r) => [r.uid, r]));
      const out = [];
      for (const uid of uids) {
        const rec = byUid.get(uid);
        if (!rec) continue;
        let parsed = null;
        if (rec.raw) {
          try { parsed = await simpleParser(Buffer.from(rec.raw, 'binary')); } catch { /* leave null */ }
        }
        out.push({ uid, flags: rec.flags, struct: rec.struct, parsed });
      }
      resolve(out);
    });
  });
}

function summarize(rec, folderName) {
  const m = rec.parsed;
  return {
    folder: folderName,
    id: rec.uid,
    date: m?.date?.toISOString() || null,
    from: m?.from?.text || '',
    to: m?.to?.text || '',
    subject: m ? (m.subject || '(no subject)') : '(headers unavailable)',
    read: rec.flags.includes('\\Seen'),
    starred: rec.flags.includes('\\Flagged'),
    has_attachments: hasAttachments(rec.struct),
  };
}

// --- Read operations ---

export async function listFolders(config) {
  return withImap(config, async (imap) => {
    const folders = (await getFolderList(imap)).filter(isSelectable);
    const out = [];
    for (const f of folders) {
      let total = null, unread = null;
      try {
        const box = await call(imap, 'status', f.name);
        total = box.messages.total;
        unread = box.messages.unseen;
      } catch { /* leave counts null */ }
      out.push({
        name: f.name,
        total,
        unread,
        kind: isLabel(f) ? 'label' : isVirtual(f) ? 'view' : 'folder',
        can_move_into: !isVirtual(f) && !isForbiddenDest(f),
      });
    }
    return out;
  });
}

export async function listMessages(config, { folder = 'INBOX', limit = 20, offset = 0, unreadOnly = false }) {
  return withImap(config, async (imap) => {
    const { folder: f } = await openFolder(imap, folder, true);
    const uids = (await call(imap, 'search', [unreadOnly ? 'UNSEEN' : 'ALL'])).sort((a, b) => b - a);
    const page = uids.slice(offset, offset + limit);
    const recs = await fetchRaw(imap, page, HEADER_FIELDS);
    return {
      folder: f.name,
      total: uids.length,
      offset,
      messages: recs.map((r) => summarize(r, f.name)),
    };
  });
}

function buildCriteria({ query, from, to, subject, since, before, unreadOnly }) {
  const criteria = [];
  if (query) criteria.push(['TEXT', query]);
  if (from) criteria.push(['FROM', from]);
  if (to) criteria.push(['TO', to]);
  if (subject) criteria.push(['SUBJECT', subject]);
  if (since) criteria.push(['SINCE', new Date(since)]);
  if (before) criteria.push(['BEFORE', new Date(before)]);
  if (unreadOnly) criteria.push('UNSEEN');
  if (criteria.length === 0) criteria.push('ALL');
  return criteria;
}

export async function searchMessages(config, { folder, limit = 20, ...filters }) {
  return withImap(config, async (imap) => {
    const all = await getFolderList(imap);
    const targets = folder
      ? [resolveFolder(all, folder)]
      : all.filter((f) => isSelectable(f) && !isVirtual(f));
    const criteria = buildCriteria(filters);

    let totalMatches = 0;
    const results = [];
    for (const f of targets) {
      await call(imap, 'openBox', f.name, true);
      const uids = (await call(imap, 'search', criteria)).sort((a, b) => b - a);
      totalMatches += uids.length;
      const recs = await fetchRaw(imap, uids.slice(0, limit), HEADER_FIELDS);
      results.push(...recs.map((r) => summarize(r, f.name)));
    }
    results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return {
      searched_folders: targets.map((f) => f.name),
      total_matches: totalMatches,
      messages: results.slice(0, limit),
    };
  });
}

function fullMessage(rec, folderName, maxBodyChars) {
  const m = rec.parsed;
  const body = m?.text || '';
  return {
    ...summarize(rec, folderName),
    cc: m?.cc?.text || '',
    reply_to: m?.replyTo?.text || '',
    message_id_header: m?.messageId || null,
    body: body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body,
    body_truncated: body.length > maxBodyChars,
    attachments: (m?.attachments || []).map((a) => ({
      filename: a.filename || null,
      content_type: a.contentType,
      size: a.size,
    })),
  };
}

export async function getMessage(config, { folder = 'INBOX', id, maxBodyChars = 20000 }) {
  return withImap(config, async (imap) => {
    // Read-only open: fetching the body does not mark the message as read.
    const { folder: f } = await openFolder(imap, folder, true);
    const [rec] = await fetchRaw(imap, [id], '');
    if (!rec || !rec.parsed) {
      throw new Error(`No message with id ${id} in ${f.name}. Ids are per-folder and change when a message is moved; list the folder again to get current ids.`);
    }
    return fullMessage(rec, f.name, maxBodyChars);
  });
}

/**
 * UIDs matching any of `criteriaList` in the open folder. Tries a single
 * OR search first and falls back to one search per criterion for servers
 * that reject nested OR.
 */
async function searchAny(imap, criteriaList) {
  const combined = criteriaList.reduce((acc, c) => (acc ? ['OR', acc, c] : c), null);
  try {
    return await call(imap, 'search', [combined]);
  } catch {
    const uids = new Set();
    for (const c of criteriaList) {
      for (const uid of await call(imap, 'search', [c])) uids.add(uid);
    }
    return [...uids].sort((a, b) => a - b);
  }
}

export async function getThread(config, { folder = 'INBOX', id, maxBodyChars = 5000 }) {
  return withImap(config, async (imap) => {
    const all = await getFolderList(imap);
    const start = resolveFolder(all, folder);
    await call(imap, 'openBox', start.name, true);
    const [rec] = await fetchRaw(imap, [id], HEADER_FIELDS);
    if (!rec || !rec.parsed) {
      throw new Error(`No message with id ${id} in ${start.name}. Ids are per-folder and change when a message is moved; list the folder again to get current ids.`);
    }

    const refs = rec.parsed.references;
    const ids = [...new Set([
      rec.parsed.messageId,
      rec.parsed.inReplyTo,
      ...(Array.isArray(refs) ? refs : refs ? [refs] : []),
    ].filter(Boolean))];
    if (ids.length === 0) {
      return { messages: [fullMessage((await fetchRaw(imap, [id], ''))[0], start.name, maxBodyChars)] };
    }

    // Ancestors (Message-ID in our references) and replies (their
    // References / In-Reply-To mention any id in the thread).
    const criteria = ids.flatMap((mid) => [
      ['HEADER', 'Message-ID', mid],
      ['HEADER', 'References', mid],
      ['HEADER', 'In-Reply-To', mid],
    ]);

    const seen = new Set();
    const messages = [];
    for (const f of all.filter((x) => isSelectable(x) && !isVirtual(x))) {
      await call(imap, 'openBox', f.name, true);
      const uids = await searchAny(imap, criteria);
      for (const r of await fetchRaw(imap, uids, '')) {
        const key = r.parsed?.messageId || `${f.name}:${r.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(fullMessage(r, f.name, maxBodyChars));
      }
    }
    messages.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    return { messages };
  });
}

function safeFilename(name, index) {
  const base = path.basename(String(name || '')).replace(/[\0/\\]/g, '_').replace(/^\.+/, '');
  return base || `attachment-${index + 1}`;
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

export async function saveAttachments(config, { folder = 'INBOX', id, directory }) {
  return withImap(config, async (imap) => {
    const { folder: f } = await openFolder(imap, folder, true);
    const [rec] = await fetchRaw(imap, [id], '');
    if (!rec || !rec.parsed) {
      throw new Error(`No message with id ${id} in ${f.name}. Ids are per-folder and change when a message is moved; list the folder again to get current ids.`);
    }
    const attachments = rec.parsed.attachments || [];
    if (attachments.length === 0) return { folder: f.name, id, saved: [] };

    const dir = directory
      ? path.resolve(directory)
      : path.join(os.tmpdir(), 'proton-mcp-attachments', `${f.name.replace(/[^\w.-]+/g, '_')}-${id}`);
    fs.mkdirSync(dir, { recursive: true });

    const saved = attachments.map((a, i) => {
      const file = uniquePath(dir, safeFilename(a.filename, i));
      fs.writeFileSync(file, a.content);
      return { path: file, filename: a.filename || null, content_type: a.contentType, size: a.size };
    });
    return { folder: f.name, id, saved };
  });
}

// --- Sorting operations ---

export async function moveMessages(config, { folder = 'INBOX', ids, destination }) {
  return withImap(config, async (imap) => {
    // Without the MOVE extension node-imap falls back to COPY + \Deleted +
    // EXPUNGE, which can permanently remove other messages. Refuse instead.
    if (!imap.serverSupports('MOVE')) {
      throw new Error('IMAP server does not support MOVE; refusing to fall back to delete+expunge.');
    }
    const all = await getFolderList(imap);
    const src = resolveFolder(all, folder);
    const dest = resolveFolder(all, destination);

    if (isForbiddenDest(dest)) {
      throw new Error(`Moving to ${dest.name} is disabled: this server does not delete mail. Use Archive or a folder instead.`);
    }
    if (isLabel(dest)) {
      throw new Error(`${dest.name} is a label, not a folder. Use mail__add_label to label messages.`);
    }
    if (isVirtual(dest)) {
      throw new Error(`${dest.name} is a view, not a folder you can move into. To star messages use mail__mark_messages with starred=true.`);
    }
    if (isVirtual(src)) {
      throw new Error(`${src.name} is a view over other folders. Find the message's real folder with mail__search_messages (without a folder) and move it from there.`);
    }
    if (src.name === dest.name) {
      throw new Error(`Messages are already in ${dest.name}.`);
    }

    await call(imap, 'openBox', src.name, false);
    const { existing, missing } = await requireExisting(imap, ids, src.name);
    await call(imap, 'move', existing, dest.name);
    return {
      moved: existing,
      not_found: missing,
      from: src.name,
      to: dest.name,
      note: `Moved messages get new ids in ${dest.name}; list that folder to find them.`,
    };
  });
}

export async function addLabel(config, { folder = 'INBOX', ids, label }) {
  return withImap(config, async (imap) => {
    const all = await getFolderList(imap);
    const src = resolveFolder(all, folder);
    const labels = all.filter((f) => isSelectable(f) && isLabel(f));
    const lower = String(label).toLowerCase().replace(/^labels\//, '');
    const dest = labels.find((f) => f.name.toLowerCase() === `labels/${lower}`);
    if (!dest) {
      throw new Error(`Label "${label}" not found. Available labels: ${labels.map((f) => f.name).join(', ') || '(none)'}. Create it with mail__create_folder.`);
    }

    await call(imap, 'openBox', src.name, true);
    const { existing, missing } = await requireExisting(imap, ids, src.name);
    // Copying into a Labels/ mailbox applies the label; the message stays put.
    await call(imap, 'copy', existing, dest.name);
    return { labeled: existing, not_found: missing, folder: src.name, label: dest.name };
  });
}

export async function markMessages(config, { folder = 'INBOX', ids, read, starred }) {
  if (read === undefined && starred === undefined) {
    throw new Error('Specify read and/or starred.');
  }
  return withImap(config, async (imap) => {
    const { folder: f } = await openFolder(imap, folder, false);
    const { existing, missing } = await requireExisting(imap, ids, f.name);
    if (read !== undefined) {
      await call(imap, read ? 'addFlags' : 'delFlags', existing, ['\\Seen']);
    }
    if (starred !== undefined) {
      await call(imap, starred ? 'addFlags' : 'delFlags', existing, ['\\Flagged']);
    }
    return { updated: existing, not_found: missing, folder: f.name, read, starred };
  });
}

export async function createFolder(config, { name, kind = 'folder' }) {
  return withImap(config, async (imap) => {
    const all = await getFolderList(imap);
    const prefix = kind === 'label' ? 'Labels' : 'Folders';
    const bare = String(name).replace(/^(folders|labels)\//i, '');
    const fullName = `${prefix}/${bare}`;
    if (all.some((f) => f.name.toLowerCase() === fullName.toLowerCase())) {
      throw new Error(`${fullName} already exists.`);
    }
    await call(imap, 'addBox', fullName);
    return { created: fullName, kind };
  });
}
