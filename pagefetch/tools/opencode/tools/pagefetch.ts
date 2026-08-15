import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Fetch a webpage using a headless browser (Playwright + Chromium) and return the rendered HTML. Handles JavaScript-rendered content and includes stealth mode to bypass bot detection. Use this over webfetch when the page is JS-rendered, behind bot protection, or when you need the fully rendered DOM.",
  args: {
    url: tool.schema.string().describe("URL to fetch"),
    wait: tool.schema
      .enum(["load", "domcontentloaded", "networkidle"])
      .optional()
      .describe("Wait strategy for page rendering (default: load)"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 30000)"),
    userAgent: tool.schema
      .string()
      .optional()
      .describe("Custom user agent string"),
  },
  async execute(args) {
    const cmd = ["pagefetch", args.url]
    if (args.wait) cmd.push("-w", args.wait)
    if (args.timeout) cmd.push("-t", String(args.timeout))
    if (args.userAgent) cmd.push("-u", args.userAgent)
    const proc = Bun.spawn(cmd, { stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return [stdout, stderr].filter(Boolean).join("\n")
  },
})
