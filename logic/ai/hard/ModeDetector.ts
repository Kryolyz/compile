/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ModeDetector - determines the strategic mode for the AI based on the
 * compiled-protocol counts of both players.
 *
 * The 7 modes form a 3x3 matrix (with collapsed corners):
 *
 *               opponent compiled
 *               0           1            2
 *           +-----------+--------------+----------------+
 *  own=0    | opening   | mid_def      | crisis_defense |
 *  own=1    | mid_off   | mid_equal    | crisis_defense |
 *  own=2    | closing   | closing      | final_race     |
 *           +-----------+--------------+----------------+
 *
 * The mode shifts the evaluator weights and tells the dispatcher when to
 * prefer disruption over building. The user explicitly described these
 * inflection points; this class encodes them.
 */

import { GameState, Player } from '../../../types';
import { HandQualityAssessor } from './HandQuality';
import { ModeContext, StrategicMode } from './types';

export class ModeDetector {
    constructor(private readonly handAssessor: HandQualityAssessor) {}

    detect(state: GameState, perspective: Player): ModeContext {
        const own = state[perspective];
        const opp = state[perspective === 'opponent' ? 'player' : 'opponent'];

        const ownCompiled = own.compiled.filter(Boolean).length;
        const oppCompiled = opp.compiled.filter(Boolean).length;

        const mode = this.detectMode(ownCompiled, oppCompiled);
        const handQuality = this.handAssessor.assess(state, perspective);

        return {
            mode,
            handQuality,
            ownCompiled,
            oppCompiled,
            perspective,
        };
    }

    private detectMode(ownCompiled: number, oppCompiled: number): StrategicMode {
        // Crisis: opponent at 2 and we are not (max defense + control fight)
        if (oppCompiled >= 2 && ownCompiled < 2) return 'crisis_defense';
        // Final race: both have 2, whoever compiles next wins
        if (ownCompiled >= 2 && oppCompiled >= 2) return 'final_race';
        // Closing: we have 2, opponent at most 1 -> push to win
        if (ownCompiled >= 2) return 'closing';
        // Mid stages
        if (ownCompiled === 1 && oppCompiled === 1) return 'mid_equal';
        if (ownCompiled === 1 && oppCompiled === 0) return 'mid_offensive';
        if (ownCompiled === 0 && oppCompiled === 1) return 'mid_defensive';
        // Opening
        return 'opening';
    }
}
