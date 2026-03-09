#!/usr/bin/env npx tsx
/**
 * X Integration - Engagement Loop
 * Main autonomous perception loop. Combines trail monitoring and feed scanning
 * to produce a set of engagement opportunities for the Claude agent.
 *
 * Does NOT make engagement decisions — just gathers and returns data.
 *
 * Usage: echo '{}' | npx tsx engagement-loop.ts
 * Usage: echo '{"accounts":["aakxssh"],"searches":["AI agents"]}' | npx tsx engagement-loop.ts
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readInput, writeResult, ScriptResult } from '../lib/browser.js';

interface EngagementLoopInput {
  /** Override accounts to scan (defaults to interest-graph people) */
  accounts?: string[];
  /** Override search terms (defaults to interest-graph topics) */
  searches?: string[];
  /** Max items per source in feed scanner */
  max_per_source?: number;
}

interface InterestGraph {
  owner: { username: string; last_checked: string | null };
  topics: string[];
  people: string[];
  stances: string[];
  recent_vibes: string[];
  avoid: string[];
  engagement_history: Array<{ url: string; type: string; timestamp: string }>;
  last_updated: string | null;
}

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const INTEREST_GRAPH_PATH = path.join(SCRIPT_DIR, '..', 'data', 'interest-graph.json');

/**
 * Load the interest graph, returning defaults if file is missing or corrupt.
 */
function loadInterestGraph(): InterestGraph {
  try {
    if (fs.existsSync(INTEREST_GRAPH_PATH)) {
      return JSON.parse(fs.readFileSync(INTEREST_GRAPH_PATH, 'utf-8'));
    }
  } catch {
    // Fall through to defaults
  }
  return {
    owner: { username: 'vimarsh_t', last_checked: null },
    topics: [],
    people: [],
    stances: [],
    recent_vibes: [],
    avoid: [],
    engagement_history: [],
    last_updated: null,
  };
}

/**
 * Run a sibling script and capture its JSON output.
 */
async function runSiblingScript(scriptName: string, args: object): Promise<ScriptResult> {
  const scriptPath = path.join(SCRIPT_DIR, `${scriptName}.ts`);

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: `${scriptName} timed out (180s)` });
    }, 180000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({ success: false, message: `${scriptName} exited with code ${code}: ${stderr.slice(0, 300)}` });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({ success: false, message: `Failed to parse ${scriptName} output: ${stdout.slice(0, 200)}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn ${scriptName}: ${err.message}` });
    });
  });
}

async function engagementLoop(input: EngagementLoopInput): Promise<ScriptResult> {
  const graph = loadInterestGraph();
  const ownerUsername = graph.owner.username;

  // --- 1. Run trail monitor on owner ---
  const trailResult = await runSiblingScript('trail-monitor', {
    username: ownerUsername,
    max_items: 30,
  });

  const trailData = trailResult.success ? (trailResult.data as unknown[]) : [];

  // --- 2. Run feed scanner ---
  const accounts = input.accounts || graph.people || [];
  const searches = input.searches || graph.topics || [];
  const maxPerSource = input.max_per_source || 10;

  let feedData: unknown[] = [];
  let feedMessage = 'Skipped feed scan (no accounts or searches configured).';

  if (accounts.length > 0 || searches.length > 0) {
    const feedResult = await runSiblingScript('feed-scanner', {
      accounts,
      searches,
      max_per_source: maxPerSource,
    });

    if (feedResult.success) {
      feedData = feedResult.data as unknown[];
      feedMessage = feedResult.message;
    } else {
      feedMessage = `Feed scan failed: ${feedResult.message}`;
    }
  }

  // --- 3. Filter out already-engaged tweets ---
  const engagedUrls = new Set(graph.engagement_history.map(e => e.url));
  const filteredFeed = (feedData as Array<{ url?: string }>).filter(item => {
    if (!item.url) return true;
    return !engagedUrls.has(item.url);
  });

  // --- 4. Update last_checked timestamp ---
  graph.owner.last_checked = new Date().toISOString();
  graph.last_updated = new Date().toISOString();
  try {
    fs.writeFileSync(INTEREST_GRAPH_PATH, JSON.stringify(graph, null, 2));
  } catch {
    // Non-fatal — graph update failure shouldn't block the result
  }

  const trailCount = Array.isArray(trailData) ? trailData.length : 0;
  const feedCount = filteredFeed.length;

  return {
    success: true,
    message: `Perception loop complete. Trail: ${trailCount} items from @${ownerUsername}. Feed: ${feedCount} opportunities (${feedMessage}).`,
    data: {
      trail: trailData,
      feed: filteredFeed,
      graph: {
        owner: graph.owner,
        topics: graph.topics,
        people: graph.people,
        stances: graph.stances,
        recent_vibes: graph.recent_vibes,
        avoid: graph.avoid,
      },
    },
  };
}

// Use readInput/writeResult directly since we spawn child scripts
// (runScript would try to launch browser which we don't need here)
(async () => {
  try {
    const input = await readInput<EngagementLoopInput>();
    const result = await engagementLoop(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Engagement loop failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
})();
