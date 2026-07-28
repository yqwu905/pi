# pi

Personal [Pi](https://pi.dev) package that bundles my extensions and user-level skills behind one Git install.

## Included extensions

| Extension | Version | Purpose |
|---|---:|---|
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | 0.14.3 | Autonomous sub-agents |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.14.0 | Web search and content fetching |
| [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 2.1.0 | Structured user questions |
| [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 2.1.0 | Persistent task lists |
| [`@narumitw/pi-statusline`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-statusline) | 0.36.0 | Information-rich footer |

## Included skills

- `grill-me` — explicitly start a plan/design interview with `/skill:grill-me`
- `grilling` — reusable interview discipline that Pi can load automatically

The skills are sourced from [`mattpocock/skills`](https://github.com/mattpocock/skills) at commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c`.

## Install and synchronize

Install Pi first:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### Rolling mode — recommended for personal machines

Install the default branch once:

```bash
pi install git:github.com/yqwu905/pi
```

Synchronize later with one command:

```bash
pi update --extensions
```

Restart Pi or run `/reload` after an update.

### Stable mode — pinned and reproducible

```bash
pi install git:github.com/yqwu905/pi@v1.1.0
```

Pinned Git refs do not move during `pi update --extensions`. Upgrade explicitly:

```bash
pi install git:github.com/yqwu905/pi@v1.2.0
```

Provider credentials and machine-specific settings are intentionally excluded. Run `/login` on each machine.

## Maintaining the bundle

This repository treats one primary machine's direct npm package installs and `~/.pi/agent/skills/` as the input inventory.

1. Install or update extensions on the primary machine:

   ```bash
   pi install npm:some-pi-package
   pi update --extensions
   ```

2. Synchronize exact installed versions and user skills into this repository:

   ```bash
   cd ~/repos/pi
   npm run sync
   npm install
   npm run check
   git diff
   ```

3. Publish a new semantic version after reviewing the diff:

   ```bash
   ./scripts/release.sh 1.2.0
   ```

The sync script:

- reads npm package sources from `~/.pi/agent/settings.json`;
- pins their currently installed versions in `package.json`;
- imports every resource declared by each dependency's `pi` manifest;
- mirrors `~/.pi/agent/skills/` into `skills/`;
- refuses to silently copy user-level extensions, prompts, or themes, which should be reviewed manually.

Non-npm package sources are reported and skipped. `package-lock.json` pins transitive dependencies.

## Remove

```bash
pi remove git:github.com/yqwu905/pi
```

## Security

Pi extensions execute with the user's full permissions, and skills can direct the agent to run commands. Review dependency and skill changes before releasing or updating.

The repository never includes `auth.json`, session history, project trust decisions, or model catalog caches.

## License

The bundle metadata and maintenance scripts are MIT licensed. Third-party extensions and skills remain under their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
