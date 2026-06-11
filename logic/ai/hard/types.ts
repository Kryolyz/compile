/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal types for the Hard AI module.
 *
 * The hard AI uses a simulate+evaluate approach: every candidate move is
 * applied to a cloned state via the real game resolvers, then the resulting
 * state is scored by the evaluator. The strategic mode adjusts the
 * evaluation weights so the same evaluator behaves differently based on
 * the current game phase.
 */

import { AIAction, Player } from '../../../types';

/**
 * High-level strategic mode of the AI based on compiled-protocol counts.
 *
 * The mode is the most important parameter for the evaluator: it shifts
 * weights between offense, defense, control hunting, and threat blocking.
 */
export type StrategicMode =
    | 'opening'           // own=0 compiled, opp=0 compiled
    | 'mid_offensive'     // own=1, opp=0  - keep building, watch control
    | 'mid_defensive'     // own=0, opp=1  - disrupt, build cautiously
    | 'mid_equal'         // own=1, opp=1  - fight for control
    | 'closing'           // own=2, opp<=1 - race to 3rd compile, want control to win
    | 'crisis_defense'    // own<=1, opp=2 - max disrupt, force opp to recompile via control
    | 'final_race';       // own=2, opp=2  - first to compile wins

export type HandQualityRating = 'strong' | 'average' | 'weak';

/**
 * Quantitative assessment of a hand. The rating drives the
 * aggressive-vs-defensive bias of the evaluator.
 */
export interface HandQualityAssessment {
    rating: HandQualityRating;
    score: number;             // 0-100 composite score
    matchingCards: number;     // count of cards that match own protocols
    averageValue: number;
    highValueCards: number;    // cards with value >= 4
    hasDisruption: boolean;    // hand contains at least one disruption keyword
}

/**
 * Strategic context: mode + hand assessment + compiled counts.
 * Passed into the evaluator and used by the move generator to bias
 * candidate ordering.
 */
export interface ModeContext {
    mode: StrategicMode;
    handQuality: HandQualityAssessment;
    ownCompiled: number;
    oppCompiled: number;
    perspective: Player;       // The player the AI is acting on behalf of
}

/**
 * A move plus its score. Used internally by the decision dispatcher.
 */
export interface ScoredMove {
    move: AIAction;
    score: number;
    /** Simulated post-move state, cached so the opponent lookahead doesn't re-simulate. */
    simState?: import('../../../types').GameState;
    debug?: string;
}

/**
 * Weights used by the evaluator. Different strategic modes use different
 * weight sets. Centralizing them keeps the evaluator generic.
 */
export interface EvalWeights {
    /** Per compiled lane (huge: this is the win condition) */
    compiledLane: number;
    /** Per point of progress toward 10 in an uncompiled lane (own) */
    closeToCompile: number;
    /** Per point of lane lead over opponent in any lane (small linear bonus) */
    laneLeadFraction: number;
    /** Binary bonus for leading a lane at all (overlay on top of laneLeadFraction).
     *  This is a STEP function - "leading" matters way more than "lead by N". */
    laneLeadBonus: number;
    /** Bonus for currently holding the control component */
    controlHolding: number;
    /** Bonus for currently leading 2+ lanes (will gain/keep control next phase) */
    controlLeading: number;
    /** Bonus when our lead-2+ position would actually FLIP control away from
     *  the opponent (or vice versa as a penalty). This rewards "stealing" moves. */
    controlSwingBonus: number;
    /** Urgency multiplier when the player holds control and we have compiled
     *  lanes - actively fighting back becomes a top priority. */
    controlFightUrgency: number;
    /** Per point of value of a card in hand that matches own protocols */
    handMatchingValue: number;
    /** Per point of value of a card in hand that does NOT match own protocols */
    handGenericValue: number;
    /** Per card remaining in own deck (small bonus) */
    deckEconomy: number;
    /** Penalty when opponent has a lane >= 10 and > our value (compileable next turn) */
    threatPenalty: number;
    /** Penalty for being at 0 hand size (can't play next turn) */
    handSizePenalty: number;
    /** Bonus per face-up card on own board (effects are active) */
    boardFaceUpBonus: number;
    /** Penalty per face-down card on own board (no effect, hidden potential) */
    boardFaceDownPenalty: number;
    /** Extra penalty per face-down card on own board that MATCHES own protocols.
     *  These cards "wasted" their face-up potential - they could have been
     *  played face-up in their matching lane for full lane gain + effect. */
    boardFaceDownMatchingPenalty: number;
}

/**
 * Configuration for the hard AI behavior. Centralized so it's easy to tune.
 */
export interface HardAIConfig {
    /** How many top candidates get a 1-ply opponent-response simulation. 0 = disabled. */
    opponentLookaheadTopK: number;
    /** Maximum recursion depth when resolving cascading sub-actions. */
    maxSimulationDepth: number;
    /** Maximum number of candidate moves to enumerate per decision (safety cap). */
    maxCandidatesPerDecision: number;
    /** Random tiebreak amplitude (small -> deterministic, large -> noisy). */
    tieBreakNoise: number;
    /** When true, the evaluator logs scoring breakdowns to console. Off by default. */
    debugLog: boolean;
}

export const DEFAULT_HARD_AI_CONFIG: HardAIConfig = {
    // 1-ply opponent lookahead for the top K candidates. Very expensive, so
    // we only run it on the few most promising moves and only at the very
    // top of the recursion (never inside cascading sub-decisions).
    opponentLookaheadTopK: 3,
    // Hard cap on cascade recursion. Deep effect chains will fall back to
    // normalAI for the deeper sub-decisions.
    maxSimulationDepth: 12,
    // Safety cap on candidate count per decision. Stops combinatorial blow-up
    // when many cards are on the board.
    maxCandidatesPerDecision: 40,
    // Slight randomness to break ties (pure determinism feels robotic).
    tieBreakNoise: 0.5,
    debugLog: false,
};
