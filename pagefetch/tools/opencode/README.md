# pagefetch OpenCode Integration

OpenCode integration for [pagefetch](https://github.com/anthropics/pagefetch) — includes a custom tool and an instruction skill.

- **Tool** (`tools/pagefetch.ts`): Adds a `pagefetch` tool to your OpenCode session for fetching web pages via headless browser.
- **Instruction** (`instruction/prefer-pagefetch.md`): Skill that guides OpenCode to prefer `pagefetch` over `webfetch` when fetching web content.

## Prerequisites

1. **pagefetch CLI** must be available in your PATH. Choose one:

   ### Install globally

   ```bash
   cd path/to/pagefetch
   npm install -g .
   ```

   ### Alternatives:

   **Option B: Link from a local clone**

   ```bash
   cd /path/to/pagefetch
   npm install
   npm link
   ```

   This symlinks `pagefetch` into your global `node_modules/.bin/`.

   **Option C: Symlink the binary directly**

   ```bash
   ln -s /path/to/pagefetch/bin/pagefetch.js ~/.local/bin/pagefetch
   ```

   Make sure `~/.local/bin` is in your `PATH`. You can check with `echo $PATH` or add it to your shell profile:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

2. **Playwright Chromium** must be installed:
   ```bash
   npx playwright install chromium
   ```

## Installation

You can install just the tool or both the tool and the instruction skill.

### Install the tool

#### Global (all projects)

```bash
mkdir -p ~/.config/opencode/tools

cp tools/opencode/tools/pagefetch.ts ~/.config/opencode/tools/pagefetch.ts
# OR: ln -s "$(pwd)/tools/opencode/tools/pagefetch.ts" ~/.config/opencode/tools/pagefetch.ts
```

#### Per-project

```bash
mkdir -p theproject/.opencode/tools

cp tools/opencode/tools/pagefetch.ts theproject/.opencode/tools/pagefetch.ts
# OR: ln -s "$(pwd)/tools/opencode/tools/pagefetch.ts" theproject/.opencode/tools/pagefetch.ts
```

### Install the instruction skill

#### Global (all projects)

```bash
mkdir -p ~/.config/opencode/skills/prefer-pagefetch

cp tools/opencode/instruction/prefer-pagefetch.md ~/.config/opencode/skills/prefer-pagefetch/SKILL.md
# OR: ln -s "$(pwd)/tools/opencode/instruction/prefer-pagefetch.md" ~/.config/opencode/skills/prefer-pagefetch/SKILL.md
```

#### Per-project

```bash
mkdir -p theproject/.opencode/skills/prefer-pagefetch

cp tools/opencode/instruction/prefer-pagefetch.md theproject/.opencode/skills/prefer-pagefetch/SKILL.md
# OR: ln -s "$(pwd)/tools/opencode/instruction/prefer-pagefetch.md" theproject/.opencode/skills/prefer-pagefetch/SKILL.md
```

## Restart OpenCode

After installing, restart OpenCode to load the new tool. You should see `pagefetch` in your available tools.

## Usage

Once installed, ask to fetch a page. If it uses another tool such as the
native webfetch then ask it to use 'pagefetch'.

## Tool Parameters

| Parameter   | Type   | Required | Description                                              |
| ----------- | ------ | -------- | -------------------------------------------------------- |
| `url`       | string | Yes      | URL to fetch                                             |
| `wait`      | enum   | No       | Wait strategy: `load`, `domcontentloaded`, `networkidle` |
| `timeout`   | number | No       | Timeout in milliseconds (default: 30000)                 |
| `userAgent` | string | No       | Custom user agent string                                 |

## How It Works

**Tool**: Shells out to the `pagefetch` CLI and returns the rendered HTML via stdout. No files are written — OpenCode captures the output directly.

**Instruction**: A skill loaded on demand. Guides the model to prefer `pagefetch` over `webfetch` and defines the fallback protocol when a fetch fails.
