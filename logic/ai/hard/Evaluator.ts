/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Evaluator - the heart of the hard AI.
 *
 * Scores a GameState from a player's perspective. Higher score = better for
 * the perspective player. The evaluator does NOT know about specific cards
 * or protocols - it only looks at the resulting state of a (simulated) move.
 *
 * This is the trick that makes the hard AI strong without card-specific
 * logic: every move is simulated through the real resolvers, and we just
 * ask "is the resulting state good for me?". Effects that don't help -
 * say, deleting a card that uncovers something good for the opponent -
 * naturally produce worse states and get lower scores.
 *
 * Evaluation factors (weights are mode-dependent):
 *  - Compiled lanes (massive)
 *  - Lane progress toward 10 in uncompiled lanes
 *  - Lane leads (you in front in this lane?)
 *  - Threats (opponent can compile this lane next turn?)
 *  - Control component (holding it now? leading 2+ lanes?)
 *  - Hand quality (matching cards, values)
 *  - Deck economy (more cards left = more options)
 *  - Hand size penalty (0 cards = stuck)
 *
 * The mode-aware weights are the second piece of the puzzle: in
 * crisis_defense the threatPenalty is huge and closeToCompile is small,
 * which makes disruption naturally outscore building. In closing mode the
 * opposite is true.
 */

import { GameState, Player } from '../../../types';
import { EvalWeights, ModeContext, StrategicMode } from './types';

export class Evaluator {
    /** Score a state from the perspective player's point of view. */
    evaluate(state: GameState, ctx: ModeContext): number {
        // Terminal states are absolute.
        if (state.winner === ctx.perspective) return 1_000_000;
        if (state.winner !== null) return -1_000_000;

        const weights = this.getWeights(ctx.mode);
        const own = state[ctx.perspective];
        const opp = state[this.otherPlayer(ctx.perspective)];

        let score = 0;

        // 1. Compiled lanes (decisive)
        const ownCompiledCount = own.compiled.filter(Boolean).length;
        const oppCompiledCount = opp.compiled.filter(Boolean).length;
        score += ownCompiledCount * weights.compiledLane;
        score -= oppCompiledCount * weights.compiledLane;

        // 2. Per-lane scoring
        for (let i = 0; i < 3; i++) {
            score += this.scoreLane(state, i, ctx, weights);
        }

        // 3. Control mechanic
        score += this.scoreControl(state, ctx, weights);

        // 4. Hand quality
        score += this.scoreHand(state, ctx, weights);

        // 5. Deck economy (small but matters in long games)
        score += own.deck.length * weights.deckEconomy;
        score -= opp.deck.length * weights.deckEconomy * 0.5;

        // 6. Board presence (having uncovered cards = options/effects available)
        score += this.scoreBoardPresence(state, ctx, weights);

        return score;
    }

