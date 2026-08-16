import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EDITOR_IFRAME_SELECTOR = "iframe";

function snapshotError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function findEditorIframe(page) {
  const frames = page.locator(EDITOR_IFRAME_SELECTOR);
  const count = await frames.count();
  for (let index = 0; index < count; index += 1) {
    const iframe = frames.nth(index);
    const details = await iframe.evaluate((element) => {
      try {
        const document = element.contentDocument;
        const html = document?.documentElement;
        const body = document?.body;
        return {
          editorCanvas: Boolean(document?.querySelector(".editor-styles-wrapper, .block-editor-writing-flow")),
          scrollWidth: Math.max(html?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
          scrollHeight: Math.max(html?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
        };
      } catch {
        return null;
      }
    });
    if (details?.editorCanvas) return { iframe, index, details };
  }
  throw snapshotError(
    "EDITOR_IFRAME_NOT_FOUND",
    "The Gutenberg editor did not expose an accessible editor iframe; snapshot-editor only supports iframe-based Gutenberg.",
  );
}

async function captureRenderedIframe(page, iframe, outputDir) {
  const dimensions = await iframe.evaluate((element) => {
    const document = element.contentDocument;
    const html = document?.documentElement;
    const body = document?.body;
    const scrolling = document?.scrollingElement;
    const rect = element.getBoundingClientRect();
    if (!document || !html || !scrolling) return null;
    return {
      width: Math.max(html.scrollWidth ?? 0, body?.scrollWidth ?? 0),
      height: Math.max(html.scrollHeight ?? 0, body?.scrollHeight ?? 0),
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      scrollTop: scrolling.scrollTop,
    };
  });
  if (!dimensions?.width || !dimensions?.height || !dimensions.viewportWidth || !dimensions.viewportHeight) {
    throw snapshotError("EDITOR_IFRAME_EMPTY", "The Gutenberg editor iframe has no measurable document content.");
  }

  const screenshotPath = path.join(outputDir, "rendered-iframe.png");
  // Gutenberg keeps the iframe inside a fixed-height, clipped editor shell. A
  // single element screenshot therefore paints only the visible viewport even
  // when the iframe document is much taller; capture viewport tiles instead.
  const tiles = [];
  const capturedOffsets = new Set();
  let totalHeight = dimensions.height;
  const maxTiles = 256;

  const readPosition = () => iframe.evaluate((element) => {
    const document = element.contentDocument;
    const html = document?.documentElement;
    const body = document?.body;
    const scrolling = document?.scrollingElement;
    const rect = element.getBoundingClientRect();
    return {
      width: Math.max(html?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
      height: Math.max(html?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      scrollTop: scrolling?.scrollTop ?? null,
    };
  });

  const scrollTo = async (requestedOffset) => {
    let position = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await iframe.evaluate((element, offset) => {
        const window = element.contentWindow;
        if (!window) throw new Error("The Gutenberg editor iframe window is unavailable.");
        window.scrollTo(0, offset);
      }, requestedOffset);
      await page.waitForTimeout(75);
      position = await readPosition();
      if (position.scrollTop !== null && Math.abs(position.scrollTop - requestedOffset) <= 1) return position;
    }
    throw snapshotError(
      "EDITOR_IFRAME_SCROLL_FAILED",
      `The Gutenberg editor iframe could not reach scroll offset ${Math.round(requestedOffset)}px.`,
    );
  };

  const offsetsFor = (height, viewportHeight) => {
    const bottom = Math.max(0, height - viewportHeight);
    const offsets = [];
    for (let offset = 0; offset < bottom; offset += viewportHeight) {
      offsets.push(Math.round(Math.min(offset, bottom)));
    }
    offsets.push(Math.round(bottom));
    return [...new Set(offsets)];
  };

  try {
    while (true) {
      // Images and block styles can settle as the frame is scrolled, so refresh
      // the offset list whenever the document grows instead of trusting one
      // height measurement for the whole capture.
      const availableOffsets = offsetsFor(totalHeight, dimensions.viewportHeight);
      const nextOffset = availableOffsets.find((offset) => !capturedOffsets.has(offset));
      if (nextOffset === undefined) {
        const latest = await readPosition();
        if (latest.height > totalHeight + 1) {
          totalHeight = latest.height;
          continue;
        }
        break;
      }
      if (tiles.length >= maxTiles) {
        throw snapshotError("EDITOR_IFRAME_TOO_TALL", "The Gutenberg editor iframe is too tall to capture safely.");
      }

      const position = await scrollTo(nextOffset);
      totalHeight = Math.max(totalHeight, position.height);
      const buffer = await iframe.screenshot();
      tiles.push({
        offset: position.scrollTop,
        data: `data:image/png;base64,${buffer.toString("base64")}`,
      });
      capturedOffsets.add(nextOffset);
    }
  } finally {
    await iframe.evaluate((element, style) => {
      const scrolling = element.contentDocument?.scrollingElement;
      if (scrolling) scrolling.scrollTop = style;
    }, dimensions.scrollTop);
  }

  const imageData = await page.evaluate(async ({ inputTiles, height, viewportHeight }) => {
    const images = await Promise.all(inputTiles.map(({ data }) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The captured Gutenberg iframe tile could not be decoded."));
      image.src = data;
    })));
    const scale = images[0].naturalHeight / viewportHeight;
    const canvas = document.createElement("canvas");
    canvas.width = images[0].naturalWidth;
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not create a canvas for the Gutenberg iframe snapshot.");
    inputTiles.forEach(({ offset }, index) => {
      context.drawImage(images[index], 0, Math.round(offset * scale));
    });
    const result = canvas.toDataURL("image/png");
    if (!result.startsWith("data:image/png;base64,")) {
      throw new Error("The browser could not encode the Gutenberg iframe snapshot.");
    }
    return result.slice("data:image/png;base64,".length);
  }, { inputTiles: tiles, height: totalHeight, viewportHeight: dimensions.viewportHeight });
  await fs.writeFile(screenshotPath, Buffer.from(imageData, "base64"));

  return {
    path: screenshotPath,
    width: dimensions.width,
    height: totalHeight,
    viewportWidth: dimensions.viewportWidth,
    viewportHeight: dimensions.viewportHeight,
    captureMode: "scroll-stitch",
    tileCount: tiles.length,
    iframeIndex: null,
  };
}

async function readEditorState(page) {
  const state = await page.evaluate(() => {
    const select = window.wp?.data?.select;
    const blockEditor = select?.("core/block-editor");
    const editor = select?.("core/editor");
    if (!blockEditor || typeof blockEditor.getBlocks !== "function") {
      return { ok: false, code: "EDITOR_DATA_UNAVAILABLE", message: "Gutenberg core/block-editor data store is unavailable." };
    }
    if (!editor || typeof editor.getEditedPostContent !== "function") {
      return { ok: false, code: "EDITOR_SOURCE_UNAVAILABLE", message: "Gutenberg core/editor.getEditedPostContent() is unavailable." };
    }

    const seen = new Set();
    const cloneAttributes = (attributes) => {
      try {
        return JSON.parse(JSON.stringify(attributes ?? {}));
      } catch {
        return {};
      }
    };
    const readBlocks = (rootClientId) => {
      const blocks = rootClientId ? blockEditor.getBlocks(rootClientId) : blockEditor.getBlocks();
      if (!Array.isArray(blocks)) return [];
      return blocks.map((block) => {
        const repeated = seen.has(block.clientId);
        if (!repeated) seen.add(block.clientId);
        const innerBlocks = repeated ? [] : readBlocks(block.clientId);
        const blockType = window.wp?.blocks?.getBlockType?.(block.name);
        const controlled = typeof blockEditor.areInnerBlocksControlled === "function"
          ? Boolean(blockEditor.areInnerBlocksControlled(block.clientId))
          : null;
        return {
          clientId: block.clientId,
          name: block.name,
          label: typeof blockType?.title === "string" ? blockType.title : null,
          attributes: cloneAttributes(block.attributes),
          valid: typeof blockEditor.isBlockValid === "function"
            ? Boolean(blockEditor.isBlockValid(block.clientId))
            : null,
          innerBlocksControlled: controlled,
          innerBlocks,
        };
      });
    };

    const source = editor.getEditedPostContent();
    if (typeof source !== "string") {
      return { ok: false, code: "EDITOR_SOURCE_INVALID", message: "Gutenberg returned a non-string edited post source." };
    }
    const blocks = readBlocks(null);
    return {
      ok: true,
      source,
      blocks,
      postType: typeof editor.getCurrentPostType === "function" ? editor.getCurrentPostType() : null,
      postId: typeof editor.getCurrentPostId === "function" ? editor.getCurrentPostId() : null,
    };
  });

  if (!state.ok) throw snapshotError(state.code, state.message);
  return state;
}

function countBlocks(blocks) {
  return blocks.reduce((count, block) => count + 1 + countBlocks(block.innerBlocks ?? []), 0);
}

export async function collect({ page, outputDir }) {
  const { iframe, index, details } = await findEditorIframe(page);
  const renderedIframe = await captureRenderedIframe(page, iframe, outputDir);
  renderedIframe.iframeIndex = index;
  const state = await readEditorState(page);
  const blocksPath = path.join(outputDir, "blocks.json");
  const sourcePath = path.join(outputDir, "source.html");
  await fs.writeFile(blocksPath, `${JSON.stringify({
    version: 1,
    postType: state.postType,
    postId: state.postId,
    blocks: state.blocks,
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(sourcePath, state.source, "utf8");

  return {
    version: 1,
    renderedIframe: {
      ...renderedIframe,
      measuredScrollWidth: details.scrollWidth,
      measuredScrollHeight: details.scrollHeight,
    },
    blocks: {
      path: blocksPath,
      rootCount: state.blocks.length,
      totalCount: countBlocks(state.blocks),
    },
    source: {
      path: sourcePath,
      bytes: Buffer.byteLength(state.source, "utf8"),
      sha256: createHash("sha256").update(state.source, "utf8").digest("hex"),
      method: "wp.data.select('core/editor').getEditedPostContent",
    },
  };
}
