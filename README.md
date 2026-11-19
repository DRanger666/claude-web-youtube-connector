# Claude Web YouTube Connector

A remote MCP server that gives Claude on the web and in the Claude apps the
YouTube tools that the [`work-with-youtube`](https://github.com/DRanger666/claude-code-youtube-skill)
skill gives Claude Code: captions in the language spoken in the video, and
Gemini for what captions cannot give, such as slides or on-screen text.

claude.ai can use only connectors it reaches over the internet. This server is
meant to run on your own computer, published through Tailscale Funnel, rather
than on a rented server. That keeps your Gemini keys on your computer, costs
nothing while idle, and lets YouTube see an ordinary home connection; YouTube
often blocks caption requests from data centers. The cost is that the
connector works only while that computer is on and awake.

The server adds no YouTube or Gemini logic of its own. It runs the installed
skill's `scripts/save_captions.mjs` and `scripts/gemini_video.py`, so Claude Code
and Claude on the web behave the same way, and a fix to the skill reaches both.

## Tools

| Tool | What it does |
|---|---|
| `video_info` | Title, channel, length, and which spoken-language captions exist |
| `captions` | Spoken-language captions as timestamped paragraphs, for the whole video or a time range; never machine-translated |
| `gemini` | A question, or a transcript, about one clip of a video; the answer is always saved to a file |
| `list_files` | The files in the saved-files folder |
| `read_file` | One saved file |
| `save_file` | Text from the chat, such as notes or a summary, saved to a file |

`captions` and `gemini` also take `save_as`, a path inside the saved-files
folder, `~/YouTube_from_Claude`. Without it, `gemini` saves under `gemini/` with
a name made from the video, the clip and the time. That folder is the only place the connector
reads or writes: paths are relative to it, paths that leave it are refused, and
an existing file is replaced only when Claude sets `overwrite`.

The server also sends Claude short usage rules, which claude.ai passes on:
captions first, Gemini only for what they lack, clips small enough for the
Gemini quota, and a look at saved files before spending quota on a question
answered earlier.

## Long Gemini requests

claude.ai stops waiting for a tool after about 230 seconds (observed, not
documented), and runs one tool call at a time. A Gemini request can take
longer, so each one runs as a job that writes its answer to a file:

- By default the call waits up to 200 seconds. If the answer arrives, Claude
  gets it; if not, Claude gets the file's path and the request keeps running.
- With `wait: false` the call returns at once, so Claude can start several clips
  and collect them later. Three requests run at a time; the rest queue.
- While a request has no answer, `list_files` shows a marker beside its file:
  `FILE.running` (queued or started, with the time) or `FILE.failed` (the
  error). An answer cut off at Gemini's output limit is kept as `FILE.partial`.
- Jobs end if the server restarts; their markers then say so.

## Requirements

- Linux with systemd, for running it as a service. The server itself is plain
  Node and runs anywhere Node does.
- Node 24 and Python 3.
- The `work-with-youtube` skill, installed by following its README, including
  its setup script and the Gemini keys in
  `~/.claude/secrets/work-with-youtube.env`. The connector uses the skill's
  scripts, its keys, and the YouTube library its setup installs. It does not
  need the skill's YouTube Data API key.
- [Tailscale](https://tailscale.com), with HTTPS certificates and Funnel
  allowed for your tailnet in the admin console.
- A claude.ai plan that allows custom connectors.

## Install

```sh
git clone https://github.com/DRanger666/claude-web-youtube-connector
cd claude-web-youtube-connector
npm ci
npm test
npm run set-passphrase
```

The passphrase is what you will type when Claude asks you to sign in. It is
stored only as a scrypt hash.

Tell the server its public address, the machine's Tailscale name:

```sh
mkdir -p ~/.config/claude-web-youtube-connector
echo "PUBLIC_URL=https://$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')" \
  > ~/.config/claude-web-youtube-connector/env
```

Install it as a systemd user service, filling in where the repository is, and
start it:

```sh
mkdir -p ~/.config/systemd/user
sed "s|@REPO@|$PWD|" deploy/claude-web-youtube-connector.service \
  > ~/.config/systemd/user/claude-web-youtube-connector.service
systemctl --user daemon-reload
systemctl --user enable --now claude-web-youtube-connector
```

The service starts when you log in. To start it at boot without a login, run
`loginctl enable-linger` once.

Publish it:

```sh
tailscale funnel --bg 8790
curl https://YOUR-MACHINE.YOUR-TAILNET.ts.net/health    # answers: awake
```

## Connect Claude

In claude.ai, open Settings → Connectors → Add custom connector, and give the
address `https://YOUR-MACHINE.YOUR-TAILNET.ts.net/mcp`.

- Authentication: keep **Sign in now**.
- OAuth client: choose **Register automatically**. The server supports dynamic
  client registration, not Claude's published identity (CIMD).
- claude.ai may warn that the server took longer than 5 seconds and that some
  checks were skipped. The delay is in the route through Tailscale's relays;
  in testing, the connection worked despite the warning.

Connect, type your passphrase on the page titled "YouTube connector", and choose
Allow. The connector then works in claude.ai, in the Claude apps, and in Claude
Code signed in with the same account.

## Keeping it reachable

The connector answers only while its computer is on, awake and online. A laptop
that sleeps on battery, or when its lid closes, takes the connector with it, so
check the power settings. When Claude says the connector cannot be reached,
that is the likely cause; `/health` answers `awake` when it is reachable, which
you can check from a phone.

## Sign-in and what is exposed

Every MCP request needs a token, which the server gives to whoever types the
passphrase. Access tokens last an hour; refresh tokens last 90 days and are
replaced each time Claude uses one.

Anyone who finds the address can:

- read the sign-in page, the public OAuth metadata, and `/health`
- register a client (20 an hour per address, the MCP SDK's limit), but only one
  that sends sign-in codes to claude.ai, claude.com, or a program on the same
  computer
- guess the passphrase ten times an hour; after that sign-in is closed to
  everyone, you included, until the hour has passed

The OAuth endpoints (discovery, registration, PKCE, token requests) are the MCP
SDK's; `src/auth.js` only decides who gets a token. The passphrase hash, and
the registered clients and their tokens in `auth.json`, are kept in
`~/.local/state/claude-web-youtube-connector` with owner-only permissions.

## Day to day

| To | Run |
|---|---|
| See what Claude called | `journalctl --user -u claude-web-youtube-connector -n 30` |
| Change the passphrase | `npm run set-passphrase` (takes effect at the next sign-in) |
| Sign every client out | stop the service, delete `~/.local/state/claude-web-youtube-connector/auth.json`, start it |
| Take it off the internet | `tailscale funnel --https=443 off` |
| Stop it | `systemctl --user disable --now claude-web-youtube-connector` |

Delete `auth.json` only while the service is stopped: the server keeps tokens
in memory and would write the file back.

## Settings

Environment variables, all optional except `PUBLIC_URL` once it is published:

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | The address Claude uses; also the only host name accepted besides localhost, a defense against DNS rebinding |
| `PORT` | `8790` | Local port; the server listens only on 127.0.0.1 |
| `FILES_DIR` | `~/YouTube_from_Claude` | The saved-files folder |
| `STATE_DIR` | `~/.local/state/claude-web-youtube-connector` | Passphrase hash, clients and tokens |
| `SKILL_DIR` | `~/.claude/skills/work-with-youtube` | The installed skill |
| `PYTHON` | `python3` | Interpreter for the Gemini script, which needs only the standard library |
| `GEMINI_WAIT_SECONDS` | `200` | How long a `gemini` call waits before returning the file's path instead |

## Development

```sh
npm test
PUBLIC_URL=http://127.0.0.1:8790 npm start
```

Tests run against a server on a random port with scratch folders, and make no
YouTube or Gemini calls (`test/fake-python.sh` stands in for the Gemini script), but they need the skill installed, since the server
loads its scripts at startup.
