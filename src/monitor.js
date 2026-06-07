import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendBarkNotification } from './bark.js';

const SCRIPT_NAME = '携程机票价格监控';
const DEFAULT_TARGETS = [
  {
    flightNo: 'ZH9494',
    depDate: '2026-08-01',
    route: 'JJN -> TFU',
    url: 'https://flights.ctrip.com/online/list/oneway-jjn-tfu?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0',
    urls: [
      'https://flights.ctrip.com/online/list/oneway-jjn-tfu?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-jjn-ctu?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-jjn0-tfu0?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-jjn0-ctu0?depdate=2026-08-01&cabin=y_s_c_f&adult=1&child=0&infant=0',
    ],
    stateFile: 'data/last-price-ZH9494-2026-08-01.json',
  },
  {
    flightNo: 'ZH9493',
    depDate: '2026-08-09',
    route: 'TFU -> JJN',
    url: 'https://flights.ctrip.com/online/list/oneway-tfu-jjn?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0',
    urls: [
      'https://flights.ctrip.com/online/list/oneway-tfu-jjn?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-ctu-jjn?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-tfu0-jjn0?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0',
      'https://flights.ctrip.com/online/list/oneway-ctu0-jjn0?depdate=2026-08-09&cabin=y_s_c_f&adult=1&child=0&infant=0',
    ],
    stateFile: 'data/last-price-ZH9493-2026-08-09.json',
  },
];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH_SEARCH_KEYWORD = 'batchSearch';
const INIT_SCRIPT = `
(() => {
  const state = { requests: [] };
  window.__ctripFlightMonitor = state;

  const capture = (meta, status, responseText) => {
    if (!String(meta.url || '').includes('${BATCH_SEARCH_KEYWORD}')) {
      return;
    }
    state.requests.push({
      url: meta.url || '',
      method: meta.method || '',
      body: meta.body || '',
      status: status || 0,
      responseText: responseText || '',
      ts: Date.now(),
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ctripFlightMonitorMeta = { method, url };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__ctripFlightMonitorMeta || {};
    meta.body = typeof body === 'string' ? body : '';
    this.addEventListener('loadend', function() {
      let responseText = '';
      try {
        responseText = this.responseText || '';
      } catch (_) {}
      capture(meta, this.status, responseText);
    });
    return originalSend.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const meta = {
      method: (init && init.method) || (input && input.method) || 'GET',
      url: typeof input === 'string' ? input : ((input && input.url) || ''),
      body: (init && typeof init.body === 'string') ? init.body : '',
    };
    const response = await originalFetch.apply(this, arguments);
    try {
      const responseText = await response.clone().text();
      capture(meta, response.status, responseText);
    } catch (_) {}
    return response;
  };
})();
`;

const config = {
  targets: createTargets(),
  apiWaitMs: Number(process.env.CTRIP_API_WAIT_MS || 45000),
  apiSettleMs: Number(process.env.CTRIP_API_SETTLE_MS || 8000),
};

function createTargets() {
  if (process.env.CTRIP_TARGETS) {
    return parseTargetsJson(process.env.CTRIP_TARGETS);
  }

  if (process.env.CTRIP_FLIGHT_URL || process.env.TARGET_FLIGHT_NO || process.env.PRICE_STATE_FILE) {
    return [
      {
        flightNo: process.env.TARGET_FLIGHT_NO || DEFAULT_TARGETS[0].flightNo,
        depDate: process.env.TARGET_DEP_DATE || DEFAULT_TARGETS[0].depDate,
        route: process.env.TARGET_ROUTE || DEFAULT_TARGETS[0].route,
        url: process.env.CTRIP_FLIGHT_URL || DEFAULT_TARGETS[0].url,
        urls: process.env.CTRIP_FLIGHT_URL ? [process.env.CTRIP_FLIGHT_URL] : DEFAULT_TARGETS[0].urls,
        stateFile: process.env.PRICE_STATE_FILE || DEFAULT_TARGETS[0].stateFile,
      },
    ];
  }

  return DEFAULT_TARGETS;
}

function parseTargetsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`CTRIP_TARGETS is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CTRIP_TARGETS must be a non-empty JSON array.');
  }

  return parsed.map((target, index) => {
    const flightNo = normalizeFlightNo(target.flightNo);
    const depDate = String(target.depDate || '').trim();
    const route = String(target.route || '').trim();
    const url = String(target.url || '').trim();
    const urls = Array.isArray(target.urls)
      ? target.urls.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const stateFile = String(target.stateFile || '').trim();

    if (!flightNo || !depDate || !route || (!url && urls.length === 0) || !stateFile) {
      throw new Error(`CTRIP_TARGETS[${index}] must include flightNo, depDate, route, url or urls, and stateFile.`);
    }

    return {
      flightNo,
      depDate,
      route,
      url: url || urls[0],
      urls: urls.length > 0 ? urls : [url],
      stateFile,
    };
  });
}

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

function collectStringsByKey(value, keyMatcher, result = []) {
  if (!value || typeof value !== 'object') {
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsByKey(item, keyMatcher, result);
    }
    return result;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (keyMatcher(key) && typeof nestedValue === 'string' && nestedValue.trim()) {
      result.push(nestedValue);
    }

    if (nestedValue && typeof nestedValue === 'object') {
      collectStringsByKey(nestedValue, keyMatcher, result);
    }
  }

  return result;
}

function getFlightNosFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const keys = [
    'flightNo',
    'flightNumber',
    'marketFlightNo',
    'operateFlightNo',
    'shareFlightNo',
  ];

  return keys
    .flatMap((key) => {
      const item = value[key];
      return Array.isArray(item) ? item : [item];
    })
    .filter((item) => typeof item === 'string')
    .map(normalizeFlightNo)
    .filter(Boolean);
}

function getPricesFromScope(scope) {
  return scope
    .flatMap((item) => collectNumbersByKey(item, (key) => (
      /adultPrice|salePrice|barePrice|ticketPrice|displayPrice|price$/i.test(key)
    )))
    .filter((price) => Number.isFinite(price) && price >= 100 && price <= 20000)
    .map((price) => Math.trunc(price))
    .sort((a, b) => a - b);
}

function getNearestPrices(value, ancestors) {
  for (const item of [value, ...[...ancestors].reverse()]) {
    const prices = [...new Set(getPricesFromScope([item]))];
    if (prices.length > 0) {
      return prices;
    }
  }

  return [];
}

function findStringByKey(scope, keyMatcher) {
  for (let index = scope.length - 1; index >= 0; index -= 1) {
    const matches = collectStringsByKey(scope[index], keyMatcher);
    if (matches.length > 0) {
      return matches[0];
    }
  }

  return '';
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

function parseFlightFromGenericJson(data, targetFlightNo) {
  const target = normalizeFlightNo(targetFlightNo);
  const matches = [];

  function visit(value, ancestors = []) {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, ancestors);
      }
      return;
    }

    const flightNos = getFlightNosFromObject(value);
    if (flightNos.includes(target)) {
      const scope = [...ancestors.slice(-5), value];
      const observedPrices = getNearestPrices(value, ancestors.slice(-5));
      const lowestPrice = observedPrices[0];

      if (lowestPrice) {
        matches.push({
          flightNo: targetFlightNo,
          lowestPrice,
          observedPrices,
          airline: findStringByKey(scope, /marketAirlineName|airlineName/i),
          depTime: findStringByKey(scope, /departureDateTime|depTime|takeOffTime/i),
          arrTime: findStringByKey(scope, /arrivalDateTime|arrTime|arrivalTime/i),
          depAirport: findStringByKey(scope, /departureAirportShortName|departureAirportName|depAirport/i),
          arrAirport: findStringByKey(scope, /arrivalAirportShortName|arrivalAirportName|arrAirport/i),
          source: 'ctrip batchSearch generic',
          context: JSON.stringify({
            flightNos,
            current: value,
          }).slice(0, 800),
        });
      }
    }

    const nextAncestors = [...ancestors, value];
    for (const nestedValue of Object.values(value)) {
      visit(nestedValue, nextAncestors);
    }
  }

  visit(data);

  return matches.sort((a, b) => a.lowestPrice - b.lowestPrice)[0] || null;
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

  return matches.sort((a, b) => a.lowestPrice - b.lowestPrice)[0]
    || parseFlightFromGenericJson(data, targetFlightNo);
}

function summarizeBatchSearchResponses(responses, targetFlightNo) {
  const target = normalizeFlightNo(targetFlightNo);
  const flightNos = [...new Set(responses.flatMap(({ data }) => (
    collectStringsByKey(data, (key) => /flight.*(no|number)|fltno/i.test(key))
      .map(normalizeFlightNo)
      .filter(Boolean)
  )))].sort();
  const requestHints = [...new Set(responses.flatMap(({ body }) => extractRequestHints(body)))].slice(0, 8);
  const statuses = [...new Set(responses.map(({ data }) => String(data?.status ?? 'unknown')))];
  const messages = [...new Set(responses.flatMap(({ data }) => (
    collectStringsByKey(data, (key) => /message|msg|error/i.test(key))
      .map((item) => compactText(item).slice(0, 80))
      .filter(Boolean)
  )))].slice(0, 3);

  return {
    count: responses.length,
    hasTarget: flightNos.includes(target),
    flightNos: flightNos.slice(0, 20),
    requestHints,
    statuses,
    messages,
  };
}

function formatBatchSummary(summary) {
  const sampledFlightNos = summary.flightNos.length > 0 ? summary.flightNos.join(', ') : 'none';
  const requestHints = summary.requestHints.length > 0 ? `; request: ${summary.requestHints.join(', ')}` : '';
  const statuses = summary.statuses.length > 0 ? summary.statuses.join(', ') : 'unknown';
  const messages = summary.messages.length > 0 ? `; messages: ${summary.messages.join(' | ')}` : '';
  return `batchSearch responses: ${summary.count}; statuses: ${statuses}; target in API: ${summary.hasTarget ? 'yes' : 'no'}; sampled flightNos: ${sampledFlightNos}${requestHints}${messages}`;
}

function formatCompactBatchSummary(summary) {
  const statuses = summary.statuses.length > 0 ? summary.statuses.join('/') : 'unknown';
  const requestHints = summary.requestHints.length > 0 ? summary.requestHints.join(',') : 'no-request-body';
  const sampledFlightNos = summary.flightNos.length > 0 ? summary.flightNos.slice(0, 5).join(',') : 'none';
  const messages = summary.messages.length > 0 ? summary.messages.join('|') : '';
  return `status=${statuses} target=${summary.hasTarget ? 'yes' : 'no'} flights=${sampledFlightNos} request=${requestHints}${messages ? ` msg=${messages}` : ''}`;
}

function getCtripUrlVariant(url) {
  const match = String(url).match(/oneway-([^/?]+)/i);
  return match ? match[1] : 'unknown-url';
}

function isLikelyCorrectEmptyCtripResult(summary) {
  if (summary.hasTarget || summary.count === 0) {
    return false;
  }

  const requestText = summary.requestHints.join(',');
  return /departureCityCode=|arrivalCityCode=|departureAirportCode=|arrivalAirportCode=/.test(requestText)
    && summary.statuses.includes('0')
    && summary.messages.includes('success');
}

function getCtripNoFlightMessage(pageText) {
  if (/抱歉，未找到符合条件的航班|无航班|航班座位已售完/.test(pageText)) {
    return '携程未找到符合条件的航班，可能无航班、座位已售完，或查询 URL 未使用携程城市代码。';
  }

  return null;
}

function getNoFlightReason(summary) {
  if (isLikelyCorrectEmptyCtripResult(summary)) {
    return '携程接口请求参数已包含正确城市/机场/日期，但返回空航班列表；通常是无有效携程登录态/Cookie，需导出并配置 CTRIP_STORAGE_STATE。';
  }

  return '携程未找到符合条件的航班，可能无航班、座位已售完，或查询 URL 未使用携程城市代码。';
}

function truncateErrorMessage(message, maxLength = 260) {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 14)}...(已截断)`;
}

