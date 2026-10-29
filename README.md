# xtooey

X in your terminal, no cap. Built with [OpenTUI](https://opentui.com), xtooey keeps it compact and keyboard-first while serving up timelines, quoted posts, profile pics, and media right where you work.

It's strictly read-only: no posting, replying, liking, reposting, or switching up your X account. Scroll the feed, catch the vibe, and jump to x.com when you want to do more.

## What's the move?

- Official X API v2 mode with your OAuth user token
- Optional cookie mode with Chrome, Brave, Edge, Firefox, or Safari (macOS only)
- Home/For You and Following timelines, depending on what the selected API actually offers
- Infinite scrolling with prefetch status, so you know when more heat is loading
- Native Kitty, Sixel, and terminal-block image rendering
- Quoted posts, profile pics, highlighted mentions, and long-post expansion
- Paginated direct comments, then right back to your exact spot in the timeline
- Keyboard-first navigation with mouse support for the controls on screen

## What you need

- [Bun](https://bun.sh) 1.3 or newer
- A terminal with Kitty or Sixel graphics for native images; other terminals get block rendering

## Get it

Fire it up straight from npm:

```bash
bunx xtooey
```

Or install the command globally. You still need Bun because the published CLI runs its TypeScript source with the Bun shebang.

```bash
bun add --global xtooey
xtooey
```

`npm install --global xtooey` works too, as long as Bun is installed and on your `PATH`.

## Run it from source

Clone your checkout, grab the dependencies, and let it rip:

```bash
bun install
bun run start
```

Want automatic restarts while you cook?

```bash
bun run dev
```

## Get connected

### The official X API route

This is the recommended route. Bring a user-context OAuth 2.0 access token with `tweet.read` and `users.read` scopes. You'll get X's documented reverse-chronological Following timeline.

Heads-up: X doesn't publish a For You endpoint in API v2. Comments run through Recent Search, so they only cover direct replies from the last seven days.

### The browser-session route

Browser mode pulls `auth_token` and `ct0` from a browser you pick. Xtooey scans that browser's profiles and uses the first one with both cookies. Safari is macOS-only. You can also paste `auth_token=...; ct0=...` yourself and skip browser detection.

Credentials stay in memory and never get written or logged. Official API tokens and manually pasted cookies don't survive a restart, so you'll need to enter those again.

Real talk: browser mode uses X's undocumented web GraphQL API through the deprecated `@steipete/bird` package for timelines and direct replies. X warns that non-API website automation can get your account permanently suspended. Only roll with this mode if you accept that risk.

Your OS might ask for Keychain, keyring, DPAPI, or browser-cookie-file access. Pick the browser holding the X session you actually want to use.

After you pick a browser, xtooey remembers only its ID in `browser-source` next to `config.jsonc`. On later starts, it tries that cookie store automatically if it's still detected. Picking the official API or manual cookies clears that preference. Hit `A` in the feed to run the full connection flow again and switch browsers, paste cookies, or go official.

If xtooey gets an authentication, rate-limit, or account-control response, it may stop the cookie session. Handle any account prompt on x.com, then hit `A` to reconnect.

## Run the keys

Keyboard is the main character here, but the mouse still gets love.

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

Don't spam `R`: refreshes are capped at once every 15 seconds in official API mode and once every 60 seconds in cookie mode. The status line shows the cooldown time left.

In image view, use `Left` / `Right` to switch images, `+` / `-` to zoom, `H` / `J` / `K` / `L` to pan, and `Escape` to bounce back. The viewer opens photos only. Videos and animated GIFs show up as preview images; xtooey doesn't play video or animation.

With a mouse, click posts or comments to select them, click an image to open it, hit the visible action labels and Show More/Less links, and use the wheel or an enabled scrollbar to scroll. Opening a post or comment on x.com stays keyboard-only with `O`. That uses `open` on macOS, `cmd start` on Windows, and `xdg-open` everywhere else.

If an image flops, xtooey logs the details to OpenTUI's console with sanitized URLs, post/media context, error code, HTTP status, cause, and stack. Hit backtick to see what's good.

## Make it yours

Xtooey reads one optional JSONC file. That's it. JSON works too because it's a subset of JSONC.

- macOS and Linux: `$XDG_CONFIG_HOME/xtooey/config.jsonc`, or `~/.config/xtooey/config.jsonc` when `XDG_CONFIG_HOME` is unset or relative
- Windows: `%APPDATA%\xtooey\config.jsonc`, falling back to `~/.config/xtooey/config.jsonc`

No project-local files, no merged config layers. Unknown or invalid fields get ignored one by one, valid sibling fields still apply, and rejected values fall back to defaults. If the whole file can't parse as JSONC, everything falls back to defaults. Xtooey logs each issue and pops open OpenTUI's console automatically.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/kommander/xtui/v0.1.0/xtooey.schema.json",
  // Hidden by default. Keys and the mouse wheel still scroll just fine.
  "scrollbar": true,
  "keybindings": {
    "x.feed.next": "down",
    "x.feed.previous": "up",
    "app.quit": "q",
  },
}
```

Every app command takes one OpenTUI key stroke. Single keys and modifier chords like `ctrl+q` are good; multi-stroke sequences get rejected and that command keeps its default.

`app.bindings` is global. Give it `?` or a non-text key/chord like `f1` or `ctrl+?`. Printable custom keys, `escape`, and keys already claimed by another command fall back to `?`, so help never blocks text entry or another move.

While a credential input has focus, printable keys type into the field instead of triggering `x.modal.back`, `app.console`, or `app.quit`. Modifier chords still work.

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

After changing the runtime schema, run `bun run schema` to regenerate `xtooey.schema.json`.

## Build your own

Need a standalone executable for your machine? Run:

```bash
bun run build
```

The executable lands in `dist/` with the platform and architecture in its filename.

Explicit Bun targets work too:

```bash
bun scripts/build.ts bun-darwin-arm64
bun scripts/build.ts bun-linux-x64
bun scripts/build.ts bun-linux-x64-musl
bun scripts/build.ts bun-windows-x64
```

Before cross-compiling, grab OpenTUI's optional native packages for every target you need:

```bash
bun install --os="*" --cpu="*" @opentui/core@0.5.1
```

Give every cross-compiled executable a smoke test on its actual target OS and architecture. Don't skip that.

## Ship it

Production npm releases go through npm Trusted Publishing from GitHub Actions. Peep [DEV.md](DEV.md) for development commands, npm/GitHub setup, and the full release procedure.

## Check your work

```bash
bun run test
bun run typecheck
bun run fmt:check
bun run lint
bun run package:smoke
```

Before a release, run `bun run release:check` for the whole spread: every check above plus an npm pack preview.

The app tests use OpenTUI's native in-memory renderer with keyboard and mouse drivers. Official X API requests hit a local HTTP server; the suite never touches X or your local browser sessions. CI runs the tests and package smoke check on Ubuntu, macOS, and Windows.

## OpenTUI development skill

If an agent is cooking in this repo, have it use OpenTUI's official agent skill. It's packed with current guidance on components, lifecycle, layout, keymaps, native images, and standalone builds.

Install it locally for every supported agent from the repo root:

```bash
npx skills add anomalyco/opentui --skill opentui --agent '*' -y
```

The generated skill directories and `skills-lock.json` stay gitignored on purpose. Each developer or agent workspace installs its own copy. When you're working with an AI coding agent, tell it to load and follow the `opentui` skill before planning or implementing OpenTUI changes.

## License

MIT. Do your thing.
