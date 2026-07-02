/**
 * AI-vs-AI SIMULATION: configurable matchup over full games, fully logged.
 *
 * Run via:  npm run simulate -- <games> <ai1> <ai2>
 * Example:  npm run simulate -- 100 hard medium
 *
 *  - ai1 / ai2: easy | normal | medium | hard   (medium = normal)
 *  - ai1 is PLAYER 1 (takes the first turn), ai2 is PLAYER 2
 *  - Logs go to sim-results/<timestamp>_<ai1>-vs-<ai2>/game-NNN_winner-X.log
 *  - The console prints per-game results and a final summary
 *  - Skipped during normal `npm test` (only runs when SIM_GAMES is set)
 *
 * Architecture: the aiManager always drives 'opponent'. AI1 occupies the
 * 'opponent' slot natively; for AI2's turns the state is perspective-swapped,
 * the same machinery runs with AI2's difficulty, then swapped back.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GameState, Difficulty } from '../types';
import {
    installLocalStorageShim, seedProtocols, allProtocolNames,
    loadGameModules, buildDispatchers, buildPhaseManager,
    swapPerspective, swapLogMessage, NOOP_ENQUEUE,
} from './helpers/headlessGame';

const GAMES = Number(process.env.SIM_GAMES || 0);

function parseDifficulty(raw: string | undefined, fallback: Difficulty): Difficulty {
    const v = (raw || '').toLowerCase();
    if (v === 'easy') return 'easy';
    if (v === 'normal' || v === 'medium') return 'normal';
    if (v === 'hard') return 'hard';
    return fallback;
}

const AI1: Difficulty = parseDifficulty(process.env.SIM_AI1, 'hard');   // Player 1 - takes the first turn
const AI2: Difficulty = parseDifficulty(process.env.SIM_AI2, 'normal'); // Player 2

// Protocol pools used in rotation (variety without exotic edge protocols)
const PROTOCOL_SETS = [
    ['Fire', 'Metal', 'Hate'],
    ['Water', 'Spirit', 'Light'],
    ['Speed', 'Darkness', 'Death'],
    ['Time', 'Luck', 'Plague'],
    ['Gravity', 'Life', 'Psychic'],
    ['Apathy', 'Frost', 'War'],
];

type GameResult = {
    winner: 'ai1' | 'ai2' | 'draw';
    turns: number;
    ai1Compiled: number;
    ai2Compiled: number;
    logFile: string;
};

beforeAll(() => {
    installLocalStorageShim();
    seedProtocols(allProtocolNames());
});

// Parse seed from environment variable
const SEED = process.env.SIM_SEED ? parseInt(process.env.SIM_SEED, 10) : undefined;

describe.skipIf(GAMES <= 0)(`AI vs AI simulation (${AI1} vs ${AI2})`, () => {
    it(`plays ${GAMES} full games`, async () => {
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const dispatchers = buildDispatchers(resolvers) as any;
        const pm = buildPhaseManager(phaseManager) as any;

        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const runDir = path.join('sim-results', `${stamp}_${AI1}-vs-${AI2}`);
        fs.mkdirSync(runDir, { recursive: true });

        const results: GameResult[] = [];

        for (let g = 0; g < GAMES; g++) {
            // AI1 = 'opponent' slot (native aiManager side), AI2 = 'player' slot.
            const ai1Protos = PROTOCOL_SETS[g % PROTOCOL_SETS.length];
            const ai2Protos = PROTOCOL_SETS[(g + 1) % PROTOCOL_SETS.length];

            const gameLog: string[] = [];
            const logLine = (line: string) => gameLog.push(line);

            let state: GameState = stateManager.createInitialState(
                ai2Protos, ai1Protos, true, 'opponent', // AI1 (opponent slot) takes the first turn
                SEED !== undefined ? SEED + g : undefined // Different seed per game if seed is set
            );
            logLine(`=== GAME ${g + 1} | P1=${AI1.toUpperCase()}: ${ai1Protos.join(',')} | P2=${AI2.toUpperCase()}: ${ai2Protos.join(',')} | P1 starts ===`);
            logLine(`    [INFO] P1 starting hand: ${state.opponent.hand.map(c => `${c.protocol}-${c.value}`).join(', ')}`);
            logLine(`    [INFO] P2 starting hand: ${state.player.hand.map(c => `${c.protocol}-${c.value}`).join(', ')}`);

            let loggedCount = state.log.length;
            const harvestLog = (swapped: boolean) => {
                for (let i = loggedCount; i < state.log.length; i++) {
                    const entry: any = state.log[i];
                    const msg = swapped ? swapLogMessage(entry.message) : entry.message;
                    logLine(`    ${msg}`);
                }
                loggedCount = state.log.length;
            };

            // FULL-INFO TRACING (simulation only): reveal drawn cards and the
            // identity of face-down plays so games can be replayed 1:1.
            type HiddenSnapshot = { hands: Record<string, Map<string, string>>; laneCards: Record<string, Map<string, string>> };
            const captureHidden = (): HiddenSnapshot => {
                const snap: HiddenSnapshot = { hands: {}, laneCards: {} };
                for (const side of ['opponent', 'player'] as const) {
                    snap.hands[side] = new Map(state[side].hand.map(c => [c.id, `${c.protocol}-${c.value}`]));
                    const laneMap = new Map<string, string>();
                    state[side].lanes.forEach((lane, laneIdx) => {
                        for (const c of lane) {
                            if (!c.isFaceUp) laneMap.set(c.id, `${c.protocol}-${c.value} (lane ${laneIdx})`);
                        }
                    });
                    snap.laneCards[side] = laneMap;
                }
                return snap;
            };
            const logHiddenDiff = (before: HiddenSnapshot) => {
                for (const side of ['opponent', 'player'] as const) {
                    const label = side === 'opponent' ? 'P1' : 'P2';
                    const gained: string[] = [];
                    for (const [id, name] of state[side].hand.map(c => [c.id, `${c.protocol}-${c.value}`] as const)) {
                        if (!before.hands[side].has(id)) gained.push(name);
                    }
                    if (gained.length > 0) logLine(`    [INFO] ${label} hand gained: ${gained.join(', ')}`);

                    const newFaceDown: string[] = [];
                    state[side].lanes.forEach((lane, laneIdx) => {
                        for (const c of lane) {
                            if (!c.isFaceUp && !before.laneCards[side].has(c.id)) {
                                newFaceDown.push(`${c.protocol}-${c.value} (lane ${laneIdx})`);
                            }
                        }
                    });
                    if (newFaceDown.length > 0) logLine(`    [INFO] ${label} face-down played: ${newFaceDown.join(', ')}`);
                }
            };

            // In log summaries: P1 = opponent slot, P2 = player slot
            const summary = () => {
                const a = state.opponent, b = state.player;
                return `lanes P1:${a.laneValues.join('/')} vs P2:${b.laneValues.join('/')}`
                    + ` | compiled P1:${a.compiled.filter(Boolean).length} P2:${b.compiled.filter(Boolean).length}`
                    + ` | hand P1:${a.hand.length} P2:${b.hand.length}`
                    + ` | control:${state.controlCardHolder === 'opponent' ? 'P1' : state.controlCardHolder === 'player' ? 'P2' : '-'}`;
            };

            let steps = 0;
            let turns = 0;
            const MAX_STEPS = 500;
            let lastActionKey: string | null = null;
            let stallCount = 0;

            while (!state.winner && steps < MAX_STEPS) {
                steps++;

                // 1. Pending action (interrupts etc.) - route to the right brain
                if (state.actionRequired) {
                    const actor = (state.actionRequired as any).actor;
                    const hiddenBefore = captureHidden();
                    if (actor === 'opponent') {
                        state = aiManager.handleRequiredActionSync(state, AI1, dispatchers, pm, NOOP_ENQUEUE);
                        harvestLog(false);
                    } else {
                        let mirrored = swapPerspective(state);
                        mirrored = aiManager.handleRequiredActionSync(mirrored, AI2, dispatchers, pm, NOOP_ENQUEUE);
                        state = swapPerspective(mirrored);
                        harvestLog(true);
                    }
                    logHiddenDiff(hiddenBefore);
                    // Anti-stall: same pending action CONTENT repeatedly (the
                    // action object may be recreated each iteration!) -> force clear
                    if (state.actionRequired) {
                        const key = JSON.stringify(state.actionRequired);
                        stallCount = key === lastActionKey ? stallCount + 1 : 0;
                        lastActionKey = key;
                        if (stallCount >= 3) {
                            logLine(`    !! STALL on ${(state.actionRequired as any).type} - force-skipping`);
                            state = resolvers.skipAction(state);
                            if (state.actionRequired) {
                                // skipAction only clears optional actions - hard-clear
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
                const hiddenBeforeTurn = captureHidden();
                if (state.turn === 'opponent') {
                    logLine(`[T${turns}][P1-${AI1}] ${summary()}`);
                    state = aiManager.runOpponentTurnSync(state, AI1, dispatchers, pm, NOOP_ENQUEUE);
                    harvestLog(false);
                } else {
                    logLine(`[T${turns}][P2-${AI2}] ${summary()}`);
                    let mirrored = swapPerspective(state);
                    mirrored = aiManager.runOpponentTurnSync(mirrored, AI2, dispatchers, pm, NOOP_ENQUEUE);
                    state = swapPerspective(mirrored);
                    harvestLog(true);
                }
                logHiddenDiff(hiddenBeforeTurn);
            }

            const winner: GameResult['winner'] =
                state.winner === 'opponent' ? 'ai1' :
                state.winner === 'player' ? 'ai2' : 'draw';
            const winnerLabel =
                winner === 'ai1' ? `P1-${AI1}` :
                winner === 'ai2' ? `P2-${AI2}` : 'draw';

            logLine(`=== RESULT: ${winnerLabel} wins after ${turns} turns (${steps} steps) ===`);
            logLine(`=== FINAL: ${summary()} ===`);

            const result: GameResult = {
                winner,
                turns,
                ai1Compiled: state.opponent.compiled.filter(Boolean).length,
                ai2Compiled: state.player.compiled.filter(Boolean).length,
                logFile: path.join(runDir, `game-${String(g + 1).padStart(3, '0')}_winner-${winnerLabel}.log`),
            };
            fs.writeFileSync(result.logFile, gameLog.join('\n'), 'utf-8');
            results.push(result);

            console.log(`Game ${String(g + 1).padStart(3)}: ${winnerLabel.padEnd(10)} in ${String(turns).padStart(3)} turns | P1:${result.ai1Compiled} P2:${result.ai2Compiled}`);
        }

        // Summary (console + file)
        const ai1Wins = results.filter(r => r.winner === 'ai1').length;
        const ai2Wins = results.filter(r => r.winner === 'ai2').length;
        const draws = results.filter(r => r.winner === 'draw').length;
        const summaryLines = [
            '='.repeat(70),
            `SUMMARY: ${GAMES} games | P1 ${AI1.toUpperCase()}: ${ai1Wins} (${Math.round(ai1Wins / GAMES * 100)}%) | P2 ${AI2.toUpperCase()}: ${ai2Wins} (${Math.round(ai2Wins / GAMES * 100)}%) | draws/stalls: ${draws}`,
            `Logs: ${runDir}`,
            '='.repeat(70),
        ];
        summaryLines.forEach(l => console.log(l));
        fs.writeFileSync(path.join(runDir, 'summary.txt'), [
            ...summaryLines,
            ...results.map((r, i) => `Game ${i + 1}: ${r.winner} | ${r.turns} turns | P1:${r.ai1Compiled} P2:${r.ai2Compiled} | ${path.basename(r.logFile)}`),
        ].join('\n'), 'utf-8');

        expect(results.length).toBe(GAMES);
    }, 3_600_000);
});
