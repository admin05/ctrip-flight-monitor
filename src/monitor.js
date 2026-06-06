import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendBarkNotification } from './bark.js';

const SCRIPT_NAME = '携程机票价格监控';
const DEFAULT_FLIGHT_URL = 'https://flights.ctrip.com/online/list/oneway-jjn0-tfu0?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0';
const DEFAULT_STATE_FILE = 'data/last-price.json';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  url: process.env.CTRIP_FLIGHT_URL || DEFAULT_FLIGHT_URL,
  flightNo: process.env.TARGET_FLIGHT_NO || 'ZH9494',
  stateFile: process.env.PRICE_STATE_FILE || DEFAULT_STATE_FILE,
  apiWaitMs: Number(process.env.CTRIP_API_WAIT_MS || 45000),
};

function extractPrices(text) {
  const prices = new Set();
  const patterns = [
    /(?:¥|￥|CNY\s*)\s*([1-9]\d{1,5})(?:\.\d+)?/gi,
    /([1-9]\d{2,5})\s*(?:元|起)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const price = Number(match[1]);
      if (Number.isFinite(price) && price >= 100 && price <= 20000) {
        prices.add(price);
      }
    }
  }

  return [...prices].sort((a, b) => a - b);
}

function compactText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('[setup] playwright is missing; running npm install...');
      execFileSync('npm', ['install'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });

      const { chromium } = await import('playwright');
      return chromium;
    }

    throw error;
  }
}

async function launchChromium(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (/Executable doesn't exist|browserType\.launch/i.test(error.message || '')) {
      console.log('[setup] Playwright Chromium is missing; installing browser runtime...');
      execFileSync('npx', ['playwright', 'install', 'chromium'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
      return chromium.launch({ headless: true });
    }

    throw error;
  }
}

function parseStorageState(value) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`CTRIP_STORAGE_STATE is not valid JSON: ${error.message}`);
  }
}

function normalizeFlightNo(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function collectNumbersByKey(value, keyMatcher, result = []) {
  if (!value || typeof value !== 'object') {
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbersByKey(item, keyMatcher, result);
    }
    return result;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (keyMatcher(key) && typeof nestedValue === 'number' && Number.isFinite(nestedValue)) {
      result.push(nestedValue);
    }

    if (nestedValue && typeof nestedValue === 'object') {
      collectNumbersByKey(nestedValue, keyMatcher, result);
    }
  }

  return result;
}

function getFlightListFromItinerary(item) {
  const segments = item?.flightSegments || item?.flightSegmentList || [];
  return segments.flatMap((segment) => segment?.flightList || segment?.flights || []);
}

function getLowestPriceFromItinerary(item) {
  const priceList = item?.priceList || item?.prices || [];
  const prices = [];

  for (const priceItem of priceList) {
    const cabin = String(priceItem?.cabin || priceItem?.cabinCode || '').toUpperCase();
    const adultPrice = Number(priceItem?.adultPrice || priceItem?.price || priceItem?.salePrice || 0);
    if ((!cabin || cabin === 'Y') && adultPrice > 0) {
      prices.push(adultPrice);
    }
  }

  if (prices.length === 0) {
    prices.push(...collectNumbersByKey(item, (key) => /adultPrice|salePrice|price$/i.test(key)));
  }

  return prices
    .filter((price) => Number.isFinite(price) && price >= 100 && price <= 20000)
    .sort((a, b) => a - b)[0];
}

function parseFlightFromBatchSearch(data, targetFlightNo) {
  const target = normalizeFlightNo(targetFlightNo);
  const itineraryList = data?.data?.flightItineraryList || data?.flightItineraryList || [];
  const matches = [];

  for (const item of itineraryList) {
    const flightList = getFlightListFromItinerary(item);
    const flightNos = flightList.map((flight) => normalizeFlightNo(flight?.flightNo));
    if (!flightNos.includes(target)) {
      continue;
    }

    const firstFlight = flightList[0] || {};
    const lastFlight = flightList.at(-1) || firstFlight;
    const lowestPrice = getLowestPriceFromItinerary(item);
    if (!lowestPrice) {
      continue;
    }

    matches.push({
      flightNo: targetFlightNo,
      lowestPrice: Math.trunc(lowestPrice),
      observedPrices: [Math.trunc(lowestPrice)],
      airline: firstFlight.marketAirlineName || firstFlight.airlineName || '',
      depTime: firstFlight.departureDateTime || '',
      arrTime: lastFlight.arrivalDateTime || '',
      depAirport: firstFlight.departureAirportShortName || firstFlight.departureAirportName || '',
      arrAirport: lastFlight.arrivalAirportShortName || lastFlight.arrivalAirportName || '',
      source: 'ctrip batchSearch',
      context: JSON.stringify({
        flightNos,
        priceList: item.priceList,
      }).slice(0, 800),
    });
  }

  return matches.sort((a, b) => a.lowestPrice - b.lowestPrice)[0] || null;
}

