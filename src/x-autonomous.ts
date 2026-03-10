/**
 * X Autonomous Daemon
 *
 * Runs a continuous background loop that surfaces interesting tweets
 * from the owner's trail and interest graph, then spawns a container
 * agent (as ssup) to decide whether to engage.
 *
 * The agent decides what to engage with — this daemon just surfaces
 * opportunities. The agent can choose to do NOTHING in a cycle.
 *
 * Toggled via X_AUTONOMOUS=true in .env.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// --- Constants ---

const PROJECT_ROOT = process.cwd();
const SKILL_DIR = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const DATA_DIR = path.join(SKILL_DIR, 'data');
const INTEREST_GRAPH_PATH = path.join(DATA_DIR, 'interest-graph.json');
const PERSONALITY_PATH = path.join(PROJECT_ROOT, 'personality.md');
const SEEN_TWEETS_PATH = path.join(DATA_DIR, 'seen-tweets.json');

/** Min interval between cycles in ms (5 minutes) */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Max interval between cycles in ms (20 minutes) */
const MAX_INTERVAL_MS = 20 * 60 * 1000;
/** Max age for seen tweets before cleanup (7 days) */
const SEEN_TWEETS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Script execution timeout (3 minutes) */
const SCRIPT_TIMEOUT_MS = 180_000;

// --- Types ---

interface SeenTweets {
  seen: Array<{ url: string; seen_at: string }>;
  last_cleanup: string | null;
}

interface InterestGraph {
  version: number;
  owner: { username: string; last_checked: string | null };
  topics: Array<{ name: string; weight: number; [k: string]: unknown }>;
  people: Array<{ handle: string; weight: number; [k: string]: unknown }>;
  stances: Array<{ topic: string; position: string; [k: string]: unknown }>;
  recent_vibes: string[];
  engagement_history: Array<{ url: string; type: string; timestamp: string }>;
  searches: string[];
  [k: string]: unknown;
}

interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface AutonomousDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
}

// --- Helpers ---

function randomInterval(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the main group (isMain=true) from registered groups.
 * Falls back to first available group if no main group exists
 * (e.g. web-chat-only setups without WhatsApp).
 * Returns [jid, group] or null if no groups at all.
 */
function findMainGroup(
  groups: Record<string, RegisteredGroup>,
): [string, RegisteredGroup] | null {
  // Prefer explicit main group
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain === true) return [jid, group];
  }
  // Fallback: use first available group (mark it as main for this run)
  const entries = Object.entries(groups);
  if (entries.length > 0) {
    const [jid, group] = entries[0];
    logger.info({ jid, name: group.name }, 'x-autonomous: no main group, using first available group');
    return [jid, { ...group, isMain: true }];
  }
  return null;
}

/**
 * Run a skill script as a subprocess (same pattern as host.ts).
 */
function runScript(scriptName: string, args: object): Promise<ScriptResult> {
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.ts`);

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NANOCLAW_ROOT: PROJECT_ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        message: `${scriptName} timed out (${SCRIPT_TIMEOUT_MS / 1000}s)`,
      });
    }, SCRIPT_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({
          success: false,
          message: `${scriptName} exited with code ${code}: ${stderr.slice(0, 300)}`,
        });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({
          success: false,
          message: `Failed to parse ${scriptName} output: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        message: `Failed to spawn ${scriptName}: ${err.message}`,
      });
    });
  });
}

// --- Seen Tweets ---

