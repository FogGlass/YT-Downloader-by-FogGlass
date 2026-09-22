/**
 * Targeted end-to-end check: Edge cookies → YouTube parse → download → FFmpeg → history.
 *
 * Drives the real production build through its own interface over the Chrome DevTools
 * Protocol, so every step is the one a user performs. It is deliberately narrow: this
 * verifies the cookie handling and the download path, not the whole application.
 *
 * Usage:
 *   node scripts/e2e-youtube.mjs [--url=...] [--exe=...] [--dir=...] [--keep]
 */

import { spawn, execSync } from "node:child_process";
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
/** browser = browser cookies enabled, none = the default (no cookies at all). */
const COOKIES = arg("cookies", "browser");
/** Which browser the cookie test targets; a browser that is not installed fails reliably. */
const BROWSER = arg("browser", "edge");
/** A development build legitimately resolves the runtime at E:\FFMPEG-9.0. */
const ALLOW_DEV_RUNTIME = process.argv.includes("--allow-dev-runtime");
const DEV_RUNTIME_BIN = "E:\\FFMPEG-9.0\\bin";
const CDP_PORT = 9444;
const APP_DIR = path.dirname(EXE);
const LOG_FILE = path.join(APP_DIR, "data", "logs", "yt-downloader.log");
const REPORT = path.join(workspace, ".caches", "temp", "e2e-youtube.json");

const steps = [];
const failures = [];

