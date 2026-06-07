const DEFAULT_BARK_BASE_URL = 'https://api.day.app';
const MAX_BARK_BODY_LENGTH = 900;

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 20)}\n...(内容已截断)`;
}

export async function sendBarkNotification({
  title,
  body,
  level = 'active',
  group = 'flight-monitor',
}) {
  const barkKey = process.env.BARK;

  if (!barkKey) {
    console.log('[bark] BARK is not set; notification skipped.');
    return { sent: false, reason: 'BARK is not set' };
  }

  const baseUrl = (process.env.BARK_BASE_URL || DEFAULT_BARK_BASE_URL).replace(/\/+$/, '');
  const safeBody = truncateText(body, MAX_BARK_BODY_LENGTH);
  const url = new URL(`${baseUrl}/${encodeURIComponent(barkKey)}/${encodeURIComponent(title)}/${encodeURIComponent(safeBody)}`);
  url.searchParams.set('group', group);
  url.searchParams.set('level', level);

  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Bark notification failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  return { sent: true, status: response.status };
}
