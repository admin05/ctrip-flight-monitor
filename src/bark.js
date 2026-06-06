const DEFAULT_BARK_BASE_URL = 'https://api.day.app';

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
  const url = new URL(`${baseUrl}/${encodeURIComponent(barkKey)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  url.searchParams.set('group', group);
  url.searchParams.set('level', level);

  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Bark notification failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  return { sent: true, status: response.status };
}
