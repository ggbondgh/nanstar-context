import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.TEST_BASE_URL || "http://localhost:8788";
const token = process.env.TEST_AUTH_TOKEN;
if (!token) throw new Error("TEST_AUTH_TOKEN is required");

await mkdir("tmp/screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
]) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") failures.push(`${viewport.name} console: ${message.text()}`); });
  page.on("pageerror", (error) => failures.push(`${viewport.name} page: ${error.message}`));
  page.on("response", (response) => { if (response.status() >= 500) failures.push(`${viewport.name} HTTP ${response.status()}: ${response.url()}`); });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#loginToken").fill(token);
  await page.locator("#loginForm button[type=submit]").click();
  await page.locator("#appShell").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#viewRoot h1").waitFor({ state: "visible", timeout: 15000 });
  const visibleText = await page.locator("#viewRoot").innerText();
  if (visibleText.trim().length < 30) failures.push(`${viewport.name} content area is unexpectedly blank`);
  await page.screenshot({ path: `tmp/screenshots/${viewport.name}-dashboard.png`, fullPage: true });

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - window.innerWidth,
    html: document.documentElement.scrollWidth - window.innerWidth
  }));
  if (overflow.body > 1 || overflow.html > 1) failures.push(`${viewport.name} horizontal overflow: ${JSON.stringify(overflow)}`);

  if (viewport.name === "desktop") {
    await page.locator('[data-view="library"]').first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: "tmp/screenshots/desktop-library.png", fullPage: true });
    await page.locator('[data-view="settings"]').first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: "tmp/screenshots/desktop-settings.png", fullPage: true });
  }
  await context.close();
}

await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Visual check passed for desktop and mobile viewports.");
