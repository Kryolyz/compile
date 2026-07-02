/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headless CLI for running AI vs AI games
 * 
 * Usage (from project root):
 *   npx tsx src/cli/runHeadlessGame.ts hard normal 10
 *   npx tsx src/cli/runHeadlessGame.ts --ai1=hard --ai2=normal --games=10
 */

import * as path from 'path';
import * as fs from 'fs';
import { GameState, Difficulty, Player } from '../types';
import { 
    installLocalStorageShim, 
    seedProtocols, 
    allProtocolNames,
    loadGameModules, 
    buildDispatchers, 
    buildPhaseManager,
    swapPerspective, 
    swapLogMessage, 
    NOOP_ENQUEUE 
} from '../../tests/helpers/headlessGame';

// =============================================================================
// Types
// =============================================================================

export interface GameConfig {
    ai1: Difficulty;           // Player 1 (opponent slot, takes first turn)
    ai2: Difficulty;           // Player 2 (player slot)
    ai1Protocols: string[];   // Protocols for AI1
    ai2Protocols: string[];   // Protocols for AI2
    maxTurns?: number;         // Max turns per game (default: 500)
    seed?: number;             // RNG seed (TODO: implement)
    verbose?: boolean;         // Log each turn
    outputFile?: string;       // Save log to file
}

export interface GameResult {
    winner: 'ai1' | 'ai2' | 'draw' | 'timeout';
    turns: number;
    ai1Compiled: number;
    ai2Compiled: number;
    log: string[];
}

// =============================================================================
// Main Game Runner
// =============================================================================

/**
 * Run a single headless game
 */
