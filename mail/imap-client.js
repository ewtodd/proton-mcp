/**
 * IMAP client for Proton Bridge
 * Handles read operations: list, get, search, unread, thread, mark
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Create a short-lived IMAP connection, run `fn`, then close.
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

    imap.once('ready', () => {
      fn(imap)
        .then((result) => {
          imap.end();
          resolve(result);
        })
        .catch((err) => {
          imap.end();
          reject(err);
        });
    });

    imap.once('error', (err) => reject(new Error(`IMAP connection failed: ${err.message}. Is Proton Bridge running?`)));
    imap.connect();
  });
}

/**
 * Fetch messages by sequence numbers. Returns parsed message objects.
 *
 * Uses imap.seq.fetch (sequence-number mode): node-imap's public fetch()
 * is UID-based, and passing sequence numbers to it silently returns a
 * subset once the mailbox has been expunged (UIDs drift from seqnos).
 *
 * Also robust against messages whose requested body part the server never
 * delivers: instead of relying on the per-message 'end' event (which never
 * fires for such messages), we resolve on the fetch-level 'end' and walk
 * the expected sequence numbers, emitting a placeholder entry for anything
 * missing rather than dropping it silently.
 *
 * Pass a Set of unseen sequence numbers to get an accurate `seen` flag.
 */
function expandRange(range) {
  const seqnos = [];
  for (const part of String(range).split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (b === undefined) {
      seqnos.push(a);
    } else {
      for (let i = a; i <= b; i++) seqnos.push(i);
    }
  }
  return seqnos;
}

function fetchMessages(imap, seqnos, bodiesOpt = '', unseenIds = null) {
  return new Promise((resolve, reject) => {
    if (seqnos.length === 0) { resolve([]); return; }

    const bySeqno = new Map();
    const f = imap.seq.fetch(seqnos, { bodies: bodiesOpt, struct: true });

    f.on('message', (msg, seqno) => {
      const rec = { seqno, raw: '', ended: false };
      bySeqno.set(seqno, rec);
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { rec.raw += chunk.toString('utf8'); });
      });
      msg.once('end', () => { rec.ended = true; });
    });

    f.once('error', reject);
    f.once('end', async () => {
      const parsed = [];
      const seqnoList = Array.isArray(seqnos) ? seqnos : expandRange(seqnos);
      for (const seqno of seqnoList) {
        const rec = bySeqno.get(seqno);
        const seen = unseenIds ? !unseenIds.has(seqno) : true;
        if (!rec || !rec.ended) {
          // The server did not deliver the requested body part for this
          // message; include a placeholder instead of dropping it.
          parsed.push({ message_id: seqno, subject: '(message unavailable)', from: '', to: '', cc: '', date: '', body: '', message_id_header: null, in_reply_to: null, references: [], seen });
          continue;
        }
        try {
          const mail = await simpleParser(rec.raw);
          parsed.push({
            message_id: seqno,
            subject: mail.subject || '(no subject)',
            from: mail.from?.text || 'unknown',
            to: mail.to?.text || '',
            cc: mail.cc?.text || '',
            date: mail.date?.toISOString() || '',
            body: mail.text || mail.html || '',
            message_id_header: mail.messageId || null,
            in_reply_to: mail.inReplyTo || null,
            references: mail.references || [],
            seen,
          });
        } catch {
          parsed.push({ message_id: seqno, subject: '(parse error)', from: '', to: '', date: '', body: '', message_id_header: null, in_reply_to: null, references: [], seen });
        }
      }
      resolve(parsed);
    });
  });
}

/**
 * Open INBOX and return box info.
 */
function openInbox(imap, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function openFolder(imap, folder, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

/**
 * IMAP SEARCH wrapper. Sequence-number mode (imap.seq.search) so results
 * line up with the seqno-based fetches used elsewhere in this file.
 */
function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.seq.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results || []);
    });
  });
}

// --- Exported operations ---

export async function getUnread(config) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const uids = await imapSearch(imap, ['UNSEEN']);
    if (uids.length === 0) return { count: 0, messages: [] };

    const recent = uids.slice(-20);
    const unseenSet = new Set(uids);
    const messages = await fetchMessages(imap, recent, 'HEADER', unseenSet);
    return {
      count: uids.length,
      messages: messages.map((m) => ({
        message_id: m.message_id,
        subject: m.subject,
        from: m.from,
        date: m.date,
      })),
    };
  });
}

export async function listMessages(config, limit = 10) {
  return withImap(config, async (imap) => {
    const box = await openInbox(imap, true);
    const total = box.messages.total;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    const messages = await fetchMessages(imap, range, 'HEADER');

    // Check which are unseen
    const unseenSet = new Set(await imapSearch(imap, ['UNSEEN']));
    return messages
      .map((m) => ({ ...m, seen: !unseenSet.has(m.message_id), body: undefined }))
      .reverse();
  });
}

export async function getMessage(config, messageId, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, true);
    const unseenSet = new Set(await imapSearch(imap, ['UNSEEN']));
    const messages = await fetchMessages(imap, [messageId], '', unseenSet);
    if (messages.length === 0) throw new Error(`Message ${messageId} not found in ${folder}`);
    return messages[0];
  });
}

