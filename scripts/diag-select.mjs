/**
 * Diagnostic: dump the format rows the real application offers and the exact
 * `enqueue_downloads` payload its interface sends.
 *
 * This exists to answer one question with evidence instead of inference: which
 * format row produced the `--format 18` download command. It is a temporary
 * instrument, not part of the verification suite.
 *
 * Usage: node scripts/diag-select.mjs [--url=...] [--exe=...]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const workspace = path.resolve(projectRoot, "..");

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const URL_TO_TEST = arg("url", "https://youtu.be/gQRnAoAdwfA?si=KlXwOVJuISl9C0Bl");
const EXE = arg("exe", path.join(projectRoot, "release", "YT Downloader", "YTDownloader.exe"));
const DOWNLOAD_DIR = arg("dir", "E:\\下载");
const CDP_PORT = 9455;
const APP_DIR = path.dirname(EXE);
const LOG_FILE = path.join(APP_DIR, "data", "logs", "yt-downloader.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return true;
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  const settingsFile = path.join(APP_DIR, "data", "config", "settings.json");
  await mkdir(path.dirname(settingsFile), { recursive: true });
  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(await readFile(settingsFile, "utf8"));
    } catch {
      settings = {};
    }
  }
  settings.downloads = { ...(settings.downloads ?? {}), outputDir: DOWNLOAD_DIR };
  settings.cookies = { mode: "browser", browser: "edge", profile: "", file: "" };
  settings.general = { ...(settings.general ?? {}), notifyOnComplete: false };
  settings.advanced = { ...(settings.advanced ?? {}), logLevel: "debug", keepRawOutput: true };
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");

  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` };
  const child = spawn(EXE, [], { cwd: APP_DIR, env, stdio: "ignore" });
  console.log(`已启动 pid ${child.pid}`);

  let browser;
  try {
    if (!(await waitForEndpoint(CDP_PORT, 45000))) {
      throw new Error("WebView2 未开放调试端点");
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const page = browser.contexts().flatMap((ctx) => ctx.pages())[0];
    page.setDefaultTimeout(30000);
    await sleep(2500);
    console.log(`页面：${page.url()}`);

    // Record every IPC call so the payload under test is observable, not guessed.
    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      window.__DIAG__ = { desktop: Boolean(internals), calls: [] };
      if (!internals || internals.__patched) {
        return;
      }
      const original = internals.invoke;
      internals.invoke = (cmd, args, options) => {
        window.__DIAG__.calls.push({ cmd, args });
        return original(cmd, args, options);
      };
      internals.__patched = true;
    });
    const desktop = await page.evaluate(() => window.__DIAG__.desktop);
    console.log(`__TAURI_INTERNALS__ 可见：${desktop}`);

    await page.getByLabel("视频链接").fill(URL_TO_TEST);
    await page.getByRole("button", { name: /^解析/ }).first().click();

    const parsedSignal = page.locator('[role="radiogroup"] [role="radio"]').first();
    const errorSignal = page.getByText("无法解析视频", { exact: true }).first();
    const outcome = await Promise.race([
      parsedSignal.waitFor({ state: "visible", timeout: 120000 }).then(() => "parsed").catch(() => null),
      errorSignal.waitFor({ state: "visible", timeout: 120000 }).then(() => "error").catch(() => null),
    ]);
    console.log(`解析结果：${outcome ?? "超时"}`);

    if (outcome === "error") {
      const retry = page.getByRole("button", { name: "不使用 Cookie 重试" });
      if ((await retry.count()) > 0) {
        await retry.first().click();
        await parsedSignal.waitFor({ state: "visible", timeout: 120000 });
        console.log("已使用「不使用 Cookie 重试」重新解析");
      }
    }

    // Dump every row the interface actually offers.
    const rows = await page.locator('[role="radio"]').evaluateAll((nodes) =>
      nodes.map((node, index) => ({
        index,
        text: (node.innerText || "").replace(/\s+/g, " ").slice(0, 90),
        checked: node.getAttribute("aria-checked"),
        html: node.outerHTML.slice(0, 160),
      })),
    );
    console.log(`\n=== 界面提供的格式行（${rows.length}）===`);
    for (const row of rows) {
      console.log(`${String(row.index).padStart(2)} [${row.checked}] ${row.text}`);
    }
    if (rows[0]) {
      console.log(`\n首行 HTML：${rows[0].html}\n`);

    }

    // What does the probe command itself report?
    const probeCall = await page.evaluate(() =>
      window.__DIAG__.calls.filter((call) => /probe|parse/i.test(call.cmd)).map((call) => call.cmd),
    );
    console.log(`探针相关命令：${JSON.stringify(probeCall)}`);

    const target = rows.find((row) => /360p/.test(row.text));
    if (!target) {
      console.log("没有找到 360p 行");
    } else {
      console.log(`点击第 ${target.index} 行：${target.text}`);
      await page.locator('[role="radio"]').nth(target.index).click();
    }

    const start = page.getByRole("button", { name: /^开始下载/ }).first();
    await start.waitFor({ state: "visible" });
    const deadline = Date.now() + 30000;
    while ((await start.isDisabled()) && Date.now() < deadline) {
      await sleep(400);
    }
    await start.click();
    console.log("已点击开始下载");
    await sleep(1500);

    const enqueued = await page.evaluate(() =>
      window.__DIAG__.calls
        .filter((call) => /enqueue|download/i.test(call.cmd))
        .map((call) => ({ cmd: call.cmd, args: call.args })),
    );
    console.log(`\n=== enqueue 调用 ===\n${JSON.stringify(enqueued, null, 2).slice(0, 3000)}`);

    await sleep(20000);
    const log = existsSync(LOG_FILE) ? await readFile(LOG_FILE, "utf8") : "";
    const lines = log
      .split(/\r?\n/)
      .filter((line) => /--format|Requested format|failed:|probe complete/.test(line));
    console.log(`\n=== 应用日志（与格式相关）===`);
    for (const line of lines.slice(-8)) {
      console.log(line.slice(0, 400));
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    child.kill();
    await sleep(1200);
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

main().catch((error) => {
  console.error(`诊断失败：${error.message}`);
  process.exitCode = 1;
});
