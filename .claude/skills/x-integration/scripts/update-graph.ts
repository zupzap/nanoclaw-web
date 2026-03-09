#!/usr/bin/env npx tsx
/**
 * X Integration - Update Interest Graph
 *
 * Takes observation data from trail monitoring, feed scanning, and past engagements,
 * then updates the interest graph used to guide ssup's personality evolution.
 *
 * Usage: echo '{"trail":[...],"feed":[...],"engagements":[...]}' | npx tsx update-graph.ts
 */

import fs from 'fs';
import path from 'path';

const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const GRAPH_PATH = path.join(NANOCLAW_ROOT, '.claude', 'skills', 'x-integration', 'data', 'interest-graph.json');

// --- Types ---

interface TrailItem {
  type: 'tweet' | 'like' | 'retweet' | 'quote';
  content?: string;
  author?: string;
  url?: string;
  timestamp?: string;
  topics?: string[];
}

interface FeedItem {
  content: string;
  author: string;
  url?: string;
  timestamp?: string;
  topics?: string[];
}

interface EngagementItem {
  type: 'reply' | 'like' | 'retweet' | 'quote' | 'post';
  content?: string;
  target_url?: string;
  target_author?: string;
  timestamp?: string;
  outcome?: {
    likes?: number;
    replies?: number;
    retweets?: number;
  };
}

interface UpdateInput {
  trail: TrailItem[];
  feed: FeedItem[];
  engagements: EngagementItem[];
}

interface TopicEntry {
  name: string;
  weight: number;
  first_seen: string;
  last_seen: string;
  source: 'trail' | 'feed' | 'engagement';
}

interface PersonEntry {
  handle: string;
  weight: number;
  first_seen: string;
  last_seen: string;
  relationship: 'owner_follows' | 'interacted' | 'mentioned' | 'engaged_with';
}

interface StanceEntry {
  topic: string;
  position: string;
  confidence: number;
  last_updated: string;
  evidence: string[];
}

interface EngagementRecord {
  type: string;
  content?: string;
  target_author?: string;
  timestamp: string;
  outcome?: EngagementItem['outcome'];
  performance: 'good' | 'neutral' | 'poor';
}

interface InterestGraph {
  version: number;
  last_updated: string;
  topics: TopicEntry[];
  people: PersonEntry[];
  stances: StanceEntry[];
  recent_vibes: string[];
  engagement_history: EngagementRecord[];
}

// --- Helpers ---

function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

function loadGraph(): InterestGraph {
  try {
    if (fs.existsSync(GRAPH_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
      // Normalize: ensure all fields exist and version is a number
      return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        last_updated: raw.last_updated || new Date().toISOString(),
        topics: Array.isArray(raw.topics) ? raw.topics : [],
        people: Array.isArray(raw.people) ? raw.people : [],
        stances: Array.isArray(raw.stances) ? raw.stances : [],
        recent_vibes: Array.isArray(raw.recent_vibes) ? raw.recent_vibes : [],
        engagement_history: Array.isArray(raw.engagement_history) ? raw.engagement_history : [],
      };
    }
  } catch {
    // Corrupted file, start fresh
  }
  return {
    version: 0,
    last_updated: new Date().toISOString(),
    topics: [],
    people: [],
    stances: [],
    recent_vibes: [],
    engagement_history: [],
  };
}

