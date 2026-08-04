# xtui

A compact, keyboard-driven X client built with [OpenTUI](https://opentui.com). It renders timelines, quoted posts, profile pictures, and post media directly in the terminal.

## Features

- Official X API v2 mode with OAuth user tokens
- Optional browser-session mode using Chrome, Brave, Edge, Firefox, or Safari cookies
- Home/For You and Following timelines where the selected API supports them
- Infinite scrolling with visible prefetch status
- Native Kitty, Sixel, and terminal-block image rendering
- Quoted posts, profile images, mention highlighting, and long-post expansion
- Paginated direct comments with exact return to the previous timeline position
- Keyboard-first navigation with mouse support for visible controls

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- A terminal with Kitty or Sixel graphics for native images; other terminals use block rendering

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

For development with automatic restart:

```bash
bun run dev
```

## Authentication

### Official X API

The recommended mode uses a user-context OAuth 2.0 access token with `tweet.read` and `users.read` scopes. It uses X's documented reverse-chronological Following timeline. X does not publish a For You endpoint in API v2. Comments use Recent Search and therefore cover direct replies created during the last seven days.

### Browser session

Browser mode reads `auth_token` and `ct0` from a selected local browser profile. Tokens stay in memory and are never written or logged. This mode uses X's undocumented web GraphQL API through the deprecated `@steipete/bird` package for timelines and direct replies. X warns that non-API website automation may result in permanent account suspension. Use it only if you accept that risk.

Your OS may request Keychain, keyring, DPAPI, or browser-cookie-file access. Select the browser that owns the X session you intend to use.

After you choose a browser, xtui remembers only that browser's ID and tries its cookie store automatically on later starts. Press `A` from the feed to open the full connection flow and replace it with another browser, manual cookies, or the official API.

## Controls

| Key           | Action                                     |
| ------------- | ------------------------------------------ |
| `J` / `K`     | Select next/previous post or comment       |
| `Up` / `Down` | Scroll                                     |
| `Tab`         | Switch Home/Following when available       |
| `E`           | Show more/less for the selected long post  |
| `C`           | Show direct comments for the selected post |
| `O`           | Open the selected post or comment on x.com |
| `R`           | Refresh                                    |
| `A`           | Change authentication/session              |
| `Escape`      | Return from comments or nested setup views |
| `` ` ``       | Toggle OpenTUI's captured console/log view |
| `Ctrl+C`      | Quit                                       |

With a mouse, click posts or comments to select them, click visible action labels and Show More/Less links, and use the wheel or scrollbar to scroll. Opening a selected post or comment on x.com remains keyboard-only with `O`.

Image failures are logged to OpenTUI's console with sanitized URLs, post/media context, error code, HTTP status, cause, and stack. Press backtick to inspect them.

## Build

Build a standalone executable for the current host:

```bash
bun run build
```

The executable is written to `dist/` with its platform and architecture in the filename.

Explicit Bun targets are supported:

```bash
bun scripts/build.ts bun-darwin-arm64
bun scripts/build.ts bun-linux-x64
bun scripts/build.ts bun-linux-x64-musl
bun scripts/build.ts bun-windows-x64
```

Before cross-compiling, install OpenTUI's optional native packages for all required targets:

```bash
bun install --os="*" --cpu="*" @opentui/core@0.5.1
```

Cross-compiled executables must be smoke-tested on their target OS and architecture.

## Development Checks

```bash
bun run test
bun run typecheck
bun run fmt:check
bun run lint
```

The application tests use OpenTUI's native in-memory renderer and keyboard driver. Official X API requests go to a local HTTP server; the suite does not access X or local browser sessions.

## OpenTUI Development Skill

Use OpenTUI's official agent skill for development in this repository. It contains the current component, lifecycle,
layout, keymap, native-image, and standalone-build guidance that coding agents should follow before changing the app.

Install it locally for all supported agents from the repository root:

```bash
npx skills add anomalyco/opentui --skill opentui --agent '*' -y
```

The generated skill directories and `skills-lock.json` are intentionally gitignored. Each developer or agent workspace
should install its own copy. When using an AI coding agent, ask it to load and follow the `opentui` skill before planning
or implementing OpenTUI changes.

## License

MIT
