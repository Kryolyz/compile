/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Simulator - applies an AIAction to a cloned state via the REAL game
 * resolvers, then resolves any cascading sub-actions by recursively
 * asking an ActionDecider (the HardAI itself).
 *
 * This is the core of the "no card-specific logic" approach: instead of
 * predicting what an effect will do, we run the effect through the same
 * code paths the real game uses, then look at the resulting state.
 *
 * Important constraints during simulation:
 *  - No animation enqueueing (we don't pass enqueueAnimation)
 *  - No phase progression (we pass a no-op endTurnCb)
 *  - No log mutation (we cleared the log on the cloned state)
 *  - No external side effects (no real game state is touched)
 *
 * If a sub-action requires a player whose perspective we cannot reliably
 * predict (i.e. an interrupt where the human must respond), we stop the
 * cascade and evaluate the state as-is. The evaluator captures most of
 * the relevant value anyway.
 */

import { GameState, AIAction, Player, ActionRequired, EffectContext } from '../../../types';
import * as resolvers from '../../game/resolvers';
import { applyCardActionResult } from '../../game/resolvers/cardResolver';
import { performShuffleTrash } from '../../effects/actions/shuffleExecutor';
import { executeOnPlayEffect } from '../../effectExecutor';
import { log } from '../../utils/log';
import { StateCloner } from './StateCloner';
import { HardAIConfig } from './types';

/** Sub-action decider passed into the simulator for cascade resolution. */
export interface ActionDecider {
    decideForState(state: GameState, perspective: Player): AIAction;
}

/** Result of a simulation: the resulting state plus a flag if it aborted early. */
export interface SimulationResult {
    state: GameState;
    /** True if the simulator stopped due to depth limit, error, or unsupported sub-action. */
    aborted: boolean;
    /** Number of cascade steps performed. */
    steps: number;
}

const NOOP_END_TURN = (s: GameState): GameState => s;
const NOOP_END_GAME = (_w: Player, _s: GameState): void => {};

export class Simulator {
    constructor(
        private readonly cloner: StateCloner,
        private readonly config: HardAIConfig
    ) {}

    /**
     * Apply an action to the state. If the action chain produces sub-actions
     * (cascading actionRequired), the decider is asked to resolve each.
     */
    simulate(
        state: GameState,
        action: AIAction,
        perspective: Player,
        decider: ActionDecider
    ): SimulationResult {
        let current = this.cloner.cloneForSimulation(state);
        let aborted = false;
        let steps = 0;

        try {
            current = this.applyAction(current, action, perspective);
        } catch {
            return { state: current, aborted: true, steps: 0 };
        }

        // Resolve cascading sub-actions until stable.
        while (current.actionRequired && steps < this.config.maxSimulationDepth) {
            steps++;
            // If the actor is the perspective, ask the decider; otherwise stop.
            const actionRequired = current.actionRequired;
            const actor = (actionRequired as any).actor as Player | undefined;
            if (actor && actor !== perspective) {
                // Interrupt for the other player. We don't predict their move
                // here. The evaluator will score the current state with the
                // pending action visible (which is fine - it's their problem).
                aborted = true;
                break;
            }

            try {
                const subAction = decider.decideForState(current, perspective);
                current = this.applyAction(current, subAction, perspective);
            } catch {
                aborted = true;
                break;
            }
        }

        if (steps >= this.config.maxSimulationDepth && current.actionRequired) {
            aborted = true;
        }

        return { state: current, aborted, steps };
    }

    /**
     * Apply a single AIAction by dispatching to the appropriate resolver.
     * Mirrors the relevant paths of aiManager.handleRequiredActionSync but
     * without animations, logging, or phase progression.
     */
    private applyAction(state: GameState, action: AIAction, perspective: Player): GameState {
        switch (action.type) {
            case 'playCard':
                return this.applyPlayCard(state, action, perspective);

            case 'fillHand':
                return resolvers.performFillHand(state, perspective);

            case 'compile':
                return resolvers.performCompile(state, action.laneIndex, NOOP_END_GAME);

            case 'discardCards':
                return this.applyDiscardCards(state, action.cardIds, perspective);

            case 'deleteCard':
            case 'flipCard':
            case 'returnCard':
            case 'shiftCard':
            case 'selectCard': {
                const result = resolvers.resolveActionWithCard(state, action.cardId);
                return applyCardActionResult(result, NOOP_END_TURN);
            }

            case 'selectLane': {
                const result = resolvers.resolveActionWithLane(state, action.laneIndex);
                return applyCardActionResult(result as any, NOOP_END_TURN);
            }

            case 'skip':
                return resolvers.skipAction(state);

            case 'giveCard':
            case 'revealCard':
                return resolvers.resolveActionWithHandCard(state, action.cardId);

            case 'rearrangeProtocols':
                return resolvers.resolveRearrangeProtocols(state, action.newOrder, NOOP_END_GAME);

            case 'resolveSwapProtocols':
                return resolvers.resolveSwapProtocols(state, action.indices, NOOP_END_GAME);

            case 'resolveControlMechanicPrompt':
                return this.applyControlMechanicPrompt(state, action.choice, perspective);

            case 'resolveOptionalEffectPrompt':
                return resolvers.resolveOptionalEffectPrompt(state, action.accept);

            case 'resolveOptionalDiscardCustomPrompt':
                return resolvers.resolveOptionalDiscardCustomPrompt(state, action.accept);

            case 'resolveCustomChoice':
                return resolvers.resolveCustomChoice(state, action.optionIndex);

            case 'resolveRevealBoardCardPrompt':
                return resolvers.resolveRevealBoardCardPrompt(state, action.choice);

            case 'resolvePrompt':
                return this.applyResolvePrompt(state, action.accept, perspective);

            case 'stateNumber':
                return resolvers.resolveStateNumberAction(state, action.number);

            case 'stateProtocol':
                return resolvers.resolveStateProtocolAction(state, action.protocol);

            case 'selectFromDrawnToReveal':
                return resolvers.resolveSelectFromDrawnToReveal(state, action.cardId);

            case 'confirmDeckDiscard':
                return resolvers.resolveConfirmDeckDiscard(state);

            case 'confirmDeckPlayPreview':
                return resolvers.resolveConfirmDeckPlayPreview(state);

            case 'selectRevealedDeckCard':
                return resolvers.resolveSelectRevealedDeckCard(state, action.cardId);

            case 'selectTrashCard':
                return this.applyTrashCardSelection(state, action.cardIndex);

            case 'resolveShuffleTrashPrompt':
                return this.applyShuffleTrashPrompt(state, action.accept, perspective);

            // Unity-4: just clears the action - aiManager handles the actual draw.
            case 'confirmRevealDeckDrawProtocol' as any:
                return resolvers.resolveRevealDeckDrawProtocol
                    ? resolvers.resolveRevealDeckDrawProtocol(state)
                    : { ...state, actionRequired: null };

            default:
                // Unknown action -> clear actionRequired and let the evaluator score the state.
                return { ...state, actionRequired: null };
        }
    }

    private applyPlayCard(
        state: GameState,
        action: Extract<AIAction, { type: 'playCard' }>,
        perspective: Player
    ): GameState {
        // playCard returns EffectResult ({ newState, animationRequests })
        const result = resolvers.playCard(
            { ...state, actionRequired: null },
            action.cardId,
            action.laneIndex,
            action.isFaceUp,
            perspective
        );
        let next = result.newState;
        // Mark that the card was played in the action phase. The real flow
        // sets _cardPlayedThisActionPhase; mirroring it here keeps phase logic
        // consistent if the simulator is later extended to advance phases.
        (next as any)._cardPlayedThisActionPhase = true;

        // CRITICAL: Execute the queued on-play (middle) effect, exactly like
        // runOpponentTurnSync does. Without this, face-up plays never show
        // their effect value in the evaluation - draws, deletes, flips etc.
        // would be invisible and face-up plays systematically underrated.
        if (!next.actionRequired && next.queuedEffect) {
            const { card: effectCard, laneIndex: effectLane } = next.queuedEffect;
            const onPlayContext: EffectContext = {
                cardOwner: perspective,
                actor: perspective,
                currentTurn: next.turn,
                opponent: perspective === 'player' ? 'opponent' : 'player',
                triggerType: 'play',
            };
            const onPlayResult = executeOnPlayEffect(effectCard, effectLane, next, onPlayContext);
            next = { ...onPlayResult.newState, queuedEffect: undefined };
        }

        return next;
    }

    private applyDiscardCards(state: GameState, cardIds: string[], perspective: Player): GameState {
        const ar = state.actionRequired as any;
        if (ar && ar.type === 'discard' && (ar.variableCount || (ar.count > 1))) {
            return resolvers.resolveVariableDiscard(state, cardIds);
        }
        // Single discard from hand or from a discard prompt for a single card
        if (cardIds.length === 1 && ar?.type === 'discard') {
            return resolvers.discardCardFromHand(state, cardIds[0]);
        }
        return resolvers.discardCards(state, cardIds, perspective);
    }

    private applyTrashCardSelection(state: GameState, cardIndex: number): GameState {
        const ar = state.actionRequired as any;
        if (ar?.type === 'select_card_from_trash_to_play') {
            return resolvers.resolveSelectTrashCardToPlay(state, cardIndex);
        }
        if (ar?.type === 'select_card_from_trash_to_reveal') {
            return resolvers.resolveSelectTrashCardToReveal(state, cardIndex);
        }
        return state;
    }

    private applyShuffleTrashPrompt(state: GameState, accept: boolean, perspective: Player): GameState {
        if (!accept) {
            const cleared = { ...state, actionRequired: null };
            return cleared;
        }
        const result = performShuffleTrash(state, perspective, 'Clarity-4');
        return result.newState;
    }

    private applyResolvePrompt(state: GameState, accept: boolean, perspective: Player): GameState {
        const ar = state.actionRequired as any;
        if (ar?.type === 'prompt_optional_shuffle_trash') {
            return this.applyShuffleTrashPrompt(state, accept, perspective);
        }
        // Generic accept/skip - clear actionRequired
        return { ...state, actionRequired: null };
    }

    /**
     * Mirrors aiManager's handling of prompt_use_control_mechanic.
     * For 'skip': just clears the actionRequired (no log).
     * For 'player'/'opponent': sets up a follow-up prompt_rearrange_protocols.
     */
    private applyControlMechanicPrompt(
        state: GameState,
        choice: 'player' | 'opponent' | 'skip',
        perspective: Player
    ): GameState {
        const ar = state.actionRequired as any;
        if (ar?.type !== 'prompt_use_control_mechanic') return state;

        const { originalAction, actor } = ar;

        if (choice === 'skip') {
            const skipped = { ...state, actionRequired: null as ActionRequired };
            // The real flow either re-enters compile (if originalAction was compile)
            // or fills the hand (if refresh). For simulation we keep it simple:
            // just clear the action and let downstream eval consider the result.
            if (originalAction?.type === 'compile') {
                return { ...skipped, phase: 'compile' };
            }
            if (originalAction?.type === 'fill_hand') {
                return resolvers.performFillHand(skipped, actor);
            }
            return skipped;
        }

        // 'player' or 'opponent' -> create the follow-up rearrange prompt.
        const target = choice;
        return {
            ...state,
            actionRequired: {
                type: 'prompt_rearrange_protocols',
                sourceCardId: 'CONTROL_MECHANIC',
                target,
                actor,
                originalAction,
            } as any,
        };
    }
}
