#!/usr/bin/env node
/**
 * Proton Mail MCP server — read and sort mail through Proton Bridge (IMAP).
 *
 * No sending and no deleting: the server cannot set \Deleted, expunge, or
 * move messages into Trash/Spam.
 */

import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  listFolders, listMessages, searchMessages, getMessage, getThread, saveAttachments,
  moveMessages, addLabel, markMessages, createFolder,
} from './mail/imap-client.js';

// --- Config ---

function loadConfig() {
  const configPath = path.join(process.env.HOME || '', '.proton-mcp', 'bridge.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  // PROTON_BRIDGE_USERNAME / PASSWORD / IMAP_HOST are older names, still accepted.
  const env = process.env;
  const username = env.PROTON_BRIDGE_USER || env.PROTON_BRIDGE_USERNAME;
  const password = env.PROTON_BRIDGE_PASS || env.PROTON_BRIDGE_PASSWORD;
  if (username && password) {
    return {
      imap_host: env.PROTON_BRIDGE_HOST || env.PROTON_BRIDGE_IMAP_HOST || '127.0.0.1',
      imap_port: parseInt(env.PROTON_BRIDGE_IMAP_PORT || '1143', 10),
      username,
      password,
    };
  }

  throw new Error(
    `Proton Bridge credentials not found. Set PROTON_BRIDGE_USER and PROTON_BRIDGE_PASS, or create ${configPath}.`,
  );
}

let config = null;
function getConfig() {
  if (!config) config = loadConfig();
  return config;
}

// --- Tool helpers ---

const server = new McpServer({ name: 'proton-mail', version: '5.0.0' });

const READ = { readOnlyHint: true, openWorldHint: false };
const SORT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function tool(name, description, inputSchema, annotations, fn) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(getConfig(), args), null, 1) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });
}

const folderArg = z.string().optional()
  .describe('Folder the message is in, as returned by other mail tools (default: INBOX)');
const idArg = z.number().int()
  .describe('Message id from mail__list_messages / mail__search_messages. Only valid together with its folder.');
const idsArg = z.array(z.number().int()).min(1)
  .describe('Message ids, all from the same folder');

// --- Reading ---

tool(
  'mail__list_folders',
  'List mail folders and labels with total and unread counts. kind is "folder" (a message lives in exactly one), "label" (tags; a message can have several), or "view" (All Mail, Starred: views over other folders). can_move_into says whether mail__move_messages accepts it as a destination.',
  {},
  READ,
  (cfg) => listFolders(cfg),
);

tool(
  'mail__list_messages',
  'List messages in one folder, newest first. Each message has an id that is stable within its folder; pass the same folder and id to other tools. Use offset to page through older mail; total is the number of matching messages in the folder.',
  {
    folder: z.string().optional().describe('Folder name (default: INBOX). Bare names like "Work" resolve to "Folders/Work".'),
    limit: z.number().int().min(1).max(100).optional().describe('Messages to return (default 20)'),
    offset: z.number().int().min(0).optional().describe('Skip this many of the newest messages (default 0)'),
    unread_only: z.boolean().optional().describe('Only unread messages (default false)'),
  },
  READ,
  (cfg, a) => listMessages(cfg, { folder: a.folder, limit: a.limit, offset: a.offset, unreadOnly: a.unread_only }),
);

tool(
  'mail__search_messages',
  'Search messages, newest first. All filters are optional and combined with AND. Without folder, searches every real folder (not labels, All Mail or Starred) so each message appears once, with the folder it is in.',
  {
    query: z.string().optional().describe('Text anywhere in headers or body'),
    from: z.string().optional().describe('Sender address or name contains'),
    to: z.string().optional().describe('Recipient address or name contains'),
    subject: z.string().optional().describe('Subject contains'),
    since: z.string().optional().describe('On or after this date (YYYY-MM-DD)'),
    before: z.string().optional().describe('Before this date (YYYY-MM-DD)'),
    unread_only: z.boolean().optional().describe('Only unread messages'),
    folder: z.string().optional().describe('Limit to one folder or label'),
    limit: z.number().int().min(1).max(100).optional().describe('Messages to return (default 20)'),
  },
  READ,
  (cfg, a) => searchMessages(cfg, {
    query: a.query, from: a.from, to: a.to, subject: a.subject, since: a.since, before: a.before,
    unreadOnly: a.unread_only, folder: a.folder, limit: a.limit,
  }),
);

tool(
  'mail__get_message',
  'Read one message: headers, plain-text body, and attachment list. Does not mark it as read.',
  {
    folder: folderArg,
    id: idArg,
    max_body_chars: z.number().int().min(100).optional().describe('Truncate the body after this many characters (default 20000)'),
  },
  READ,
  (cfg, a) => getMessage(cfg, { folder: a.folder, id: a.id, maxBodyChars: a.max_body_chars }),
);

tool(
  'mail__get_thread',
  'Read the whole conversation a message belongs to, oldest first, across all folders (so your sent replies are included). Each message includes its folder and id.',
  {
    folder: folderArg,
    id: idArg,
    max_body_chars: z.number().int().min(100).optional().describe('Truncate each body after this many characters (default 5000)'),
  },
  READ,
  (cfg, a) => getThread(cfg, { folder: a.folder, id: a.id, maxBodyChars: a.max_body_chars }),
);

tool(
  'mail__save_attachments',
  'Save a message\'s attachments to local files and return their paths.',
  {
    folder: folderArg,
    id: idArg,
    directory: z.string().optional().describe('Directory to save into (default: a per-message folder under the system temp dir)'),
  },
  { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  (cfg, a) => saveAttachments(cfg, { folder: a.folder, id: a.id, directory: a.directory }),
);

// --- Sorting ---

tool(
  'mail__move_messages',
  'Move messages from one folder to another (e.g. INBOX -> Archive or Folders/Work). Moving into Trash or Spam is not allowed. Moved messages get new ids in the destination folder; ids of other messages do not change.',
  {
    folder: z.string().optional().describe('Folder the messages are in now (default: INBOX)'),
    ids: idsArg,
    destination: z.string().describe('Destination folder, e.g. "Archive" or "Folders/Work" (see mail__list_folders)'),
  },
  SORT,
  (cfg, a) => moveMessages(cfg, { folder: a.folder, ids: a.ids, destination: a.destination }),
);

tool(
  'mail__add_label',
  'Add a label to messages. The messages stay in their folder and ids do not change.',
  {
    folder: folderArg,
    ids: idsArg,
    label: z.string().describe('Label name, e.g. "Receipts" or "Labels/Receipts"'),
  },
  SORT,
  (cfg, a) => addLabel(cfg, { folder: a.folder, ids: a.ids, label: a.label }),
);

tool(
  'mail__mark_messages',
  'Mark messages read/unread and/or starred/unstarred.',
  {
    folder: folderArg,
    ids: idsArg,
    read: z.boolean().optional().describe('true = read, false = unread'),
    starred: z.boolean().optional().describe('true = star, false = unstar'),
  },
  SORT,
  (cfg, a) => markMessages(cfg, { folder: a.folder, ids: a.ids, read: a.read, starred: a.starred }),
);

tool(
  'mail__create_folder',
  'Create a new folder (under Folders/) or label (under Labels/).',
  {
    name: z.string().describe('Name, e.g. "Receipts"'),
    kind: z.enum(['folder', 'label']).optional().describe('Default: folder'),
  },
  SORT,
  (cfg, a) => createFolder(cfg, { name: a.name, kind: a.kind }),
);

// --- Start ---

await server.connect(new StdioServerTransport());