export function runHeadlessGame(config: GameConfig): GameResult {
    const {
        ai1,
        ai2,
        ai1Protocols,
        ai2Protocols,
        maxTurns = 500,
        verbose = false,
        outputFile,
    } = config;

    // Install localStorage shim (required for Node.js)
    installLocalStorageShim();
    seedProtocols(allProtocolNames());

    const log: string[] = [];
    const logLine = (line: string) => {
        log.push(line);
        if (verbose) console.log(line);
    };

    // Load game modules
    const { aiManager, resolvers, phaseManager, stateManager } = loadGameModules() as any;
    const dispatchers = buildDispatchers(resolvers);
    const pm = buildPhaseManager(phaseManager);

    // Create initial state (ai1 = opponent slot = takes first turn)
    let state: GameState = stateManager.createInitialState(
        ai2Protocols,  // player protocols
        ai1Protocols,  // opponent protocols
        true,           // isOpponentTurn (ai1 starts)
        'opponent'
    );

    logLine(`=== GAME START | AI1=${ai1.toUpperCase()} ${ai1Protocols.join(',')} | AI2=${ai2.toUpperCase()} ${ai2Protocols.join(',')} ===`);
    logLine(`    [INFO] AI1 (opponent) hand: ${state.opponent.hand.map((c: any) => `${c.protocol}-${c.value}`).join(', ')}`);
    logLine(`    [INFO] AI2 (player) hand: ${state.player.hand.map((c: any) => `${c.protocol}-${c.value}`).join(', ')}`);

    // Game loop
    let loggedCount = state.log.length;
    let steps = 0;
    let turns = 0;
    const MAX_STEPS = maxTurns * 10; // Prevent infinite loops

    const harvestLog = (swapped: boolean) => {
        for (let i = loggedCount; i < state.log.length; i++) {
            const entry: any = state.log[i];
            const msg = swapped ? swapLogMessage(entry.message) : entry.message;
            logLine(`    ${msg}`);
        }
        loggedCount = state.log.length;
    };

    const summary = () => {
        const a = state.opponent;
        const b = state.player;
        return `lanes P1:${a.laneValues.join('/')} vs P2:${b.laneValues.join('/')} | compiled P1:${a.compiled.filter(Boolean).length} P2:${b.compiled.filter(Boolean).length} | hand P1:${a.hand.length} P2:${b.hand.length}`;
    };

    let lastActionKey: string | null = null;
    let stallCount = 0;

    while (!state.winner && steps < MAX_STEPS) {
        steps++;

        // 1. Pending action (interrupts, prompts, etc.)
        if (state.actionRequired) {
            const actor = (state.actionRequired as any).actor;
            if (actor === 'opponent') {
                state = aiManager.handleRequiredActionSync(state, ai1, dispatchers, pm, NOOP_ENQUEUE);
                harvestLog(false);
            } else {
                let mirrored = swapPerspective(state);
                mirrored = aiManager.handleRequiredActionSync(mirrored, ai2, dispatchers, pm, NOOP_ENQUEUE);
                state = swapPerspective(mirrored);
                harvestLog(true);
            }

            // Anti-stall logic
            if (state.actionRequired) {
                const key = JSON.stringify(state.actionRequired);
                stallCount = key === lastActionKey ? stallCount + 1 : 0;
                lastActionKey = key;
                if (stallCount >= 3) {
                    logLine(`    !! STALL on ${(state.actionRequired as any).type} - force-skipping`);
                    state = resolvers.skipAction(state);
                    if (state.actionRequired) {
                        state = { ...state, actionRequired: null };
                    }
                    lastActionKey = null;
                    stallCount = 0;
                }
            } else {
                lastActionKey = null;
                stallCount = 0;
            }
            continue;
        }

        // 2. Full turn for whoever is up
        turns++;
        if (state.turn === 'opponent') {
            logLine(`[T${turns}][AI1-${ai1}] ${summary()}`);
            state = aiManager.runOpponentTurnSync(state, ai1, dispatchers, pm, NOOP_ENQUEUE);
            harvestLog(false);
        } else {
            logLine(`[T${turns}][AI2-${ai2}] ${summary()}`);
            let mirrored = swapPerspective(state);
            mirrored = aiManager.runOpponentTurnSync(mirrored, ai2, dispatchers, pm, NOOP_ENQUEUE);
            state = swapPerspective(mirrored);
            harvestLog(true);
        }
    }

    // Determine winner
    const winner: GameResult['winner'] =
        state.winner === 'opponent' ? 'ai1' :
        state.winner === 'player' ? 'ai2' : 'draw';

    const winnerLabel = winner === 'ai1' ? `AI1-${ai1}` : winner === 'ai2' ? `AI2-${ai2}` : 'draw';

    logLine(`=== RESULT: ${winnerLabel} wins after ${turns} turns (${steps} steps) ===`);
    logLine(`=== FINAL: ${summary()} ===`);

    const result: GameResult = {
        winner,
        turns,
        ai1Compiled: state.opponent.compiled.filter(Boolean).length,
        ai2Compiled: state.player.compiled.filter(Boolean).length,
        log,
    };

    // Write log file if requested
    if (outputFile) {
        const dir = path.dirname(outputFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(outputFile, log.join('\n'), 'utf-8');
    }

    return result;
}

/**
 * Run multiple games and return summary statistics
 */
export function runBatchGames(
    ai1: Difficulty,
    ai2: Difficulty,
    ai1Protocols: string[],
    ai2Protocols: string[],
    count: number,
    verbose: boolean = false
): {
    results: GameResult[];
    summary: {
        totalGames: number;
        ai1Wins: number;
        ai2Wins: number;
        draws: number;
        avgTurns: number;
    };
} {
    const results: GameResult[] = [];
    
    for (let i = 0; i < count; i++) {
        const gameConfig: GameConfig = {
            ai1,
            ai2,
            ai1Protocols,
            ai2Protocols,
            verbose: false, // Suppress per-turn logs in batch mode
        };

        const result = runHeadlessGame(gameConfig);
        results.push(result);

        const winnerLabel = result.winner === 'ai1' ? ai1.toUpperCase() : 
                          result.winner === 'ai2' ? ai2.toUpperCase() : 'draw';
        console.log(`Game ${String(i + 1).padStart(3)}: ${winnerLabel.padEnd(10)} in ${String(result.turns).padStart(3)} turns | AI1:${result.ai1Compiled} AI2:${result.ai2Compiled}`);
    }

    // Calculate summary
    const ai1Wins = results.filter(r => r.winner === 'ai1').length;
    const ai2Wins = results.filter(r => r.winner === 'ai2').length;
    const draws = results.filter(r => r.winner === 'draw').length;
    const avgTurns = results.reduce((sum, r) => sum + r.turns, 0) / results.length;

    const summary = {
        totalGames: count,
        ai1Wins,
        ai2Wins,
        draws,
        avgTurns: Math.round(avgTurns * 100) / 100,
    };

    console.log('='.repeat(70));
    console.log(`SUMMARY: ${count} games | AI1 ${ai1.toUpperCase()}: ${ai1Wins} (${Math.round(ai1Wins / count * 100)}%) | AI2 ${ai2.toUpperCase()}: ${ai2Wins} (${Math.round(ai2Wins / count * 100)}%) | draws/stalls: ${draws}`);
    console.log(`Average turns: ${summary.avgTurns}`);
    console.log('='.repeat(70));

    return { results, summary };
}
