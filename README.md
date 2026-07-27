# pi

Personal [Pi](https://pi.dev) extension bundle. It installs the extensions I use through one versioned Git package.

## Included extensions

| Extension | Version | Purpose |
|---|---:|---|
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) | 0.14.3 | Autonomous sub-agents |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | 0.14.0 | Web search and content fetching |
| [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 2.1.0 | Structured user questions |
| [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 2.1.0 | Persistent task lists |

Direct dependencies and transitive dependencies are pinned by `package-lock.json`.

## Install

Install Pi first:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Then install this bundle:

```bash
pi install git:github.com/yqwu905/pi@v1.0.0
```

Until the first release tag exists, install the default branch:

```bash
pi install git:github.com/yqwu905/pi
```

Restart Pi or run `/reload` after installation. Provider credentials are intentionally not included; use `/login` on each machine.

## Update

Unpinned default-branch installs can be updated with:

```bash
pi update git:github.com/yqwu905/pi
```

Pinned installs are intentionally not moved by `pi update`. Install a newer tag explicitly:

```bash
pi install git:github.com/yqwu905/pi@v1.1.0
```

## Remove

```bash
pi remove git:github.com/yqwu905/pi
```

## Development

```bash
npm install --ignore-scripts
pi -e .
```

The package references each dependency's declared extension entry point under `node_modules/`. Do not commit `node_modules`; Pi installs dependencies when it installs this Git package.

## Scope

This repository bundles extensions only. It does not contain Pi authentication tokens, session history, project trust decisions, or machine-specific settings.

## Security

Pi extensions execute with the user's full permissions. Review this repository and all dependency changes before installing or updating it.

## License

The bundle metadata is MIT licensed. Included extensions remain under their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
