import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackage } from "./verify-package.mjs";
import { parseTargetArgs } from "./package-target.mjs";
import { MANAGED_NODE_VERSION } from "./stage-runtime-config.mjs";

const CORE_READY_TIMEOUT_MS = 15_000;
const DESKTOP_READY_TIMEOUT_MS = 30_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceDir = join(repoRoot, "docs", "superpowers", "notes", "evidence");

export async function smokePackage({ artifact, target }) {
  const checks = {
    verifyPackage: "pending",
    coreHealth: "pending",
    dashboardLoad: "pending",
    nativeMainWidget: "pending"
  };
  let nativeSkipReason = null;

  const verification = await verifyPackage({ artifact, target });
  checks.verifyPackage = "passed";

  await runCoreSmoke(verification.runtimeRoot, verification.nodeCommand);
  checks.coreHealth = "passed";

  await runDashboardSmoke(verification.runtimeRoot);
  checks.dashboardLoad = "passed";

  if (process.env.AGENT_METRICS_RUN_NATIVE_SMOKE === "1") {
    try {
      await runDesktopSmoke(artifact, target);
      checks.nativeMainWidget = "passed";
    } catch (error) {
      checks.nativeMainWidget = "failed";
      await writeSmokeEvidence({
        artifact,
        target,
        checks,
        verification,
        nativeSkipReason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  } else {
    checks.nativeMainWidget = "skipped";
    nativeSkipReason =
      "AGENT_METRICS_RUN_NATIVE_SMOKE is not set; native Main/Widget smoke requires a matching desktop host.";
    console.log("Main/Widget native smoke skipped; set AGENT_METRICS_RUN_NATIVE_SMOKE=1 on a desktop host.");
  }

  await writeSmokeEvidence({ artifact, target, checks, verification, nativeSkipReason });
  return verification;
}

async function writeSmokeEvidence({ artifact, target, checks, verification, nativeSkipReason }) {
  const timestamp = new Date().toISOString();
  const datePart = timestamp.slice(0, 10);
  await mkdir(evidenceDir, { recursive: true });

  const evidence = {
    platform: target.platform,
    arch: target.arch,
    hostPlatform: process.platform,
    hostArch: process.arch === "arm64" ? "arm64" : "x64",
    timestamp,
    artifact,
    checks,
    node: {
      host: process.version,
      bundled: MANAGED_NODE_VERSION,
      bundledCommand: verification?.nodeCommand ?? null
    }
  };

  if (nativeSkipReason !== null && checks.nativeMainWidget === "skipped") {
    evidence.nativeSkipReason = nativeSkipReason;
  }
  if (checks.nativeMainWidget === "failed" && nativeSkipReason !== null) {
    evidence.nativeFailureReason = nativeSkipReason;
  }

  const evidencePath = join(evidenceDir, `smoke-${target.platform}-${target.arch}-${datePart}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Smoke evidence written: ${evidencePath}`);
}

async function runCoreSmoke(runtimeRoot, nodeCommand) {
  const smokeRoot = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "agent-metrics-core-smoke-"));
  const port = await reservePort();
  const eventLogPath = join(smokeRoot, "events", "events.jsonl");
  const dbPath = join(smokeRoot, "sqlite", "metrics.sqlite");
  await mkdir(dirname(eventLogPath), { recursive: true });
  await mkdir(dirname(dbPath), { recursive: true });
  const child = spawn(nodeCommand, [join(runtimeRoot, "core", "dist", "server.js")], {
    cwd: join(runtimeRoot, "core"),
    env: {
      ...process.env,
      AGENT_METRICS_CORE_PORT: String(port),
      AGENT_METRICS_DB_PATH: dbPath,
      AGENT_METRICS_EVENT_LOG_PATH: eventLogPath,
      AGENT_METRICS_REPO_ROOT: smokeRoot
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, CORE_READY_TIMEOUT_MS);
    if (health.apiVersion !== 2 || health.eventSchemaVersion !== 2) {
      throw new Error("Core health smoke returned an incompatible API/event schema version.");
    }
    console.log("Core health smoke passed.");
  } finally {
    await stopChild(child);
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function runDashboardSmoke(runtimeRoot) {
  const html = await readFile(join(runtimeRoot, "dashboard", "index.html"), "utf8");
  if (!/<script[^>]+src=/i.test(html) || !/id=["']root["']/i.test(html)) {
    throw new Error("Dashboard load smoke did not find the root and script entry.");
  }
  console.log("Dashboard load smoke passed.");
}

async function runDesktopSmoke(artifact, target) {
  if (process.platform !== target.platform || (process.arch === "arm64" ? "arm64" : "x64") !== target.arch) {
    throw new Error("Native Main/Widget smoke requires a host matching the package target.");
  }
  const executable = await findDesktopExecutable(artifact, target);
  const smokeRoot = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "agent-metrics-desktop-smoke-"));
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      AGENT_METRICS_DESKTOP_SMOKE: "1",
      AGENT_METRICS_DATA_ROOT: smokeRoot
    },
    stdio: "inherit",
    windowsHide: true
  });
  try {
    const [code, signal] = await waitForExit(child, DESKTOP_READY_TIMEOUT_MS);
    if (code !== 0 || signal !== null) {
      throw new Error(`Main/Widget native smoke exited abnormally: code=${code} signal=${signal ?? "none"}`);
    }
    await verifyDesktopSmokeMarker(smokeRoot);
    console.log("Main/Widget native smoke passed.");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function verifyDesktopSmokeMarker(smokeRoot) {
  const markerPath = join(smokeRoot, "desktop-smoke-ok.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.main !== true) {
      throw new Error("Desktop smoke marker missing main: true.");
    }
    if (marker.widget !== true) {
      throw new Error("Desktop smoke marker expected widget: true for default settings.");
    }
    if (marker.alwaysOnTop !== undefined && marker.alwaysOnTop !== true) {
      throw new Error("Desktop smoke marker expected alwaysOnTop: true when widget is enabled.");
    }
    console.log("Desktop smoke marker verified.");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("Desktop smoke marker not found; skipping marker verification.");
      return;
    }
    throw error;
  }
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Core exited before readiness with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // The Core process may still be binding its port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Core readiness timed out after ${timeoutMs}ms.`);
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Desktop smoke timed out after ${timeoutMs}ms.`)), timeoutMs))
  ]);
}

async function findDesktopExecutable(artifact, target) {
  if (target.platform === "win32") {
    const candidate = join(artifact, "AgentMetrics.exe");
    return candidate;
  }
  const entries = await readdir(artifact, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      const executableDirectory = join(artifact, entry.name, "Contents", "MacOS");
      const files = await readdir(executableDirectory);
      if (files.length > 0) {
        return join(executableDirectory, files[0]);
      }
    }
  }
  throw new Error(`Unable to locate the macOS desktop executable under ${artifact}.`);
}

async function main() {
  const target = parseTargetArgs(process.argv.slice(2), { requireArtifact: true, resolveArtifactDefault: true });
  await smokePackage({ artifact: target.artifact, target });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Package smoke failed.", error);
    process.exit(1);
  });
}
