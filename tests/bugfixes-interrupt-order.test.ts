/**
 * Regression tests for interrupt/effect-chain bugs:
 *
 * Bug 1: Luck-0 triggered during an interrupt reused the previously stated
 *        number instead of asking for a new one (queue order was inverted).
 * Bug 2: Delete eligibility used the PRINTED value of face-down cards instead
 *        of the effective value (face-down = 2, Darkness-2 = 4).
 * Bug 3: Time-0 uncovered during an interrupt shuffled the trash BEFORE the
 *        "play from trash" selection could happen (queue order was inverted).
 * Bug 4: Face-down plays announced the card name in the animation toast.
 */

import { describe, it, expect } from 'vitest';
import { GameState, PlayedCard, Player } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { handleUncoverEffect, handleOnFlipToFaceUp } from '../logic/game/helpers/actionUtils';
import { queueActionWithPendingEffects } from '../logic/game/phaseManager';
import { executeDeleteEffect } from '../logic/effects/actions/deleteExecutor';
import { executeStateNumberEffect } from '../logic/effects/actions/stateNumberExecutor';
import { playCardMessage } from '../logic/utils/logMessages';
import { EffectContext } from '../types';

// --- Helpers (same pattern as effect-chains.test.ts) ---

function createCard(protocol: string, value: number, isFaceUp: boolean = true): PlayedCard {
    return {
        id: uuidv4(),
        protocol,
        value,
        top: '',
        middle: '',
        bottom: '',
        keywords: {},
        isFaceUp,
        isRevealed: false,
    };
}

function createCustomCard(protocol: string, value: number, isFaceUp: boolean, customEffects: any): PlayedCard {
    return { ...createCard(protocol, value, isFaceUp), customEffects } as PlayedCard;
}

function createTestState(): GameState {
    const state: any = {
        player: {
            protocols: ['Fire', 'Water', 'Death'],
            lanes: [[], [], []],
            hand: [],
            deck: Array(10).fill(null).map(() => createCard('Fire', 2)),
            discard: [],
            compiled: [false, false, false],
            stats: { cardsPlayed: 0, cardsDeleted: 0, cardsDrawn: 0, cardsFlipped: 0, cardsDiscarded: 0 },
            laneValues: [0, 0, 0],
        },
        opponent: {
            protocols: ['Luck', 'Time', 'Metal'],
            lanes: [[], [], []],
            hand: [],
            deck: Array(10).fill(null).map(() => createCard('Time', 1)),
            discard: [],
            compiled: [false, false, false],
            stats: { cardsPlayed: 0, cardsDeleted: 0, cardsDrawn: 0, cardsFlipped: 0, cardsDiscarded: 0 },
            laneValues: [0, 0, 0],
        },
        turn: 'player' as Player,
        phase: 'action',
        turnNumber: 1,
        winner: null,
        actionRequired: null,
        queuedActions: [],
        queuedEffect: null,
        compilableLanes: [],
        processedUncoverEventIds: [],
        stats: {
            player: { cardsPlayed: 0, cardsDeleted: 0, cardsDrawn: 0, cardsFlipped: 0, cardsDiscarded: 0 },
            opponent: { cardsPlayed: 0, cardsDeleted: 0, cardsDrawn: 0, cardsFlipped: 0, cardsDiscarded: 0 },
        },
        log: [],
        _logIndentLevel: 0,
    };
    return state as GameState;
}

// Real Time-0 middle effects (mirrors custom_protocols/time_custom_protocol.json)
const TIME_0_EFFECTS = {
    topEffects: [],
    middleEffects: [
        {
            id: 'time-0-play-from-trash',
            params: { action: 'play', source: 'trash', count: 1 },
            position: 'middle',
            trigger: 'on_play',
        },
        {
            id: 'time-0-shuffle-trash',
            params: { action: 'shuffle_trash', optional: false },
            position: 'middle',
            trigger: 'on_play',
        },
    ],
    bottomEffects: [],
};

// Real Luck-0 middle effects (mirrors custom_protocols/luck_custom_protocol.json)
const LUCK_0_EFFECTS = {
    topEffects: [],
    middleEffects: [
        {
            id: 'luck-0-state-number',
            params: { action: 'state_number', numberSource: 'own_protocol_values' },
            position: 'middle',
            trigger: 'on_play',
        },
        {
            id: 'luck-0-draw-and-reveal',
            params: {
                action: 'draw',
                count: 3,
                target: 'self',
                source: 'own_deck',
                revealFromDrawn: { valueSource: 'stated_number', thenAction: 'may_play' },
            },
            position: 'middle',
            trigger: 'on_play',
        },
    ],
    bottomEffects: [],
};