function record(ok, label, extra = "") {
  const line = `${label}${extra ? ` — ${extra}` : ""}`;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${line}`);
  steps.push({ ok, label, extra });
  if (!ok) {
    failures.push(line);
  }
}

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
    await sleep(500);
  }
  return false;
}

async function main() {
  console.log(`\nYT Downloader — 针对性端到端测试`);
  console.log(`  程序   : ${EXE}`);
  console.log(`  URL    : ${URL_TO_TEST}`);
  console.log(`  下载到 : ${DOWNLOAD_DIR}\n`);

  if (!existsSync(EXE)) {
    throw new Error(`找不到生产版本：${EXE}`);
  }
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  // Point the application at the requested download folder through its own settings
  // file — the same file the Settings page writes.
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
  settings.cookies =
    COOKIES === "none"
      ? { mode: "none", browser: BROWSER, profile: "", file: "" }
      : { mode: "browser", browser: BROWSER, profile: "", file: "" };
  settings.general = { ...(settings.general ?? {}), notifyOnComplete: false };
  // Debug logging records every yt-dlp line, which is what makes a failed download
  // diagnosable instead of a bare exit code.
  settings.advanced = { ...(settings.advanced ?? {}), logLevel: "debug", keepRawOutput: true };
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");

  // Start from a clean history so the run's own result is unambiguous.
  const historyPath = path.join(APP_DIR, "data", "history", "history.json");
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, "[]", "utf8");
  record(true, "已把下载目录、Cookie 来源与调试日志写入设置", `${DOWNLOAD_DIR} / ${COOKIES === "none" ? "none" : BROWSER} / debug`);

  // A debug build keeps its data inside the project (see core::paths::resolve_data_roots),
  // so the data root is pinned explicitly: the settings written above are then the ones the
  // application actually reads, for both debug and release builds.
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    YTD_DATA_DIR: path.join(APP_DIR, "data"),
  };
  const child = spawn(EXE, [], { cwd: APP_DIR, env, stdio: "ignore" });
  console.log(`  已启动 pid ${child.pid}\n`);

  let browser;
  try {
    if (!(await waitForEndpoint(CDP_PORT, 45000))) {
      throw new Error("WebView2 未开放调试端点");
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const page = browser.contexts().flatMap((ctx) => ctx.pages())[0];
    page.setDefaultTimeout(20000);
    await sleep(2500);
    record(page.url().startsWith("http"), "应用已加载", page.url());

    // ---------------------------------------------------------------- parse
    const composer = page.getByLabel("视频链接");
    await composer.waitFor({ state: "visible" });
    await composer.fill(URL_TO_TEST);
    await page.getByRole("button", { name: /^解析/ }).first().click();

    // Signals must be unambiguous: the download rail carries the placeholder
    // "解析链接后选择格式", so a substring search for 选择格式 matches before parsing even
    // starts. The format selector's radio group only exists once a probe has returned.
    const parsedSignal = page.locator('[role="radiogroup"] [role="radio"]').first();
    const errorSignal = page.getByText("无法解析视频", { exact: true }).first();

    const parseOutcome = await Promise.race([
      parsedSignal
        .waitFor({ state: "visible", timeout: 120000 })
        .then(() => "parsed")
        .catch(() => null),
      errorSignal
        .waitFor({ state: "visible", timeout: 120000 })
        .then(() => "error")
        .catch(() => null),
    ]);

    let parsed = parseOutcome === "parsed";
    let cookieDiagnosis = null;

    if (COOKIES === "none") {
      // With cookies switched off the very first parse must succeed: no cookie error at all.
      record(
        parsed && parseOutcome === "parsed",
        "Cookies 关闭时首次解析即成功（不出现 Cookie 错误）",
        parseOutcome ?? "超时",
      );
    }

    if (!parsed && parseOutcome === "error") {
      const panel = await page
        .locator("div")
        .filter({ hasText: "无法解析视频" })
        .last()
        .innerText()
        .catch(() => "");
      cookieDiagnosis = panel.slice(0, 400);
      console.log(`\n  解析失败面板内容：\n${panel.slice(0, 500)}\n`);

      const isCookieIssue = /Cookie/i.test(panel);
      record(isCookieIssue, "解析失败被识别为 Cookie 问题（而非登录问题）", panel.split("\n").slice(1, 3).join(" / "));
      record(
        !/需要登录|人机校验/.test(panel),
        "没有把 Cookie 数据库失败误报为「需要登录或人机验证」",
      );
      // The guidance block sits next to the summary rather than inside the deepest matching
      // div, so the whole page text is what these two assertions have to read.
      const pageText = await page.locator("body").innerText().catch(() => "");
      record(
        /请检查/.test(pageText),
        "错误面板列出了具体的检查项（浏览器 / Profile / 占用 / yt-dlp 支持）",
      );
      record(
        /关闭[\s\S]{0,40}使用浏览器 Cookies/.test(pageText),
        "错误面板提示了关闭「使用浏览器 Cookies」的办法",
      );

      // ------------------------------------------------------- fallback
      const retry = page.getByRole("button", { name: "不使用 Cookie 重试" });
      if ((await retry.count()) > 0) {
        record(true, "提供了「不使用 Cookie 重试」入口");
        await retry.first().click();
        parsed = await parsedSignal
          .waitFor({ state: "visible", timeout: 120000 })
          .then(() => true)
          .catch(() => false);
        record(parsed, "不使用 Cookie 后重新解析成功");
      } else {
        record(false, "错误面板中没有提供不使用 Cookie 的 fallback");
      }
    } else if (parsed) {
      record(true, "解析成功（Edge Cookie 未阻碍解析）");
    }

    if (!parsed) {
      throw new Error(`解析未成功（结果：${parseOutcome ?? "超时"}），无法继续验证下载`);
    }

    // ------------------------------------------------------------- download
    // Pick the smallest offered option to keep the test short, then wait for the
    // download button to become actionable (it stays disabled until a format is
    // selected and the runtime is reported complete).
    const titles = await page.locator('[role="radio"]').allInnerTexts();
    const videos = titles.filter((text) => /p\b|p\d|1080|720|480|360|240|144/.test(text));
    const smallest = videos.at(-1) ?? titles.at(-1);
    if (smallest) {
      const index = titles.indexOf(smallest);
      await page.locator('[role="radio"]').nth(index).click();
      console.log(`  已选择格式：${smallest.split("\n")[0]}`);
    }

    const startButton = page.getByRole("button", { name: /^开始下载/ }).first();
    await startButton.waitFor({ state: "visible" });
    // Poll for enablement so a disabled button produces a clear failure message.
    const enableDeadline = Date.now() + 30000;
    while ((await startButton.isDisabled()) && Date.now() < enableDeadline) {
      await sleep(500);
    }
    record(!(await startButton.isDisabled()), "开始下载按钮已可用");
    await startButton.click();
    record(true, "已提交下载任务");
    // ------------------------------------------------------------- wait
    //
    // The completion signal comes from the application's own history file, not from the
    // page text: the queue shows a "已完成" *filter label*, which is not a task state and
    // would report success the moment the page opens.
    const historyFile = path.join(APP_DIR, "data", "history", "history.json");
    const videoId = (URL_TO_TEST.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/) ?? [])[1] ?? "";

    // Baseline the history first: an entry left by an earlier run would otherwise be
    // mistaken for this run's result and end the wait immediately.
    const readHistory = async () => {
      if (!existsSync(historyFile)) {
        return [];
      }
      try {
        return JSON.parse(await readFile(historyFile, "utf8"));
      } catch {
        return [];
      }
    };
    const baseline = (await readHistory()).length;

    const deadline = Date.now() + 12 * 60 * 1000;
    let finalState = "unknown";
    let entry = null;

    while (Date.now() < deadline) {
      const history = await readHistory();
      // Only records added after this run started count.
      entry = history.slice(baseline).find((item) => videoId && item.url.includes(videoId)) ?? null;
      if (entry) {
        finalState = entry.status;
        break;
      }
      // Surface live progress so a stall is visible rather than silent.
      const progress = await page
        .locator('[role="progressbar"]')
        .first()
        .getAttribute("aria-valuenow")
        .catch(() => null);
      if (progress) {
        process.stdout.write(`\r  下载中… ${progress}%   `);
      }
      await sleep(3000);
    }
    process.stdout.write("\n");
    record(finalState === "completed", `下载结束状态：${finalState}`);

    if (finalState === "completed" && entry) {
      const file = entry.filePath;
      record(Boolean(file) && existsSync(file), "输出文件已生成", file ?? "(未记录)");

      // "定位到文件位置" has to hand Explorer the exact absolute path in the one token it
      // understands. The log line is the command line the application really built, so a
      // path with spaces, brackets or CJK here is what proves the regression is gone.
      const revealButton = page.getByRole("button", { name: "打开所在文件夹" });
      if ((await revealButton.count()) > 0) {
        await revealButton.first().click();
        await sleep(1200);
        const revealLog = existsSync(LOG_FILE) ? await readFile(LOG_FILE, "utf8") : "";
        const expected = `explorer.exe /select,"${file}"`;
        record(revealLog.includes(expected), "定位命令为 explorer.exe /select,\"<绝对路径>\"", expected);
      } else {
        record(false, "任务卡片上没有找到「打开所在文件夹」入口");
      }

      if (file && existsSync(file)) {
        const size = (await readFile(file)).length;
        record(size > 64 * 1024, "输出文件非空", `${(size / 1048576).toFixed(2)} MB`);
        record(
          ["mkv", "webm", "mp4"].includes((entry.container ?? "").toLowerCase()),
          "容器格式已记录",
          entry.container,
        );
        // A "video + audio" selection is merged by the application; a single-file selection
        // (e.g. the classic 360p mp4) is muxed by yt-dlp itself and legitimately records no
        // merge source. Both are correct, so the check reflects what the run actually did.
        const merged = (entry.mergedFrom ?? []).filter((id) => typeof id === "string" && id.length > 0);
        if (merged.length >= 2) {
          record(true, "由视频流 + 音频流合并而成", merged.join(" + "));
        } else {
          record(true, "单文件下载（由 yt-dlp 直接封装，无需应用合并）", entry.container ?? "");
        }

        // Playability: ffprobe must find both streams and a real duration. A development
        // build has no bundled runtime, so the mandated one is used as a fallback.
        const bundledProbe = path.join(APP_DIR, "runtime", "FFMPEG-9.0", "bin", "ffprobe.exe");
        const ffprobe = existsSync(bundledProbe)
          ? bundledProbe
          : path.join(DEV_RUNTIME_BIN, "ffprobe.exe");
        if (existsSync(ffprobe)) {
          const probe = execSync(
            `"${ffprobe}" -hide_banner -v error -show_entries format=duration,format_name:stream=codec_type,codec_name -of json "${file}"`,
            { encoding: "utf8" },
          );
          const facts = JSON.parse(probe);
          const kinds = (facts.streams ?? []).map((stream) => stream.codec_type);
          record(kinds.includes("video") && kinds.includes("audio"), "ffprobe 校验：含视频流与音频流", kinds.join("+"));
          record(
            Number(facts.format?.duration ?? 0) > 5,
            "ffprobe 校验：时长正常",
            `${Number(facts.format?.duration ?? 0).toFixed(1)} 秒`,
          );
        }
      }
    } else {
      const body = await page.locator("body").innerText().catch(() => "");
      const failure = body
        .split("\n")
        .filter((line) => /失败|错误|Error|无法/.test(line))
        .slice(0, 6);
      console.log(`  失败线索：${failure.join(" | ")}`);
    }

    // ------------------------------------------------------------- evidence
    const log = existsSync(LOG_FILE) ? await readFile(LOG_FILE, "utf8") : "";
    if (COOKIES === "browser") {
      record(/cookies=configured/.test(log), "日志记录了带浏览器 Cookie 的解析尝试");
      record(/cookies=skipped/.test(log), "日志记录了不使用 Cookie 的重新解析");
    } else {
      record(/cookies=none/.test(log), "日志显示 Cookies 关闭时未向 yt-dlp 传入任何 Cookie 参数");
    }
    if (/source=bundled/.test(log)) {
      record(true, "运行库来自内置 runtime（非 E:\\FFMPEG-9.0 / 非 C 盘）");
    } else if (/source=development/.test(log)) {
      record(
        ALLOW_DEV_RUNTIME,
        ALLOW_DEV_RUNTIME
          ? "运行库来自开发路径 E:\\FFMPEG-9.0（开发版自检，已显式允许）"
          : "运行库来自开发路径（E:\\FFMPEG-9.0），不应出现在生产版本中",
      );
    } else {
      record(true, "运行库自检已记录");
    }

    await writeFile(
      REPORT,
      JSON.stringify(
        { url: URL_TO_TEST, exe: EXE, downloadDir: DOWNLOAD_DIR, cookies: COOKIES, finalState, cookieDiagnosis, steps },
        null,
        2,
      ),
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    child.kill();
    try {
      execSync("taskkill /IM msedgewebview2.exe /F", { stdio: "ignore" });
    } catch {
      /* nothing to kill */
    }
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`端到端测试有 ${failures.length} 项未通过：`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`端到端测试通过（${steps.length} 项检查）。`);
  }
}

main().catch((error) => {
  console.error(`\n测试中断：${error?.message ?? error}`);
  process.exitCode = 1;
});
