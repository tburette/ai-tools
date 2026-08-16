const LOGIN_PATH = "/wp-login.php";

export function isEditorCommand(command) {
  return command === "check-editor" || command === "snapshot-editor";
}

export const SELECTORS = {
  loginForm: "#loginform",
  loginUser: "#user_login",
  adminShell: ":is(#wpcontent, #wpbody, #wpadminbar)",
  editorShell: ":is(#editor, .edit-post-visual-editor, .edit-site-visual-editor)",
  // WordPress 7 renders post-editor content in an iframe. Older Gutenberg
  // versions expose the writing flow directly, so keep those fallbacks.
  editorCanvas: ":is(.edit-post-visual-editor iframe, .edit-site-visual-editor iframe, .editor-styles-wrapper, .block-editor-writing-flow, .edit-site-visual-editor__editor-canvas)",
  onboardingClose: ":is(.edit-post-welcome-guide .components-modal__header button, .edit-post-welcome-guide [aria-label='Close'], .edit-post-welcome-guide [aria-label='Fermer'], .edit-site-welcome-guide .components-modal__header button, .edit-site-welcome-guide [aria-label='Close'], .edit-site-welcome-guide [aria-label='Fermer'], .block-editor-welcome-guide .components-modal__header button, .block-editor-welcome-guide [aria-label='Close'], .block-editor-welcome-guide [aria-label='Fermer'])",
  // These are structural error indicators, not block-content parsers: a
  // visible match makes the corresponding editor-health assertion fail.
  invalidBlockWarning: ".block-editor-warning",
  recoveryPrompt: ".block-editor-block-recovery, .block-editor-block-recovery__dialog",
  missingBlock: ".wp-block-missing",
  fatalEditor: ".editor-error, .block-editor-error-boundary",
};

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "") || "/";
}

export function normalizeBaseUrl(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim()) throw new Error("--base-url is required");
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`Invalid WordPress base URL: ${rawValue}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("WordPress base URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("WordPress base URL must not contain credentials");
  if (parsed.search || parsed.hash) throw new Error("WordPress base URL must not contain a query or fragment");
  parsed.pathname = stripTrailingSlashes(parsed.pathname);
  return parsed.toString().replace(/\/$/, "");
}

export function buildBaseUrl(baseUrl, relativePath) {
  const base = new URL(`${stripTrailingSlashes(baseUrl)}/`);
  const path = String(relativePath).replace(/^\/+/, "");
  return new URL(path, base).toString();
}

export function normalizeEditorUrl(baseUrl, rawValue) {
  // Only allow known Gutenberg editor routes. The adapter is read-only, so a
  // same-origin URL alone is not sufficient protection against mutation routes.
  if (typeof rawValue !== "string" || !rawValue.trim()) throw new Error("--editor-url is required for an editor command");
  let editorUrl;
  try {
    editorUrl = new URL(rawValue, `${baseUrl}/`);
  } catch {
    throw new Error(`Invalid editor URL: ${rawValue}`);
  }
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(editorUrl.protocol) || editorUrl.origin !== base.origin) {
    throw new Error("--editor-url must use the same origin as --base-url");
  }
  if (editorUrl.username || editorUrl.password) throw new Error("--editor-url must not contain credentials");
  const basePath = base.pathname.replace(/\/+$/, "");
  const postEditorPath = `${basePath}/wp-admin/post.php` || "/wp-admin/post.php";
  const siteEditorPath = `${basePath}/wp-admin/site-editor.php` || "/wp-admin/site-editor.php";
  const actionValues = editorUrl.searchParams.getAll("action");
  const postValues = editorUrl.searchParams.getAll("post");
  const isPostEditor = editorUrl.pathname === postEditorPath
    && actionValues.length === 1
    && actionValues[0] === "edit"
    && postValues.length === 1
    && /^\d+$/.test(postValues[0])
    && Number(postValues[0]) > 0;
  const isSiteEditor = editorUrl.pathname === siteEditorPath && !editorUrl.searchParams.has("action");
  if (!isPostEditor && !isSiteEditor) {
    throw new Error("--editor-url must target a supported read-only Gutenberg editor route (post.php?action=edit or site-editor.php)");
  }
  return editorUrl.toString();
}

export function isLoginUrl(rawValue) {
  try {
    const parsed = new URL(rawValue);
    return parsed.pathname === LOGIN_PATH || parsed.pathname.endsWith(LOGIN_PATH) || parsed.searchParams.get("reauth") === "1";
  } catch {
    return false;
  }
}

function reportItems(report) {
  return Array.isArray(report?.viewports) ? report.viewports : [];
}

export function actionFailed(report, index) {
  return reportItems(report).some((item) => item.actionResults?.[index]?.error);
}

export function technicalIssues(report) {
  // Action assertion failures are expected product signals (for example, an
  // invalid-block warning), not browser diagnostics. Only retain actual page,
  // console, navigation, request, or response failures here.
  const issues = [];
  for (const item of reportItems(report)) {
    if (item.navigationError) issues.push("navigation");
    if (item.pageErrors?.some((error) => !/^action \d+:/i.test(String(error)))) issues.push("page-error");
    if (item.console?.some(({ type }) => type === "error")) issues.push("console-error");
    if (item.failedRequests?.length) issues.push("request-failure");
    if (item.failedResponses?.length) issues.push("response-error");
  }
  return [...new Set(issues)];
}

export function finalUrl(report) {
  return reportItems(report)[0]?.finalUrl ?? null;
}

export function screenshots(report) {
  return reportItems(report).map((item) => item.screenshot).filter(Boolean);
}

export function collectorArtifacts(report) {
  return reportItems(report)[0]?.collector ?? null;
}

export function collectorError(report) {
  return reportItems(report).find((item) => item.collectorError)?.collectorError ?? null;
}

export function authRequired(report, authActionIndexes = []) {
  if (isLoginUrl(finalUrl(report))) return true;
  if (authActionIndexes.some((index) => actionFailed(report, index))) return true;
  return false;
}

export function createSummary({ command, baseUrl, editorUrl = null, profile, classification, reportPath, report, checks, warnings = [], limitations = [], artifacts = null }) {
  // Keep the public artifact small and safe: paths to reports/screenshots are
  // useful for follow-up inspection, while cookies and browser storage stay
  // inside the persistent profile and are never serialized here. Snapshot
  // artifacts are referenced by path rather than copied into this summary.
  const targetType = isEditorCommand(command)
    ? "gutenberg-editor"
    : command === "check-admin"
      ? "wp-admin"
      : "authentication";
  return {
    version: 1,
    command,
    targetType,
    baseUrl,
    editorUrl,
    profile,
    classification,
    checks,
    finalUrl: finalUrl(report),
    genericReport: reportPath,
    screenshots: screenshots(report),
    warnings,
    limitations,
    ...(artifacts ? { artifacts } : {}),
  };
}
