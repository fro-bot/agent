# @fro.bot/harness

The patched OpenCode build that Fro Bot runs. Installing this package puts two commands on your `PATH`:

- **`harness`** — the patched OpenCode plus a few harness-own subcommands.
- **`opencode`** — the patched OpenCode and nothing else.

## Commands

### `harness`

| Command             | Does                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `harness info`      | Print provenance: base version, integration refs, build SHA              |
| `harness patches`   | List the integration refs carried on top of upstream                     |
| `harness doctor`    | Check that the resolved binary is present, runnable, and the right build |
| `harness integrate` | Run the integration pipeline (maintainers)                               |
| `harness --help`    | Print usage                                                              |
| `harness --version` | Print the harness provenance version                                     |

Everything else passes through to the patched binary: `harness run ...` behaves like `opencode run ...`.

### `opencode`

A pure passthrough. It has no reserved subcommands: every argument, including `--version`, `info`, `doctor`, and `upgrade`, goes to the patched binary unchanged. Tools that look `opencode` up by name (editors, scripts, the OpenCode SDK) get the patched build.

## Install

```bash
npm i -g @fro.bot/harness
bun add -g @fro.bot/harness
mise use -g npm:@fro.bot/harness
```

The native binary ships in a per-platform package that the installer pulls in as an optional dependency:

| Package                         | Platform    |
| ------------------------------- | ----------- |
| `@fro.bot/harness-linux-x64`    | Linux x64   |
| `@fro.bot/harness-linux-arm64`  | Linux arm64 |
| `@fro.bot/harness-darwin-x64`   | macOS x64   |
| `@fro.bot/harness-darwin-arm64` | macOS arm64 |

Windows is not supported. Install does not fail when the platform package is missing; the commands then exit with a message until a binary is provided (see below).

### Install caveats

Both commands share the name `opencode` with the stock `opencode-ai` package, so the two compete for the same bin. OpenCode 2's `@opencode/cli` (which also declares `opencode2`) declares an `opencode` bin too and collides the same way. The legacy `opencode-ai` and `@opencode-ai/sdk` packages end at 1.19.0.

- **npm:** if `opencode-ai` is installed globally, installing the harness fails with `EEXIST` because that package already owns the `opencode` bin. `npm i -g --force @fro.bot/harness` overwrites the bin. Uninstalling the harness afterwards removes it and leaves no `opencode` on your system; reinstall `opencode-ai` if you want the stock command back.
- **bun:** a global install silently overwrites the existing `opencode` bin.
- **mise:** which `opencode` runs depends on `PATH` order between the tools mise manages. Check with `which opencode`.

## How the binary is found

In order:

1. **`OPENCODE_PATH`** — an explicit path to the native binary (an absolute path is recommended), not a script or a dispatcher such as a mise shim. A bare or relative value resolves against the current directory and is never looked up on `PATH`.
2. **The platform package** — `@fro.bot/harness-<os>-<arch>`, resolved from the installed harness.
3. **`HARNESS_ALLOW_PATH_FALLBACK=1`** — searches `PATH` for a native `opencode`. For development only.

Resolution never runs the binary to check it. Candidates are rejected rather than executed when they are:

- not a native binary (a script or dispatcher cannot be proven to be the patched build);
- not executable;
- one of the harness's own entry points, which would recurse forever. This check compares real paths and inodes, so symlinks and hardlinks to the shim are caught. A copy of the shim is a different file and is not recognized as one.

`harness doctor` is the exception: it runs the binary with `--version` and compares it with the expected build. It also prints the binary the `opencode` command will run (`opencode command:`) and exits non-zero if that resolution fails, even when the probe passed.

## Upgrading

`opencode upgrade` is unsupported for a harness install, and OpenCode never updates it in place. Update the package with the tool you installed it with:

```bash
npm i -g @fro.bot/harness@latest
bun add -g @fro.bot/harness@latest
mise upgrade
```

Do not run `opencode upgrade --method <pm>`: that installs stock `opencode-ai` from the package manager, not the harness. `opencode upgrade --major --method <pm>` is worse: it removes the global `opencode-ai` package and installs OpenCode 2 (`@opencode/cli`), also not the harness.

Since 1.19, OpenCode never installs updates automatically; the `autoupdate` setting only controls the update notice. The interactive TUI checks for a newer release shortly after startup and every 10 minutes, and may show an update notice or an "OpenCode 2" notice. Set `autoupdate: false` or `OPENCODE_DISABLE_AUTOUPDATE` to turn the check off. `opencode serve` never runs the check.

The install method is detected by asking each package manager whether `opencode-ai` is installed globally (a binary under `.opencode/bin` or `.local/bin` counts as a curl install). A harness install matches none of these, so its method is `unknown`, and applying an update from `/update`, `opencode upgrade`, or `opencode upgrade --major` fails: the TUI reports "Installation method not found", and the CLI reports an unknown installation method (`opencode upgrade` first asks "Install anyways?", defaulting to No). Because the check for an unknown method reads the stock GitHub release and the harness reports `<base>+harness.<sha>`, the TUI may show an update notice even when the base release is current.

If stock `opencode-ai` is also installed under a detected package manager, the method is detected as that manager, and an applied update targets that stock install instead.

## Signals and exit codes

The shim runs the binary as a direct child with inherited stdio and stays in your terminal's foreground group, so terminal input, Ctrl-C, and window resizing behave as they do for stock OpenCode.

- **Signals:** `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGUSR1`, and `SIGUSR2` are forwarded to the child. A signal sent to the whole foreground group, such as Ctrl-C or a terminal hangup, may therefore reach the child twice.
- **Cases that cannot be forwarded:** `SIGKILL` sent to the shim, or an uncaught error inside it, can leave the server running.
- **Hangup protection does not carry through the shim:** Node resets inherited signal ignores at startup, so `nohup opencode serve` and `trap '' HUP` do not protect a server that runs through the shim. To keep a server alive across a hangup, invoke the native binary directly, not through the shim: `nohup "$OPENCODE_PATH" serve` with `OPENCODE_PATH` set to the native binary, or the platform package's `bin/opencode`. (Setting `OPENCODE_PATH` alone still launches it through the shim.)

Exit codes:

| Code         | Meaning                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| child's code | Passed through unchanged                                                                           |
| signal death | `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT` are re-raised on the shim; any other signal exits `128+n` |
| `127`        | Binary not found, rejected by resolution, or a self-reference                                      |
| `126`        | Binary exists but is not executable                                                                |
| `1`          | Any other spawn failure, or an unexpected error in the shim                                        |

## Development checkouts

In a checkout of this repository, `bun install` links `node_modules/.bin/opencode` to the workspace shim, so `opencode` inside `bun run` scripts resolves to it. The workspace has no platform package, so set `OPENCODE_PATH` to a native harness binary first:

```bash
OPENCODE_PATH=/path/to/native/opencode bun run <script>
```

## License

MIT. Embeds [cortexkit/orw](https://github.com/cortexkit/orw)'s integration method and redistributes a modified [OpenCode](https://github.com/anomalyco/opencode) build; see `LICENSE`.
