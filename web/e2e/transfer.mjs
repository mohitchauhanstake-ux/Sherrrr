// End-to-end check: two real browser pages pair through the signaling server,
// transfer files over WebRTC, survive a forced mid-transfer disconnect, and the
// received bytes are compared against the originals by SHA-256.
//
// Requires both dev servers running:  npm run dev:signal  and  npm run dev:web
// Usage: node e2e/transfer.mjs [bigFileMB]

import { chromium } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.APP_URL ?? "http://localhost:5180";
const BIG_MB = Number(process.argv[2] ?? 300);

const dir = mkdtempSync(join(tmpdir(), "sher-e2e-"));

async function makeBigFile(path, megabytes) {
  const out = createWriteStream(path);
  for (let i = 0; i < megabytes; i++) {
    if (!out.write(randomBytes(1024 * 1024))) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const files = {
  "big.bin": join(dir, "big.bin"),
  "small.txt": join(dir, "small.txt"),
  "empty.dat": join(dir, "empty.dat"),
  "medium.bin": join(dir, "medium.bin"),
};
await makeBigFile(files["big.bin"], BIG_MB);
writeFileSync(files["small.txt"], "hello from sher\n");
writeFileSync(files["empty.dat"], "");
writeFileSync(files["medium.bin"], randomBytes(5 * 1024 * 1024 + 123));
const expected = {};
for (const [name, path] of Object.entries(files)) expected[name] = await sha256(path);

const browser = await chromium.launch();
try {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  for (const [label, page] of [["host", host], ["guest", guest]]) {
    page.on("pageerror", (err) => fail(`${label} page error: ${err.message}`));
  }

  await host.goto(APP);
  await host.getByRole("button", { name: "Send files" }).click();
  const code = await host.getByTestId("room-code").getAttribute("data-code");
  console.log(`room ${code}`);

  // ?downloads forces the no-folder-picker path, which a script can drive.
  await guest.goto(`${APP}/?downloads#${code}`);
  await host.getByText("Connected").waitFor({ timeout: 30_000 });
  console.log(`paired: ${await host.locator(".status").innerText()}`);

  await host.getByTestId("file-input").setInputFiles(Object.values(files));
  await host.getByRole("button", { name: /^Send \d+ files?$/ }).click();
  await guest.getByRole("button", { name: "Receive", exact: true }).click();
  const started = Date.now();

  // Kill the connection partway through; the transfer must resume by itself.
  // Set NO_DROP=1 to skip this and measure uninterrupted speed.
  if (!process.env.NO_DROP) {
    await guest.waitForFunction(() => {
      const s = window.__sher.getState();
      return s.phase === "transferring" && s.doneBytes > s.totalBytes * 0.3;
    }, null, { timeout: 120_000 });
    const before = await guest.evaluate(() => {
      const bytes = window.__sher.getState().doneBytes;
      window.__sher.link.debugDrop();
      return bytes;
    });
    console.log(`dropped connection at ${(before / 1048576).toFixed(0)} MB`);
  }

  const dumpState = async () => {
    for (const [label, page] of [["host", host], ["guest", guest]]) {
      const s = await page.evaluate(() => {
        const { files, saved, ...rest } = window.__sher.getState();
        return rest;
      });
      console.error(label, JSON.stringify(s));
    }
  };
  await guest
    .waitForFunction(() => ["done", "error"].includes(window.__sher.getState().phase), null, { timeout: 600_000 })
    .catch(async (err) => {
      await dumpState();
      throw err;
    });
  if ((await guest.evaluate(() => window.__sher.getState().phase)) !== "done") {
    await dumpState();
    throw new Error("transfer ended in an error state");
  }
  await guest.getByText(/^Received 4 files/).waitFor({ timeout: 5_000 });
  await host.getByText(/^Sent 4 files/).waitFor({ timeout: 30_000 });
  const seconds = (Date.now() - started) / 1000;
  const totalMB = BIG_MB + 5;
  console.log(`transferred ~${totalMB} MB in ${seconds.toFixed(1)}s (${((totalMB * 8) / seconds).toFixed(0)} Mbps incl. reconnect)`);

  const received = await guest.evaluate(async () => {
    const out = {};
    for (const file of window.__sher.getState().saved) {
      const bytes = await (await fetch(file.url)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      out[file.name] = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return out;
  });

  for (const [name, hash] of Object.entries(expected)) {
    if (received[name] === hash) console.log(`ok   ${name}`);
    else fail(`${name}: expected ${hash}, got ${received[name]}`);
  }
  if (Object.keys(received).length !== Object.keys(expected).length) {
    fail(`expected ${Object.keys(expected).length} files, received ${Object.keys(received).length}`);
  }

  // ---- Scenario 2: save-to-folder mode, and skipping files already received.
  // The real folder picker can't be scripted, so it is replaced with a folder
  // in the browser's private storage, which has the same interface.
  const folderCtx = await browser.newContext();
  await folderCtx.addInitScript(() => {
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
  });
  const smallSet = ["medium.bin", "small.txt", "empty.dat"];
  const sendSmallSet = async () => {
    const h = await (await browser.newContext()).newPage();
    const g = await folderCtx.newPage();
    await h.goto(APP);
    await h.getByRole("button", { name: "Send files" }).click();
    const roomCode = await h.getByTestId("room-code").getAttribute("data-code");
    await g.goto(`${APP}/#${roomCode}`);
    await h.getByText("Connected").waitFor({ timeout: 30_000 });
    await h.getByTestId("file-input").setInputFiles(smallSet.map((n) => files[n]));
    await h.getByRole("button", { name: /^Send \d+ files?$/ }).click();
    await g.getByRole("button", { name: "Choose folder and receive" }).click();
    await g.getByText(/^Received 3 files/).waitFor({ timeout: 60_000 });
    await h.getByText(/^Sent 3 files/).waitFor({ timeout: 30_000 });
    const bytesSent = await h.evaluate(() => window.__sher.sender.sent);
    const hashes = await g.evaluate(async (names) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
      const out = {};
      for (const name of names) {
        const bytes = await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        out[name] = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      const listing = [];
      for await (const key of dir.keys()) listing.push(key);
      return { out, listing };
    }, smallSet);
    await h.close();
    await g.close();
    return { bytesSent, ...hashes };
  };

  const first = await sendSmallSet();
  for (const name of smallSet) {
    if (first.out[name] === expected[name]) console.log(`ok   folder mode: ${name}`);
    else fail(`folder mode ${name}: hash mismatch`);
  }
  const second = await sendSmallSet();
  if (second.bytesSent === 0) console.log("ok   repeat transfer skipped files already in the folder");
  else fail(`repeat transfer re-sent ${second.bytesSent} bytes`);
  if (second.listing.length === smallSet.length) console.log("ok   no duplicate files created");
  else fail(`folder contains unexpected entries: ${second.listing.join(", ")}`);
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(process.exitCode ? "E2E FAILED" : "E2E PASSED");
