/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MoveGenerator - enumerates legal candidate AIActions for any decision context.
 *
 * The hard AI doesn't try to predict which moves are good - it generates ALL
 * (within reason) reasonable candidates and lets the simulator+evaluator pick.
 * That removes the need for card-specific heuristics: the move generator only
 * needs to know what is LEGAL, not what is optimal.
 *
 * Two main entry points:
 *
 *  - generateTopLevel(state, perspective): no actionRequired, AI is choosing
 *    a top-level action (play a card or refresh hand).
 *
 *  - generateForAction(state, action, perspective): an actionRequired exists
 *    and we need to produce candidate responses (target choices, prompt
 *    answers, etc.).
 *
 * The generator imports passive-rule checks (canPlayCard, isFrost1Active)
 * so it never produces an illegal move.
 */

import {
    GameState,
    AIAction,
    Player,
    PlayedCard,
    ActionRequired,
    TargetFilter,
} from '../../../types';
import { canPlayCard, isFrost1Active } from '../../game/passiveRuleChecker';
import { findCardOnBoard, isCardCommitted } from '../../game/helpers/actionUtils';
import { HardAIConfig } from './types';

export class MoveGenerator {
    constructor(private readonly config: HardAIConfig) {}

    // -------------------------------------------------------------------------
    // TOP LEVEL: no actionRequired
    // -------------------------------------------------------------------------

    /**
     * Generate candidate top-level moves based on the current game phase:
     *  - compile phase: one compile action per compileable lane (mandatory phase!)
     *  - action phase: playCard for each (card, lane, face-up/down) combo, plus fillHand
     *  - other phases: fall back to a no-op skip (the aiManager doesn't ask
     *    the AI for moves outside compile/action phases)
     *
     * The aiManager dispatches by phase and expects a matching action type:
     *  - phase=compile + compilableLanes.length > 0  →  expects { type: 'compile', laneIndex }
     *  - phase=action + !cardPlayedThisActionPhase   →  expects 'playCard' or 'fillHand'
     */
    generateTopLevel(state: GameState, perspective: Player): AIAction[] {
        // CRITICAL: compile phase is MANDATORY when compilable - the AI must
        // return a compile action, not a play/refresh. Generating any other
        // type here softlocks the aiManager loop.
        if (state.phase === 'compile' && state.compilableLanes && state.compilableLanes.length > 0) {
            return state.compilableLanes.map(laneIndex => ({
                type: 'compile',
                laneIndex,
            }));
        }

        const moves: AIAction[] = [];
        const ps = state[perspective];

        // 1. Refresh hand (only legal if hand size < 5)
        if (ps.hand.length < 5) {
            moves.push({ type: 'fillHand' });
        }

        // 2. Play card moves
        for (const card of ps.hand) {
            // Face-up play: only in lanes where the card can legally be played face-up
            for (let laneIdx = 0; laneIdx < 3; laneIdx++) {
                const allowed = canPlayCard(state, perspective, laneIdx, true, card.protocol, card);
                if (allowed.allowed) {
                    moves.push({
                        type: 'playCard',
                        cardId: card.id,
                        laneIndex: laneIdx,
                        isFaceUp: true,
                    });
                }
            }
            // Face-down play: any lane (passive rules permitting)
            for (let laneIdx = 0; laneIdx < 3; laneIdx++) {
                const allowed = canPlayCard(state, perspective, laneIdx, false, card.protocol, card);
                if (allowed.allowed) {
                    moves.push({
                        type: 'playCard',
                        cardId: card.id,
                        laneIndex: laneIdx,
                        isFaceUp: false,
                    });
                }
            }
        }

        return moves;
    }

    // -------------------------------------------------------------------------
    // ACTION-REQUIRED DISPATCH
    // -------------------------------------------------------------------------