function createBatchSearchCollector(page, targetFlightNo) {
  const responses = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('batchSearch')) {
      return;
    }

    try {
      const text = await response.text();
      const data = JSON.parse(text);
      responses.push({ url, data });
    } catch {
      // Ignore non-JSON or inaccessible responses.
    }
  });

  return {
    async waitForResult(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const response of responses) {
          const result = parseFlightFromBatchSearch(response.data, targetFlightNo);
          if (result) {
            return {
              ...result,
              apiUrl: response.url,
            };
          }
        }
        await sleep(500);
      }

      return null;
    },
    get count() {
      return responses.length;
    },
  };
}

async function readPreviousState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function writeCurrentState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function describePriceChange(previous, currentPrice) {
  if (!previous?.lowestPrice) {
    return '首次记录';
  }

  const diff = currentPrice - previous.lowestPrice;
  if (diff === 0) {
    return `价格未变，仍为 ¥${currentPrice}`;
  }

  if (diff < 0) {
    return `价格下降 ¥${Math.abs(diff)}，上次 ¥${previous.lowestPrice}`;
  }

  return `价格上涨 ¥${diff}，上次 ¥${previous.lowestPrice}`;
}

function formatBeijingTime(date) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.format(date).replace(/\//g, '-');
}

async function findFlightPrice(page, flightNo) {
  const batchSearchCollector = createBatchSearchCollector(page, flightNo);

  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const apiResult = await batchSearchCollector.waitForResult(config.apiWaitMs);
  if (apiResult) {
    return apiResult;
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const initialText = compactText(await page.locator('body').innerText().catch(() => ''));
  if (/whaleguard\s+block/i.test(initialText)) {
    throw new Error('Ctrip whaleguard block: 携程反爬系统拦截了自动化访问，页面未返回航班数据。');
  }

  const flightLocator = page.getByText(flightNo, { exact: false }).first();
  await flightLocator.waitFor({ timeout: 45000 });

  const candidates = await page.evaluate((targetFlightNo) => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('body *')]
      .filter((node) => node.children.length === 0 && node.textContent?.includes(targetFlightNo));

    const blocks = [];
    for (const node of nodes) {
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const text = normalize(current.textContent || '');
        if (text.includes(targetFlightNo) && /[¥￥元起]\s*\d|\d+\s*(元|起)/.test(text)) {
          blocks.push({
            depth,
            tag: current.tagName,
            text: text.slice(0, 2000),
          });
        }
        current = current.parentElement;
      }
    }

    return blocks;
  }, flightNo);

  const pricedCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      prices: extractPrices(candidate.text),
    }))
    .filter((candidate) => candidate.prices.length > 0);

  if (pricedCandidates.length === 0) {
    const pageText = compactText(await page.locator('body').innerText());
    const index = pageText.indexOf(flightNo);
    const context = index >= 0 ? pageText.slice(Math.max(0, index - 300), index + 800) : pageText.slice(0, 1000);
    throw new Error(`Found ${flightNo}, but no price was extracted. batchSearch responses: ${batchSearchCollector.count}. Context: ${context}`);
  }

  const allPrices = pricedCandidates.flatMap((candidate) => candidate.prices);
  const lowestPrice = Math.min(...allPrices);
  const bestCandidate = pricedCandidates.find((candidate) => candidate.prices.includes(lowestPrice));

  return {
    flightNo,
    lowestPrice,
    observedPrices: [...new Set(allPrices)].sort((a, b) => a - b),
    source: 'page text',
    context: bestCandidate.text.slice(0, 500),
  };
}

async function run() {
  const chromium = await loadChromium();
  const browser = await launchChromium(chromium);
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1000 },
  };

  contextOptions.storageState = parseStorageState(process.env.CTRIP_STORAGE_STATE);

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    const result = await findFlightPrice(page, config.flightNo);
    const previous = await readPreviousState(config.stateFile);
    const changeText = describePriceChange(previous, result.lowestPrice);
    const now = new Date();
    const checkedAt = now.toISOString();
    const checkedAtBeijing = formatBeijingTime(now);

    await writeCurrentState(config.stateFile, {
      ...result,
      checkedAt,
      checkedAtBeijing,
      route: 'JJN -> TFU',
      depDate: '2026-08-09',
      sourceUrl: config.url,
    });

    const message = [
      `${SCRIPT_NAME}: 成功`,
      `航班: ${result.flightNo} JJN -> TFU 2026-08-09`,
      `最低价: ¥${result.lowestPrice}`,
      `变化: ${changeText}`,
      `检查时间: ${checkedAtBeijing}`,
    ].join('\n');

    console.log(message);
    await sendBarkNotification({
      title: SCRIPT_NAME,
      body: message,
    });
  } catch (error) {
    const message = [
      `${SCRIPT_NAME}: 失败`,
      `航班: ${config.flightNo} JJN -> TFU 2026-08-09`,
      `错误: ${error.message}`,
    ].join('\n');

    console.error(message);
    await sendBarkNotification({
      title: `${SCRIPT_NAME}失败`,
      body: message.slice(0, 900),
      level: 'timeSensitive',
    }).catch((notifyError) => {
      console.error(`[bark] failure notification skipped: ${notifyError.message}`);
    });

    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await run();
