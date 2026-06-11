/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * StateCloner - deep clones a GameState for safe simulation.
 *
 * The hard AI's simulator must NEVER mutate the real game state. Resolvers
 * are mostly pure but some helpers (e.g. findAndFlipCards) mutate by
 * reference inside the lane arrays. To play it safe, every simulation step
 * starts with a fresh deep clone.
 *
 * Uses the native structuredClone() if available (faster), falls back to
 * JSON-based cloning. The game state is fully serializable so this works.
 */

import { GameState } from '../../../types';

export class StateCloner {
    /**
     * Returns a deep clone of the given state.
     *
     * Important: animation/log/UI fields are kept on the clone too, but they
     * may be stripped or replaced by the simulator before passing to a
     * resolver to avoid leaking simulation noise into the real UI.
     */
    clone(state: GameState): GameState {
        // Try structuredClone first (handles more types, faster).
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(state) as GameState;
            } catch {
                // Some non-serializable field slipped through; fall back.
            }
        }
        return JSON.parse(JSON.stringify(state)) as GameState;
    }

    /**
     * Returns a clone with simulation-only flags applied:
     * - winner cleared (we want to detect "would the move win" via evaluation, not via the global flag)
     * - log truncated (we don't want to grow logs during simulation)
     * - animation requests cleared (we don't run animations in simulation)
     */
    cloneForSimulation(state: GameState): GameState {
        const c = this.clone(state);
        c.log = []; // Don't grow the log during simulation.
        // Clear animation request side-channels so resolvers don't try to enqueue.
        (c as any)._pendingAnimationRequests = undefined;
        (c as any)._pendingAnimations = undefined;
        return c;
    }
}
