#!/usr/bin/env npx tsx
/**
 * X Integration - Evolve Personality
 *
 * Reads the interest graph and current personality.md, then suggests an updated
 * personality with refreshed interests, people, and recent context sections.
 *
 * IMPORTANT: This script SUGGESTS changes. The agent or owner approves them.
 *
 * Usage: npx tsx evolve-personality.ts
 * (No stdin required - reads from files directly)
 */

import fs from 'fs';
import path from 'path';

const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const GRAPH_PATH = path.join(NANOCLAW_ROOT, '.claude', 'skills', 'x-integration', 'data', 'interest-graph.json');
const PERSONALITY_PATH = path.join(NANOCLAW_ROOT, 'personality.md');

// --- Types ---

interface TopicEntry {
  name: string;
  weight: number;
  first_seen: string;
  last_seen: string;
  source: string;
}

interface PersonEntry {
  handle: string;
  weight: number;
  first_seen: string;
  last_seen: string;
  relationship: string;
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
  outcome?: { likes?: number; replies?: number; retweets?: number };
  performance: string;
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

function loadGraph(): InterestGraph | null {
  try {
    if (fs.existsSync(GRAPH_PATH)) {
      return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

function loadPersonality(): string {
  try {
    if (fs.existsSync(PERSONALITY_PATH)) {
      return fs.readFileSync(PERSONALITY_PATH, 'utf-8');
    }
  } catch {}
  return '';
}

/**
 * Split personality.md into core sections (immutable) and evolving sections (mutable).
 * Core sections: everything up to "## Current Interests" or "## Interests"
 * Evolving sections: Current Interests, People I Vibe With, Recent Context, Evolution Log
 */
function splitPersonality(md: string): { core: string; hasEvolvingSections: boolean } {
  // Find where evolving sections start
  const evolvingHeaders = [
    /^## Current Interests/m,
    /^## People I Vibe With/m,
    /^## Recent Context/m,
    /^## Evolution Log/m,
  ];

  let earliestIndex = md.length;

  for (const pattern of evolvingHeaders) {
    const match = md.match(pattern);
    if (match && match.index !== undefined && match.index < earliestIndex) {
      earliestIndex = match.index;
    }
  }

  // The original "## Interests" section is part of core, but we'll append our dynamic sections after everything else
  // We keep the ENTIRE original file as core (including ## Interests) and append new sections
  const hasEvolvingSections = earliestIndex < md.length;

  if (hasEvolvingSections) {
    // Remove existing evolving sections, keep core
    return { core: md.slice(0, earliestIndex).trimEnd(), hasEvolvingSections: true };
  }

  return { core: md.trimEnd(), hasEvolvingSections: false };
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function buildCurrentInterestsSection(topics: TopicEntry[]): string {
  if (topics.length === 0) return '';

  const top = topics
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15);

  const high = top.filter(t => t.weight >= 0.6);
  const medium = top.filter(t => t.weight >= 0.3 && t.weight < 0.6);
  const emerging = top.filter(t => t.weight < 0.3);

  let section = '## Current Interests\n\n';
  section += '*Auto-updated from interest graph. Core interests are in the Interests section above.*\n\n';

  if (high.length > 0) {
    section += '**Hot right now:**\n';
    section += high.map(t => `- ${t.name} (trending since ${formatDate(t.first_seen)})`).join('\n');
    section += '\n\n';
  }

  if (medium.length > 0) {
    section += '**On the radar:**\n';
    section += medium.map(t => `- ${t.name}`).join('\n');
    section += '\n\n';
  }

  if (emerging.length > 0) {
    section += '**Emerging:**\n';
    section += emerging.map(t => `- ${t.name}`).join('\n');
    section += '\n\n';
  }

  return section;
}

function buildPeopleSection(people: PersonEntry[]): string {
  if (people.length === 0) return '';

  const top = people
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15);

  const engaged = top.filter(p => p.relationship === 'engaged_with');
  const ownerFollows = top.filter(p => p.relationship === 'owner_follows');
  const others = top.filter(p => !['engaged_with', 'owner_follows'].includes(p.relationship));

  let section = '## People I Vibe With\n\n';
  section += '*People ssup has been interacting with or sees often in the feed.*\n\n';

  if (engaged.length > 0) {
    section += '**Active conversations:**\n';
    section += engaged.map(p => `- @${p.handle}`).join('\n');
    section += '\n\n';
  }

  if (ownerFollows.length > 0) {
    section += '**Owner\'s circle:**\n';
    section += ownerFollows.map(p => `- @${p.handle}`).join('\n');
    section += '\n\n';
  }

  if (others.length > 0) {
    section += '**In the orbit:**\n';
    section += others.map(p => `- @${p.handle}`).join('\n');
    section += '\n\n';
  }

  return section;
}

function buildRecentContextSection(graph: InterestGraph): string {
  let section = '## Recent Context\n\n';
  section += `*Last updated: ${formatDate(graph.last_updated)} (graph v${graph.version})*\n\n`;

  // Vibes
  if (graph.recent_vibes.length > 0) {
    section += `**Current vibes:** ${graph.recent_vibes.join(', ')}\n\n`;
  }

  // Stances
  const confidentStances = graph.stances
    .filter(s => s.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  if (confidentStances.length > 0) {
    section += '**Positions emerging from owner\'s activity:**\n';
    section += confidentStances.map(s =>
      `- ${s.topic}: ${s.position} (confidence: ${Math.round(s.confidence * 100)}%)`
    ).join('\n');
    section += '\n\n';
  }

  // Engagement performance summary
  const recent = graph.engagement_history.slice(-20);
  if (recent.length > 0) {
    const good = recent.filter(e => e.performance === 'good').length;
    const neutral = recent.filter(e => e.performance === 'neutral').length;
    const poor = recent.filter(e => e.performance === 'poor').length;
    section += `**Engagement track record (last ${recent.length}):** ${good} hits, ${neutral} ok, ${poor} misses\n\n`;

    // What's working
    const goodOnes = recent.filter(e => e.performance === 'good');
    if (goodOnes.length > 0) {
      section += '**What\'s landing:**\n';
      section += goodOnes.slice(-3).map(e =>
        `- ${e.type}${e.target_author ? ` to @${e.target_author}` : ''}: "${(e.content || '').slice(0, 60)}..."`
      ).join('\n');
      section += '\n\n';
    }
  }

  return section;
}

function buildEvolutionLogEntry(graph: InterestGraph): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const topTopics = graph.topics.slice(0, 5).map(t => t.name).join(', ');
  const vibes = graph.recent_vibes.join(', ') || 'neutral';

  return `- **${dateStr}** (v${graph.version}): topics=[${topTopics}], vibes=[${vibes}], ${graph.engagement_history.length} engagements tracked`;
}

// --- Main ---

async function main() {
  try {
    const graph = loadGraph();
    if (!graph) {
      console.log(JSON.stringify({
        success: false,
        message: 'No interest graph found. Run x_update_graph first to build one.',
      }));
      process.exit(0);
    }

    const currentPersonality = loadPersonality();
    if (!currentPersonality) {
      console.log(JSON.stringify({
        success: false,
        message: 'No personality.md found.',
      }));
      process.exit(0);
    }

    const { core } = splitPersonality(currentPersonality);

    // Build evolving sections
    const currentInterests = buildCurrentInterestsSection(graph.topics);
    const people = buildPeopleSection(graph.people);
    const recentContext = buildRecentContextSection(graph);
    const logEntry = buildEvolutionLogEntry(graph);

    // Extract existing evolution log entries if any
    const existingLogMatch = currentPersonality.match(/## Evolution Log\n\n([\s\S]*?)$/);
    let existingLogEntries = '';
    if (existingLogMatch) {
      // Keep last 20 entries
      const entries = existingLogMatch[1].trim().split('\n').filter(l => l.startsWith('- **'));
      existingLogEntries = entries.slice(-19).join('\n');
    }

    const evolutionLog = `## Evolution Log\n\n${existingLogEntries ? existingLogEntries + '\n' : ''}${logEntry}\n`;

    // Assemble the full personality
    const updatedPersonality = [
      core,
      '',
      currentInterests.trimEnd(),
      '',
      people.trimEnd(),
      '',
      recentContext.trimEnd(),
      '',
      evolutionLog,
    ].join('\n');

    console.log(JSON.stringify({
      success: true,
      message: `Personality evolution suggested: ${graph.topics.length} topics, ${graph.people.length} people, ${graph.recent_vibes.length} vibes integrated. Review and approve the changes.`,
      data: {
        personality: updatedPersonality,
      },
    }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      message: `Failed to evolve personality: ${err instanceof Error ? err.message : String(err)}`,
    }));
    process.exit(1);
  }
}

main();
