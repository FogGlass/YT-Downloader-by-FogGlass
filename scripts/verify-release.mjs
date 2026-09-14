/**
 * Release verification.
 *
 * Launches the packaged executable and inspects the *live* WebView2 that it creates,
 * over the Chrome DevTools Protocol. This answers the questions a release folder must
 * answer for itself:
 *
 *   * what URL did the window actually load (embedded assets or the dev server)?
 *   * does the loaded document contain the application's real interface?
 *   * is the bundled runtime detected from beside the executable?
 *   * is anything still talking to the Vite dev server port?
 *
 * Usage: node scripts/verify-release.mjs [path-to-exe]
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

const exePath =
  process.argv[2] ?? path.join(projectRoot, "release", "YT Downloader", "YTDownloader.exe");
const releaseDir = path.dirname(exePath);
const logFile = path.join(releaseDir, "data", "logs", "yt-downloader.log");
const shotPath = path.join(workspace, ".caches", "temp", "release-window.png");

const CDP_PORT = 9333;
const results = [];
const failures = [];

function record(ok, message) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${message}`);
  if (ok) {
    results.push(message);
  } else {
    failures.push(message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  console.log(`verifying: ${exePath}\n`);
  if (!existsSync(exePath)) {
    throw new Error(`找不到可执行文件：${exePath}`);
  }

  // The WebView2 host exposes a CDP endpoint when asked; this lets the verification
  // read the window's real document instead of trusting the build configuration.
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };

  const child = spawn(exePath, [], {
    cwd: releaseDir,
    env,
    detached: false,
    stdio: "ignore",
  });
  console.log(`launched pid ${child.pid}\n`);

  try {
    const version = await waitForEndpoint(CDP_PORT, 45000);
    record(!!version, `WebView2 调试端点已就绪${version ? ` (${version.Browser})` : ""}`);
    if (!version) {
      throw new Error("WebView2 未开放调试端点，无法读取窗口内容");
    }

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    record(pages.length > 0, `找到 ${pages.length} 个 WebView 页面`);
    if (pages.length === 0) {
      throw new Error("没有可检查的页面");
    }

    const page = pages[0];
    // Give the shell a moment to mount and the runtime probe to finish.
    await sleep(3500);

    const url = page.url();
    const info = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 4000),
      hasRoot: !!document.getElementById("root"),
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      scriptCount: document.querySelectorAll("script").length,
      styleSheets: document.styleSheets.length,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    }));

    console.log(`\n  url        : ${url}`);
    console.log(`  title      : ${info.title}`);
    console.log(`  root nodes : ${info.rootChildren}`);
    console.log(`  stylesheets: ${info.styleSheets}`);
    console.log(`  accent     : ${info.accent || "(none)"}`);
    console.log(`  background : ${info.bodyBackground}`);
    console.log("");

    // 1. The interface must come from the embedded frontend, not the dev server.
    const isDevServer = /localhost:1420|127\.0\.0\.1:1420/.test(url);
    record(!isDevServer, `未加载开发服务器地址（实际：${url}）`);
    record(
      /^(tauri|https?):\/\/(tauri\.)?localhost\/?/.test(url) || url.startsWith("tauri://"),
      `URL 属于 Tauri 本地资源协议`,
    );

    // 2. The document must be the real application, not a browser error page.
    record(info.title.includes("YT Downloader"), `文档标题为 "${info.title}"`);
    record(info.hasRoot && info.rootChildren > 0, "React 已挂载到 #root");
    record(info.styleSheets > 0, `样式表已加载（${info.styleSheets} 个）`);
    record(!!info.accent, `设计令牌已生效（--accent=${info.accent}）`);

    const markers = ["新建下载", "运行库", "粘贴", "还没有下载"];
    const found = markers.filter((marker) => info.text.includes(marker));
    record(
      found.length >= 2,
      `界面文案命中 ${found.length}/${markers.length} 项：${found.join("、") || "无"}`,
    );
    record(
      !/无法访问此页面|拒绝连接|refused to connect|ERR_CONNECTION/i.test(info.text),
      "页面内容不是连接错误页",
    );

    // 3. The runtime must be the bundled one, resolved from beside the executable.
    const log = existsSync(logFile) ? await readFile(logFile, "utf8") : "";
    const boot = log.split(/\r?\n/).filter(Boolean).slice(-8);
    console.log(`\n  启动日志：`);
    for (const line of boot) {
      console.log(`    ${line}`);
    }
    console.log("");

    record(
      /frontend source:\s*embedded assets/.test(log),
      "日志确认前端来源为内嵌资源（embedded assets）",
    );
    record(
      /frontend source:\s*dev server/.test(log) === false,
      "日志中没有出现 dev server 字样",
    );
    record(/source=bundled/.test(log), "运行库来源为随包内置（source=bundled）");
    record(
      log.includes(path.join(releaseDir, "runtime")),
      "运行库路径位于 release 目录内",
    );

    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath });
    record(existsSync(shotPath), `已保存窗口截图：${shotPath}`);

    await browser.close();
  } finally {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    // WebView2 children outlive the parent kill.
    for (const name of ["msedgewebview2"]) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`taskkill /IM ${name}.exe /F`, { stdio: "ignore" });
      } catch {
        // Nothing to kill.
      }
    }
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`Release 验证失败：${failures.length} 项`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    await writeFile(
      path.join(workspace, ".caches", "temp", "release-verify.json"),
      JSON.stringify({ exePath, results, failures }, null, 2),
    );
    process.exitCode = 1;
  } else {
    console.log(`Release 验证通过（${results.length} 项检查）。`);
    await writeFile(
      path.join(workspace, ".caches", "temp", "release-verify.json"),
      JSON.stringify({ exePath, results, failures }, null, 2),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
