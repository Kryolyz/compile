/**
 * Headless game harness - shared between smoke tests and AI-vs-AI simulation.
 *
 * Provides:
 *  - localStorage shim + protocol seeding (real protocol JSONs from disk)
 *  - dispatcher/phaseManager wiring identical to useGameState
 *  - swapPerspective(): mirrors a GameState so the SAME aiManager machinery
 *    (which always drives 'opponent') can play BOTH sides of a game
 */

import * as fs from 'fs';
import * as path from 'path';
import { GameState, Player } from '../../types';

// ---------------------------------------------------------------------------
// localStorage shim + protocol seeding
// ---------------------------------------------------------------------------

export function installLocalStorageShim(): void {
    if ((globalThis as any).localStorage) return;
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

export function seedProtocols(names: string[]): void {
    const protocols = names.map(name => {
        const file = path.join('custom_protocols', `${name.toLowerCase()}_custom_protocol.json`);
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    });
    localStorage.setItem('custom_protocols_v1', JSON.stringify({ protocols, version: 1 }));
}

/** All protocols shipped in custom_protocols/ (by file name). */
export function allProtocolNames(): string[] {
    return fs.readdirSync('custom_protocols')
        .filter(f => f.endsWith('_custom_protocol.json'))
        .map(f => f.replace('_custom_protocol.json', ''));
}

// ---------------------------------------------------------------------------
// Dispatcher + phaseManager wiring (mirrors useGameState)
// ---------------------------------------------------------------------------

export const NOOP_END_GAME = (_w: Player, _s: GameState): void => {};
export const NOOP_ENQUEUE = (_item: any): void => {};

export async function loadGameModules() {
    // Dynamic imports AFTER the localStorage shim is installed (modules cache cards lazily)
    const aiManager = await import('../../logic/game/aiManager');
    const resolvers = await import('../../logic/game/resolvers');
    const phaseManager = await import('../../logic/game/phaseManager');
    const stateManager = await import('../../logic/game/stateManager');
    return { aiManager, resolvers, phaseManager, stateManager };
}

export function buildDispatchers(resolvers: any) {
    return {
        compileLane: (s: GameState, l: number) => resolvers.performCompile(s, l, NOOP_END_GAME),
        playCard: resolvers.playCard,
        fillHand: resolvers.performFillHand,
        discardCards: resolvers.discardCards,
        flipCard: resolvers.flipCard,
        deleteCard: (s: GameState, c: string) => ({
            newState: s,
            animationRequests: [{ type: 'delete', cardId: c, owner: 'opponent' as Player }],
        }),
        returnCard: resolvers.returnCard,
        skipAction: resolvers.skipAction,
        resolveOptionalDrawPrompt: resolvers.resolveOptionalDrawPrompt,
        resolveOptionalDiscardCustomPrompt: resolvers.resolveOptionalDiscardCustomPrompt,
        resolveOptionalEffectPrompt: resolvers.resolveOptionalEffectPrompt,
        resolveVariableDiscard: resolvers.resolveVariableDiscard,
        resolveRearrangeProtocols: (s: GameState, o: string[]) => resolvers.resolveRearrangeProtocols(s, o, NOOP_END_GAME),
        resolveActionWithHandCard: resolvers.resolveActionWithHandCard,
        resolveSwapProtocols: (s: GameState, o: [number, number]) => resolvers.resolveSwapProtocols(s, o, NOOP_END_GAME),
        revealOpponentHand: resolvers.revealOpponentHand,
        resolveCustomChoice: resolvers.resolveCustomChoice,
    };
}

export function buildPhaseManager(phaseManager: any) {
    return {
        processEndOfAction: phaseManager.processEndOfAction,
        processStartOfTurn: phaseManager.processStartOfTurn,
        continueTurnAfterStartPhaseAction: phaseManager.continueTurnAfterStartPhaseAction,
        continueTurnProgression: phaseManager.continueTurnProgression,
    };
}

// ---------------------------------------------------------------------------
// Perspective swap
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of the state with the 'player' and 'opponent' roles
 * swapped EVERYWHERE: top-level slices, turn, actor fields, interrupt flags,
 * queued action contexts, etc.
 *
 * This lets the aiManager (hard-wired to act as 'opponent') drive both sides:
 * to make the 'player' side move, swap, run the AI, swap back.
 */
export function swapPerspective(state: GameState): GameState {
    return swapValue(state) as GameState;
}

function swapValue(value: any): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (value === 'player') return 'opponent';
        if (value === 'opponent') return 'player';
        return value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(swapValue);

    const result: any = {};
    for (const key of Object.keys(value)) {
        const newKey = key === 'player' ? 'opponent' : key === 'opponent' ? 'player' : key;
        result[newKey] = swapValue(value[key]);
    }
    return result;
}

/** Swap the words "Player"/"Opponent" inside a log message (after a swapped phase). */
export function swapLogMessage(message: string): string {
    return message
        .replace(/\bPlayer\b/g, '§TMP§')
        .replace(/\bOpponent\b/g, 'Player')
        .replace(/§TMP§/g, 'Opponent');
}
