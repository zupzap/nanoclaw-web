#!/usr/bin/env npx tsx
/**
 * X Integration - Feed Scanner
 * Scans specific accounts and search terms on X for interesting tweets.
 *
 * Usage: echo '{"accounts":["aakxssh"],"searches":["AI agents"]}' | npx tsx feed-scanner.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface FeedScannerInput {
  accounts?: string[];
  searches?: string[];
  max_per_source?: number;
}

interface FeedItem {
  source: string;
  source_type: 'account' | 'search';
  author: string;
  text: string;
  url: string;
  timestamp: string;
  engagement_count: number;
}

/**
 * Parse approximate engagement counts from text like "1.2K", "45", "3M"
 */
function parseEngagementCount(text: string): number {
  if (!text) return 0;
  const cleaned = text.trim().replace(/,/g, '');
  const match = cleaned.match(/^([\d.]+)\s*([KkMm])?$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  return Math.round(num);
}

/**
 * Scrape tweets from the currently loaded page.
 */
function scrapeTweetsEval() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  const results: Array<{
    author: string;
    text: string;
    url: string;
    timestamp: string;
    likes_text: string;
    retweets_text: string;
  }> = [];

  for (const article of articles) {
    // Extract author handle
    const userLinks = article.querySelectorAll('a[role="link"][href^="/"]');
    let author = '';
    for (const link of userLinks) {
      const href = (link as HTMLAnchorElement).href;
      const match = href.match(/x\.com\/([^/]+)$/);
      if (match && !['home', 'explore', 'notifications', 'messages', 'i', 'settings'].includes(match[1])) {
        author = `@${match[1]}`;
        break;
      }
    }

    // Extract tweet text
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const text = tweetTextEl ? tweetTextEl.textContent || '' : '';

    // Extract tweet URL from timestamp link
    let url = '';
    const timeEl = article.querySelector('time');
    if (timeEl) {
      const timeLink = timeEl.closest('a');
      if (timeLink) url = (timeLink as HTMLAnchorElement).href;
    }

    // Extract timestamp
    let timestamp = '';
    if (timeEl) timestamp = timeEl.getAttribute('datetime') || '';

    // Extract engagement numbers
    const likeButton = article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="unlike"]');
    const likesText = likeButton?.getAttribute('aria-label') || '';
    const retweetButton = article.querySelector('[data-testid="retweet"]') || article.querySelector('[data-testid="unretweet"]');
    const retweetsText = retweetButton?.getAttribute('aria-label') || '';

    if (text || url) {
      results.push({
        author,
        text: text.trim(),
        url,
        timestamp,
        likes_text: likesText,
        retweets_text: retweetsText,
      });
    }
  }

  return results;
}

/**
 * Extract number from aria-label like "42 Likes" or "1234 Replies"
 */
function extractNumberFromLabel(label: string): number {
  const match = label.match(/^([\d,]+)/);
  if (!match) return 0;
  return parseInt(match[1].replace(/,/g, ''), 10) || 0;
}

async function feedScanner(input: FeedScannerInput): Promise<ScriptResult> {
  const accounts = input.accounts || [];
  const searches = input.searches || [];
  const maxPerSource = input.max_per_source || 10;

  if (accounts.length === 0 && searches.length === 0) {
    return { success: false, message: 'Provide at least one account or search term.' };
  }

  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    const allItems: FeedItem[] = [];
    const seenUrls = new Set<string>();

    // Check login once
    await page.goto('https://x.com/home', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
      }
    }

    // --- Scan accounts ---
    for (const account of accounts) {
      const cleanHandle = account.replace(/^@/, '');
      try {
        await page.goto(`https://x.com/${cleanHandle}`, {
          timeout: config.timeouts.navigation,
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(config.timeouts.pageLoad);

        // Wait for content
        await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

        // Scroll for more content
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1500);

        const rawTweets = await page.evaluate(scrapeTweetsEval);
        let count = 0;

        for (const tweet of rawTweets) {
          if (count >= maxPerSource) break;
          if (tweet.url && seenUrls.has(tweet.url)) continue;
          if (tweet.url) seenUrls.add(tweet.url);

          const likes = extractNumberFromLabel(tweet.likes_text);
          const retweets = extractNumberFromLabel(tweet.retweets_text);

          allItems.push({
            source: `@${cleanHandle}`,
            source_type: 'account',
            author: tweet.author,
            text: tweet.text,
            url: tweet.url,
            timestamp: tweet.timestamp,
            engagement_count: likes + retweets,
          });
          count++;
        }
      } catch (err) {
        // Continue on per-account failures
        allItems.push({
          source: `@${cleanHandle}`,
          source_type: 'account',
          author: '',
          text: `[Error scanning @${cleanHandle}: ${err instanceof Error ? err.message : String(err)}]`,
          url: '',
          timestamp: '',
          engagement_count: 0,
        });
      }
    }

    // --- Scan search terms ---
    for (const query of searches) {
      try {
        const encodedQuery = encodeURIComponent(query);
        await page.goto(`https://x.com/search?q=${encodedQuery}&src=typed_query&f=live`, {
          timeout: config.timeouts.navigation,
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(config.timeouts.pageLoad);

        // Wait for search results
        await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

        // Scroll for more
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1500);

        const rawTweets = await page.evaluate(scrapeTweetsEval);
        let count = 0;

        for (const tweet of rawTweets) {
          if (count >= maxPerSource) break;
          if (tweet.url && seenUrls.has(tweet.url)) continue;
          if (tweet.url) seenUrls.add(tweet.url);

          const likes = extractNumberFromLabel(tweet.likes_text);
          const retweets = extractNumberFromLabel(tweet.retweets_text);

          allItems.push({
            source: query,
            source_type: 'search',
            author: tweet.author,
            text: tweet.text,
            url: tweet.url,
            timestamp: tweet.timestamp,
            engagement_count: likes + retweets,
          });
          count++;
        }
      } catch (err) {
        allItems.push({
          source: query,
          source_type: 'search',
          author: '',
          text: `[Error searching "${query}": ${err instanceof Error ? err.message : String(err)}]`,
          url: '',
          timestamp: '',
          engagement_count: 0,
        });
      }
    }

    return {
      success: true,
      message: `Scanned ${accounts.length} account(s) and ${searches.length} search term(s). Found ${allItems.length} tweets.`,
      data: allItems,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<FeedScannerInput>(feedScanner);
