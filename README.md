# pi

Personal [Pi](https://pi.dev) package that bundles my extensions and skills behind one Git install, while remaining able to discover and import resources installed separately on any machine.

## Install

Install Pi and authenticate GitHub on machines that will publish changes:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
gh auth login
```

### Rolling install — required for package management

```bash
pi install git:github.com/yqwu905/pi
```

A rolling install checks out `main`. It can use the built-in `/package` manager to add, remove, pull, and publish resources.

### Pinned install — stable, read-only management

```bash
pi install git:github.com/yqwu905/pi@v1.2.0
```

Pinned tags load all bundled resources, but write operations under `/package` are intentionally rejected because the checkout is detached. Upgrade explicitly to a newer tag.

Provider credentials are not included. Run `/login` on every machine.

## Included resources

### Extensions

| Extension | Version | Purpose |
|---|---:|---|
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | 0.14.3 | Autonomous sub-agents |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.14.0 | Web search and content fetching |
| [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 2.1.0 | Structured user questions |
| [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 2.1.0 | Persistent task lists |
| [`@narumitw/pi-statusline`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-statusline) | 0.36.0 | Information-rich footer |
| `package-manager` | built in | Interactive `/package` management |

### Skills

- `grill-me` — explicitly start a plan/design interview with `/skill:grill-me`
- `grilling` — reusable interview discipline that Pi can load automatically

The skills are sourced from [`mattpocock/skills`](https://github.com/mattpocock/skills) at commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c`.

## Install other resources normally

This package does not prevent independent Pi customization. Install additional packages normally:

```bash
pi install npm:some-pi-package
pi install git:github.com/vendor/pi-package
```

User extensions, skills, prompts, and themes can also be placed in Pi's normal top-level resource directories. They remain independent until explicitly selected in `/package add`.

## `/package` commands

| Command | Purpose |
|---|---|
| `/package` | Open the management menu |
| `/package status` | Show bundle inventory, Git state, and resources available to import |
| `/package add` | Select missing npm/Git packages or local resources and stage them in the bundle |
| `/package remove` | Explicitly remove selected managed units, with optional local uninstall |
| `/package review` | Validate and inspect pending Git changes and the suggested semantic version |
| `/package pull` | Fast-forward a clean rolling checkout from `origin/main`, validate, and reload |
| `/package publish` | Validate, version, commit, push main and tag, create a GitHub Release, and reload |
| `/package doctor` | Diagnose schema, Git, GitHub auth, dependencies, audit, and interrupted transactions |

Only `/package publish` makes staged bundle changes available to other machines.

## Cross-machine contribution workflow

On any rolling-install machine:

1. Install extra resources independently.
2. Run `/package add` and select only the resources that belong in the bundle.
3. Resolve any same-name conflicts explicitly.
4. Run `/package review`.
5. Run `/package publish`, review the suggested version, and confirm direct publication to `main`.
6. Optionally remove newly bundled direct installs when prompted, preventing duplicate loading after reload.

Other rolling machines synchronize with:

```bash
pi update --extensions
```

or `/package pull`. Pinned machines install the new release tag explicitly.

### Concurrency rules

The manager never stashes, rebases, force-pushes, or silently overwrites another machine. Mutations require a synchronized `main`. If `origin/main` moved while local changes are pending, publication stops and reports the conflict for manual resolution.

Because the confirmed design edits Pi's managed Git checkout directly, **do not run `pi update --extensions` while `/package status` reports pending changes**: Pi reconciles managed clones with reset/clean and can discard them. The manager keeps an external recovery snapshot under `~/.pi/agent/package-manager-state/yqwu905-pi/`, but publication is still the preferred protection. Clean installations remain safe to update normally.

## Packaging model

`bundle.json` is the canonical inventory. It records protected resources, package sources, exact npm versions or Git commits, vendored paths, hashes, and resource ownership. `package.json` dependencies and `pi` resources are generated from it.

- npm packages use exact versions.
- Git packages with valid package metadata use commit-pinned dependencies.
- Local resources and Git packages that cannot be dependencies are copied under `vendor/`.
- Third-party Pi packages are imported as whole packages.
- Individual top-level extensions, skills, prompts, and themes are selectable separately.
- The package manager itself is protected from replacement and removal.

## Removal safety

Removing a unit from the bundle does not automatically erase its original local installation. `/package remove` offers a separate uninstall choice. Permanent deletion of file-based resources requires two confirmations and typing the exact resource ID.

## Development checks

```bash
npm install
npm test
npm run check
npm audit --omit=dev --registry=https://registry.npmjs.org
pi -e .
```

## Security

Pi extensions execute with the user's full permissions, and skills can instruct the agent to run commands. `/package add` always requires explicit selection and shows conflicts before changing the bundle.

The repository never includes `auth.json`, API/OAuth credentials, session history, project trust decisions, or model catalog caches.

## License

The bundle metadata, package manager, and maintenance scripts are MIT licensed. Third-party resources retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