describe('Bug 3: Time-0 uncovered during an interrupt', () => {
    it('queues "play from trash" BEFORE "shuffle trash"', () => {
        const state = createTestState();
        const time0 = createCustomCard('Time', 0, true, TIME_0_EFFECTS);

        // AI's turn was interrupted, the player is currently acting.
        // The player's action uncovers the AI's Time-0.
        state.turn = 'player';
        (state as any)._interruptedTurn = 'opponent';
        (state as any)._interruptedPhase = 'action';
        state.opponent.lanes[1] = [time0];
        state.opponent.discard = [
            { protocol: 'Time', value: 3, top: '', middle: '', bottom: '', keywords: {} } as any,
            { protocol: 'Metal', value: 1, top: '', middle: '', bottom: '', keywords: {} } as any,
        ];

        const result = handleUncoverEffect(state, 'opponent', 1);
        const newState = result.newState;

        // The action must NOT be lost and must NOT execute after the shuffle:
        // queue order = [select_card_from_trash_to_play, execute_remaining(shuffle_trash)]
        expect(newState.actionRequired).toBeNull();
        const queue = newState.queuedActions || [];
        expect(queue.length).toBeGreaterThanOrEqual(2);
        expect(queue[0].type).toBe('select_card_from_trash_to_play');
        expect((queue[0] as any).actor).toBe('opponent');
        expect(queue[1].type).toBe('execute_remaining_custom_effects');
        expect((queue[1] as any).effects[0].params.action).toBe('shuffle_trash');

        // Trash must still be untouched (no premature shuffle!)
        expect(newState.opponent.discard.length).toBe(2);
    });
});

describe('Bug 1: Luck-0 triggered during an interrupt', () => {
    it('queues "state a number" BEFORE the draw/reveal effect', () => {
        const state = createTestState();
        const luck0 = createCustomCard('Luck', 0, true, LUCK_0_EFFECTS);

        state.turn = 'player';
        (state as any)._interruptedTurn = 'opponent';
        (state as any)._interruptedPhase = 'action';
        state.opponent.lanes[0] = [luck0];
        // A number was stated earlier in the game - it must NOT be reused
        state.lastStatedNumber = 4;

        const result = handleOnFlipToFaceUp(state, luck0.id);
        const newState = result.newState;

        expect(newState.actionRequired).toBeNull();
        const queue = newState.queuedActions || [];
        expect(queue.length).toBeGreaterThanOrEqual(2);
        expect(queue[0].type).toBe('state_number');
        expect((queue[0] as any).actor).toBe('opponent');
        expect(queue[1].type).toBe('execute_remaining_custom_effects');
        expect((queue[1] as any).effects[0].params.action).toBe('draw');

        // No cards may have been drawn yet (draw must wait for the new number)
        expect(newState.opponent.hand.length).toBe(0);
    });

    it('executeStateNumberEffect invalidates a previously stated number', () => {
        const state = createTestState();
        const luck0 = createCustomCard('Luck', 0, true, LUCK_0_EFFECTS);
        state.opponent.lanes[0] = [luck0];
        state.lastStatedNumber = 4;

        const context: EffectContext = {
            cardOwner: 'opponent', actor: 'opponent', currentTurn: 'opponent', opponent: 'player',
        } as any;
        const result = executeStateNumberEffect(luck0, 0, state, context, {});

        expect(result.newState.lastStatedNumber).toBeUndefined();
        expect(result.newState.actionRequired?.type).toBe('state_number');
    });
});

