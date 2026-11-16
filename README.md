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

The server also sends Claude short usage rules: captions first, Gemini only for
what they lack, and clip sizes that respect the Gemini quota.

## Run it locally

Requires Node 24, the installed skill at `~/.claude/skills/work-with-youtube`
(or `SKILL_DIR`), and the YouTube MCP server install that the skill uses.

```sh
npm ci
npm start          # http://127.0.0.1:8790/mcp, and /health
npm test
```

`PORT` changes the port. `PUBLIC_HOST` adds the public hostname to the allowed
`Host` headers, which the server otherwise refuses as a defense against DNS
rebinding.

Do not publish it yet: it has no sign-in.