function extractRequestHints(body) {
  const text = String(body || '');
  if (!text) {
    return [];
  }

  const hints = [];
  try {
    const data = JSON.parse(text);
    const keys = [
      'departureCityCode',
      'arrivalCityCode',
      'departureAirportCode',
      'arrivalAirportCode',
      'dcity',
      'acity',
      'departCity',
      'arriveCity',
      'departDate',
      'departureDate',
      'startDate',
    ];
    for (const key of keys) {
      const values = collectStringsByKey(data, (itemKey) => itemKey === key);
      for (const value of values) {
        hints.push(`${key}=${value}`);
      }
    }
  } catch {
    for (const match of text.matchAll(/"(departureCityCode|arrivalCityCode|departureAirportCode|arrivalAirportCode|dcity|acity|departDate|departureDate|startDate)"\s*:\s*"([^"]+)"/g)) {
      hints.push(`${match[1]}=${match[2]}`);
    }
  }

  return hints;
}

function createBatchSearchCollector(page, targetFlightNo) {
  const responses = [];

  async function collectInjectedResponses() {
    const logs = await page.evaluate(() => window.__ctripFlightMonitor?.requests || []).catch(() => []);
    for (const item of logs) {
      if (responses.some((response) => response.ts === item.ts && response.url === item.url)) {
        continue;
      }
      try {
        const data = JSON.parse(item.responseText);
        responses.push({
          url: item.url,
          body: item.body,
          status: item.status,
          ts: item.ts,
          data,
        });
      } catch {
        // Ignore non-JSON responses.
      }
    }
  }

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes(BATCH_SEARCH_KEYWORD)) {
      return;
    }

    try {
      const text = await response.text();
      const data = JSON.parse(text);
      responses.push({ url, body: '', status: response.status(), ts: Date.now(), data });
    } catch {
      // Ignore non-JSON or inaccessible responses.
    }
  });

  return {
    async waitForResult(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let settleDeadline = null;
      while (Date.now() < deadline) {
        await collectInjectedResponses();
        for (const response of responses) {
          const result = parseFlightFromBatchSearch(response.data, targetFlightNo);
          if (result) {
            return {
              ...result,
              apiUrl: response.url,
            };
          }
        }

        if (responses.length > 0 && settleDeadline === null) {
          settleDeadline = Date.now() + config.apiSettleMs;
        }

        if (settleDeadline !== null && Date.now() >= settleDeadline) {
          return null;
        }

        await sleep(500);
      }

      return null;
    },
    get count() {
      return responses.length;
    },
    summary() {
      return summarizeBatchSearchResponses(responses, targetFlightNo);
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

async function findFlightPriceFromUrl(page, target, url) {
  const { flightNo } = target;
  const batchSearchCollector = createBatchSearchCollector(page, flightNo);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const apiResult = await batchSearchCollector.waitForResult(config.apiWaitMs);
  if (apiResult) {
    return {
      ...apiResult,
      sourceUrl: url,
    };
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const initialText = compactText(await page.locator('body').innerText().catch(() => ''));
  if (/whaleguard\s+block/i.test(initialText)) {
    throw new Error('Ctrip whaleguard block: 携程反爬系统拦截了自动化访问，页面未返回航班数据。');
  }

  const batchSummary = batchSearchCollector.summary();
  const noFlightMessage = getCtripNoFlightMessage(initialText);
  if (noFlightMessage) {
    const error = new Error(`${getNoFlightReason(batchSummary)} ${formatBatchSummary(batchSummary)}.`);
    error.compactSummary = formatCompactBatchSummary(batchSummary);
    throw error;
  }

  const flightLocator = page.getByText(flightNo, { exact: false }).first();
  const flightVisible = await flightLocator.waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (!flightVisible) {
    const pageSummary = initialText.slice(0, 200);
    const error = new Error(`No visible ${flightNo} result after API wait. ${formatBatchSummary(batchSummary)}. Page: ${pageSummary}`);
    error.compactSummary = formatCompactBatchSummary(batchSummary);
    throw error;
  }

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
    const error = new Error(`Found ${flightNo}, but no price was extracted. ${formatBatchSummary(batchSummary)}. Context: ${context}`);
    error.compactSummary = formatCompactBatchSummary(batchSummary);
    throw error;
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
    sourceUrl: url,
  };
}

async function findFlightPrice(context, target) {
  const urls = [...new Set([...(target.urls || []), target.url].filter(Boolean))];
  const errors = [];

  for (const url of urls) {
    const page = await context.newPage();
    try {
      return await findFlightPriceFromUrl(page, target, url);
    } catch (error) {
      const variant = getCtripUrlVariant(url);
      const summary = error.compactSummary || truncateErrorMessage(error.message, 140);
      errors.push(`[${variant}] ${summary}`);
    } finally {
      await page.close();
    }
  }

  throw new Error(`All candidate Ctrip URLs failed: ${errors.slice(0, 2).join(' | ')}${errors.length > 2 ? ` | ... ${errors.length - 2} more` : ''}`);
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
  await context.addInitScript(INIT_SCRIPT);
  try {
    const now = new Date();
    const checkedAt = now.toISOString();
    const checkedAtBeijing = formatBeijingTime(now);
    const successes = [];
    const failures = [];

    for (const target of config.targets) {
      try {
        const result = await findFlightPrice(context, target);
        const previous = await readPreviousState(target.stateFile);
        const changeText = describePriceChange(previous, result.lowestPrice);

        await writeCurrentState(target.stateFile, {
          ...result,
          checkedAt,
          checkedAtBeijing,
          route: target.route,
          depDate: target.depDate,
          sourceUrl: result.sourceUrl || target.url,
        });

        successes.push({
          ...target,
          result,
          changeText,
        });
      } catch (error) {
        failures.push({
          ...target,
          error,
        });
      }
    }

    const summaryLines = [
      `${SCRIPT_NAME}: ${failures.length === 0 ? '成功' : '部分失败'}`,
      `检查时间: ${checkedAtBeijing}`,
      ...successes.map(({ flightNo, route, depDate, result, changeText }) => (
        `${flightNo} ${route} ${depDate}: ¥${result.lowestPrice}，${changeText}`
      )),
      ...failures.map(({ flightNo, route, depDate, error }) => (
        `${flightNo} ${route} ${depDate}: 失败，${truncateErrorMessage(error.message)}`
      )),
    ];

    const message = summaryLines.join('\n');

    console.log(message);
    await sendBarkNotification({
      title: SCRIPT_NAME,
      body: message,
      level: failures.length === 0 ? 'active' : 'timeSensitive',
    });

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = [
      `${SCRIPT_NAME}: 失败`,
      `目标: ${config.targets.map((target) => `${target.flightNo} ${target.route} ${target.depDate}`).join('; ')}`,
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
