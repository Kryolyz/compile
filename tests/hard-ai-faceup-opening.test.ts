/**
 * Regression: the hard AI must NOT open with a face-down play when it holds
 * matching cards of value >= 3. Reported bug: with a realistic PLAYER hand the
 * 1-ply opponent lookahead penalized only the top-K (face-up) candidates with
 * an absolute opponent score, letting unpenalized face-down moves leapfrog.
 */

import { describe, it, expect } from 'vitest';
import { hardAI } from '../logic/ai/hard';
import { GameState, PlayedCard } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { recalculateAllLaneValues } from '../logic/game/stateManager';
import * as fs from 'fs';
import * as path from 'path';

function loadRealProtocol(name: string) {
    const file = path.join('custom_protocols', `${name.toLowerCase()}_custom_protocol.json`);
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function makeRealCard(protocolName: string, value: number): PlayedCard {
    const proto = loadRealProtocol(protocolName);
    const cardData = proto.cards.find((c: any) => c.value === value);
    if (!cardData) throw new Error(`No ${protocolName}-${value}`);
    return {
        id: uuidv4(),
        protocol: protocolName,
        value,
        top: '', middle: '', bottom: '',
        keywords: {},
        isFaceUp: true,
        isRevealed: false,
        customEffects: {
            topEffects: cardData.topEffects || [],
            middleEffects: cardData.middleEffects || [],
            bottomEffects: cardData.bottomEffects || [],
        },
    } as any as PlayedCard;
}

function buildOpeningState(aiHand: PlayedCard[], playerHand: PlayedCard[]): GameState {
    const s: any = {
        player: {
            protocols: ['Water', 'Spirit', 'Light'], lanes: [[], [], []], hand: playerHand,
            deck: [makeRealCard('Water', 4), makeRealCard('Spirit', 2), makeRealCard('Light', 1)],
            discard: [],
            stats: { cardsPlayed: 0, cardsDeleted: 0, compiledLanes: [] },
            laneValues: [0, 0, 0], compiled: [false, false, false], cannotCompile: false,
        },
        opponent: {
            protocols: ['Fire', 'Metal', 'Hate'], lanes: [[], [], []], hand: aiHand,
            deck: [makeRealCard('Fire', 0), makeRealCard('Metal', 0), makeRealCard('Hate', 0)],
            discard: [],
            stats: { cardsPlayed: 0, cardsDeleted: 0, compiledLanes: [] },
            laneValues: [0, 0, 0], compiled: [false, false, false], cannotCompile: false,
        },
        turn: 'opponent', phase: 'action',
        controlCardHolder: null, useControlMechanic: true,
        winner: null, log: [], actionRequired: null, queuedActions: [],
        stats: {
            player: { cardsPlayed: 0, cardsDeleted: 0, compiledLanes: [] },
            opponent: { cardsPlayed: 0, cardsDeleted: 0, compiledLanes: [] },
        },
        compilableLanes: [],
    };
    return recalculateAllLaneValues(s) as GameState;
}

describe('Hard AI: never invests into a lane the player compiles next turn', () => {
    it('avoids playing into the doomed lane', () => {
        for (let i = 0; i < 5; i++) {
            const aiHand = [
                makeRealCard('Fire', 4),
                makeRealCard('Fire', 1),
                makeRealCard('Metal', 3),
                makeRealCard('Hate', 2),
                makeRealCard('Metal', 0),
            ];
            const state = buildOpeningState(aiHand, [
                makeRealCard('Water', 3),
                makeRealCard('Spirit', 2),
            ]);

            // Player's lane 0 is at 12 and leads -> they MUST compile it next
            // turn, wiping both sides. The AI cannot beat 12 with one card.
            state.player.lanes[0] = [
                { ...makeRealCard('Water', 4), isFaceUp: true },
                { ...makeRealCard('Water', 4), isFaceUp: true },
                { ...makeRealCard('Water', 4), isFaceUp: true },
            ];
            const recalced = recalculateAllLaneValues(state);

            const action = hardAI(recalced, null) as any;
            expect(action.type).toBe('playCard');
            // Lane 0 is doomed - any card played there dies with the compile.
            expect(action.laneIndex).not.toBe(0);
        }
    }, 30000);
});

describe('Hard AI: blocks an imminent player compile when possible', () => {
    it('plays into the threatened lane to remove the player lead', () => {
        for (let i = 0; i < 5; i++) {
            const aiHand = [
                makeRealCard('Hate', 3),   // lane 2 block: 8+3=11 vs 11 -> tie, no compile!
                makeRealCard('Fire', 4),
                makeRealCard('Metal', 2),
                makeRealCard('Fire', 1),
                makeRealCard('Metal', 0),
            ];
            const state = buildOpeningState(aiHand, [
                makeRealCard('Water', 3),
                makeRealCard('Spirit', 2),
            ]);

            // Player lane 2 at 11 (compiles next turn), AI lane 2 (Hate) at 8.
            state.player.lanes[2] = [
                { ...makeRealCard('Light', 4), isFaceUp: true },
                { ...makeRealCard('Light', 4), isFaceUp: true },
                { ...makeRealCard('Light', 3), isFaceUp: true },
            ];
            state.opponent.lanes[2] = [
                { ...makeRealCard('Hate', 4), isFaceUp: true },
                { ...makeRealCard('Hate', 4), isFaceUp: true },
            ];
            const recalced = recalculateAllLaneValues(state);
            expect(recalced.player.laneValues[2]).toBe(11);
            expect(recalced.opponent.laneValues[2]).toBe(8);

            const action = hardAI(recalced, null) as any;
            // The ONLY way to stop the compile is Hate-3 into lane 2 (8+3=11, tie).
            expect(action.type).toBe('playCard');
            expect(action.laneIndex).toBe(2);
            expect(action.isFaceUp).toBe(true);
        }
    }, 30000);
});

describe('Hard AI opening: no face-down play with a realistic player hand', () => {
    it('plays face-up on turn 1 even when the player holds a full hand', () => {
        // Run several times - tie-break noise must never produce face-down here.
        for (let i = 0; i < 5; i++) {
            const aiHand = [
                makeRealCard('Fire', 5),
                makeRealCard('Metal', 3),
                makeRealCard('Hate', 3),
                makeRealCard('Fire', 2),
                makeRealCard('Metal', 1),
            ];
            const playerHand = [
                makeRealCard('Water', 5),
                makeRealCard('Spirit', 4),
                makeRealCard('Light', 3),
                makeRealCard('Water', 2),
                makeRealCard('Spirit', 1),
            ];
            const state = buildOpeningState(aiHand, playerHand);

            const action = hardAI(state, null);
            expect(action.type).toBe('playCard');
            const a = action as any;
            const card = state.opponent.hand.find(c => c.id === a.cardId)!;
            expect({ isFaceUp: a.isFaceUp, value: card.value }).toEqual(
                expect.objectContaining({ isFaceUp: true })
            );
            // And it should be a meaningful card, not the 1
            expect(card.value).toBeGreaterThanOrEqual(2);
        }
    }, 30000);
});