    private scoreLane(
        state: GameState,
        laneIdx: number,
        ctx: ModeContext,
        weights: EvalWeights
    ): number {
        const own = state[ctx.perspective];
        const opp = state[this.otherPlayer(ctx.perspective)];
        const ownVal = own.laneValues[laneIdx];
        const oppVal = opp.laneValues[laneIdx];
        const ownCompiledHere = own.compiled[laneIdx];
        const oppCompiledHere = opp.compiled[laneIdx];

        let score = 0;

        // === DOOMED LANE CHECK ===
        // If the opponent can compile this lane on their next turn (>=10 AND
        // ahead of us), EVERYTHING in this lane gets deleted - including our
        // own cards. Investing here is wasted, so our progress in this lane
        // must not earn any credit. (Exception: a play that takes the LEAD
        // here removes the threat - then laneDoomed is false after the move.)
        const laneDoomed = oppVal >= 10 && oppVal > ownVal && !opp.cannotCompile;

        // === BINARY LEAD SIGNAL ===
        // The single most important per-lane question: do I lead this lane?
        // A binary bonus is much stronger than a linear lead-amount bonus -
        // it pushes the AI to actually flip lane ownership for control purposes.
        const ownLeadsLane = ownVal > oppVal;
        const oppLeadsLane = oppVal > ownVal;
        if (ownLeadsLane) score += weights.laneLeadBonus;
        if (oppLeadsLane) score -= weights.laneLeadBonus;

        // === OWN side ===
        if (!ownCompiledHere) {
            // Progress toward compile threshold - worthless in a doomed lane!
            if (!laneDoomed) {
                const compileableProgress = Math.min(ownVal, 10);
                score += compileableProgress * weights.closeToCompile;
            }

            // Lead amount as a small linear bonus on top of the binary lead.
            if (ownLeadsLane) {
                score += (ownVal - oppVal) * weights.laneLeadFraction;
            }

            // Compileable RIGHT NOW (>=10 AND > opponent) -> very valuable...
            if (ownVal >= 10 && ownVal > oppVal && !own.cannotCompile) {
                // ...UNLESS the opponent holds Control AND we have a compiled
                // protocol: before our compile check they can rearrange our
                // compiled protocol ONTO this lane, forcing a worthless
                // recompile that deletes the whole stack (the "recompile trap"
                // the human player used to steal winning compiles!).
                const ownCompiledCount = own.compiled.filter(Boolean).length;
                const oppHasControl = state.useControlMechanic
                    && state.controlCardHolder === this.otherPlayer(ctx.perspective);
                if (oppHasControl && ownCompiledCount >= 1) {
                    score += 40; // compile will most likely be stolen
                } else {
                    score += 250;
                }
            }
            // Almost compileable (>=8) - one good play away
            else if (ownVal >= 8 && !laneDoomed) {
                score += 30;
            }
        } else {
            // Lane is already compiled by us. Building here helps the
            // control fight (leading lanes -> control next phase).
            if (
                ctx.mode === 'closing' ||
                ctx.mode === 'crisis_defense' ||
                ctx.mode === 'final_race'
            ) {
                // Control matters more in these modes -> meaningful bonus
                if (ownLeadsLane) {
                    score += (ownVal - oppVal) * weights.laneLeadFraction * 0.7;
                }
            } else {
                // Earlier game: small bonus for leading a compiled lane
                if (ownLeadsLane) {
                    score += (ownVal - oppVal) * weights.laneLeadFraction * 0.25;
                }
            }

            // CRITICAL: A compiled own lane at >=10 with the lead FORCES a
            // recompile next turn - that wastes the whole turn (compile is the
            // only action!) for a single stolen card. Strongly discourage
            // pushing compiled lanes toward the threshold.
            // Even WITHOUT the lead, >=10 is a trap: any drop of the opponent's
            // value in this lane (their compile, flip, return...) triggers the
            // forced recompile on our next turn.
            if (ownVal >= 10 && ownVal > oppVal && !own.cannotCompile) {
                score -= 110;
            } else if (ownVal >= 10) {
                score -= 60;
            } else if (ownVal >= 8) {
                score -= 30;
            }
        }

        // === OPPONENT side (mirror with negative sign) ===
        if (!oppCompiledHere) {
            const oppProgress = Math.min(oppVal, 10);
            score -= oppProgress * weights.closeToCompile;

            if (oppLeadsLane) {
                score -= (oppVal - ownVal) * weights.laneLeadFraction;
            }

            // CRITICAL: Opponent can compile this lane on their next turn
            if (oppVal >= 10 && oppVal > ownVal && !opp.cannotCompile) {
                score -= weights.threatPenalty;
            }
            // Near compileable
            else if (oppVal >= 8) {
                score -= 40;
            }
        } else {
            // Opponent compiled lane: leading there helps them with control
            if (oppLeadsLane) {
                score -= (oppVal - ownVal) * weights.laneLeadFraction * 0.3;
            }
        }

        return score;
    }

