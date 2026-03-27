#!/usr/bin/env node
/**
 * reconstruct-logs.js
 * 
 * Synthesizes rich event logs (WebFetch, Bash, Session Boundaries)
 * entirely from cold ~/.claude/projects/ transcript files.
 * Provides complete Day-1 data parity for the UI.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

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

async function processTranscript(filePath) {
    const projectDir = path.basename(path.dirname(filePath));
    const sessionId = path.basename(filePath, '.jsonl');
    
    console.log(`Analyzing session: ${sessionId} (${projectDir})`);

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let firstTimestamp = null;
    let lastTimestamp = null;
    let eventCount = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        
        try {
            const entry = JSON.parse(line);
            
            // Track session boundaries
            if (entry.timestamp) {
                if (!firstTimestamp) firstTimestamp = entry.timestamp;
                lastTimestamp = entry.timestamp;
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
                        project: projectDir,
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
                                project: projectDir,
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

    // Synthesize the Session Boundary Milestone
    if (firstTimestamp && lastTimestamp && firstTimestamp !== lastTimestamp) {
        const durationMs = new Date(lastTimestamp) - new Date(firstTimestamp);
        const durationHours = (durationMs / (1000 * 60 * 60)).toFixed(1);
        if (durationHours > 0) {
            sendToQdrant({
                event_id: `session-bound-${sessionId}`,
                timestamp: lastTimestamp,
                project: projectDir,
                type: 'session_milestone',
                summary: `Session Concluded (Duration: ${durationHours} hours). ${eventCount} actions.`,
                transcript_path: filePath
            });
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
            await processTranscript(path.join(projPath, file));
        }
    }
    console.log("Reconstruction complete!");
}

run();
