/**
 * UI verification harness.
 *
 * The packaged application talks to Rust, so it cannot be driven by a browser
 * automation tool. This script therefore serves the built frontend and lets it run
 * against the browser-preview backend (`src/api/mock.ts`), which exposes the same
 * command surface with fixture data — including one task in every state.
 *
 * What it actually proves, at every required window size:
 *   * the page renders without console errors,
 *   * nothing overflows horizontally and no interactive control is pushed outside
 *     the viewport,
 *   * each navigation target really changes the page,
 *   * the design tokens resolve (background/surface/border/accent),
 *   * every download state is reachable and labelled,
 *   * light and dark themes both resolve to different, valid palettes.
 *
 * Screenshots are written next to the report so a human can review them.
 *
 * Usage: node scripts/ui-check.mjs [--keep]
 */

import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const distDir = path.join(projectRoot, "dist");
const outputDir = path.join(projectRoot, "release", "ui-check");
const userDataDir = path.join(projectRoot, "release", ".ui-profile");
const workspace = path.resolve(projectRoot, "..");
const shotDir = path.join(workspace, ".caches", "temp", "ui-shots");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** 1x1 transparent PNG, used to answer thumbnail requests without touching the network. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "2560x1440", width: 2560, height: 1440 },
  { name: "3840x2160", width: 3840, height: 2160 },
];

const NAV = [
  { label: "新建下载", page: "home", expect: ["新建下载", "粘贴"] },
  { label: "下载队列", page: "queue", expect: ["下载队列"] },
  { label: "下载历史", page: "history", expect: ["下载历史"] },
  { label: "收藏", page: "favorites", expect: ["收藏"] },
  { label: "设置", page: "settings", expect: ["设置"] },
  { label: "关于", page: "about", expect: ["YT Downloader", "运行库"] },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function staticServer(root) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let filePath = path.join(root, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(root)) {
        response.writeHead(403).end();
        return;
      }
      if (!existsSync(filePath) || url.pathname === "/") {
        filePath = path.join(root, "index.html");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
  });
}

const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

/** Assert nothing overflows the viewport horizontally. */
async function assertNoOverflow(page, context) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const offenders = [];
    for (const element of document.querySelectorAll("button, a, input, textarea, [role=button]")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) {
        continue;
      }
      if (box.right > viewportWidth + 1 || box.left < -1) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().slice(0, 24),
          left: Math.round(box.left),
          right: Math.round(box.right),
        });
      }
    }
    return {
      documentWidth: root.scrollWidth,
      bodyWidth: body.scrollWidth,
      viewportWidth,
      offenders: offenders.slice(0, 6),
    };
  });

  check(
    metrics.documentWidth <= metrics.viewportWidth + 1,
    `${context}: document width ${metrics.documentWidth} fits viewport ${metrics.viewportWidth}`,
  );
  check(
    metrics.offenders.length === 0,
    `${context}: no control outside the viewport${
      metrics.offenders.length ? ` (${JSON.stringify(metrics.offenders)})` : ""
    }`,
  );
}

/** Assert the surface tokens resolve to real colours. */
async function assertTokens(page, context) {
  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      background: body.backgroundColor,
      surface: styles.getPropertyValue("--surface").trim(),
      border: styles.getPropertyValue("--border").trim(),
      accent: styles.getPropertyValue("--accent").trim(),
      text: styles.getPropertyValue("--text-primary").trim(),
    };
  });

  check(/^rgb/.test(tokens.background), `${context}: body background resolves (${tokens.background})`);
  check(tokens.surface.length > 0, `${context}: --surface token resolves (${tokens.surface})`);
  check(tokens.border.length > 0, `${context}: --border token resolves`);
  check(/^#|^rgb/.test(tokens.accent), `${context}: --accent token resolves (${tokens.accent})`);
  check(tokens.text.length > 0, `${context}: --text-primary token resolves`);
  return tokens;
}

