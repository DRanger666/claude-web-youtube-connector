# Claude Web YouTube Connector

A remote MCP server that gives Claude on the web, and on mobile, the YouTube
tools that the [`work-with-youtube`](https://github.com/DRanger666/claude-code-youtube-skill)
skill gives Claude Code: spoken-language captions, and Gemini for what captions
cannot give.

It runs on this laptop and is meant to be reached through Tailscale Funnel. That
keeps the Gemini keys on this machine, and YouTube sees an ordinary home
connection rather than a data center. The cost is that it works only while the
laptop is awake.

It adds no YouTube or Gemini logic of its own: it calls the installed skill's
`scripts/save_captions.mjs` and `scripts/gemini_video.py`, so a fix there reaches
both Claude Code and Claude on the web.

## Tools

| Tool | What it does |
|---|---|
| `video_info` | Title, channel, length, and the spoken-language captions available |
| `captions` | Spoken-language captions as timestamped paragraphs, for the whole video or a time range; never machine-translated |
| `gemini` | A question, or a transcript, about one clip of a video |
| `list_files` | The files in the saved-files folder |
| `read_file` | One saved file |
| `save_file` | Text from the chat, such as notes or a summary, saved to a file |

`captions` and `gemini` also take `save_as`, a path inside the saved-files
folder, `~/YouTube_from_Claude` (or `FILES_DIR`). That folder is the only place
the connector reads or writes: paths are relative to it, paths that leave it are
refused, and an existing file is replaced only with `overwrite`.

The server also sends Claude short usage rules: captions first, Gemini only for
what they lack, clip sizes that respect the Gemini quota, and checking saved
files before spending quota on a question answered earlier.

## Run it locally

Requires Node 24, the installed skill at `~/.claude/skills/work-with-youtube`
(or `SKILL_DIR`), and the YouTube MCP server install that the skill uses.

```sh
npm ci
npm start          # http://127.0.0.1:8790/mcp, and /health
npm test
```

`PORT` changes the port. `PUBLIC_URL` is the address Claude uses, such as
`https://machine.example.ts.net`; the server still listens only on 127.0.0.1,
and refuses requests addressed to any other host, a defense against DNS
rebinding.

## Sign-in

Every MCP request needs a token, which the server gives to whoever types the
passphrase on its sign-in page. Claude walks through this when the connector is
added: it registers itself, opens the sign-in page, and receives a token for an
hour and a refresh token for 90 days, which is replaced each time it is used.

Set the passphrase without putting it in a command line or the shell history:

```sh
read -rs p && printf %s "$p" | npm run --silent set-passphrase; unset p
```

What a stranger who finds the address can do:

- read the sign-in page and the public OAuth metadata, and `/health`
- register a client (20 an hour per address, the SDK's limit), but only one
  that sends codes back to Claude (`claude.ai` or `claude.com`) or to a
  program on this machine
- guess the passphrase ten times an hour; after that the sign-in page refuses
  everyone, including the user, until the hour has passed

The OAuth endpoints themselves (discovery, registration, PKCE, token requests)
are the MCP SDK's; `src/auth.js` only decides who gets a token. The passphrase
is stored as a scrypt hash, and clients and tokens in `auth.json`, both in
`~/.local/state/claude-web-youtube-connector` (or `STATE_DIR`) with owner-only
permissions. Deleting `auth.json` signs every client out.