export async function searchMessages(config, query) {
  return withImap(config, async (imap) => {
    const allMessages = [];
    const folders = ['INBOX', 'Sent', 'Drafts', 'Archive'];

    for (const folder of folders) {
      try {
        await openFolder(imap, folder, true);
        const uids = await imapSearch(imap, [['TEXT', query]]);
        if (uids.length > 0) {
          const recent = uids.slice(-10);
          const messages = await fetchMessages(imap, recent, 'HEADER');
          allMessages.push(...messages.map((m) => ({ ...m, body: undefined, folder })));
        }
      } catch {
        // Folder may not exist — skip silently
      }
    }

    // Sort by date descending, return up to 20 results
    allMessages.sort((a, b) => new Date(b.date) - new Date(a.date));
    return allMessages.slice(0, 20);
  });
}

export async function getMessageHeaders(config, messageId, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, true);
    const messages = await fetchMessages(imap, [messageId], 'HEADER');
    if (messages.length === 0) throw new Error(`Message ${messageId} not found in ${folder}`);
    return {
      messageId: messages[0].message_id_header,
      subject: messages[0].subject,
      from: messages[0].from,
      to: messages[0].to,
      cc: messages[0].cc || null,
      references: messages[0].references,
      inReplyTo: messages[0].in_reply_to,
    };
  });
}

export async function getThread(config, messageId, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, true);
    const unseenSet = new Set(await imapSearch(imap, ['UNSEEN']));

    // 1. Fetch the starting message to get its threading headers
    const startMsgs = await fetchMessages(imap, [messageId], '', unseenSet);
    if (startMsgs.length === 0) throw new Error(`Message ${messageId} not found in ${folder}`);

    // 2. Collect all Message-IDs in the thread
    const refIds = [
      startMsgs[0].message_id_header,
      ...(startMsgs[0].references || []),
      startMsgs[0].in_reply_to,
    ].filter(Boolean);

    // 3. Search INBOX for each referenced Message-ID
    const allSeqnos = new Set([messageId]);
    for (const id of refIds) {
      const results = await imapSearch(imap, [['HEADER', 'Message-ID', id]]);
      results.forEach(n => allSeqnos.add(n));
    }

    // 4. Fetch all matching messages
    const seqnoArray = [...allSeqnos];
    const threadMsgs = await fetchMessages(imap, seqnoArray, '', unseenSet);

    // 5. Sort chronologically
    return threadMsgs.sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

export async function markMessage(config, messageId, read, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, false);
    await new Promise((resolve, reject) => {
      const fn = read ? imap.seq.addFlags.bind(imap.seq) : imap.seq.delFlags.bind(imap.seq);
      fn(messageId, ['\\Seen'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, read };
  });
}

export async function starMessage(config, messageId, star, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, false);
    await new Promise((resolve, reject) => {
      const fn = star ? imap.seq.addFlags.bind(imap.seq) : imap.seq.delFlags.bind(imap.seq);
      fn(messageId, ['\\Flagged'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, starred: star };
  });
}

export async function deleteMessage(config, messageId, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, false);
    await new Promise((resolve, reject) => {
      imap.seq.addFlags(messageId, ['\\Deleted'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      imap.expunge((err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, deleted: true };
  });
}

export async function moveMessage(config, messageId, destFolder, sourceFolder = 'INBOX') {
  if (sourceFolder === destFolder) {
    throw new Error(`Source folder and destination folder are the same: ${destFolder}`);
  }
  return withImap(config, async (imap) => {
    await openBox(imap, sourceFolder, false);
    await new Promise((resolve, reject) => {
      imap.seq.move(messageId, destFolder, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, moved_from: sourceFolder, moved_to: destFolder };
  });
}

export async function listFolders(config) {
  return withImap(config, async (imap) => {
    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) reject(err);
        else {
          const folders = [];
          function walk(obj, prefix = '') {
            for (const [name, box] of Object.entries(obj)) {
              const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
              folders.push({ name: fullName, delimiter: box.delimiter });
              if (box.children) walk(box.children, fullName);
            }
          }
          walk(boxes);
          resolve(folders);
        }
      });
    });
  });
}

function openBox(imap, folder, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

export async function listMessagesInFolder(config, folder, limit = 10) {
  return withImap(config, async (imap) => {
    const box = await openBox(imap, folder, true);
    const total = box.messages.total;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    const messages = await fetchMessages(imap, range, 'HEADER');
    const unseenSet = new Set(await imapSearch(imap, ['UNSEEN']));
    return messages
      .map((m) => ({ ...m, seen: !unseenSet.has(m.message_id), body: undefined }))
      .reverse();
  });
}

export async function getAttachments(config, messageId, folder = 'INBOX') {
  return withImap(config, async (imap) => {
    await openBox(imap, folder, true);

    return new Promise((resolve, reject) => {
      const f = imap.seq.fetch([messageId], { bodies: '', struct: true });
      let raw = '';

      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
        });
      });

      f.once('error', reject);
      f.once('end', async () => {
        try {
          const mail = await simpleParser(raw);
          const attachments = (mail.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            content: a.content.toString('base64'),
          }));
          resolve(attachments);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}
