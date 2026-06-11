/**
 * Hard AI Full-Turn Smoke Tests
 *
 * Runs COMPLETE AI turns headlessly through the real aiManager pipeline
 * (runOpponentTurnSync + real resolvers + real phaseManager) with real
 * protocol decks. This catches softlocks, exceptions and illegal moves
 * across the whole decision surface - not just isolated handlers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GameState, Player } from '../types';

// ---------------------------------------------------------------------------
// localStorage shim + protocol seeding (must exist before game modules run)
// ---------------------------------------------------------------------------

function installLocalStorageShim() {
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

function seedProtocols(names: string[]) {
    const protocols = names.map(name => {
        const file = path.join('custom_protocols', `${name.toLowerCase()}_custom_protocol.json`);
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    });
    localStorage.setItem('custom_protocols_v1', JSON.stringify({ protocols, version: 1 }));
}

beforeAll(() => {
    installLocalStorageShim();
    seedProtocols(['fire', 'water', 'death', 'hate', 'metal', 'speed', 'time', 'luck', 'darkness', 'plague']);
});

// ---------------------------------------------------------------------------
// Headless turn runner (mirrors the dispatcher wiring in useGameState)
// ---------------------------------------------------------------------------

const NOOP_END_GAME = (_w: Player, _s: GameState): void => {};
const NOOP_ENQUEUE = (_item: any): void => {};

async function loadGameModules() {
    // Dynamic imports AFTER the localStorage shim is installed (modules cache cards lazily)
    const aiManager = await import('../logic/game/aiManager');
    const resolvers = await import('../logic/game/resolvers');
    const phaseManager = await import('../logic/game/phaseManager');
    const stateManager = await import('../logic/game/stateManager');
    return { aiManager, resolvers, phaseManager, stateManager };
}

function buildDispatchers(resolvers: any) {
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

function buildPhaseManager(phaseManager: any) {
    return {
        processEndOfAction: phaseManager.processEndOfAction,
        processStartOfTurn: phaseManager.processStartOfTurn,
        continueTurnAfterStartPhaseAction: phaseManager.continueTurnAfterStartPhaseAction,
        continueTurnProgression: phaseManager.continueTurnProgression,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Hard AI - full headless turns', () => {
    it('completes a full opening turn without softlock (5 random decks)', async () => {
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const dispatchers = buildDispatchers(resolvers);
        const pm = buildPhaseManager(phaseManager);

        for (let run = 0; run < 5; run++) {
            const state = stateManager.createInitialState(
                ['Fire', 'Water', 'Death'],
                ['Hate', 'Metal', 'Speed'],
                true,
                'opponent'
            );
            expect(state.opponent.deck.length).toBeGreaterThan(0); // decks really built

            const result: GameState = aiManager.runOpponentTurnSync(
                state, 'hard', dispatchers as any, pm as any, NOOP_ENQUEUE
            );

            // The turn must terminate: either handed over to the player or
            // waiting on a player interrupt - never stuck on an AI action.
            const waitingOnPlayer =
                result.actionRequired && (result.actionRequired as any).actor === 'player';
            expect(result.turn === 'player' || waitingOnPlayer).toBe(true);

            // The AI must have DONE something: played a card or refreshed.
            const boardCards = result.opponent.lanes.flat().length;
            const handSize = result.opponent.hand.length;
            expect(boardCards > 0 || handSize === 5).toBe(true);
        }
    }, 60000);

    it('compiles a lane when compile conditions are met', async () => {
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const dispatchers = buildDispatchers(resolvers);
        const pm = buildPhaseManager(phaseManager);

        const state = stateManager.createInitialState(
            ['Fire', 'Water', 'Death'],
            ['Hate', 'Metal', 'Speed'],
            false,
            'opponent'
        );

        // Force lane 0 to a compileable value (>=10, beats the player's 0).
        // Use simple face-down cards (value 2 each) to avoid effect triggers.
        const deckCards = state.opponent.deck.slice(0, 5);
        expect(deckCards.length).toBe(5);
        state.opponent.lanes[0] = deckCards.map((c, i) => ({
            ...c,
            id: `compile-test-${i}`,
            isFaceUp: false,
        })) as any;
        const recalced = (await import('../logic/game/stateManager')).recalculateAllLaneValues(state);

        const result: GameState = aiManager.runOpponentTurnSync(
            recalced, 'hard', dispatchers as any, pm as any, NOOP_ENQUEUE
        );

        expect(result.opponent.compiled[0]).toBe(true);
        expect(result.opponent.lanes[0].length).toBe(0); // lane cleared by compile
    }, 30000);

    it('refreshes when the hand is empty', async () => {
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const dispatchers = buildDispatchers(resolvers);
        const pm = buildPhaseManager(phaseManager);

        const state = stateManager.createInitialState(
            ['Fire', 'Water', 'Death'],
            ['Hate', 'Metal', 'Speed'],
            false,
            'opponent'
        );
        // Move the whole hand back into the deck -> AI MUST refresh.
        state.opponent.deck = [...state.opponent.deck, ...state.opponent.hand.map(({ id, isFaceUp, ...c }) => c)] as any;
        state.opponent.hand = [];

        const result: GameState = aiManager.runOpponentTurnSync(
            state, 'hard', dispatchers as any, pm as any, NOOP_ENQUEUE
        );

        const waitingOnPlayer =
            result.actionRequired && (result.actionRequired as any).actor === 'player';
        expect(result.turn === 'player' || waitingOnPlayer).toBe(true);
        expect(result.opponent.hand.length).toBe(5);
    }, 30000);

    it('plays predominantly FACE-UP across multi-turn games (no face-down bias)', async () => {
        // Regression for the "AI only plays face-down" bug: the opponent
        // lookahead penalized only the top-K (face-up) candidates with an
        // absolute opponent score, letting unpenalized face-down moves win.
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const { v4: uuidv4 } = await import('uuid');
        const dispatchers = buildDispatchers(resolvers);
        const pm = buildPhaseManager(phaseManager);

        let faceUp = 0;
        let faceDown = 0;

        for (let game = 0; game < 3; game++) {
            let state: any = stateManager.createInitialState(
                ['Water', 'Spirit', 'Light'], ['Fire', 'Metal', 'Hate'], true, 'opponent'
            );

            for (let turn = 0; turn < 8; turn++) {
                const before = state.opponent.lanes.flat().map((c: any) => c.id);
                state = aiManager.runOpponentTurnSync(state, 'hard', dispatchers as any, pm as any, NOOP_ENQUEUE);
                if (state.winner) break;
                for (const lane of state.opponent.lanes) {
                    for (const c of lane) {
                        if (!before.includes(c.id)) { c.isFaceUp ? faceUp++ : faceDown++; }
                    }
                }
                if (state.actionRequired) break; // waiting on player interrupt - end this game

                // Crude player turn: place their best matching card face-up.
                const hand = state.player.hand;
                if (hand.length > 0) {
                    const best = [...hand].sort((a: any, b: any) => b.value - a.value)[0];
                    const laneIdx = Math.max(0, state.player.protocols.indexOf(best.protocol));
                    state.player.hand = hand.filter((c: any) => c.id !== best.id);
                    state.player.lanes[laneIdx] = [
                        ...state.player.lanes[laneIdx],
                        { ...best, isFaceUp: best.protocol === state.player.protocols[laneIdx], id: uuidv4() },
                    ];
                } else {
                    state.player.hand = state.player.deck.slice(0, 5).map((c: any) => ({ ...c, id: uuidv4(), isFaceUp: true }));
                    state.player.deck = state.player.deck.slice(5);
                }
                state = stateManager.recalculateAllLaneValues(state);
                state.turn = 'opponent';
                state.phase = 'start';
                state.processedStartEffectIds = [];
                state.processedEndEffectIds = [];
                state.processedUncoverEventIds = [];
                state._cardPlayedThisActionPhase = undefined;
            }
        }

        expect(faceUp + faceDown).toBeGreaterThan(0);
        // The bug produced ~1:9 face-up:face-down. Healthy play is face-up dominant.
        expect(faceUp).toBeGreaterThan(faceDown);
    }, 120000);

    it('handles effect-heavy protocols (Time/Luck/Darkness/Plague) without softlock', async () => {
        const { aiManager, resolvers, phaseManager, stateManager } = await loadGameModules();
        const dispatchers = buildDispatchers(resolvers);
        const pm = buildPhaseManager(phaseManager);

        for (let run = 0; run < 5; run++) {
            const state = stateManager.createInitialState(
                ['Fire', 'Water', 'Death'],
                ['Time', 'Luck', 'Darkness'],
                true,
                'opponent'
            );
            // Give the AI a non-empty trash so Time effects have material.
            state.opponent.discard = state.opponent.deck.slice(0, 3).map(({ ...c }) => c) as any;
            state.opponent.deck = state.opponent.deck.slice(3);

            const result: GameState = aiManager.runOpponentTurnSync(
                state, 'hard', dispatchers as any, pm as any, NOOP_ENQUEUE
            );

            const waitingOnPlayer =
                result.actionRequired && (result.actionRequired as any).actor === 'player';
            if (!(result.turn === 'player' || waitingOnPlayer)) {
                // Diagnostic dump for rare random-deck failures
                console.error('STUCK STATE:', JSON.stringify({
                    turn: result.turn,
                    phase: result.phase,
                    winner: result.winner,
                    actionRequired: result.actionRequired ? {
                        type: (result.actionRequired as any).type,
                        actor: (result.actionRequired as any).actor,
                    } : null,
                    queuedActions: (result.queuedActions || []).map((a: any) => ({ type: a.type, actor: a.actor })),
                    interrupted: (result as any)._interruptedTurn,
                    logTail: result.log.slice(-12).map((l: any) => l.message),
                }, null, 1));
            }
            expect(result.turn === 'player' || waitingOnPlayer).toBe(true);
        }
    }, 60000);
});