    private scoreControl(state: GameState, ctx: ModeContext, weights: EvalWeights): number {
        if (!state.useControlMechanic) return 0;

        const opp = this.otherPlayer(ctx.perspective);
        let score = 0;

        // === CURRENT HOLDER ===
        // Already holding control: comfortable bonus
        if (state.controlCardHolder === ctx.perspective) {
            score += weights.controlHolding;
            // Holding control with compiled protocols is even better:
            // we can rearrange to set up an immediate compile.
            score += ctx.ownCompiled * 25;
        } else if (state.controlCardHolder === opp) {
            // Player holds control - this is a problem we should fix.
            // Penalty grows with their compiled count (more they can break us).
            score -= weights.controlHolding * 0.8;
            score -= ctx.oppCompiled * 30;
        }

        // === WHO WILL HOLD CONTROL NEXT CONTROL PHASE ===
        // The control phase awards control to whoever leads in 2+ lanes.
        // The transition is BINARY: either we lead 2+ or we don't. So we
        // score "are we set up to take/keep control" as a step function.
        const ownLeads = this.countLanesLeading(state, ctx.perspective);
        const oppLeads = this.countLanesLeading(state, opp);
        const ownWillHaveControl = ownLeads >= 2;
        const oppWillHaveControl = oppLeads >= 2;

        if (ownWillHaveControl) {
            // We're set up to gain/keep control
            score += weights.controlLeading;
            // Extra bonus if this REPLACES the opponent as holder.
            if (state.controlCardHolder === opp) {
                score += weights.controlSwingBonus;
            }
        } else if (ownLeads === 1) {
            // One step away from control. Substantial fraction of the bonus.
            score += weights.controlLeading * 0.4;
        }

        if (oppWillHaveControl) {
            // Opponent is set up to take/keep control - this is bad.
            score -= weights.controlLeading * 0.85;
            // Extra penalty if this STEALS control from us.
            if (state.controlCardHolder === ctx.perspective) {
                score -= weights.controlSwingBonus * 0.85;
            }
        } else if (oppLeads === 1) {
            score -= weights.controlLeading * 0.3;
        }

        // === EXPLICIT CONTROL FIGHTING ===
        // Special case: player currently holds control. Fighting back becomes
        // a high-priority objective once we have any compiled lane (per user's
        // stated strategy). We add an extra urgency multiplier.
        if (state.controlCardHolder === opp && ctx.ownCompiled >= 1) {
            // The closer we are to taking control, the bigger the bonus.
            const distanceToControl = Math.max(0, 2 - ownLeads);
            // distance 0 (we lead 2+) -> +full bonus, distance 1 -> half, distance 2 -> small
            const fightBonus = weights.controlFightUrgency * (1 - distanceToControl * 0.45);
            score += fightBonus;
        }

        // === COMPILE PROTECTION ===
        // When we are close to our next compile AND already own a compiled
        // protocol, Control decides whether that compile actually happens:
        // the holder can rearrange protocols and spring the recompile trap.
        const ownState = state[ctx.perspective];
        const ownNearCompile = ownState.laneValues.some((v, i) => !ownState.compiled[i] && v >= 8);
        if (ownNearCompile && ctx.ownCompiled >= 1) {
            if (state.controlCardHolder === ctx.perspective) score += 60;
            else if (state.controlCardHolder === opp) score -= 90;
        }

        return score;
    }

    private scoreHand(state: GameState, ctx: ModeContext, weights: EvalWeights): number {
        const own = state[ctx.perspective];
        let score = 0;

        for (const card of own.hand) {
            const matches = own.protocols.includes(card.protocol);
            const v = card.value;
            score += v * (matches ? weights.handMatchingValue : weights.handGenericValue);
            // Tiny bonus for high-value matching cards (compile fuel)
            if (matches && v >= 4) score += 1.5;
        }

        // Very small hand = limited options. 0 cards is bad next turn.
        if (own.hand.length === 0) {
            score -= weights.handSizePenalty;
        } else if (own.hand.length === 1) {
            score -= weights.handSizePenalty * 0.3;
        }

        return score;
    }

    private scoreBoardPresence(state: GameState, ctx: ModeContext, weights: EvalWeights): number {
        const own = state[ctx.perspective];
        let score = 0;
        for (const lane of own.lanes) {
            for (const card of lane) {
                if (card.isFaceUp) {
                    score += weights.boardFaceUpBonus;
                } else {
                    score += weights.boardFaceDownPenalty;
                    // Wasted potential: a matching card played face-down
                    // could have been played face-up in its protocol lane
                    // for full lane gain + effect activation.
                    if (own.protocols.includes(card.protocol)) {
                        score += weights.boardFaceDownMatchingPenalty;
                    }
                }
            }
        }
        return score;
    }

    private countLanesLeading(state: GameState, p: Player): number {
        const me = state[p];
        const opp = state[this.otherPlayer(p)];
        let leads = 0;
        for (let i = 0; i < 3; i++) {
            if (me.laneValues[i] > opp.laneValues[i]) leads++;
        }
        return leads;
    }

    private otherPlayer(p: Player): Player {
        return p === 'player' ? 'opponent' : 'player';
    }

