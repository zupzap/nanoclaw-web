#!/usr/bin/env npx tsx
/**
 * X Integration - Trail Monitor
 * Scrapes the owner's recent X activity (tweets, replies, RTs, QRTs, likes)
 * to understand their interests and engagement patterns.
 *
 * Usage: echo '{"username":"vimarsh_t"}' | npx tsx trail-monitor.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface TrailMonitorInput {
  username: string;
  max_items?: number;
}

interface ActivityItem {
  type: 'tweet' | 'reply' | 'retweet' | 'quote' | 'like';
  text: string;
  author: string;
  url: string;
  timestamp: string;
  /** For RTs/QRTs/likes: the original tweet's author */
  original_author?: string;
}

/**
 * Scrape tweet articles from the current page.
 * Reusable across tabs (posts, replies, likes).
 */
function buildScrapeEval(activityType: 'tweet' | 'reply' | 'retweet' | 'quote' | 'like', ownerHandle: string) {
  return (type: string, owner: string) => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const results: ActivityItem[] = [];

    for (const article of articles) {
      // Extract author handle(s) from user links
      const userLinks = article.querySelectorAll('a[role="link"][href^="/"]');
      const handles: string[] = [];
      for (const link of userLinks) {
        const href = (link as HTMLAnchorElement).href;
        const match = href.match(/x\.com\/([^/]+)$/);
        if (match && !['home', 'explore', 'notifications', 'messages', 'i', 'settings'].includes(match[1])) {
          if (!handles.includes(match[1])) handles.push(match[1]);
        }
      }

      const author = handles.length > 0 ? `@${handles[0]}` : '';

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

      // Detect retweet: social context with "reposted" text
      const socialContext = article.querySelector('[data-testid="socialContext"]');
      const isRetweet = socialContext?.textContent?.toLowerCase().includes('reposted') || false;

      // Determine type
      let itemType = type as ActivityItem['type'];
      if (isRetweet) {
        itemType = 'retweet';
      }

      const item: ActivityItem = {
        type: itemType,
        text: text.trim(),
        author,
        url,
        timestamp,
      };

      // For likes/retweets, the displayed author is the original author
      if ((itemType === 'like' || itemType === 'retweet') && author.toLowerCase() !== `@${owner.toLowerCase()}`) {
        item.original_author = author;
        item.author = `@${owner}`;
      }

      if (text || url) {
        results.push(item);
      }
    }

    return results;
  };
}

async function trailMonitor(input: TrailMonitorInput): Promise<ScriptResult> {
  const { username } = input;
  const maxItems = input.max_items || 30;

  if (!username) {
    return { success: false, message: 'Missing username' };
  }

  const cleanHandle = username.replace(/^@/, '');
  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    const allActivity: ActivityItem[] = [];

    // --- 1. Scrape Posts tab (tweets + RTs) ---
    await page.goto(`https://x.com/${cleanHandle}`, {
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

    // Check if profile exists
    const profileNotFound = await page.locator('div[data-testid="empty_state_header_text"]').isVisible().catch(() => false);
    if (profileNotFound) {
      return { success: false, message: `Profile @${cleanHandle} not found.` };
    }

    // Wait for tweets to load
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

    // Scroll down a couple times to get more content
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1500);
    }

    const posts = await page.evaluate(buildScrapeEval('tweet', cleanHandle), 'tweet', cleanHandle);
    allActivity.push(...posts);

    // --- 2. Scrape Replies tab ---
    await page.goto(`https://x.com/${cleanHandle}/with_replies`, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

    // Scroll for more replies
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);

    const replies = await page.evaluate(buildScrapeEval('reply', cleanHandle), 'reply', cleanHandle);
    // Mark actual replies (those that aren't just regular tweets showing up again)
    for (const r of replies) {
      if (r.type === 'tweet') r.type = 'reply';
    }
    allActivity.push(...replies);

    // --- 3. Scrape Likes tab ---
    await page.goto(`https://x.com/${cleanHandle}/likes`, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: config.timeouts.elementWait * 3 }).catch(() => {});

    // Scroll for more likes
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);

    const likes = await page.evaluate(buildScrapeEval('like', cleanHandle), 'like', cleanHandle);
    allActivity.push(...likes);

    // Deduplicate by URL
    const seen = new Set<string>();
    const deduped: ActivityItem[] = [];
    for (const item of allActivity) {
      const key = item.url || `${item.text.slice(0, 80)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }

    // Limit results
    const limited = deduped.slice(0, maxItems);

    return {
      success: true,
      message: `Scraped ${limited.length} activity items from @${cleanHandle} (${posts.length} posts, ${replies.length} replies, ${likes.length} likes).`,
      data: limited,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<TrailMonitorInput>(trailMonitor);
