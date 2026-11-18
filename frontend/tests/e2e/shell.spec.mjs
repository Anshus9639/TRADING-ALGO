import { test, expect } from '@playwright/test';
import { mockApi, seedSession, SESSION_TOKEN } from './fixtures.mjs';

async function openTerminal(page) {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto('/');
  await expect(page.locator('section[aria-label="Chart and market controls"]')).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => (window.__marketStream ? window.__marketStream.connections() : 0))
  ).toBe(1);
  return pageErrors;
}

function lastFocus(page) {
  return page.evaluate(() => window.__marketStream.focusEvents.at(-1) || null);
}

test.describe('market stream lifecycle', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('keeps one socket and re-focuses on interval and symbol changes', async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
    const pageErrors = await openTerminal(page);

    await expect.poll(() => lastFocus(page)).toEqual({ symbol: 'BTCUSDT', interval: '5m' });
    expect(await page.evaluate(() => window.__marketStream.socketCount)).toBe(1);

    await page
      .getByRole('group', { name: 'Chart interval' })
      .getByRole('button', { name: '1h', exact: true })
      .click();
    await expect.poll(() => lastFocus(page)).toEqual({ symbol: 'BTCUSDT', interval: '1h' });

    const navigator = page.locator('aside[aria-label="Market navigator"]');
    await navigator.getByRole('button', { name: /ETH\/USDT/ }).click();
    await expect.poll(() => lastFocus(page)).toEqual({ symbol: 'ETHUSDT', interval: '1h' });
    await expect(page.getByRole('heading', { name: 'ETH / USDT' })).toBeVisible();

    // Selecting another market re-uses the connection instead of opening one.
    expect(await page.evaluate(() => window.__marketStream.socketCount)).toBe(1);
    expect(await page.evaluate(() => window.__marketStream.connections())).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__marketStream.focusEvents.length)).toBe(3);

    expect(pageErrors).toEqual([]);
  });

  test('prices come from the stream and invalid ticks are ignored', async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
    const pageErrors = await openTerminal(page);

    const price = page.locator('section[aria-label="Chart and market controls"] .metric').first();
    await expect(price).toHaveText('64,000.00');

    await page.evaluate(() => {
      const stream = window.__marketStream;
      stream.serverEmit('marketUpdate', {
        symbol: 'BTCUSDT', price: 64100.5, changePercent: 0.68, quoteVolume: 9000000, ts: Date.now()
      });
      stream.serverEmit('marketUpdate', {
        symbol: 'BTCUSDT', price: 64200.75, changePercent: 0.69, quoteVolume: 9100000, ts: Date.now()
      });
      stream.serverEmit('marketUpdate', {
        symbol: 'BTCUSDT', price: 65000.25, changePercent: 0.7, quoteVolume: 9200000, ts: Date.now()
      });
    });
    await expect(price).toHaveText('65,000.25');

    await page.evaluate(() => {
      window.__marketStream.serverEmit('marketUpdate', {
        symbol: 'BTCUSDT', price: 0, changePercent: -99, quoteVolume: 1, ts: Date.now()
      });
      window.__marketStream.serverEmit('candleUpdate', {
        symbol: 'ETHUSDT', interval: '5m',
        time: Math.floor(Date.now() / 1000), open: 1, high: 1, low: 1, close: 1, volume: 1
      });
    });
    await page.waitForTimeout(400);
    await expect(price).toHaveText('65,000.25');

    expect(pageErrors).toEqual([]);
  });
});

test.describe('watchlist writes', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('adds and removes a symbol with the session token attached', async ({ page }) => {
    const state = await mockApi(page);
    await seedSession(page);
    const pageErrors = await openTerminal(page);

    const capturedHeaders = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/auth/watchlist')) {
        capturedHeaders.push(request.headers());
      }
    });

    const navigator = page.locator('aside[aria-label="Market navigator"]');
    await navigator.getByRole('button', { name: 'Add XRPUSDT to watchlist' }).click();

    await expect.poll(() => state.watchlistWrites.length).toBe(1);
    expect(state.watchlistWrites[0]).toEqual(['ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
    await expect(navigator.getByRole('region', { name: 'Watchlist' }).getByText('XRPUSDT')).toBeVisible();

    const removeXrp = navigator.getByRole('button', { name: 'Remove XRPUSDT from watchlist' });
    await expect(removeXrp).toBeVisible();
    await removeXrp.click();
    await expect.poll(() => state.watchlistWrites.length).toBe(2);
    expect(state.watchlistWrites[1]).toEqual(['ETHUSDT', 'SOLUSDT']);

    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    for (const headers of capturedHeaders) {
      expect(headers['x-auth-token']).toBe(SESSION_TOKEN);
    }

    expect(pageErrors).toEqual([]);
  });
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens and closes the market navigator and trade sheet', async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
    const pageErrors = await openTerminal(page);

    await page.getByRole('button', { name: 'Open market navigator' }).click();
    const navigatorDialog = page.getByRole('dialog', { name: 'Market navigator' });
    await expect(navigatorDialog).toBeVisible();
    await expect(navigatorDialog.getByPlaceholder('Search BTC, SOL, ETH…')).toBeVisible();

    const dialogBox = await navigatorDialog.locator('div').first().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, width: rect.width };
    });
    expect(dialogBox.width).toBeLessThanOrEqual(390 * 0.86 + 1);
    expect(dialogBox.right).toBeLessThanOrEqual(390 + 1);

    await navigatorDialog.getByRole('button', { name: 'Close market navigator' }).last().click();
    await expect(navigatorDialog).toBeHidden();

    await page.getByRole('button', { name: 'Open trading panel' }).click();
    const tradeDialog = page.getByRole('dialog', { name: 'Trading panel' });
    await expect(tradeDialog).toBeVisible();
    await expect(tradeDialog.getByRole('heading', { name: 'Trade BTCUSDT' })).toBeVisible();
    await expect(tradeDialog.getByText('Bruda Bot')).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);

    await tradeDialog.getByRole('button', { name: 'Close trading panel' }).last().click();
    await expect(tradeDialog).toBeHidden();

    expect(pageErrors).toEqual([]);
  });
});

test.describe('authentication screen', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('renders the sign-in surface without a session or overflow', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await mockApi(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'NexusTrade' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Authorize access' })).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();

    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create identity' })).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    ).toBeLessThanOrEqual(1);

    expect(pageErrors).toEqual([]);
  });
});
