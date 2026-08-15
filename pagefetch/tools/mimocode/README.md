# pagefetch MiMoCode Integration

MiMoCode integration for [pagefetch](https://github.com/anthropics/pagefetch) — includes a custom tool and an instruction file.

- **Tool** (`tool/pagefetch.ts`): Adds a `pagefetch` tool to your MiMoCode session for fetching web pages via headless browser.
- **Instruction** (`instruction/prefer-pagefetch.md`): Guides MiMoCode to prefer `pagefetch` over `webfetch` when fetching web content.

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

3. **MiMoCode** must have the plugin SDK available (`@mimo-ai/plugin`).

## Installation

You can install just the tool or both the tool and the instruction.

### Install the tool

#### Global (all projects)

```bash
mkdir -p ~/.config/mimocode/tools

cp tools/mimocode/tool/pagefetch.ts ~/.config/mimocode/tools/pagefetch.ts
# OR: ln -s "$(pwd)/tools/mimocode/tool/pagefetch.ts" ~/.config/mimocode/tools/pagefetch.ts
```

#### Per-project

```bash
mkdir -p theproject/.mimocode/tools

cp tools/mimocode/tool/pagefetch.ts theproject/.mimocode/tools/pagefetch.ts
# OR: ln -s "$(pwd)/tools/mimocode/tool/pagefetch.ts" theproject/.mimocode/tools/pagefetch.ts
```

### Install the instruction

#### Global (all projects)

```bash
mkdir -p ~/.config/mimocode/instructions

cp tools/mimocode/instruction/prefer-pagefetch.md ~/.config/mimocode/instructions/prefer-pagefetch.md
# OR: ln -s "$(pwd)/tools/mimocode/instruction/prefer-pagefetch.md" ~/.config/mimocode/instructions/prefer-pagefetch.md
```

#### Per-project

```bash
mkdir -p theproject/.mimocode/instructions

cp tools/mimocode/instruction/prefer-pagefetch.md theproject/.mimocode/instructions/prefer-pagefetch.md
# OR: ln -s "$(pwd)/tools/mimocode/instruction/prefer-pagefetch.md" theproject/.mimocode/instructions/prefer-pagefetch.md
```

## Restart MiMoCode

After installing, restart MiMoCode to load the new tool. You should see `pagefetch` in your available tools.

## Usage

Once installed, ask to fetch a page. If it uses another tool such as the
native webfetch then ask it to use 'pagefetch'.


## Tool Parameters

You can ask to use one of the optional parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `wait` | enum | No | Wait strategy: `load`, `domcontentloaded`, `networkidle` |
| `timeout` | number | No | Timeout in milliseconds (default: 30000) |
| `userAgent` | string | No | Custom user agent string |

## How It Works

**Tool**: Shells out to the `pagefetch` CLI and returns the rendered HTML via stdout. No files are written — MiMoCode captures the output directly.

**Instruction**: Injected into MiMoCode's context at session start. Guides the model to prefer `pagefetch` over `webfetch` and defines the fallback protocol when a fetch fails.
