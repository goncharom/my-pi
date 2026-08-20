# my-pi

Personal pnpm monorepo for everything I install into [Pi](https://pi.dev): skills and extensions.

## Layout

```text
packages/
├── skills/        # standalone skill packages
└── extensions/    # Pi extension packages and their support projects
```

The root `package.json` is also an aggregate Pi package. Its manifest exposes both resource directories, so installing the repository installs the whole catalog.

## Install

Install everything globally:

```bash
pi install .
```

Install everything into the current project's `.pi/settings.json` instead:

```bash
pi install -l .
```

## From a clone

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
pnpm install
```

Install all Pi skills and extensions globally:

```bash
pi install .
```

Or install them into the current project:

```bash
pi install -l .
```

Install one package locally:

```bash
pi install ./packages/skills/<skill-package>
pi install ./packages/extensions/<extension-package>
```

Install the Zellij control extension with:

```bash
pi install ./packages/extensions/pi-zellij
```

The Pi Review extension is installed with:

```bash
pi install ./packages/extensions/pi-vscode/packages/pi-extension
```

The VS Code extension is separate from Pi installation. Build and install its VSIX with:

```bash
pnpm --filter pi-vscode-review package
code --install-extension packages/extensions/pi-vscode/packages/vscode-extension/pi-vscode-review-0.1.0.vsix
```

After publishing the standalone skill packages, users can install them directly from npm:

```bash
pi install npm:pi-skill-browser-cdp
pi install npm:pi-skill-learn
```

You can also install the aggregate package directly from Git:

```bash
pi install git:github.com/<owner>/<repo>
```

Pi runs `npm install` for Git packages. No pnpm build or protocol build is required for the Pi resources. Use `pi config` to enable or disable individual resources. Pi does not install arbitrary Git subdirectories directly; for separate GitHub installs, clone the repository and install a local package path, or publish each standalone package to npm.

## Package conventions

Each standalone package should have its own `package.json` and be independently installable with `pi install <path>`:

```text
packages/skills/my-skill/
├── package.json
└── SKILL.md

packages/extensions/my-extension/
├── package.json
└── src/index.ts
```

Use a `pi` manifest in the package when the resource is not in a conventional directory. The Pi Review extension keeps its private shared protocol source at `packages/extensions/pi-vscode/packages/pi-extension/src/protocol/`; the VS Code extension bundles that source into its VSIX. Install the Pi extension with `pi install ./packages/extensions/pi-vscode/packages/pi-extension`.

## Development

```bash
pnpm install
pnpm build
```