    /**
     * Generate candidate moves for the current actionRequired.
     * Always returns at least one move; on a fully unrecognized action it
     * returns a 'skip'.
     */
    generateForAction(state: GameState, action: ActionRequired, perspective: Player): AIAction[] {
        if (!action) return [{ type: 'skip' }];

        switch (action.type) {
            // ---- DISCARD ----
            case 'discard':
                return this.genDiscard(state, action, perspective);

            // ---- CARD SELECTION (delete/flip/shift/return) ----
            case 'select_cards_to_delete':
                return this.genCardTargets(state, action, perspective, 'deleteCard');
            case 'select_card_to_flip':
                return this.genCardTargets(state, action, perspective, 'flipCard');
            case 'select_card_to_shift':
                return this.genCardTargets(state, action, perspective, 'shiftCard');
            case 'select_card_to_return':
                return this.genCardTargets(state, action, perspective, 'returnCard');

            // ---- LANE SELECTION ----
            case 'select_lane_for_shift':
            case 'select_lane_for_shift_all':
            case 'select_lane_for_delete':
            case 'select_lane_for_delete_all':
            case 'select_lane_for_play':
            case 'select_lane_for_return':
                return this.genLaneSelection(state, action);
            case 'select_lanes_for_swap_stacks':
                return this.genLaneSelection(state, action);

            // "You may shift the flipped card" (Time-2, Darkness-1, Spirit-3):
            // resolved via LANE selection (laneResolver), NOT via card selection!
            // CRITICAL: must come before the generic fallback - the type name
            // contains both "shift" and "flip" and would be misrouted there.
            case 'shift_flipped_card_optional' as any:
            case 'gravity_2_shift_after_flip' as any:
                return this.genShiftFlippedCardLanes(state, action);

            // ---- HAND CARD SELECTION ----
            case 'select_card_from_hand_to_play':
                return this.genHandPlay(state, action, perspective);
            case 'select_card_from_hand_to_give':
                return this.genHandSelect(state, perspective, 'giveCard');
            case 'select_card_from_hand_to_reveal':
                return this.genHandSelect(state, perspective, 'revealCard');

            // ---- PROMPT/CHOICE ----
            case 'prompt_use_control_mechanic':
                return [
                    { type: 'resolveControlMechanicPrompt', choice: 'skip' },
                    { type: 'resolveControlMechanicPrompt', choice: 'opponent' },
                    { type: 'resolveControlMechanicPrompt', choice: 'player' },
                ];
            case 'prompt_optional_effect':
                return [
                    { type: 'resolveOptionalEffectPrompt', accept: true },
                    { type: 'resolveOptionalEffectPrompt', accept: false },
                ];
            // CRITICAL: 'prompt_optional_draw' is dispatched by aiManager via the
            // 'resolveOptionalEffectPrompt' branch, NOT a dedicated handler.
            case 'prompt_optional_draw' as any:
                return [
                    { type: 'resolveOptionalEffectPrompt', accept: true },
                    { type: 'resolveOptionalEffectPrompt', accept: false },
                ];
            case 'prompt_optional_discard_custom':
                return [
                    { type: 'resolveOptionalDiscardCustomPrompt', accept: true },
                    { type: 'resolveOptionalDiscardCustomPrompt', accept: false },
                ];
            // CRITICAL: aiManager dispatches 'prompt_optional_shuffle_trash' on
            // 'resolvePrompt' (not 'resolveShuffleTrashPrompt'), so we must
            // return the matching AIAction type or the move is silently dropped.
            case 'prompt_optional_shuffle_trash':
                return [
                    { type: 'resolvePrompt', accept: true },
                    { type: 'resolvePrompt', accept: false },
                ];
            // Unity-4 reveal-and-draw is auto-confirmed by aiManager.
            case 'reveal_deck_draw_protocol' as any:
                return [{ type: 'confirmRevealDeckDrawProtocol' as any }];
            case 'prompt_shift_or_flip_revealed_card':
                return this.genShiftOrFlipPrompt(action);
            case 'custom_choice':
                return this.genCustomChoice(action);

            // ---- REARRANGE / SWAP ----
            case 'prompt_rearrange_protocols':
                return this.genRearrangeProtocols(state, action);
            case 'prompt_swap_protocols':
                return this.genSwapProtocols(state, action);

            // ---- LUCK PROTOCOL ----
            case 'state_number':
                return this.genStateNumber();
            case 'state_protocol':
                return this.genStateProtocol(action);
            case 'select_from_drawn_to_reveal':
                return this.genSelectFromDrawnToReveal(action);
            case 'confirm_deck_discard':
                return [{ type: 'confirmDeckDiscard' }];
            case 'confirm_deck_play_preview':
                return [{ type: 'confirmDeckPlayPreview' }];

            // ---- CLARITY / TIME ----
            case 'select_card_from_revealed_deck':
                return this.genRevealedDeckCards(action);
            case 'select_card_from_trash_to_play':
            case 'select_card_from_trash_to_reveal':
                return this.genTrashCards(state, action, perspective);

            // ---- MIRROR / COPY ----
            case 'select_card_for_copy_middle':
                return this.genCopyMiddle(action);

            // ---- BOARD CARD REVEAL (Light-2 etc.) ----
            // Resolved via resolveActionWithCard -> needs a cardId selection.
            case 'select_board_card_to_reveal' as any:
            case 'select_board_card_to_reveal_custom' as any:
                return this.genFaceDownBoardCards(state, action);

            // Same prompt family as prompt_shift_or_flip_revealed_card.
            case 'prompt_shift_or_flip_board_card_custom' as any:
                return this.genShiftOrFlipPrompt(action);

            // ---- PHASE EFFECT ORDER (Start/End with 2+ effects) ----
            // Resolved via resolveActionWithCard with the chosen effect's cardId.
            case 'select_phase_effect':
                return this.genPhaseEffectSelection(action);

            // ---- AUTO-RESOLVE / NO-OP ACTIONS ----
            case 'reveal_opponent_hand':
                return [{ type: 'skip' }]; // auto-resolves elsewhere

            default:
                return this.genFallbackForLegacy(state, action, perspective);
        }
    }

