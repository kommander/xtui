# xtooey

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

Run directly from npm:

```bash
bunx xtooey
```

Or install the command globally. Bun is still required because the published CLI runs its TypeScript source with the Bun shebang.

```bash
bun add --global xtooey
xtooey
```

`npm install --global xtooey` also works when Bun is installed and available on `PATH`.

## Development

Install dependencies and run from a checkout:

```bash
bun install
bun run start
```

For automatic restart:

```bash
bun run dev
```

## Authentication

### Official X API

The recommended mode uses a user-context OAuth 2.0 access token with `tweet.read` and `users.read` scopes. It uses X's documented reverse-chronological Following timeline. X does not publish a For You endpoint in API v2. Comments use Recent Search and therefore cover direct replies created during the last seven days.

### Browser session

Browser mode reads `auth_token` and `ct0` from a selected local browser profile. Tokens stay in memory and are never written or logged. This mode uses X's undocumented web GraphQL API through the deprecated `@steipete/bird` package for timelines and direct replies. X warns that non-API website automation may result in permanent account suspension. Use it only if you accept that risk.

Your OS may request Keychain, keyring, DPAPI, or browser-cookie-file access. Select the browser that owns the X session you intend to use.

After you choose a browser, xtooey remembers only that browser's ID and tries its cookie store automatically on later starts. Press `A` from the feed to open the full connection flow and replace it with another browser, manual cookies, or the official API.

## Controls

| Key           | Action                                     |
| ------------- | ------------------------------------------ |
| `J` / `K`     | Select next/previous post or comment       |
| `Up` / `Down` | Scroll                                     |
| `Tab`         | Switch Home/Following when available       |
| `E`           | Show more/less for the selected long post  |
| `C`           | Show direct comments for the selected post |
| `I`           | Open the selected tweet's first image      |
| `O`           | Open the selected post or comment on x.com |
| `R`           | Refresh                                    |
| `A`           | Change authentication/session              |
| `?`           | Show active keybindings                    |
| `Escape`      | Return from comments or nested setup views |
| `` ` ``       | Toggle OpenTUI's captured console/log view |
| `Ctrl+C`      | Quit                                       |

In the image view, use `Left` / `Right` to move between images, `+` / `-` to zoom, `H` / `J` / `K` / `L` to pan, and `Escape` to return.

With a mouse, click posts or comments to select them, click an image to open it, click visible action labels and Show More/Less links, and use the wheel or an enabled scrollbar to scroll. Opening a selected post or comment on x.com remains keyboard-only with `O`.

Image failures are logged to OpenTUI's console with sanitized URLs, post/media context, error code, HTTP status, cause, and stack. Press backtick to inspect them.

## Configuration

xtooey reads one optional JSONC file. JSON is also supported because it is a subset of JSONC.

- macOS and Linux: `$XDG_CONFIG_HOME/xtooey/config.jsonc`, or `~/.config/xtooey/config.jsonc` when `XDG_CONFIG_HOME` is unset or relative
- Windows: `%APPDATA%\xtooey\config.jsonc`, falling back to `~/.config/xtooey/config.jsonc`

There are no project-local files or merged configuration layers. Unknown or invalid fields are ignored independently, valid sibling fields still apply, and defaults are used for anything rejected. xtooey logs each problem and opens OpenTUI's console automatically.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/kommander/xtui/v0.1.0/xtooey.schema.json",
  // Hidden by default. Scrolling still works with keys and the mouse wheel.
  "scrollbar": true,
  "keybindings": {
    "x.feed.next": "down",
    "x.feed.previous": "up",
    "app.quit": "q",
  },
}
```

Every application command can be rebound to one OpenTUI key stroke. Single keys and modifier chords such as `ctrl+q` are supported; multi-stroke sequences are rejected with a fallback to that command's default.

`app.bindings` is global. It accepts `?` or a non-text key/chord such as `f1` or `ctrl+?`; printable custom keys, `escape`, and keys used by another command fall back to `?` so help never blocks text entry or another action.

| Command                  | Default  |
| ------------------------ | -------- |
| `x.feed.next`            | `j`      |
| `x.feed.previous`        | `k`      |
| `x.feed.open`            | `o`      |
| `x.feed.image`           | `i`      |
| `x.feed.comments`        | `c`      |
| `x.feed.refresh`         | `r`      |
| `x.feed.toggle-expanded` | `e`      |
| `x.feed.switch-stream`   | `tab`    |
| `x.session.open`         | `a`      |
| `x.comments.next`        | `j`      |
| `x.comments.previous`    | `k`      |
| `x.comments.open`        | `o`      |
| `x.comments.image`       | `i`      |
| `x.comments.back`        | `escape` |
| `x.image.next`           | `right`  |
| `x.image.previous`       | `left`   |
| `x.image.zoom-in`        | `+`      |
| `x.image.zoom-out`       | `-`      |
| `x.image.pan-left`       | `l`      |
| `x.image.pan-down`       | `k`      |
| `x.image.pan-up`         | `j`      |
| `x.image.pan-right`      | `h`      |
| `x.image.close`          | `escape` |
| `x.modal.back`           | `escape` |
| `app.bindings`           | `?`      |
| `app.console`            | `` ` ``  |
| `app.quit`               | `ctrl+c` |

Run `bun run schema` after changing the runtime schema to regenerate `xtooey.schema.json`.

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

## Releasing

Production npm releases use npm Trusted Publishing from GitHub Actions. See [RELEASING.md](RELEASING.md) for the one-time npm/GitHub setup and release procedure.

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
