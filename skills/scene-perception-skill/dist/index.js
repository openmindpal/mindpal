"use strict";
/**
 * Scene Perception Skill — Entry Point
 *
 * Universal vision perception for embodied agents.
 * Provides structured understanding of any visual scene
 * without task-specific logic — the Agent Loop decides what to do.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
exports.shutdown = shutdown;
const analyzer_1 = require("./analyzer");
// --- Singleton analyzer ---
let analyzer = null;
function getAnalyzer() {
    if (!analyzer) {
        analyzer = new analyzer_1.SceneAnalyzer();
    }
    return analyzer;
}
// --- Main execute ---
async function execute(request) {
    const { command, image, context, target, question } = request.input;
    if (!image) {
        return { ok: false, error: 'Missing required field: image (base64-encoded)' };
    }
    try {
        const a = getAnalyzer();
        switch (command) {
            case 'analyze': {
                const result = await a.analyze(image, context);
                return { ok: true, data: result };
            }
            case 'identify': {
                if (!target)
                    return { ok: false, error: 'Missing required field: target (object name to find)' };
                const result = await a.identify(image, target);
                return { ok: true, data: result };
            }
            case 'spatial': {
                if (!question)
                    return { ok: false, error: 'Missing required field: question (spatial query)' };
                const result = await a.querySpatial(image, question);
                return { ok: true, data: result };
            }
            case 'state': {
                if (!target)
                    return { ok: false, error: 'Missing required field: target (object to check state)' };
                const result = await a.queryState(image, target);
                return { ok: true, data: result };
            }
            case 'affordance': {
                if (!target)
                    return { ok: false, error: 'Missing required field: target (object to analyze affordances)' };
                const result = await a.queryAffordance(image, target);
                return { ok: true, data: result };
            }
            default:
                return { ok: false, error: `Unknown command: ${command}` };
        }
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/** Shutdown hook */
async function shutdown() {
    analyzer = null;
}
//# sourceMappingURL=index.js.map