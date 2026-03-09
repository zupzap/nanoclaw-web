#!/usr/bin/env npx tsx
/**
 * X Integration - Read Mentions
 * Usage: echo '{}' | npx tsx mentions.ts
 * Usage: echo '{"since":"2026-03-09T00:00:00Z"}' | npx tsx mentions.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface MentionsInput {
  since?: string;
}

interface Mention {
  author: string;
  text: string;
  url: string;
  timestamp: string;
}

async function readMentions(input: MentionsInput): Promise<ScriptResult> {
  const sinceDate = input.since ? new Date(input.since) : null;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/notifications/mentions', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
      }
    }

    // Wait for tweet articles to load
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

    // Scrape visible mention tweets
    const mentions: Mention[] = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results: Mention[] = [];

      for (const article of articles) {
        // Extract author handle
        const userLinks = article.querySelectorAll('a[role="link"][href^="/"]');
        let author = '';
        for (const link of userLinks) {
          const href = (link as HTMLAnchorElement).href;
          const match = href.match(/x\.com\/([^/]+)$/);
          if (match && !['home', 'explore', 'notifications', 'messages', 'i'].includes(match[1])) {
            author = `@${match[1]}`;
            break;
          }
        }

        // Extract tweet text
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const text = tweetTextEl ? tweetTextEl.textContent || '' : '';

        // Extract tweet URL from the timestamp link
        let url = '';
        const timeEl = article.querySelector('time');
        if (timeEl) {
          const timeLink = timeEl.closest('a');
          if (timeLink) {
            url = (timeLink as HTMLAnchorElement).href;
          }
        }

        // Extract timestamp from the time element
        let timestamp = '';
        if (timeEl) {
          timestamp = timeEl.getAttribute('datetime') || '';
        }

        if (author || text) {
          results.push({ author, text: text.trim(), url, timestamp });
        }
      }

      return results;
    });

    // Filter by since date if provided
    let filtered = mentions;
    if (sinceDate) {
      filtered = mentions.filter(m => {
        if (!m.timestamp) return true; // Include if no timestamp available
        return new Date(m.timestamp) > sinceDate;
      });
    }

    return {
      success: true,
      message: `Found ${filtered.length} mention${filtered.length === 1 ? '' : 's'}${sinceDate ? ` since ${input.since}` : ''}.`,
      data: filtered,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<MentionsInput>(readMentions);
