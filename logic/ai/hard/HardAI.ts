/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HardAI - the main orchestration class for the hard difficulty.
 *
 * Decision flow:
 *  1. Detect strategic mode (mode + hand quality)
 *  2. Generate candidate moves via MoveGenerator
 *  3. For each candidate:
 *     a. Simulate the move on a cloned state via Simulator (which uses
 *        the real game resolvers)
 *     b. Cascading sub-decisions inside the simulation are answered by a
 *        cheap NormalAI-based decider, NOT by HardAI itself. This keeps
 *        simulation cost bounded - we'd otherwise get combinatorial blow-up.
 *     c. Evaluate the resulting state via Evaluator with mode-aware weights
 *  4. (Optional) For top-K candidates, simulate the player's best response
 *     and subtract their gain from our score (1-ply minimax)
 *  5. Pick the highest-scoring move
 *
 * Why this works without card-specific logic: every effect is run through
 * the actual game logic during simulation, so the AI naturally accounts
 * for uncover effects, reactive effects, and chain reactions. The hard AI
 * never tries to "predict" what an effect will do.
 *
 * Why normalAI for cascades: HardAI is asked for the SAME decision the
 * aiManager would normally ask for. The cascade is what happens AFTER our
 * top-level move - selecting effect targets etc. NormalAI handles that
 * adequately and is much faster than recursive HardAI. The strength of
 * HardAI comes from picking the right TOP-LEVEL move (which card, where,
 * face up or down, refresh or not).
 *
 * Safety: if anything goes wrong, the dispatcher falls back to the normal
 * AI for that single decision. The hard AI can never play worse than normal.
 */

import { GameState, AIAction, ActionRequired, Player } from '../../../types';
import { normalAI } from '../normal';
import { StateCloner } from './StateCloner';
import { HandQualityAssessor } from './HandQuality';
import { ModeDetector } from './ModeDetector';
import { Evaluator } from './Evaluator';
import { Simulator, ActionDecider } from './Simulator';
import { MoveGenerator } from './MoveGenerator';
import {
    DEFAULT_HARD_AI_CONFIG,
    HardAIConfig,
    ModeContext,
    ScoredMove,
} from './types';

/**
 * A cheap decider that uses normalAI for sub-decisions during simulation.
 * Used by HardAI to keep simulation cost bounded.
 */
class NormalAIDecider implements ActionDecider {
    decideForState(state: GameState, _perspective: Player): AIAction {
        return normalAI(state, state.actionRequired);
    }
}

export class HardAI {
    private readonly cloner: StateCloner;
    private readonly handAssessor: HandQualityAssessor;
    private readonly modeDetector: ModeDetector;
    private readonly evaluator: Evaluator;
    private readonly simulator: Simulator;
    private readonly moveGenerator: MoveGenerator;
    private readonly subDecider: NormalAIDecider;

    constructor(private readonly config: HardAIConfig = DEFAULT_HARD_AI_CONFIG) {
        this.cloner = new StateCloner();
        this.handAssessor = new HandQualityAssessor();
        this.modeDetector = new ModeDetector(this.handAssessor);
        this.evaluator = new Evaluator();
        this.simulator = new Simulator(this.cloner, config);
        this.moveGenerator = new MoveGenerator(config);
        this.subDecider = new NormalAIDecider();
    }

    // -------------------------------------------------------------------------
    // PUBLIC ENTRY POINT - matches easyAI/normalAI signature
    // -------------------------------------------------------------------------

    decide(state: GameState, action: ActionRequired | null): AIAction {
        // Hard AI always plays as the opponent (the human is 'player').
        const perspective: Player = 'opponent';

        try {
            return this.decideInternal(state, action, perspective);
        } catch (err) {
            // Last-ditch fallback: never throw out of the AI.
            this.debugLog('HardAI exception, falling back to normalAI', err);
            return normalAI(state, action);
        }
    }

    // -------------------------------------------------------------------------
    // INTERNAL DECISION DISPATCH
    // -------------------------------------------------------------------------

    private decideInternal(
        state: GameState,
        action: ActionRequired | null,
        perspective: Player
    ): AIAction {
        const ctx = this.modeDetector.detect(state, perspective);

        // Generate candidates
        const candidates: AIAction[] = action
            ? this.moveGenerator.generateForAction(state, action, perspective)
            : this.moveGenerator.generateTopLevel(state, perspective);

        // Edge case: no candidates -> fallback to normal AI
        if (candidates.length === 0) {
            return normalAI(state, action);
        }

        // Single candidate -> just take it
        if (candidates.length === 1) {
            return candidates[0];
        }

        // Score every candidate via simulate+evaluate
        const scored: ScoredMove[] = [];
        for (const move of candidates) {
            scored.push(this.scoreMove(state, move, perspective, ctx));
        }

        // Sort high to low
        scored.sort((a, b) => b.score - a.score);

        // Optional 1-ply opponent response for the top-K candidates.
        // CRITICAL: The lookahead may only RE-RANK the top-K among themselves.
        // It must never let an unadjusted candidate (rank K+1) leapfrog the
        // adjusted ones - that bug made the AI prefer face-down plays, because
        // the strongest (face-up) moves were the only ones being penalized.
        let pool = scored;
        if (this.config.opponentLookaheadTopK > 0 && scored.length > 1) {
            const k = Math.min(this.config.opponentLookaheadTopK, scored.length);
            pool = scored.slice(0, k);
            this.applyOpponentResponseLookahead(pool, ctx);
            pool.sort((a, b) => b.score - a.score);
        }

        // Tie-break with small noise (deterministic-ish)
        if (this.config.tieBreakNoise > 0 && pool.length > 1) {
            const top = pool[0].score;
            // If the next-best is within 0.5, do a tiny shuffle on the top group
            const tiedGroup = pool.filter(m => Math.abs(m.score - top) < 1);
            if (tiedGroup.length > 1) {
                // Light noise: keep first tied move 95% of the time, sometimes pick another
                if (Math.random() < this.config.tieBreakNoise / 10) {
                    // Pick a random member of tiedGroup
                    return tiedGroup[Math.floor(Math.random() * tiedGroup.length)].move;
                }
            }
        }

        return pool[0].move;
    }