    /**
     * Mode-specific weight tables.
     *
     * Reference points for tuning:
     *  - 1 compiled lane = 1000
     *  - 1 progress point in own lane = 8-16 depending on mode
     *  - leading a lane (binary) = 35-90 depending on mode
     *  - holding control = 50-220 depending on mode
     *  - leading 2 lanes (control gain next phase) = 80-250
     *  - control swing bonus (taking it from the player) = +60-200
     *
     * The control numbers are deliberately HIGH so that the AI actively
     * fights for the component. The user explicitly complained that the
     * old AI didn't seem to try to take control.
     */
    private getWeights(mode: StrategicMode): EvalWeights {
        const base: EvalWeights = {
            compiledLane: 1000,
            closeToCompile: 8,
            laneLeadFraction: 4,
            laneLeadBonus: 35,
            controlHolding: 60,
            controlLeading: 80,
            controlSwingBonus: 60,
            controlFightUrgency: 0,
            handMatchingValue: 1.5,
            handGenericValue: 0.6,
            deckEconomy: 0.8,
            threatPenalty: 250,
            handSizePenalty: 80,
            boardFaceUpBonus: 5,
            boardFaceDownPenalty: -2,
            boardFaceDownMatchingPenalty: -8,
        };

        switch (mode) {
            case 'opening':
                // Early: build aggressively, control matters but isn't decisive yet.
                // We strongly prefer face-up plays in matching lanes to compile fast.
                return {
                    ...base,
                    laneLeadBonus: 30,
                    controlHolding: 40,
                    controlLeading: 60,
                    boardFaceUpBonus: 6,
                    boardFaceDownMatchingPenalty: -10,
                };

            case 'mid_offensive':
                // We have 1 compiled. Keep building, but actively fight for control.
                return {
                    ...base,
                    closeToCompile: 9,
                    laneLeadBonus: 50,
                    controlHolding: 90,
                    controlLeading: 130,
                    controlSwingBonus: 100,
                    controlFightUrgency: 80,
                    boardFaceUpBonus: 6,
                    boardFaceDownMatchingPenalty: -8,
                };

            case 'mid_defensive':
                // Opponent leads with 1. Slow our build, disrupt.
                // Hidden cards are slightly more useful for surprise plays.
                return {
                    ...base,
                    closeToCompile: 6,
                    laneLeadBonus: 45,
                    threatPenalty: 350,
                    controlHolding: 100,
                    controlLeading: 130,
                    controlSwingBonus: 90,
                    boardFaceDownPenalty: -1,
                    boardFaceDownMatchingPenalty: -5,
                };

            case 'mid_equal':
                return {
                    ...base,
                    closeToCompile: 7,
                    laneLeadBonus: 60,
                    controlHolding: 130,
                    controlLeading: 170,
                    controlSwingBonus: 130,
                    controlFightUrgency: 120,
                    threatPenalty: 320,
                    boardFaceUpBonus: 6,
                };

            case 'closing':
                // 2 compiled, racing to 3rd. Control = often wins via rearrange.
                // Heavy face-up preference - we need lane progress fast.
                // closeToCompile is high: the last uncompiled lane IS the win.
                return {
                    ...base,
                    closeToCompile: 15,
                    laneLeadBonus: 75,
                    controlHolding: 180,
                    controlLeading: 220,
                    controlSwingBonus: 180,
                    controlFightUrgency: 150,
                    threatPenalty: 350,
                    boardFaceUpBonus: 8,
                    boardFaceDownMatchingPenalty: -12,
                };

            case 'crisis_defense':
                // Opponent at 2. Disrupt at all costs, fight for control HARD.
                // Hiding cards is OK to confuse opponent disruption attempts.
                return {
                    ...base,
                    closeToCompile: 4,
                    laneLeadBonus: 90,
                    threatPenalty: 700,
                    controlHolding: 220,
                    controlLeading: 250,
                    controlSwingBonus: 200,
                    controlFightUrgency: 220,
                    handGenericValue: 0.8,
                    boardFaceDownPenalty: -1,
                    boardFaceDownMatchingPenalty: -3,
                };

            case 'final_race':
                // Both at 2 - whoever compiles next wins.
                return {
                    ...base,
                    closeToCompile: 16,
                    laneLeadBonus: 80,
                    threatPenalty: 500,
                    controlHolding: 180,
                    controlLeading: 200,
                    controlSwingBonus: 150,
                    controlFightUrgency: 130,
                    boardFaceUpBonus: 8,
                    boardFaceDownMatchingPenalty: -12,
                };
        }
    }
}
