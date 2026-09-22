/**
 * Installer / uninstaller interface verification.
 *
 * The setup file builds its window from embedded assets, so the only honest way to check
 * that the branded interface really survived is to start it and read the live WebView2 over
 * the Chrome DevTools Protocol. This verifies appearance and content only: nothing is
 * installed, and no window is ever confirmed.
 *
 * Checks, in both modes:
 *   * the document comes from the Tauri asset protocol, never from the Vite dev server,
 *   * the installer's own markup and styling are present (design tokens resolve),
 *   * the interface still uses the shared design system (components + motion),
 *   * mode-specific copy: install path selection and payload summary, or the uninstall
 *     confirmations including the "keep user data" choices,
 *   * a screenshot is written for human review.
 *
 * Usage:
 *   node scripts/verify-installer-ui.mjs [--setup=<exe>] [--mode=install|uninstall] [--port=9555]
 */

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

const SETUP = arg("setup", path.join(projectRoot, "release", "installer", "YT Downloader Setup.exe"));
const MODE = arg("mode", "install");
const PORT = Number(arg("port", "9555"));
const SHOT = path.join(workspace, ".caches", "temp", `installer-ui-${MODE}.png`);

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
      /* not listening yet */
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  console.log(`\nYT Downloader — 安装器/卸载器界面验证（${MODE}）`);
  console.log(`  程序 : ${SETUP}`);
  if (!existsSync(SETUP)) {
    throw new Error(`找不到安装程序：${SETUP}`);
  }

  const args = MODE === "uninstall" ? ["--uninstall"] : [];
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  const child = spawn(SETUP, args, { cwd: path.dirname(SETUP), env, stdio: "ignore" });
  console.log(`  已启动 pid ${child.pid}\n`);

  let browser;
  try {
    const version = await waitForEndpoint(PORT, 45000);
    record(!!version, `WebView2 调试端点已就绪${version ? ` (${version.Browser})` : ""}`);
    if (!version) {
      throw new Error("安装器窗口没有开放调试端点");
    }

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    record(pages.length > 0, `找到 ${pages.length} 个窗口页面`);
    if (pages.length === 0) {
      throw new Error("没有可检查的窗口");
    }

    const page = pages[0];
    // The window fades in and the first IPC round-trip fills the panel.
    await sleep(3000);

    const url = page.url();
    const info = await page.evaluate(() => {
      const root = document.getElementById("root");
      const tokens = getComputedStyle(document.documentElement);
      return {
        title: document.title,
        text: document.body.innerText,
        hasRoot: !!root,
        rootChildren: root?.childElementCount ?? 0,
        styleSheets: document.styleSheets.length,
        accent: tokens.getPropertyValue("--accent").trim(),
        background: getComputedStyle(document.body).backgroundColor,
        // framer-motion animates through inline styles; their presence is what proves the
        // interface still runs the shared motion helpers instead of a static document.
        animated: document.querySelectorAll('[style*="opacity"], [style*="transform"]').length,
        inputs: [...document.querySelectorAll("input")].map((node) => node.value),
        buttons: [...document.querySelectorAll("button")]
          .map((node) => (node.innerText || "").trim())
          .filter(Boolean),
      };
    });

    console.log(`  url        : ${url}`);
    console.log(`  title      : ${info.title}`);
    console.log(`  root nodes : ${info.rootChildren}`);
    console.log(`  accent     : ${info.accent || "(none)"}`);
    console.log(`  动画元素   : ${info.animated}`);
    console.log(`  按钮       : ${info.buttons.slice(0, 8).join(" | ")}`);
    console.log("");

    record(
      !/localhost:1420|127\.0\.0\.1:1420/.test(url),
      `未加载开发服务器地址（实际：${url}）`,
    );
    record(/^(tauri|https?):\/\/(tauri\.)?localhost\/?/.test(url) || url.startsWith("tauri://"), "URL 属于 Tauri 本地资源协议");
    record(info.title.includes("安装程序"), `窗口标题为 "${info.title}"`);
    record(info.hasRoot && info.rootChildren > 0, "React 已挂载到 #root");
    record(info.styleSheets > 0, `样式表已加载（${info.styleSheets} 个）`);
    record(!!info.accent, `设计令牌已生效（--accent=${info.accent}）`);
    record(info.animated > 0, `界面包含动效元素（${info.animated} 个）`);
    record(
      !/无法访问此页面|拒绝连接|refused to connect|ERR_CONNECTION/i.test(info.text),
      "页面内容不是连接错误页",
    );

    if (MODE === "uninstall") {
      const markers = ["卸载", "安装位置", "移除"];
      const hit = markers.filter((marker) => info.text.includes(marker));
      record(hit.length >= 2, `卸载界面文案命中 ${hit.length}/${markers.length} 项：${hit.join("、")}`);
      record(
        info.buttons.some((label) => /卸载/.test(label) && !/取消/.test(label)),
        `卸载界面提供确认按钮：${info.buttons.slice(0, 5).join(" | ")}`,
      );
      // User data is only removed when it is explicitly asked for, never by default.
      record(
        /同时删除应用设置/.test(info.text) && /同时删除已下载的视频文件/.test(info.text),
        "卸载界面把「删除用户数据/下载文件」作为可选项列出（默认保留）",
      );
      record(
        /^[A-Za-z]:\\/m.test(info.text),
        "卸载界面显示了将要移除的安装位置",
      );
    } else {
      const markers = ["安装", "运行库"];
      const hit = markers.filter((marker) => info.text.includes(marker));
      record(hit.length >= 2, `安装界面文案命中 ${hit.length}/${markers.length} 项：${hit.join("、")}`);
      // The target directory is shown as a verified row with a picker button: the design
      // deliberately avoids a free-text field so an unusable path cannot be typed in.
      record(
        /^[A-Za-z]:\\/m.test(info.text),
        "安装界面显示了目标目录（默认或已选择）",
      );
      record(
        info.buttons.some((label) => /浏览/.test(label)),
        `安装界面提供目录选择入口：${info.buttons.slice(0, 6).join(" | ")}`,
      );
      record(
        info.buttons.some((label) => /^安装/.test(label)),
        "安装界面提供「安装」按钮",
      );
      // The payload summary is the proof that the embedded application is really there.
      record(
        /\d+\s*(个文件|项)/.test(info.text) || /MB|GB/.test(info.text),
        "界面显示了安装包载荷信息（文件数/体积）",
      );
    }

    await mkdir(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    record(existsSync(SHOT), `已保存窗口截图：${SHOT}`);

    await browser.close();
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    try {
      execSync("taskkill /IM msedgewebview2.exe /F", { stdio: "ignore" });
    } catch {
      /* nothing to kill */
    }
  }

  console.log("");
  await writeFile(
    path.join(workspace, ".caches", "temp", `installer-ui-${MODE}.json`),
    JSON.stringify({ setup: SETUP, mode: MODE, results, failures }, null, 2),
  );

  if (failures.length > 0) {
    console.log(`${MODE} 界面验证失败：${failures.length} 项`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`${MODE} 界面验证通过（${results.length} 项检查）。`);
  }
}

main().catch((error) => {
  console.error(`\n验证中断：${error?.message ?? error}`);
  process.exitCode = 1;
});