function loadSeenTweets(): SeenTweets {
  try {
    if (fs.existsSync(SEEN_TWEETS_PATH)) {
      return JSON.parse(fs.readFileSync(SEEN_TWEETS_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { seen: [], last_cleanup: null };
}

function saveSeenTweets(data: SeenTweets): void {
  try {
    fs.mkdirSync(path.dirname(SEEN_TWEETS_PATH), { recursive: true });
    fs.writeFileSync(SEEN_TWEETS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err }, 'x-autonomous: failed to save seen tweets');
  }
}

function cleanupSeenTweets(data: SeenTweets): SeenTweets {
  const cutoff = Date.now() - SEEN_TWEETS_MAX_AGE_MS;
  data.seen = data.seen.filter(
    (entry) => new Date(entry.seen_at).getTime() > cutoff,
  );
  data.last_cleanup = new Date().toISOString();
  return data;
}

function markTweetsSeen(urls: string[], data: SeenTweets): SeenTweets {
  const existingUrls = new Set(data.seen.map((e) => e.url));
  const now = new Date().toISOString();
  for (const url of urls) {
    if (url && !existingUrls.has(url)) {
      data.seen.push({ url, seen_at: now });
    }
  }
  return data;
}

function filterSeenTweets(
  items: Array<{ url?: string; [k: string]: unknown }>,
  seenUrls: Set<string>,
): Array<{ url?: string; [k: string]: unknown }> {
  return items.filter((item) => !item.url || !seenUrls.has(item.url));
}

// --- Interest Graph ---

function loadInterestGraph(): InterestGraph {
  try {
    if (fs.existsSync(INTEREST_GRAPH_PATH)) {
      return JSON.parse(fs.readFileSync(INTEREST_GRAPH_PATH, 'utf-8'));
    }
  } catch {
    // Fall through
  }
  return {
    version: 1,
    owner: { username: 'vimarsh', last_checked: null },
    topics: [],
    people: [],
    stances: [],
    recent_vibes: [],
    engagement_history: [],
    searches: [],
  };
}

// --- Personality ---

function loadPersonality(): string {
  try {
    if (fs.existsSync(PERSONALITY_PATH)) {
      return fs.readFileSync(PERSONALITY_PATH, 'utf-8');
    }
  } catch {
    // Fall through
  }
  return '(personality file not found)';
}

// --- Build Agent Prompt ---

function buildAgentPrompt(
  personality: string,
  interestGraph: InterestGraph,
  trailData: unknown[],
  feedData: unknown[],
): string {
  const sections: string[] = [];

  sections.push(`<personality>\n${personality}\n</personality>`);

  sections.push(
    `<interest_graph>\n${JSON.stringify(interestGraph, null, 2)}\n</interest_graph>`,
  );

  if (trailData.length > 0) {
    sections.push(
      `<owner_trail>\nRecent activity from @${interestGraph.owner.username} on X:\n${JSON.stringify(trailData, null, 2)}\n</owner_trail>`,
    );
  }

  if (feedData.length > 0) {
    sections.push(
      `<feed_opportunities>\nTweets from accounts and searches you follow:\n${JSON.stringify(feedData, null, 2)}\n</feed_opportunities>`,
    );
  }

  sections.push(`<instructions>
You are ssup. Here's what's happening on X right now.

Look through these tweets. If any genuinely interest you and you have something worth saying, use x_reply, x_like, or x_quote. If nothing catches your eye, that's fine — skip. Don't force engagement. Be selective.

Guidelines:
- Only engage if you'd actually want to say something. Quality over quantity.
- Match the vibe of the conversation. Don't be that account that drops generic replies.
- Likes are low-commitment — use them for stuff you genuinely appreciate but don't need to comment on.
- Quote tweets are for when you have a real take to add. Don't just paraphrase the original.
- Replies should add value — a different angle, a joke that lands, a genuine question.
- You can do nothing. An empty cycle is better than a forced one.
- Stay in character. You're ssup — chill, witty, lowercase, no corporate speak.
- NEVER engage with the same tweet twice.
- Max 280 characters for any tweet/reply/quote.

After you're done (or if you chose to skip), respond with a brief internal summary of what you did or why you skipped. Wrap it in <internal>...</internal> tags so it doesn't get sent anywhere.
</instructions>`);

  return sections.join('\n\n');
}

// --- Main Loop ---

let autonomousRunning = false;

export function startAutonomousLoop(deps: AutonomousDependencies): void {
  if (autonomousRunning) {
    logger.debug(
      'x-autonomous: loop already running, skipping duplicate start',
    );
    return;
  }
  autonomousRunning = true;
  logger.info('x-autonomous: autonomous X engagement loop started');

  const loop = async () => {
    while (true) {
      const intervalMs = randomInterval();
      const intervalMin = (intervalMs / 60000).toFixed(1);

      try {
        await runCycle(deps);
      } catch (err) {
        logger.error({ err }, 'x-autonomous: cycle crashed unexpectedly');
      }

      logger.info(
        { nextCycleMinutes: intervalMin },
        'x-autonomous: sleeping until next cycle',
      );
      await sleep(intervalMs);
    }
  };

  // Run asynchronously, don't block startup
  loop().catch((err) => {
    logger.error({ err }, 'x-autonomous: loop exited unexpectedly');
    autonomousRunning = false;
  });
}

async function runCycle(deps: AutonomousDependencies): Promise<void> {
  const cycleStart = Date.now();
  logger.info('x-autonomous: starting perception cycle');

  // Find the main group
  const groups = deps.registeredGroups();
  const mainGroupEntry = findMainGroup(groups);
  if (!mainGroupEntry) {
    logger.warn('x-autonomous: no main group found, skipping cycle');
    return;
  }
  const [mainJid, mainGroup] = mainGroupEntry;

  // Load fresh data each cycle
  const personality = loadPersonality();
  const interestGraph = loadInterestGraph();
  let seenTweets = loadSeenTweets();

  // Cleanup seen tweets periodically (once a day max)
  const lastCleanup = seenTweets.last_cleanup
    ? new Date(seenTweets.last_cleanup).getTime()
    : 0;
  if (Date.now() - lastCleanup > 24 * 60 * 60 * 1000) {
    seenTweets = cleanupSeenTweets(seenTweets);
    saveSeenTweets(seenTweets);
    logger.debug('x-autonomous: cleaned up old seen tweets');
  }

  const seenUrls = new Set(seenTweets.seen.map((e) => e.url));

  // --- Step 1: Run trail monitor ---
  logger.info('x-autonomous: running trail monitor');
  const trailResult = await runScript('trail-monitor', {
    username: interestGraph.owner.username,
    max_items: 30,
  });

  let trailData: unknown[] = [];
  if (trailResult.success) {
    trailData = (trailResult.data as unknown[]) || [];
    logger.info(
      { count: trailData.length },
      'x-autonomous: trail monitor complete',
    );
  } else {
    logger.warn(
      { message: trailResult.message },
      'x-autonomous: trail monitor failed',
    );
  }

  // --- Step 2: Run feed scanner ---
  const accounts = interestGraph.people.map((p) => p.handle);
  const searches = interestGraph.searches || interestGraph.topics.map((t) => t.name);

  let feedData: unknown[] = [];
  if (accounts.length > 0 || searches.length > 0) {
    logger.info(
      { accounts: accounts.length, searches: searches.length },
      'x-autonomous: running feed scanner',
    );
    const feedResult = await runScript('feed-scanner', {
      accounts,
      searches,
      max_per_source: 10,
    });

    if (feedResult.success) {
      feedData = (feedResult.data as unknown[]) || [];
      logger.info(
        { count: feedData.length },
        'x-autonomous: feed scanner complete',
      );
    } else {
      logger.warn(
        { message: feedResult.message },
        'x-autonomous: feed scanner failed',
      );
    }
  } else {
    logger.info('x-autonomous: no accounts or searches configured, skipping feed scan');
  }

  // --- Step 3: Filter out already-seen tweets ---
  const filteredFeed = filterSeenTweets(
    feedData as Array<{ url?: string }>,
    seenUrls,
  );
  const filteredTrail = filterSeenTweets(
    trailData as Array<{ url?: string }>,
    seenUrls,
  );

  const totalOpportunities = filteredFeed.length + filteredTrail.length;
  logger.info(
    {
      trail: filteredTrail.length,
      feed: filteredFeed.length,
      filtered_out: trailData.length + feedData.length - totalOpportunities,
    },
    'x-autonomous: perception data ready',
  );

  if (totalOpportunities === 0) {
    logger.info('x-autonomous: no new opportunities, skipping agent spawn');
    return;
  }

  // --- Step 4: Mark all surfaced tweets as seen ---
  const allUrls = [
    ...(filteredTrail as Array<{ url?: string }>).map((t) => t.url).filter(Boolean) as string[],
    ...(filteredFeed as Array<{ url?: string }>).map((t) => t.url).filter(Boolean) as string[],
  ];
  seenTweets = markTweetsSeen(allUrls, seenTweets);
  saveSeenTweets(seenTweets);

  // --- Step 5: Build prompt and spawn container agent ---
  const prompt = buildAgentPrompt(
    personality,
    interestGraph,
    filteredTrail,
    filteredFeed,
  );

  logger.info(
    { promptLength: prompt.length },
    'x-autonomous: spawning agent container',
  );

  // Update tasks snapshot (same pattern as task-scheduler)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    mainGroup.folder,
    true,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const sessions = deps.getSessions();
  const sessionId = sessions[mainGroup.folder];

  try {
    const output = await runContainerAgent(
      mainGroup,
      {
        prompt,
        sessionId,
        groupFolder: mainGroup.folder,
        chatJid: mainJid,
        isMain: true,
        isScheduledTask: true, // single-turn, no need for idle timeout
        assistantName: ASSISTANT_NAME,
      },
      (_proc, _containerName) => {
        // No queue registration needed — this is a fire-and-forget background task.
        // We don't pipe messages into it or track it in the GroupQueue.
        logger.debug(
          { containerName: _containerName },
          'x-autonomous: agent container started',
        );
      },
    );

    if (output.status === 'error') {
      logger.error(
        { error: output.error },
        'x-autonomous: agent container returned error',
      );
    } else {
      logger.info(
        { durationMs: Date.now() - cycleStart },
        'x-autonomous: agent cycle completed successfully',
      );
    }
  } catch (err) {
    logger.error({ err }, 'x-autonomous: agent container failed');
  }

  // --- Step 6: Optionally evolve the interest graph ---
  try {
    logger.debug('x-autonomous: updating interest graph');
    await runScript('update-graph', {
      trail: filteredTrail,
      feed: filteredFeed,
      engagements: [],
    });
  } catch (err) {
    logger.warn({ err }, 'x-autonomous: interest graph update failed (non-fatal)');
  }
}