describe('queueActionWithPendingEffects helper', () => {
    it('puts the current action in front of the pending effects', () => {
        const state = createTestState();
        const source = createCustomCard('Time', 0, true, TIME_0_EFFECTS);
        state.opponent.lanes[0] = [source];
        state.actionRequired = { type: 'select_card_from_trash_to_play', actor: 'opponent', sourceCardId: source.id } as any;
        (state as any)._pendingCustomEffects = {
            sourceCardId: source.id,
            laneIndex: 0,
            context: { cardOwner: 'opponent', actor: 'opponent', currentTurn: 'opponent', opponent: 'player' },
            effects: [TIME_0_EFFECTS.middleEffects[1]],
        };
        (state as any).queuedActions = [{ type: 'reveal_opponent_hand', sourceCardId: source.id, actor: 'opponent' } as any];

        const newState = queueActionWithPendingEffects(state);

        expect(newState.actionRequired).toBeNull();
        const queue = newState.queuedActions || [];
        expect(queue[0].type).toBe('select_card_from_trash_to_play');
        expect(queue[1].type).toBe('execute_remaining_custom_effects');
        expect(queue[2].type).toBe('reveal_opponent_hand');
        expect((newState as any)._pendingCustomEffects).toBeUndefined();
    });

    it('works without pending effects (action only)', () => {
        const state = createTestState();
        state.actionRequired = { type: 'state_number', actor: 'opponent', sourceCardId: 'x' } as any;

        const newState = queueActionWithPendingEffects(state);

        expect(newState.actionRequired).toBeNull();
        expect((newState.queuedActions || [])[0].type).toBe('state_number');
    });
});

describe('Bug 2: Delete eligibility uses effective card values', () => {
    const makeContext = (cardOwner: Player): EffectContext => ({
        cardOwner, actor: cardOwner, currentTurn: cardOwner,
        opponent: cardOwner === 'player' ? 'opponent' : 'player',
    } as any);

    it('valueSource: face-down card with high printed value IS eligible (effective value 2)', () => {
        const state = createTestState();
        const source = createCard('Luck', 4, true);
        const faceDownHighCard = createCard('Water', 5, false); // effective value 2!

        state.opponent.lanes[0] = [source];
        state.player.lanes[0] = [faceDownHighCard];
        state.lastCustomEffectTargetValue = 2;

        const result = executeDeleteEffect(source, 0, state, makeContext('opponent'), {
            count: 1,
            targetFilter: { position: 'any', valueSource: 'previous_effect_card' },
        });

        const action = result.newState.actionRequired as any;
        expect(action?.type).toBe('select_cards_to_delete');
        expect(action.allowedIds).toContain(faceDownHighCard.id);
    });

    it('valueSource: face-down card does NOT match its printed value', () => {
        const state = createTestState();
        const source = createCard('Luck', 4, true);
        const faceDownCard = createCard('Water', 5, false); // printed 5, effective 2

        state.opponent.lanes[0] = [source];
        state.player.lanes[0] = [faceDownCard];
        state.lastCustomEffectTargetValue = 5; // matches printed, NOT effective value

        const result = executeDeleteEffect(source, 0, state, makeContext('opponent'), {
            count: 1,
            excludeSelf: true,
            targetFilter: { position: 'any', valueSource: 'previous_effect_card', excludeSelf: true },
        });

        // Only the face-down card (effective 2) exists besides the source - no valid target
        const action = result.newState.actionRequired as any;
        if (action) {
            expect(action.allowedIds || []).not.toContain(faceDownCard.id);
        } else {
            expect((result.newState as any)._effectSkippedNoTargets).toBe(true);
        }
    });

    it('valueRange: face-down card with printed value 0 is NOT eligible for range 0-1', () => {
        const state = createTestState();
        const source = createCard('Death', 4, true);
        const faceDownZero = createCard('Water', 0, false); // printed 0, effective 2

        state.opponent.lanes[0] = [source];
        state.player.lanes[0] = [faceDownZero];

        const result = executeDeleteEffect(source, 0, state, makeContext('opponent'), {
            count: 1,
            excludeSelf: true,
            targetFilter: { position: 'uncovered', valueRange: { min: 0, max: 1 }, excludeSelf: true },
        });

        // Face-down counts as 2 -> outside range 0-1 -> effect skipped
        expect((result.newState as any)._effectSkippedNoTargets).toBe(true);
        expect(result.newState.actionRequired).toBeNull();
    });

    it('valueRange: face-down card IS eligible for a range that includes 2', () => {
        const state = createTestState();
        const source = createCard('Death', 2, true);
        const faceDownHigh = createCard('Water', 6, false); // printed 6, effective 2

        state.opponent.lanes[0] = [source];
        state.player.lanes[0] = [faceDownHigh];

        const result = executeDeleteEffect(source, 0, state, makeContext('opponent'), {
            count: 1,
            excludeSelf: true,
            targetFilter: { position: 'uncovered', valueRange: { min: 1, max: 2 }, excludeSelf: true },
        });

        const action = result.newState.actionRequired as any;
        expect(action?.type).toBe('select_cards_to_delete');
        expect(action.allowedIds).toContain(faceDownHigh.id);
    });
});

