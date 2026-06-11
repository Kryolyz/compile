/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Hard AI entry point.
 *
 * Matches the easyAI / normalAI signature so it can be plugged into the
 * existing aiManager dispatch:
 *
 *     export const hardAI = (state, action) => AIAction
 *
 * The actual logic lives in logic/ai/hard/HardAI.ts. We keep a singleton
 * instance so the AI doesn't reinitialize all of its sub-modules on every
 * decision.
 */

import { GameState, ActionRequired, AIAction } from '../../types';
import { HardAI } from './hard/HardAI';

let _instance: HardAI | null = null;

const getInstance = (): HardAI => {
    if (_instance === null) {
        _instance = new HardAI();
    }
    return _instance;
};

export const hardAI = (state: GameState, action: ActionRequired | null): AIAction => {
    return getInstance().decide(state, action);
};
