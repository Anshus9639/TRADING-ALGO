import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mockApi, seedSession } from './fixtures.mjs';

const VIEWPORTS = [
  { name: '320x640-mobile', width: 320, height: 640 },
  { name: '390x844-mobile', width: 390, height: 844 },
  { name: '430x932-mobile', width: 430, height: 932 },
  { name: '768x1024-tablet', width: 768, height: 1024 },
  { name: '1024x768-tablet-landscape', width: 1024, height: 768 },
  { name: '1366x768-laptop', width: 1366, height: 768 },
  { name: '1440x900-desktop', width: 1440, height: 900 },
  { name: '1920x1080-desktop', width: 1920, height: 1080 }
];

const SCREENSHOT_DIR = path.join(process.cwd(), 'test-results', 'screenshots');

function horizontalOverflow() {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}

async function boxOf(page, selector) {
  return page.locator(selector).first().evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('renders the terminal with responsive navigation and no horizontal overflow', async ({ page }) => {
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error)));

      await mockApi(page);
      await seedSession(page);
      await page.goto('/');

      const chartPanel = page.locator('section[aria-label="Chart and market controls"]');
      await expect(chartPanel).toBeVisible();
      await expect.poll(
        () => page.evaluate(() => (window.__marketStream ? window.__marketStream.connections() : 0))
      ).toBe(1);

      // Prices shown to the user come from the mocked catalogue source.
      await expect(chartPanel.locator('.metric').first()).toHaveText('64,000.00');

      expect(await page.evaluate(horizontalOverflow)).toBeLessThanOrEqual(1);

      const offenders = await page.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const found = [];
        for (const element of document.querySelectorAll('body *')) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = element.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          if (rect.left >= -1 && rect.right <= viewportWidth + 1) continue;

          let ancestor = element.parentElement;
          let insideScroller = false;
          while (ancestor) {
            const parentStyle = getComputedStyle(ancestor);
            const scrolls = parentStyle.overflowX === 'auto' || parentStyle.overflowX === 'scroll';
            const clips = parentStyle.overflowX === 'hidden' || parentStyle.overflowX === 'clip';
            if ((scrolls && ancestor.scrollWidth > ancestor.clientWidth + 1) || clips) {
              insideScroller = true;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (!insideScroller) {
            found.push(`${element.tagName}.${String(element.className).slice(0, 80)}`);
          }
        }
        return found.slice(0, 8);
      });
      expect(offenders).toEqual([]);

      const isTabletUp = viewport.width >= 768;
      const isDesktopUp = viewport.width >= 1280;

      if (isTabletUp) {
        await expect(page.locator('aside[aria-label="Primary navigation"]')).toBeVisible();
        await expect(page.locator('nav[aria-label="Section navigation"]')).toBeHidden();
      } else {
        await expect(page.locator('aside[aria-label="Primary navigation"]')).toBeHidden();
        await expect(page.locator('nav[aria-label="Section navigation"]')).toBeVisible();
      }

      if (isDesktopUp) {
        await expect(page.locator('aside[aria-label="Market navigator"]')).toBeVisible();
        await expect(page.locator('aside[aria-label="Trading panel"]')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open market navigator' })).toBeHidden();
        await expect(page.getByRole('button', { name: 'Open trading panel' })).toBeHidden();
      } else {
        await expect(page.getByRole('button', { name: 'Open market navigator' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open trading panel' })).toBeVisible();
      }

      // The ticker strip exists only where the navigator rail is absent.
      const ticker = page.locator('.no-scrollbar').first();
      if (isDesktopUp) await expect(ticker).toBeHidden();
      else await expect(ticker).toBeVisible();

      // Stacking: main content starts below the header (and ticker strip),
      // and the fixed bottom navigation stays inside the viewport.
      const header = await boxOf(page, 'header');
      const main = await boxOf(page, 'main');
      expect(main.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
      if (!isDesktopUp) {
        const tickerBox = await boxOf(page, '.no-scrollbar');
        expect(main.y).toBeGreaterThanOrEqual(tickerBox.y + tickerBox.height - 1);
      }
      const bottomNav = await page.locator('nav[aria-label="Section navigation"]').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom };
      });
      expect(bottomNav.bottom).toBeLessThanOrEqual(viewport.height + 1);

      // The chart surface must actually receive space at every width.
      const chart = await boxOf(page, 'section[aria-label="Chart and market controls"]');
      expect(chart.width).toBeGreaterThan(200);
      expect(chart.height).toBeGreaterThan(300);

      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const shot = path.join(SCREENSHOT_DIR, `${viewport.name}.png`);
      await page.screenshot({ path: shot });
      expect(fs.statSync(shot).size).toBeGreaterThan(5000);

      expect(pageErrors).toEqual([]);
    });
  });
}