    // -------------------------------------------------------------------------
    // HELPERS - DISCARD
    // -------------------------------------------------------------------------

    private genDiscard(state: GameState, action: any, perspective: Player): AIAction[] {
        const ps = state[perspective];
        const hand = ps.hand;
        if (hand.length === 0) return [{ type: 'discardCards', cardIds: [] }];

        const count = Math.min(action.count ?? 1, hand.length);
        // For variableCount or upTo, we generate several count choices
        const isVariable = !!action.variableCount;
        const isUpTo = !!action.upTo;

        // Sort hand by ascending value (cheapest to discard first)
        const sorted = [...hand].sort((a, b) => a.value - b.value);

        const choices: number[] = [];
        if (isVariable) {
            // variableCount = "discard COUNT or more" (Plague-2: "1 or more").
            // The minimum is `count` - discarding fewer is NOT legal!
            choices.push(count);
            if (hand.length >= count + 1) choices.push(count + 1);
            if (hand.length >= count + 2) choices.push(count + 2);
            choices.push(hand.length);
        } else if (isUpTo) {
            // upTo = "discard up to COUNT" - 0 is allowed here.
            choices.push(0);
            choices.push(Math.min(1, count));
            if (count >= 2) choices.push(2);
            choices.push(count);
        } else {
            choices.push(count);
        }

        const seen = new Set<string>();
        const moves: AIAction[] = [];
        for (const ct of choices) {
            // Strategy 1: discard the lowest-value cards
            const cardIdsLow = sorted.slice(0, ct).map(c => c.id);
            const keyLow = cardIdsLow.slice().sort().join(',');
            if (!seen.has(keyLow)) {
                seen.add(keyLow);
                moves.push({ type: 'discardCards', cardIds: cardIdsLow });
            }
            // Strategy 2: discard non-matching cards first (keep matching for plays)
            const nonMatching = [...hand].filter(c => !ps.protocols.includes(c.protocol));
            const matching = [...hand].filter(c => ps.protocols.includes(c.protocol));
            const altList = [...nonMatching.sort((a, b) => a.value - b.value), ...matching.sort((a, b) => a.value - b.value)];
            const cardIdsAlt = altList.slice(0, ct).map(c => c.id);
            const keyAlt = cardIdsAlt.slice().sort().join(',');
            if (!seen.has(keyAlt)) {
                seen.add(keyAlt);
                moves.push({ type: 'discardCards', cardIds: cardIdsAlt });
            }
        }
        return moves.slice(0, this.config.maxCandidatesPerDecision);
    }