describe('Softlock: variable discard resolved with zero cards (Plague-2)', () => {
    // Plague-2: "Discard any number of cards. Then your opponent discards that many +1."
    const PLAGUE_2_EFFECTS = {
        topEffects: [],
        middleEffects: [
            {
                id: 'plague-2-self-discard',
                params: { action: 'discard', count: 1, actor: 'self', variableCount: true },
                position: 'middle',
                trigger: 'on_play',
                conditional: {
                    type: 'then',
                    thenEffect: {
                        id: 'plague-2-opponent-discard',
                        params: { action: 'discard', actor: 'opponent', countType: 'equal_to_discarded', countOffset: 1 },
                        position: 'middle',
                        trigger: 'on_play',
                    },
                },
            },
        ],
        bottomEffects: [],
    };

    function buildPlague2State(aiHandSize: number, playerHandSize: number) {
        const state = createTestState();
        const plague2 = createCustomCard('Plague', 2, true, PLAGUE_2_EFFECTS);
        state.turn = 'player';
        (state as any)._interruptedTurn = 'player';
        state.opponent.lanes[2] = [plague2];
        state.opponent.hand = Array(aiHandSize).fill(null).map((_, i) => createCard('Metal', i % 4));
        state.player.hand = Array(playerHandSize).fill(null).map((_, i) => createCard('Fire', i % 4));
        state.actionRequired = {
            type: 'discard',
            actor: 'opponent',
            count: 1,
            variableCount: true,
            sourceCardId: plague2.id,
            followUpEffect: PLAGUE_2_EFFECTS.middleEffects[0].conditional.thenEffect,
            conditionalType: 'then',
            previousHandSize: aiHandSize,
        } as any;
        return state;
    }

    it('completes the discard when the actor has NO cards (skip + follow-up, never pending)', async () => {
        const { discardCards } = await import('../logic/game/resolvers/discardResolver');
        const state = buildPlague2State(0, 0);
        (state.actionRequired as any).previousHandSize = 0;

        const newState = discardCards(state, [], 'opponent');

        // The action must be resolved - a pending discard here means softlock.
        expect(newState.actionRequired).toBeNull();
        const logText = newState.log.map((l: any) => l.message).join(' | ');
        expect(logText).toContain('Opponent has no cards to discard - effect skipped');
    });

    it('keeps the discard pending on empty selection while cards are in hand (min 1!)', async () => {
        const { discardCards } = await import('../logic/game/resolvers/discardResolver');
        const state = buildPlague2State(4, 0);

        // "Discard 1 or more": an empty selection is NOT a legal resolution.
        const newState = discardCards(state, [], 'opponent');
        expect(newState.actionRequired).toBe(state.actionRequired);
    });

    it('hard AI discards AT LEAST one card when it has cards in hand', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const state = buildPlague2State(4, 0);

        const decision = hardAI(state, state.actionRequired) as any;
        expect(decision.type).toBe('discardCards');
        expect(decision.cardIds.length).toBeGreaterThanOrEqual(1);
    });

    it('applying the hard AI discard forces the player follow-up discard (X+1)', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const { discardCards } = await import('../logic/game/resolvers/discardResolver');
        const state = buildPlague2State(4, 3);

        const decision = hardAI(state, state.actionRequired) as any;
        expect(decision.cardIds.length).toBeGreaterThanOrEqual(1);

        const newState = discardCards(state, decision.cardIds, 'opponent');
        // Plague-2 follow-up: player discards X+1.
        const action = newState.actionRequired as any;
        expect(action?.type).toBe('discard');
        expect(action?.actor).toBe('player');
        expect(action?.count).toBe(Math.min(decision.cardIds.length + 1, 3));
    });
});

