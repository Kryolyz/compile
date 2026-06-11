/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HandQualityAssessor - evaluates how strong a hand is.
 *
 * The user's strategic insight: a strong hand (e.g. Metal-5 + Metal-6)
 * justifies an aggressive playstyle, while a weak hand pushes the AI
 * toward defensive disruption. The hand quality assessment feeds into
 * mode detection and into the move generator's prioritization.
 *
 * Quality is measured along four axes:
 *  - protocol match: more cards matching own protocols = stronger
 *  - average value: higher = stronger
 *  - high-value cards (>=4): more = stronger
 *  - disruption presence: cards that can delete/flip/shift/return/discard
 */

import { GameState, Player, PlayedCard } from '../../../types';
import { HandQualityAssessment, HandQualityRating } from './types';

const DISRUPTION_KEYWORDS = ['delete', 'flip', 'shift', 'return', 'discard'];

export class HandQualityAssessor {
    assess(state: GameState, player: Player): HandQualityAssessment {
        const ps = state[player];
        const hand = ps.hand;

        if (hand.length === 0) {
            return {
                rating: 'weak',
                score: 0,
                matchingCards: 0,
                averageValue: 0,
                highValueCards: 0,
                hasDisruption: false,
            };
        }

        let matchingCards = 0;
        let totalValue = 0;
        let highValueCards = 0;
        let hasDisruption = false;

        for (const card of hand) {
            if (ps.protocols.includes(card.protocol)) matchingCards++;
            totalValue += card.value;
            if (card.value >= 4) highValueCards++;
            if (this.cardHasDisruption(card)) hasDisruption = true;
        }

        const averageValue = totalValue / hand.length;

        // Composite 0-100 score combining the four axes.
        let score = 0;
        score += (matchingCards / hand.length) * 40; // protocol fit: up to 40
        score += Math.min(averageValue / 6, 1) * 30; // value strength: up to 30
        score += (highValueCards / hand.length) * 20; // big-card density: up to 20
        if (hasDisruption) score += 10;              // disruption presence: 10 flat

        const rating: HandQualityRating =
            score >= 60 ? 'strong' : score >= 35 ? 'average' : 'weak';

        return {
            rating,
            score,
            matchingCards,
            averageValue,
            highValueCards,
            hasDisruption,
        };
    }

    private cardHasDisruption(card: PlayedCard): boolean {
        if (!card.keywords) return false;
        return DISRUPTION_KEYWORDS.some(kw => (card.keywords as any)[kw]);
    }
}