    // -------------------------------------------------------------------------
    // HELPERS - CARD TARGETS (delete/flip/shift/return)
    // -------------------------------------------------------------------------

    private genCardTargets(
        state: GameState,
        action: any,
        perspective: Player,
        moveKind: 'deleteCard' | 'flipCard' | 'shiftCard' | 'returnCard'
    ): AIAction[] {
        const targetFilter: TargetFilter = action.targetFilter ?? {};
        const sourceCardId: string | undefined = action.sourceCardId;
        const disallowedIds: string[] = action.disallowedIds ?? [];
        const isOptional: boolean = !!action.optional;
        // CRITICAL: allowedIds restricts targets to a precomputed set (e.g. Luck-4:
        // "same value as discarded card"). Picking outside it gets rejected by the
        // resolver ("Illegal delete") and would stall the AI loop.
        const allowedIds: string[] | undefined = action.allowedIds;
        // Lane restrictions (Death-0: "delete 1 card from each OTHER line")
        const disallowedLaneIndex: number | undefined = action.disallowedLaneIndex;
        const lanesSelected: number[] = action.lanesSelected ?? [];
        // CRITICAL: Some actions restrict selection to ONE lane:
        // - currentLaneIndex: each-lane chains ("flip 1 card in each line")
        // - restrictedLaneIndex: Mirror-3 "same lane as the first flip"
        // - scope 'this_lane' + sourceLaneIndex: Fear-3 "in this line"
        const requiredLane: number | undefined =
            action.currentLaneIndex
            ?? action.restrictedLaneIndex
            ?? (action.scope === 'this_lane' ? action.sourceLaneIndex : undefined);

        // For flip moves, also respect Frost-1 (cannot flip face-down to face-up)
        const frost1Active = moveKind === 'flipCard' && isFrost1Active(state);

        const candidates: string[] = [];
        for (const playerKey of ['player', 'opponent'] as const) {
            const ps = state[playerKey];
            for (let laneIdx = 0; laneIdx < ps.lanes.length; laneIdx++) {
                if (laneIdx === disallowedLaneIndex) continue;
                if (lanesSelected.includes(laneIdx)) continue;
                if (requiredLane !== undefined && laneIdx !== requiredLane) continue;
                const lane = ps.lanes[laneIdx];
                for (let cardIdx = 0; cardIdx < lane.length; cardIdx++) {
                    const card = lane[cardIdx];
                    const isTopCard = cardIdx === lane.length - 1;

                    // Always exclude committed cards (cards in transition)
                    if (isCardCommitted(state, card.id)) continue;
                    // Always exclude disallowed cards
                    if (disallowedIds.includes(card.id)) continue;
                    // Respect precomputed target restriction
                    if (allowedIds && !allowedIds.includes(card.id)) continue;

                    // Owner filter is relative to the source card owner
                    const ownerOfCard = playerKey;
                    const sourceOwner = this.getSourceOwner(state, sourceCardId) ?? perspective;
                    if (targetFilter.owner === 'own' && ownerOfCard !== sourceOwner) continue;
                    if (targetFilter.owner === 'opponent' && ownerOfCard === sourceOwner) continue;

                    if (!this.matchesTargetFilter(card, isTopCard, targetFilter, sourceCardId)) continue;

                    if (frost1Active && !card.isFaceUp) continue;

                    candidates.push(card.id);
                }
            }
        }

        const moves: AIAction[] = candidates.map(cardId => ({
            type: moveKind,
            cardId,
        }));

        if (isOptional) {
            moves.push({ type: 'skip' });
        }

        // If no valid targets, the simulator+resolver will handle it gracefully.
        if (moves.length === 0) moves.push({ type: 'skip' });

        return moves.slice(0, this.config.maxCandidatesPerDecision);
    }