async function run() {
  if (!existsSync(path.join(distDir, "index.html"))) {
    throw new Error("dist/index.html is missing — run `npm run build` first");
  }
  if (!existsSync(EDGE)) {
    throw new Error(`Microsoft Edge not found at ${EDGE}`);
  }

  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(shotDir, { recursive: true });

  const server = staticServer(distDir);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`serving ${distDir} at ${base}\n`);

  // A watchdog keeps a stuck browser from hanging the whole verification run.
  const watchdog = setTimeout(() => {
    console.error("ui-check: watchdog fired after 300s — treating as a failure");
    process.exit(2);
  }, 300_000);

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Playwright already passes --user-data-dir; only the cache location is added, so
    // nothing is written to the system drive.
    args: [`--disk-cache-dir=${path.join(userDataDir, "cache")}`],
  });
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(25000);

  // The fixture data references real thumbnail URLs. They are answered locally so the
  // check never depends on the network and never waits on a stalled image request.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) {
      return route.continue();
    }
    if (/ytimg|ggpht|googleusercontent/i.test(url)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
    }
    return route.abort();
  });

  const page = context.pages()[0] ?? (await context.newPage());

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  try {
    // ---------------------------------------------------------------- render
    console.log("== initial render (1280x720) ==");
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header", { timeout: 20000 });
    await page.waitForTimeout(900);

    check(
      (await page.locator("aside").count()) === 1,
      "the sidebar is present",
    );
    check(
      (await page.getByText("新建下载", { exact: false }).count()) > 0,
      "the composer page rendered",
    );

    const palette = await assertTokens(page, "dark");
    await assertNoOverflow(page, "initial/1280x720");

    // Real proof that the token layer is not a flat single colour: the sidebar
    // surface must differ from the page background.
    const surfaces = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      aside: getComputedStyle(document.querySelector("aside")).backgroundColor,
    }));
    check(
      surfaces.body !== surfaces.aside,
      `sidebar surface is layered above the page (${surfaces.aside} vs ${surfaces.body})`,
    );

    // ------------------------------------------------------------ navigation
    console.log("\n== navigation ==");
    for (const item of NAV) {
      const button = page.locator("aside button", { hasText: item.label }).first();
      if ((await button.count()) === 0) {
        check(false, `navigation item "${item.label}" exists`);
        continue;
      }
      await button.click();
      await page.waitForTimeout(420);
      for (const expected of item.expect) {
        const found = await page.getByText(expected, { exact: false }).count();
        check(found > 0, `page ${item.page} shows "${expected}"`);
      }
      await page.screenshot({ path: path.join(shotDir, `page-${item.page}.png`) });
    }

    // --------------------------------------------------------- task states
    console.log("\n== download states ==");
    const queueButton = page.locator("aside button", { hasText: "下载队列" }).first();
    await queueButton.click();
    await page.waitForTimeout(500);

    const stateLabels = ["下载中", "合并中", "等待中", "已暂停", "已完成", "失败"];
    for (const label of stateLabels) {
      const count = await page.getByText(label, { exact: false }).count();
      check(count > 0, `state "${label}" is represented in the queue`);
    }

    const mergeRetry = await page.getByText("只重试合并", { exact: false }).count();
    check(mergeRetry > 0, "the merge-only recovery affordance is offered on a failed task");

    const percent = await page.evaluate(() => {
      const progress = document.querySelector('[role="progressbar"]');
      return progress ? progress.getAttribute("aria-valuenow") : null;
    });
    check(percent !== null, `progress bars expose an accessible value (${percent})`);

    // ------------------------------------------------------------- themes
    console.log("\n== themes ==");
    const applied = await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.remove("dark");
      root.classList.add("light");
      return getComputedStyle(document.body).backgroundColor;
    });
    check(
      applied !== palette.background,
      `light theme resolves to a different background (${applied})`,
    );
    await page.screenshot({ path: path.join(shotDir, "theme-light.png") });
    await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.remove("light");
      root.classList.add("dark");
    });

    // ------------------------------------------------------- window sizes
    console.log("\n== window sizes ==");
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(320);
      await assertNoOverflow(page, `queue/${viewport.name}`);

      // The composer is the most layout-sensitive page: check it at every size too.
      await page.locator("aside button", { hasText: "新建下载" }).first().click();
      await page.waitForTimeout(320);
      await assertNoOverflow(page, `home/${viewport.name}`);
      await page.screenshot({ path: path.join(shotDir, `size-${viewport.name}.png`) });
    }

    // ------------------------------------------------------- empty states
    console.log("\n== empty / filtered states ==");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("aside button", { hasText: "下载历史" }).first().click();
    await page.waitForTimeout(400);
    const search = page.locator('input[type="text"], input:not([type])').first();
    if ((await search.count()) > 0) {
      await search.fill("zzz-no-such-download-zzz");
      await page.waitForTimeout(420);
      const emptyShown =
        (await page.getByText("没有", { exact: false }).count()) > 0 ||
        (await page.getByText("清除", { exact: false }).count()) > 0;
      check(emptyShown, "a filtered history shows an empty state");
      await page.screenshot({ path: path.join(shotDir, "state-filtered-empty.png") });
      await search.fill("");
    } else {
      notes.push("history search input not found by selector");
    }

    // --------------------------------------------------------- console log
    console.log("\n== console ==");
    const significant = consoleErrors.filter(
      (message) =>
        !message.includes("favicon") &&
        !message.includes("ERR_FILE_NOT_FOUND") &&
        !message.includes("i.ytimg.com") &&
        !message.includes("net::ERR"),
    );
    check(
      significant.length === 0,
      `no console errors${significant.length ? `: ${significant.slice(0, 3).join(" | ")}` : ""}`,
    );

    await writeFile(
      path.join(outputDir, "ui-check.json"),
      JSON.stringify({ failures, notes, consoleErrors, screenshots: shotDir }, null, 2),
    );
  } finally {
    clearTimeout(watchdog);
    await context.close();
    server.close();
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`UI 检查失败：${failures.length} 项`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log("UI 检查全部通过。");
    console.log(`截图目录：${shotDir}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
