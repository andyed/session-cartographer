#!/usr/bin/env node
/**
 * reconstruct-logs.js
 *
 * Synthesizes rich event logs (WebFetch, Bash, Session Boundaries)
 * entirely from cold ~/.claude/projects/ transcript files.
 * Provides complete Day-1 data parity for the UI.
 *
 * Feature flag: DEVTOOLS_PARSER=true
 *   When set, each session is also run through the devtools-adapted parser
 *   (src/lib/devtools-adapted/) which adds richer metadata to the session_milestone
 *   event: token attribution breakdown (6 categories), compaction phase data,
 *   and ongoing state. This data feeds activation scoring in future iterations.
 *
 *   Usage:
 *     DEVTOOLS_PARSER=true node scripts/reconstruct-history.js
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Feature flag — checked once at startup
const DEVTOOLS_PARSER = process.env.DEVTOOLS_PARSER === 'true' || process.env.DEVTOOLS_PARSER === '1';

// Lazily-resolved dynamic import — only loaded when DEVTOOLS_PARSER is active.
let _analyzeSession = null;
async function getAnalyzeSession() {
    if (!_analyzeSession) {
        const mod = await import('../src/lib/devtools-adapted/index.js');
        _analyzeSession = mod.analyzeSession;
    }
    return _analyzeSession;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = process.env.CARTOGRAPHER_TRANSCRIPTS_DIR || path.join(process.env.HOME, '.claude/projects');
const INDEX_SCRIPT = path.join(__dirname, 'index-event.sh');

if (!fs.existsSync(INDEX_SCRIPT)) {
    console.error(`Indexer not found: ${INDEX_SCRIPT}`);
    process.exit(1);
}

function sendToQdrant(payload) {
    try {
        const jsonStr = JSON.stringify(payload).replace(/'/g, "'\\''");
        execSync(`echo '${jsonStr}' | "${INDEX_SCRIPT}"`, { stdio: 'ignore' });
    } catch (e) {
        console.error("Failed to index event:", payload.event_id);
    }
}

// Derive project name from a cwd path — last component under ~/Documents/dev/
function projectFromCwd(cwd) {
    if (!cwd) return '';
    const devPrefix = path.join(process.env.HOME, 'Documents/dev/');
    if (!cwd.startsWith(devPrefix)) return '';
    const rel = cwd.slice(devPrefix.length);
    // Take first path component (the repo directory)
    return rel.split('/')[0] || '';
}

async function processTranscript(filePath) {
    const projectDir = path.basename(path.dirname(filePath));
    const sessionId = path.basename(filePath, '.jsonl');

    console.log(`Analyzing session: ${sessionId} (${projectDir})`);

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let firstTimestamp = null;
    let lastTimestamp = null;
    let eventCount = 0;
    const cwdCounts = new Map(); // track cwd-derived projects

    for await (const line of rl) {
        if (!line.trim()) continue;

        try {
            const entry = JSON.parse(line);

            // Track session boundaries
            if (entry.timestamp) {
                if (!firstTimestamp) firstTimestamp = entry.timestamp;
                lastTimestamp = entry.timestamp;
            }

            // Track cwd for project resolution
            if (entry.cwd) {
                const p = projectFromCwd(entry.cwd);
                if (p) cwdCounts.set(p, (cwdCounts.get(p) || 0) + 1);
            }

            // General Transcript text
            if ((entry.type === 'user' || entry.type === 'assistant') && entry.message?.content) {
                let textContent = '';
                if (typeof entry.message.content === 'string') {
                    textContent = entry.message.content;
                } else if (Array.isArray(entry.message.content)) {
                    const textNode = entry.message.content.find(c => c.type === 'text');
                    if (textNode) textContent = textNode.text;
                }

                if (textContent && textContent.length > 5) {
                    sendToQdrant({
                        event_id: `hist-${sessionId}-${entry.timestamp || Date.now()}`,
                        timestamp: entry.timestamp,
                        project: projectFromCwd(entry.cwd) || projectDir,
                        cwd: entry.cwd || '',
                        type: 'transcript',
                        summary: textContent,
                        transcript_path: filePath
                    });
                }
            }

            // Synthesize Tool and Research events
            if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
                for (const block of entry.message.content) {
                    if (block.type === 'tool_use') {
                        const toolName = block.name;
                        const input = block.input || {};
                        
                        let eventType = null;
                        let summary = '';
                        let url = '';

                        // Recreate Research Logs
                        if (toolName === 'WebSearch') {
                            eventType = 'research';
                            summary = `Search: ${input.query || ''}`;
                        } else if (toolName === 'WebFetch') {
                            eventType = 'research';
                            summary = `Fetched: ${input.url || ''}`;
                            url = input.url || '';
                        } 
                        // Recreate Tool Use Logs
                        else if (toolName === 'Bash') {
                            eventType = 'tool_use';
                            summary = `Bash: ${input.command || ''}`.substring(0, 300);
                        } else if (['View', 'Edit', 'Write', 'Replace', 'StrReplace'].includes(toolName)) {
                            eventType = 'tool_use';
                            summary = `${toolName}: ${input.file_path || input.path || 'file'}`;
                        }

                        if (eventType) {
                            sendToQdrant({
                                event_id: `synth-${block.id || Date.now()}`,
                                timestamp: entry.timestamp,
                                project: projectFromCwd(entry.cwd) || projectDir,
                                cwd: entry.cwd || '',
                                type: eventType,
                                summary: summary,
                                url: url,
                                transcript_path: filePath
                            });
                            eventCount++;
                        }
                    }
                }
            }

        } catch (e) {
            // Ignore badly formatted JSONL rows
        }
    }

    // Resolve session project from cwd frequency, fall back to transcript dir
    const resolvedProject = cwdCounts.size > 0
        ? [...cwdCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : projectDir;

    // Synthesize the Session Boundary Milestone
    if (firstTimestamp && lastTimestamp && firstTimestamp !== lastTimestamp) {
        const durationMs = new Date(lastTimestamp) - new Date(firstTimestamp);
        const durationHours = (durationMs / (1000 * 60 * 60)).toFixed(1);
        if (durationHours > 0) {
            const milestonePayload = {
                event_id: `session-bound-${sessionId}`,
                timestamp: lastTimestamp,
                project: resolvedProject,
                type: 'session_milestone',
                summary: `Session Concluded (Duration: ${durationHours} hours). ${eventCount} actions.`,
                transcript_path: filePath
            };

            // DEVTOOLS_PARSER=true: enrich with attribution + compaction data
            if (DEVTOOLS_PARSER) {
                try {
                    const analyzeSession = await getAnalyzeSession();
                    const enriched = await analyzeSession(filePath);

                    // Token attribution (6 categories, char/4 estimates)
                    milestonePayload.attribution = enriched.attribution;

                    // Compaction: how many context resets, total context work done
                    milestonePayload.compaction_count = enriched.compaction.compactionCount;
                    milestonePayload.context_consumption = enriched.compaction.contextConsumption;
                    milestonePayload.compaction_phases = enriched.compaction.phases.length;

                    // Session state
                    milestonePayload.is_ongoing = enriched.isOngoing;
                    milestonePayload.total_tokens = enriched.metrics.totalTokens;
                    milestonePayload.output_tokens = enriched.metrics.outputTokens;
                    milestonePayload.message_count = enriched.metrics.messageCount;

                    console.log(`  [devtools] attribution: toolOutputs=${enriched.attribution.toolOutputs} thinkingText=${enriched.attribution.thinkingText} compactions=${enriched.compaction.compactionCount}`);
                } catch (e) {
                    // Non-fatal: degraded to basic milestone without enrichment
                    console.warn(`  [devtools] enrichment failed for ${sessionId}:`, e.message);
                }
            }

            sendToQdrant(milestonePayload);
        }
    }
}

async function run() {
    console.log("Starting exhaustive historical reconstruction...");
    if (!fs.existsSync(TRANSCRIPTS_DIR)) {
        console.error(`Transcripts dir not found: ${TRANSCRIPTS_DIR}`);
        return;
    }

    const projects = fs.readdirSync(TRANSCRIPTS_DIR);
    for (const proj of projects) {
        const projPath = path.join(TRANSCRIPTS_DIR, proj);
        if (!fs.statSync(projPath).isDirectory()) continue;

        const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            try {
                await processTranscript(path.join(projPath, file));
            } catch (err) {
                if (err.code === 'ENOENT') {
                    console.warn(`Skipping missing file: ${file}`);
                } else {
                    console.error(`Error processing ${file}: ${err.message}`);
                }
            }
        }
    }
    console.log("Reconstruction complete!");
}

run();