    private getSourceOwner(state: GameState, sourceCardId?: string): Player | null {
        if (!sourceCardId) return null;
        const info = findCardOnBoard(state, sourceCardId);
        return info?.owner ?? null;
    }

    private matchesTargetFilter(
        card: PlayedCard,
        isTopCard: boolean,
        filter: TargetFilter,
        sourceCardId?: string
    ): boolean {
        // Position default: uncovered (only the top card of each lane)
        const pos = filter.position ?? 'uncovered';
        if (pos === 'uncovered' && !isTopCard) return false;
        if (pos === 'covered' && isTopCard) return false;
        // Face-state
        if (filter.faceState === 'face_up' && !card.isFaceUp) return false;
        if (filter.faceState === 'face_down' && card.isFaceUp) return false;
        // Exclude self
        if (filter.excludeSelf && sourceCardId && card.id === sourceCardId) return false;
        // Value range - game rule: face-down cards have value 2 (effective value)
        if (filter.valueRange) {
            const value = card.isFaceUp ? card.value : 2;
            if (value < filter.valueRange.min || value > filter.valueRange.max) return false;
        }
        // Value equals - game rule: face-down cards have value 2 (effective value)
        if (filter.valueEquals !== undefined) {
            const value = card.isFaceUp ? card.value : 2;
            if (value !== filter.valueEquals) return false;
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // HELPERS - LANE SELECTION
    // -------------------------------------------------------------------------

    /**
     * "You may shift the flipped card to another lane" - candidates are all
     * OTHER lanes (selectLane) plus skip when optional.
     */
    private genShiftFlippedCardLanes(state: GameState, action: any): AIAction[] {
        const cardId: string | undefined = action.cardId;
        const cardInfo = cardId ? findCardOnBoard(state, cardId) : null;
        if (!cardInfo) return [{ type: 'skip' }];

        const owner = cardInfo.owner;
        const originalLaneIndex = state[owner].lanes.findIndex(l => l.some(c => c.id === cardId));

        const moves: AIAction[] = [];
        for (let laneIdx = 0; laneIdx < 3; laneIdx++) {
            if (laneIdx === originalLaneIndex) continue;
            if (!this.laneAllowedByRestriction(state, { ...action, cardToShiftId: cardId }, laneIdx, originalLaneIndex)) continue;
            moves.push({ type: 'selectLane', laneIndex: laneIdx });
        }
        if (action.optional !== false || moves.length === 0) {
            moves.push({ type: 'skip' });
        }
        return moves;
    }

    private genLaneSelection(state: GameState, action: any): AIAction[] {
        const validLanes: number[] = action.validLanes ?? [0, 1, 2];
        const disallowed: number | undefined = action.disallowedLaneIndex;
        // CRITICAL: select_lane_for_shift carries originalLaneIndex - shifting
        // a card into its own lane is ILLEGAL. Offering it caused an infinite
        // ping-pong (resolver rejects -> same action -> same pick -> ...).
        const original: number | undefined = action.originalLaneIndex;
        const moves: AIAction[] = [];
        for (const laneIdx of validLanes) {
            if (laneIdx === disallowed) continue;
            if (laneIdx === original) continue;
            if (!this.laneAllowedByRestriction(state, action, laneIdx, original)) continue;
            moves.push({ type: 'selectLane', laneIndex: laneIdx });
        }
        if (action.optional) {
            moves.push({ type: 'skip' });
        }
        if (moves.length === 0) {
            // No legal destination: skip is the only sane answer.
            moves.push({ type: 'skip' });
        }
        return moves;
    }

    /**
     * CRITICAL: Enforce the action's destinationRestriction when choosing a
     * shift destination. Without this the AI offered ILLEGAL lanes (Gravity-1:
     * "shift 1 card either to or from this line" must involve Gravity-1's lane).
     */
    private laneAllowedByRestriction(
        state: GameState,
        action: any,
        targetLane: number,
        originalLane: number | undefined
    ): boolean {
        const restriction = action.destinationRestriction;
        if (!restriction) return true;

        switch (restriction.type) {
            case 'to_or_from_this_lane': {
                // Gravity-1: either the source or the destination must be the card's lane
                const ref = restriction.laneIndex;
                if (typeof ref !== 'number') return true; // unresolved - resolver will validate
                return originalLane === ref || targetLane === ref;
            }
            case 'to_this_lane':
                // Gravity-2/4: destination is fixed
                return typeof restriction.laneIndex === 'number' ? targetLane === restriction.laneIndex : true;
            case 'to_another_line':
                return targetLane !== originalLane;
            case 'non_matching_protocol': {
                // Card may not land in a lane whose protocols match its own
                const cardId = action.cardToShiftId;
                const info = cardId ? findCardOnBoard(state, cardId) : null;
                if (!info || !info.card.isFaceUp) return true;
                return state.player.protocols[targetLane] !== info.card.protocol
                    && state.opponent.protocols[targetLane] !== info.card.protocol;
            }
            default:
                return true;
        }
    }

    // -------------------------------------------------------------------------
    // HELPERS - HAND CARD SELECTION
    // -------------------------------------------------------------------------

    private genHandSelect(
        state: GameState,
        perspective: Player,
        kind: 'giveCard' | 'revealCard'
    ): AIAction[] {
        const ps = state[perspective];
        if (ps.hand.length === 0) return [{ type: 'skip' }];
        return ps.hand.map(c => ({ type: kind, cardId: c.id }));
    }

    private genHandPlay(state: GameState, action: any, perspective: Player): AIAction[] {
        const ps = state[perspective];
        if (ps.hand.length === 0) return [{ type: 'skip' }];

        // CRITICAL: The action's field is 'faceDown' (set by the effect
        // interpreter) and it FORCES the facing - Darkness-3: "play 1 card
        // face-down in another line" must NEVER produce a face-up play!
        const forcedFaceDown: boolean = action.faceDown === true;
        // Clarity-2: only specific cards may be selected
        const selectableCardIds: string[] | undefined = action.selectableCardIds;
        // Diversity-0: "in this line" / Smoke-3: restricted lane set
        const forcedLaneIndex: number | undefined = action.forcedLaneIndex;
        const disallowed: number | undefined = action.disallowedLaneIndex;
        const lanes: number[] = forcedLaneIndex !== undefined
            ? [forcedLaneIndex]
            : (action.validLanes ?? [0, 1, 2]);

        const moves: AIAction[] = [];
        for (const card of ps.hand) {
            if (selectableCardIds && !selectableCardIds.includes(card.id)) continue;
            for (const laneIdx of lanes) {
                if (laneIdx === disallowed) continue;
                const facings = forcedFaceDown ? [false] : [true, false];
                for (const isFaceUp of facings) {
                    const allowed = canPlayCard(state, perspective, laneIdx, isFaceUp, card.protocol, card);
                    if (!allowed.allowed) continue;
                    moves.push({ type: 'playCard', cardId: card.id, laneIndex: laneIdx, isFaceUp });
                }
            }
        }
        if (moves.length === 0) moves.push({ type: 'skip' });
        return moves.slice(0, this.config.maxCandidatesPerDecision);
    }

    // -------------------------------------------------------------------------
    // HELPERS - REARRANGE / SWAP PROTOCOLS
    // -------------------------------------------------------------------------

    /**
     * For 3 protocols there are 6 permutations, but the identity is illegal.
     * That leaves 5 candidate orders for the AI to evaluate.
     */
    private genRearrangeProtocols(state: GameState, action: any): AIAction[] {
        const target: Player = action.target;
        const protocols = state[target].protocols;
        if (protocols.length !== 3) return [{ type: 'skip' }];

        const permutations = this.permutationsOf3(protocols);
        const moves: AIAction[] = [];
        for (const perm of permutations) {
            // Skip identity permutation (must result in a different config)
            if (perm[0] === protocols[0] && perm[1] === protocols[1] && perm[2] === protocols[2]) continue;
            // Respect disallowedProtocolForLane (Anarchy-3)
            const disallowed = action.disallowedProtocolForLane;
            if (disallowed && perm[disallowed.laneIndex] === disallowed.protocol) continue;
            moves.push({ type: 'rearrangeProtocols', newOrder: perm });
        }
        if (moves.length === 0) moves.push({ type: 'rearrangeProtocols', newOrder: protocols });
        return moves;
    }

    private genSwapProtocols(state: GameState, action: any): AIAction[] {
        const target: Player = action.target;
        const protocols = state[target].protocols;
        if (protocols.length !== 3) return [{ type: 'skip' }];
        return [
            { type: 'resolveSwapProtocols', indices: [0, 1] },
            { type: 'resolveSwapProtocols', indices: [0, 2] },
            { type: 'resolveSwapProtocols', indices: [1, 2] },
        ];
    }

    private permutationsOf3<T>(arr: T[]): T[][] {
        const [a, b, c] = arr;
        return [
            [a, b, c],
            [a, c, b],
            [b, a, c],
            [b, c, a],
            [c, a, b],
            [c, b, a],
        ];
    }

    // -------------------------------------------------------------------------
    // HELPERS - LUCK PROTOCOL
    // -------------------------------------------------------------------------

    private genStateNumber(): AIAction[] {
        const moves: AIAction[] = [];
        for (let n = 0; n <= 5; n++) moves.push({ type: 'stateNumber', number: n });
        return moves;
    }

    private genStateProtocol(action: any): AIAction[] {
        const protocols: string[] = action.availableProtocols ?? [];
        if (protocols.length === 0) return [{ type: 'skip' }];
        return protocols.map(p => ({ type: 'stateProtocol', protocol: p }));
    }

    private genSelectFromDrawnToReveal(action: any): AIAction[] {
        const eligibleCardIds: string[] = action.eligibleCardIds ?? action.drawnCardIds ?? [];
        const moves: AIAction[] = eligibleCardIds.map(id => ({ type: 'selectFromDrawnToReveal', cardId: id }));
        // Always include the empty-id "skip" so the resolver clears the action gracefully
        moves.push({ type: 'selectFromDrawnToReveal', cardId: '' });
        return moves;
    }

    // -------------------------------------------------------------------------
    // HELPERS - CLARITY / TIME / MIRROR
    // -------------------------------------------------------------------------

    private genRevealedDeckCards(action: any): AIAction[] {
        const ids: string[] = action.revealedCardIds ?? [];
        if (ids.length === 0) return [{ type: 'skip' }];
        const moves: AIAction[] = ids.map(id => ({ type: 'selectRevealedDeckCard', cardId: id }));
        if (action.optional) moves.push({ type: 'skip' });
        return moves;
    }

    private genTrashCards(state: GameState, action: any, perspective: Player): AIAction[] {
        const trash = state[perspective].discard;
        const moves: AIAction[] = [];
        for (let i = 0; i < trash.length; i++) {
            moves.push({ type: 'selectTrashCard', cardIndex: i });
        }
        if (action.optional || moves.length === 0) moves.push({ type: 'skip' });
        return moves.slice(0, this.config.maxCandidatesPerDecision);
    }

    private genCopyMiddle(action: any): AIAction[] {
        const validIds: string[] = action.validTargetIds ?? [];
        const moves: AIAction[] = validIds.map(id => ({ type: 'selectCard', cardId: id }));
        if (action.optional || moves.length === 0) moves.push({ type: 'skip' });
        return moves;
    }

    /**
     * Light-2 style "reveal a face-down board card": candidates are all
     * uncovered face-down cards. Resolved via resolveActionWithCard.
     */
    private genFaceDownBoardCards(state: GameState, action: any): AIAction[] {
        const moves: AIAction[] = [];
        for (const playerKey of ['player', 'opponent'] as const) {
            for (const lane of state[playerKey].lanes) {
                if (lane.length === 0) continue;
                const topCard = lane[lane.length - 1];
                if (!topCard.isFaceUp && !isCardCommitted(state, topCard.id)) {
                    moves.push({ type: 'selectCard', cardId: topCard.id });
                }
            }
        }
        if (action.optional || moves.length === 0) moves.push({ type: 'skip' });
        return moves;
    }

    /**
     * Start/End phase with 2+ triggered effects: the AI picks the execution
     * order. Each available effect is a candidate (resolved via cardId).
     */
    private genPhaseEffectSelection(action: any): AIAction[] {
        const effects: Array<{ cardId: string }> = action.availableEffects ?? [];
        if (effects.length === 0) return [{ type: 'skip' }];
        return effects.map(e => ({ type: 'selectCard', cardId: e.cardId }));
    }

    private genShiftOrFlipPrompt(action: any): AIAction[] {
        const moves: AIAction[] = [
            { type: 'resolveRevealBoardCardPrompt', choice: 'flip' },
            { type: 'resolveRevealBoardCardPrompt', choice: 'shift' },
        ];
        if (action.optional) moves.push({ type: 'resolveRevealBoardCardPrompt', choice: 'skip' });
        return moves;
    }

    private genCustomChoice(action: any): AIAction[] {
        const opts: any[] = action.options ?? [];
        const moves: AIAction[] = [];
        for (let i = 0; i < opts.length; i++) {
            moves.push({ type: 'resolveCustomChoice', optionIndex: i });
        }
        if (moves.length === 0) moves.push({ type: 'skip' });
        return moves;
    }

    // -------------------------------------------------------------------------
    // FALLBACK FOR LEGACY ACTION TYPES
    // -------------------------------------------------------------------------

    /**
     * Handles old card-specific action types (e.g. 'select_card_to_delete_for_death_1')
     * by reading their generic shape (targetFilter, validLanes, etc.) from the
     * action object and dispatching to the same enumeration logic.
     */
    private genFallbackForLegacy(state: GameState, action: any, perspective: Player): AIAction[] {
        const t: string = action.type ?? '';

        if (t.startsWith('select_lane_')) {
            return this.genLaneSelection(state, action);
        }
        if (t.includes('flip')) {
            return this.genCardTargets(state, action, perspective, 'flipCard');
        }
        if (t.includes('delete')) {
            return this.genCardTargets(state, action, perspective, 'deleteCard');
        }
        if (t.includes('shift')) {
            return this.genCardTargets(state, action, perspective, 'shiftCard');
        }
        if (t.includes('return')) {
            return this.genCardTargets(state, action, perspective, 'returnCard');
        }
        if (t.includes('reveal')) {
            return this.genFaceDownBoardCards(state, action);
        }
        // Generic prompt fallback
        return [{ type: 'skip' }];
    }
}
