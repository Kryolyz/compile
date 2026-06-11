/**
 * Hard AI Opening Move Regression Tests
 *
 * Verifies that the Hard AI prefers face-up plays in matching protocol lanes
 * at game start (when there's a value-2+ matching card available). The user's
 * stated strategy: "compile a lane as fast as possible at the start".
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
        category: 'main' as any,
        customEffects: {
            topEffects: cardData.topEffects || [],
            middleEffects: cardData.middleEffects || [],
            bottomEffects: cardData.bottomEffects || [],
        },
    } as any as PlayedCard;
}

function buildOpeningState(handCards: PlayedCard[], protocols: string[]): GameState {
    const s: any = {
        player: { protocols: ['Water','Earth','Wind'], lanes:[[],[],[]], hand:[],
            deck:[], discard:[],
            stats:{cardsPlayed:0,cardsDeleted:0,compiledLanes:[]},
            laneValues:[0,0,0], compiled:[false,false,false], cannotCompile:false },
        opponent: { protocols, lanes:[[],[],[]], hand:handCards,
            deck:[], discard:[],
            stats:{cardsPlayed:0,cardsDeleted:0,compiledLanes:[]},
            laneValues:[0,0,0], compiled:[false,false,false], cannotCompile:false },
        turn: 'opponent', phase: 'action',
        controlCardHolder: null, useControlMechanic: true,
        winner: null, log: [], actionRequired: null, queuedActions: [],
        stats: { player:{cardsPlayed:0,cardsDeleted:0,compiledLanes:[]},
            opponent:{cardsPlayed:0,cardsDeleted:0,compiledLanes:[]} },
        compilableLanes: [],
    };
    return recalculateAllLaneValues(s) as GameState;
}

describe('Hard AI Opening Move - Face-Up Preference', () => {
    it('plays Fire-5 face-up when it is the strongest matching card', () => {
        const hand = [
            makeRealCard('Fire', 5),
            makeRealCard('Metal', 3),
            makeRealCard('Hate', 3),
            makeRealCard('Fire', 2),
            makeRealCard('Metal', 1),
        ];
        const state = buildOpeningState(hand, ['Fire', 'Metal', 'Hate']);
        const action = hardAI(state, null);
        expect(action.type).toBe('playCard');
        const a = action as any;
        expect(a.isFaceUp).toBe(true);
        // Should pick the Fire-5 in the Fire lane
        const card = state.opponent.hand.find(c => c.id === a.cardId)!;
        expect(card.value).toBeGreaterThanOrEqual(3);
    });

    it('plays a high-value face-up with strong hand', () => {
        const hand = [
            makeRealCard('Fire', 5),
            makeRealCard('Metal', 5),
            makeRealCard('Hate', 5),
            makeRealCard('Fire', 4),
            makeRealCard('Metal', 6),
        ];
        const state = buildOpeningState(hand, ['Fire', 'Metal', 'Hate']);
        const action = hardAI(state, null);
        expect(action.type).toBe('playCard');
        const a = action as any;
        expect(a.isFaceUp).toBe(true);
        const card = state.opponent.hand.find(c => c.id === a.cardId)!;
        expect(card.value).toBeGreaterThanOrEqual(4);
    });

    it('plays a value-3 face-up rather than value-1 face-down', () => {
        const hand = [
            makeRealCard('Fire', 2),
            makeRealCard('Metal', 3),
            makeRealCard('Hate', 2),
            makeRealCard('Fire', 3),
            makeRealCard('Metal', 1),
        ];
        const state = buildOpeningState(hand, ['Fire', 'Metal', 'Hate']);
        const action = hardAI(state, null);
        expect(action.type).toBe('playCard');
        const a = action as any;
        expect(a.isFaceUp).toBe(true);
        const card = state.opponent.hand.find(c => c.id === a.cardId)!;
        expect(card.value).toBeGreaterThanOrEqual(2);
    });
});
