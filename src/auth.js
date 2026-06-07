import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const DEFAULT_FLIGHT_URL = 'https://flights.ctrip.com/online/list/oneway-jjn-ctu?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0';
const DEFAULT_STORAGE_STATE = 'data/ctrip-storage-state.json';

const config = {
  url: process.env.CTRIP_FLIGHT_URL || DEFAULT_FLIGHT_URL,
  storageState: resolve(process.env.CTRIP_STORAGE_STATE || DEFAULT_STORAGE_STATE),
};

async function run() {
  await mkdir(dirname(config.storageState), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  console.log(`Opening Ctrip page: ${config.url}`);
  console.log('In the browser window, finish any manual verification and make sure the flight list loads.');
  console.log('When the page is usable, return here and press Enter to save storage state.');

  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const rl = createInterface({ input, output });
  await rl.question('Press Enter after Ctrip is loaded and usable...');
  rl.close();

  await context.storageState({ path: config.storageState });
  console.log(`Saved storage state: ${config.storageState}`);
  console.log(`Use this in Arcadia: CTRIP_STORAGE_STATE=${config.storageState}`);

  await browser.close();
}

await run();
