# proton-mcp

MCP server for **reading and sorting Proton Mail** through Proton Bridge (IMAP).

It cannot send or delete mail: there are no send/delete tools, it never sets `\Deleted` or expunges, and it refuses to move messages into Trash or Spam (Proton can auto-empty both).

## Requirements

- **Proton Mail Bridge** running on the host
- **Node.js 22+**

## Installation

```bash
git clone https://github.com/jorgenclaw/proton-mcp.git
cd proton-mcp
npm install
```

## Configuration

Set these environment variables (or copy `.env.example` to `.env`):

```env
PROTON_BRIDGE_HOST=127.0.0.1
PROTON_BRIDGE_IMAP_PORT=1143
PROTON_BRIDGE_USER=your@proton.me
PROTON_BRIDGE_PASS=your-bridge-password
```

The Bridge password is the IMAP password shown for your account in the Proton Bridge app. It is NOT your Proton account password.

Alternatively, put `{"username": "...", "password": "...", "imap_host": "127.0.0.1", "imap_port": 1143}` in `~/.proton-mcp/bridge.json`.

## Usage

Claude Code:

```bash
claude mcp add proton-mail \
  -e PROTON_BRIDGE_USER=your@proton.me \
  -e PROTON_BRIDGE_PASS=your-bridge-password \
  -- node /path/to/proton-mcp/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "proton-mail": {
      "command": "node",
      "args": ["/path/to/proton-mcp/index.js"],
      "env": {
        "PROTON_BRIDGE_USER": "your@proton.me",
        "PROTON_BRIDGE_PASS": "your-bridge-password"
      }
    }
  }
}
```

Standalone: `node --env-file=.env index.js` (speaks MCP over stdio).

## How messages are identified

Every message is addressed by **folder + id**. The id is the IMAP UID: it stays the same when other messages are moved out of the folder. A message gets a new id when it is itself moved to another folder.

Folder names can be given as the full name (`Folders/Work`, `Labels/Receipts`) or the bare name (`Work`).

## Tools

### Reading

| Tool | Description |
|------|-------------|
| `mail__list_folders` | Folders and labels with total/unread counts |
| `mail__list_messages` | Messages in one folder, newest first, with paging and an unread filter |
| `mail__search_messages` | Search by text, sender, recipient, subject, date, unread; across all folders or one |
| `mail__get_message` | Headers, plain-text body, attachment list (does not mark as read) |
| `mail__get_thread` | Whole conversation across folders, including your sent replies |
| `mail__save_attachments` | Save attachments to local files, returns paths |

### Sorting

| Tool | Description |
|------|-------------|
| `mail__move_messages` | Move messages to another folder (not Trash/Spam) |
| `mail__add_label` | Apply a label; message stays where it is |
| `mail__mark_messages` | Read/unread, star/unstar |
| `mail__create_folder` | Create a folder or label |

## License

MIT — see [LICENSE](LICENSE)