function saveGraph(graph: InterestGraph): void {
  fs.mkdirSync(path.dirname(GRAPH_PATH), { recursive: true });
  const tmp = `${GRAPH_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2));
  fs.renameSync(tmp, GRAPH_PATH);
}

function extractTopicsFromContent(content: string): string[] {
  const topics: string[] = [];
  const lower = content.toLowerCase();

  // Extract hashtags
  const hashtags = content.match(/#(\w+)/g);
  if (hashtags) {
    topics.push(...hashtags.map(h => h.slice(1).toLowerCase()));
  }

  // Extract common tech/AI keywords
  const keywords = [
    'ai', 'agents', 'llm', 'gpt', 'claude', 'openai', 'anthropic',
    'p2p', 'decentralized', 'blockchain', 'web3', 'crypto',
    'open source', 'containers', 'docker', 'kubernetes',
    'rust', 'typescript', 'python', 'javascript',
    'mcp', 'tool use', 'function calling',
    'shipping', 'building', 'deploying',
    'startup', 'vc', 'founder',
    'infrastructure', 'devops', 'ci/cd',
    'machine learning', 'deep learning', 'neural',
    'api', 'sdk', 'framework',
    'agentic', 'autonomous', 'multi-agent',
  ];

  for (const kw of keywords) {
    if (lower.includes(kw) && !topics.includes(kw)) {
      topics.push(kw);
    }
  }

  return topics;
}

function detectVibe(content: string): string | null {
  const lower = content.toLowerCase();

  if (/ship|launch|deploy|release|built|made|created/.test(lower)) return 'shipping';
  if (/frustrat|annoying|broken|bug|wtf|ugh/.test(lower)) return 'frustrated';
  if (/excit|amazing|incredible|wow|wild/.test(lower)) return 'excited';
  if (/learn|discover|found|realized|til/.test(lower)) return 'learning';
  if (/joke|lol|lmao|haha|rofl/.test(lower)) return 'playful';
  if (/think|wonder|consider|question/.test(lower)) return 'reflective';
  if (/hot take|unpopular|controversial|actually/.test(lower)) return 'spicy';

  return null;
}

function assessPerformance(outcome?: EngagementItem['outcome']): 'good' | 'neutral' | 'poor' {
  if (!outcome) return 'neutral';
  const total = (outcome.likes || 0) + (outcome.replies || 0) * 2 + (outcome.retweets || 0) * 3;
  if (total >= 10) return 'good';
  if (total >= 2) return 'neutral';
  return 'poor';
}

function isStale(dateStr: string, days: number): boolean {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return diffMs > days * 24 * 60 * 60 * 1000;
}

// --- Main Update Logic ---

function updateGraph(graph: InterestGraph, input: UpdateInput): InterestGraph {
  const now = new Date().toISOString();

  // --- Process trail (owner's activity) ---
  for (const item of input.trail || []) {
    const ts = item.timestamp || now;

    // Extract topics
    const contentTopics = item.content ? extractTopicsFromContent(item.content) : [];
    const allTopics = [...contentTopics, ...(item.topics || [])];

    for (const topicName of allTopics) {
      const existing = graph.topics.find(t => t.name === topicName);
      if (existing) {
        existing.weight = Math.min(existing.weight + 0.2, 1.0);
        existing.last_seen = ts;
      } else {
        graph.topics.push({
          name: topicName,
          weight: 0.5,
          first_seen: ts,
          last_seen: ts,
          source: 'trail',
        });
      }
    }

    // Track people the owner interacts with
    if (item.author && item.type !== 'tweet') {
      const existing = graph.people.find(p => p.handle === item.author);
      if (existing) {
        existing.weight = Math.min(existing.weight + 0.15, 1.0);
        existing.last_seen = ts;
      } else {
        graph.people.push({
          handle: item.author,
          weight: 0.4,
          first_seen: ts,
          last_seen: ts,
          relationship: 'owner_follows',
        });
      }
    }

    // Update stances based on RTs and QRTs (owner agrees with this content)
    if ((item.type === 'retweet' || item.type === 'quote') && item.content) {
      for (const topic of allTopics) {
        const existing = graph.stances.find(s => s.topic === topic);
        if (existing) {
          existing.evidence.push(`Owner ${item.type}d: "${(item.content || '').slice(0, 80)}"`);
          if (existing.evidence.length > 10) {
            existing.evidence = existing.evidence.slice(-10);
          }
          existing.confidence = Math.min(existing.confidence + 0.1, 1.0);
          existing.last_updated = ts;
        } else {
          graph.stances.push({
            topic,
            position: 'aligned',
            confidence: 0.3,
            last_updated: ts,
            evidence: [`Owner ${item.type}d: "${(item.content || '').slice(0, 80)}"`],
          });
        }
      }
    }

    // Detect vibes
    if (item.content) {
      const vibe = detectVibe(item.content);
      if (vibe && !graph.recent_vibes.includes(vibe)) {
        graph.recent_vibes.push(vibe);
      }
    }
  }

  // --- Process feed (tweets ssup has seen) ---
  for (const item of input.feed || []) {
    const ts = item.timestamp || now;
    const contentTopics = extractTopicsFromContent(item.content);
    const allTopics = [...contentTopics, ...(item.topics || [])];

    for (const topicName of allTopics) {
      const existing = graph.topics.find(t => t.name === topicName);
      if (existing) {
        existing.weight = Math.min(existing.weight + 0.05, 1.0);
        existing.last_seen = ts;
      } else {
        graph.topics.push({
          name: topicName,
          weight: 0.2,
          first_seen: ts,
          last_seen: ts,
          source: 'feed',
        });
      }
    }

    // Track people from the feed
    if (item.author) {
      const existing = graph.people.find(p => p.handle === item.author);
      if (existing) {
        existing.weight = Math.min(existing.weight + 0.05, 1.0);
        existing.last_seen = ts;
      } else {
        graph.people.push({
          handle: item.author,
          weight: 0.15,
          first_seen: ts,
          last_seen: ts,
          relationship: 'mentioned',
        });
      }
    }
  }

  // --- Process engagements (ssup's own activity and outcomes) ---
  for (const item of input.engagements || []) {
    const ts = item.timestamp || now;
    const performance = assessPerformance(item.outcome);

    graph.engagement_history.push({
      type: item.type,
      content: item.content?.slice(0, 200),
      target_author: item.target_author,
      timestamp: ts,
      outcome: item.outcome,
      performance,
    });

    // Track people ssup has engaged with
    if (item.target_author) {
      const existing = graph.people.find(p => p.handle === item.target_author);
      if (existing) {
        existing.weight = Math.min(existing.weight + 0.2, 1.0);
        existing.last_seen = ts;
        existing.relationship = 'engaged_with';
      } else {
        graph.people.push({
          handle: item.target_author,
          weight: 0.3,
          first_seen: ts,
          last_seen: ts,
          relationship: 'engaged_with',
        });
      }
    }

    // Boost topics from successful engagements
    if (performance === 'good' && item.content) {
      const topics = extractTopicsFromContent(item.content);
      for (const topicName of topics) {
        const existing = graph.topics.find(t => t.name === topicName);
        if (existing) {
          existing.weight = Math.min(existing.weight + 0.3, 1.0);
          existing.last_seen = ts;
          existing.source = 'engagement';
        }
      }
    }
  }

  // --- Prune stale entries ---

  // Decay weights for old topics (>7 days)
  graph.topics = graph.topics
    .map(t => {
      if (isStale(t.last_seen, 7)) {
        t.weight = Math.max(t.weight - 0.15, 0);
      }
      return t;
    })
    .filter(t => t.weight > 0.05)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50); // Keep top 50

  // Decay weights for old people (>7 days)
  graph.people = graph.people
    .map(p => {
      if (isStale(p.last_seen, 7)) {
        p.weight = Math.max(p.weight - 0.1, 0);
      }
      return p;
    })
    .filter(p => p.weight > 0.05)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50); // Keep top 50

  // Prune stale stances
  graph.stances = graph.stances
    .filter(s => !isStale(s.last_updated, 30)) // Stances last longer
    .slice(0, 30);

  // Keep only recent vibes (last 10)
  graph.recent_vibes = graph.recent_vibes.slice(-10);

  // Keep only recent engagement history (last 100)
  graph.engagement_history = graph.engagement_history.slice(-100);

  // Update metadata
  graph.last_updated = now;
  graph.version += 1;

  return graph;
}

// --- Entry Point ---

async function main() {
  try {
    const input = await readInput<UpdateInput>();
    const graph = loadGraph();
    const updated = updateGraph(graph, input);
    saveGraph(updated);

    console.log(JSON.stringify({
      success: true,
      message: `Interest graph updated (v${updated.version}): ${updated.topics.length} topics, ${updated.people.length} people, ${updated.engagement_history.length} engagements tracked`,
      data: updated,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      message: `Failed to update interest graph: ${err instanceof Error ? err.message : String(err)}`,
    }));
    process.exit(1);
  }
}

main();