    // -------------------------------------------------------------------------
    // SCORING
    // -------------------------------------------------------------------------

    private scoreMove(
        state: GameState,
        move: AIAction,
        perspective: Player,
        ctx: ModeContext
    ): ScoredMove {
        // Use the cheap NormalAI sub-decider for cascades. This bounds the
        // total work per top-level decision (no recursive HardAI calls).
        const sim = this.simulator.simulate(state, move, perspective, this.subDecider);
        const score = this.evaluator.evaluate(sim.state, ctx);
        // Cache the simulated state so the opponent lookahead can reuse it.
        return { move, score, simState: sim.state };
    }

    /**
     * 1-ply minimax for the already-scored top candidates: simulate the
     * player's possible responses to each move and re-evaluate the position
     * FROM OUR PERSPECTIVE afterwards. The player is assumed to pick the
     * response that is worst for us.
     *
     * CRITICAL: All scores stay in OUR currency (evaluate with our ctx).
     * The old version subtracted the player's ABSOLUTE evaluation, which is
     * not comparable across candidates and systematically crushed strong
     * moves while leaving weak ones untouched.
     *
     * The final score blends the immediate result with the worst-case
     * after-reply result (we don't fully trust our model of the human).
     */
    private applyOpponentResponseLookahead(
        scored: ScoredMove[],
        ctx: ModeContext
    ): void {
        for (const item of scored) {
            try {
                // Post-move state was cached by scoreMove.
                const afterState = item.simState;
                if (!afterState || afterState.winner) continue;

                // CRITICAL: If our move left a pending interrupt for the player
                // (e.g. a forced discard), settle it FIRST via the cheap decider.
                // Otherwise the response generation only sees the interrupt and
                // never the player's real threats (like their mandatory compile)
                // - making interrupt-leaving moves look deceptively safe.
                let afterStatePlayer: GameState = afterState;
                if (afterStatePlayer.actionRequired && (afterStatePlayer.actionRequired as any).actor === 'player') {
                    try {
                        const interruptAction = this.subDecider.decideForState(afterStatePlayer, 'player');
                        afterStatePlayer = this.simulator.simulate(afterStatePlayer, interruptAction, 'player', this.subDecider).state;
                    } catch {
                        // keep the unsettled state
                    }
                }

                // Simulate the player's responses on THEIR turn. This matters
                // for performCompile, which compiles for state.turn.
                if (!afterStatePlayer.actionRequired) {
                    afterStatePlayer = { ...afterStatePlayer, turn: 'player' };
                }

                // Generate player candidates and find OUR worst case.
                const playerMoves = afterStatePlayer.actionRequired
                    ? this.moveGenerator.generateForAction(afterStatePlayer, afterStatePlayer.actionRequired, 'player')
                    : this.moveGenerator.generateTopLevel(afterStatePlayer, 'player');

                // CRITICAL: Include the player's MANDATORY compile as a response.
                // Compiling wipes BOTH sides of the lane - without this the AI
                // happily played cards into lanes the player compiles next turn.
                if (!afterStatePlayer.actionRequired) {
                    for (let lane = 0; lane < 3; lane++) {
                        const playerVal = afterStatePlayer.player.laneValues[lane];
                        const ownVal = afterStatePlayer.opponent.laneValues[lane];
                        if (playerVal >= 10 && playerVal > ownVal && !afterStatePlayer.player.cannotCompile) {
                            playerMoves.unshift({ type: 'compile', laneIndex: lane });
                        }
                    }
                }

                let worstForUs = Infinity;
                const playerCandidatesToTry = Math.min(playerMoves.length, 6);
                for (let j = 0; j < playerCandidatesToTry; j++) {
                    try {
                        const playerSim = this.simulator.simulate(afterStatePlayer, playerMoves[j], 'player', this.subDecider);
                        const ourScore = this.evaluator.evaluate(playerSim.state, ctx);
                        if (ourScore < worstForUs) worstForUs = ourScore;
                    } catch {
                        // ignore failed sub-sim
                    }
                }

                if (worstForUs !== Infinity) {
                    item.score = item.score * 0.5 + worstForUs * 0.5;
                }
            } catch {
                // Ignore any failure - leave score as-is
            }
        }
    }

    // -------------------------------------------------------------------------
    // UTIL
    // -------------------------------------------------------------------------

    private debugLog(...args: any[]): void {
        if (this.config.debugLog) {
            // eslint-disable-next-line no-console
            console.log('[HardAI]', ...args);
        }
    }
}