describe('Softlock: select_lane_for_shift must never target the original lane', () => {
    it('hard AI picks a DIFFERENT lane (or skip), never the original lane', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const state = createTestState();
        const sourceCard = createCard('Psychic', 3, true);
        const cardToShift = createCard('Fire', 2, true);

        state.turn = 'opponent';
        state.opponent.lanes[1] = [sourceCard];
        state.player.lanes[1] = [cardToShift];
        state.actionRequired = {
            type: 'select_lane_for_shift',
            cardToShiftId: cardToShift.id,
            cardOwner: 'player',
            originalLaneIndex: 1,
            sourceCardId: sourceCard.id,
            actor: 'opponent',
        } as any;

        for (let i = 0; i < 5; i++) {
            const decision = hardAI(state, state.actionRequired) as any;
            if (decision.type === 'selectLane') {
                expect(decision.laneIndex).not.toBe(1);
            } else {
                expect(decision.type).toBe('skip');
            }
        }
    });
});

describe('Darkness-3: forced face-down play must stay face-down', () => {
    it('hard AI never answers a faceDown-forced hand play with face-up', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const state = createTestState();
        const darkness3 = createCard('Darkness', 3, true);

        state.turn = 'opponent';
        state.opponent.lanes[1] = [darkness3];
        state.opponent.hand = [createCard('Metal', 4), createCard('Fire', 2), createCard('Hate', 1)];
        // Darkness-3: "Play 1 card face-down in another line."
        state.actionRequired = {
            type: 'select_card_from_hand_to_play',
            sourceCardId: darkness3.id,
            actor: 'opponent',
            count: 1,
            faceDown: true,
            source: 'hand',
            disallowedLaneIndex: 1,
        } as any;

        for (let i = 0; i < 5; i++) {
            const decision = hardAI(state, state.actionRequired) as any;
            expect(decision.type).toBe('playCard');
            expect(decision.isFaceUp).toBe(false);
            expect(decision.laneIndex).not.toBe(1);
        }
    });
});

describe('Gravity-1: shift must go TO or FROM the source lane', () => {
    it('hard AI only offers the Gravity lane as destination for outside cards', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const state = createTestState();
        const gravity1 = createCard('Gravity', 1, true);
        const cardToShift = createCard('Fire', 3, true);

        state.turn = 'opponent';
        state.opponent.lanes[0] = [gravity1];   // Gravity-1 in lane 0
        state.player.lanes[2] = [cardToShift];  // shift target sits in lane 2

        // Lane selection after the card was chosen: card from lane 2,
        // restriction "to or from lane 0" -> ONLY lane 0 is a legal destination.
        state.actionRequired = {
            type: 'select_lane_for_shift',
            cardToShiftId: cardToShift.id,
            cardOwner: 'player',
            originalLaneIndex: 2,
            sourceCardId: gravity1.id,
            actor: 'opponent',
            destinationRestriction: { type: 'to_or_from_this_lane', laneIndex: 0 },
        } as any;

        for (let i = 0; i < 5; i++) {
            const decision = hardAI(state, state.actionRequired) as any;
            expect(decision.type).toBe('selectLane');
            expect(decision.laneIndex).toBe(0);
        }
    });

    it('hard AI may pick any other lane when the card comes FROM the Gravity lane', async () => {
        const { hardAI } = await import('../logic/ai/hard');
        const state = createTestState();
        const gravity1 = createCard('Gravity', 1, true);
        const cardToShift = createCard('Fire', 3, true);

        state.turn = 'opponent';
        state.opponent.lanes[0] = [gravity1, cardToShift]; // card IS in the Gravity lane
        state.actionRequired = {
            type: 'select_lane_for_shift',
            cardToShiftId: cardToShift.id,
            cardOwner: 'opponent',
            originalLaneIndex: 0,
            sourceCardId: gravity1.id,
            actor: 'opponent',
            destinationRestriction: { type: 'to_or_from_this_lane', laneIndex: 0 },
        } as any;

        const decision = hardAI(state, state.actionRequired) as any;
        expect(decision.type).toBe('selectLane');
        expect([1, 2]).toContain(decision.laneIndex);
    });
});

describe('Bug 4: face-down plays do not announce the card name', () => {
    it('hides the card name for face-down plays', () => {
        const card = createCard('Fire', 4);
        const msg = playCardMessage('opponent', card, 'Metal', false);

        expect(msg).not.toContain('Fire-4');
        expect(msg).toBe('Opponent plays a face-down card into Protocol Metal.');
    });

    it('shows the card name for face-up plays', () => {
        const card = createCard('Fire', 4);
        const msg = playCardMessage('opponent', card, 'Fire', true);

        expect(msg).toBe('Opponent plays Fire-4 into Protocol Fire.');
    });
});
