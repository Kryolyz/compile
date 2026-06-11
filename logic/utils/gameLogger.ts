/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * DEV-ONLY game logger for analyzing real games against the AI.
 *
 * Writes the complete game - including hidden information (starting hands,
 * every drawn card, the identity of face-down plays) - to game-logs/<file>
 * on disk via the dev server's /__gamelog endpoint (see vite.config.ts).
 *
 * Enabled automatically when running `npm run dev`.
 * Turn OFF in the browser console:   localStorage.setItem('gameLogging', 'off')
 * Turn back ON:                      localStorage.removeItem('gameLogging')
 *
 * Has NO effect in production builds or tests.
 */

import { GameState, Player } from '../../types';

const STORAGE_KEY = 'gameLogging';

export function isGameLoggingEnabled(): boolean {
    try {
        if (typeof window === 'undefined' || typeof fetch === 'undefined') return false;
        if (!(import.meta as any).env?.DEV) return false;
        return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Internal per-game tracking
// ---------------------------------------------------------------------------

type HiddenSnapshot = {
    hands: Record<Player, Map<string, string>>;
    laneCards: Record<Player, Map<string, string>>;
};

let currentFile: string | null = null;
let lastLogCount = 0;
let lastTurn: Player | null = null;
let winnerLogged = false;
let hiddenSnapshot: HiddenSnapshot | null = null;

const cardName = (c: { protocol: string; value: number }) => `${c.protocol}-${c.value}`;

function captureHidden(state: GameState): HiddenSnapshot {
    const snap: HiddenSnapshot = {
        hands: { player: new Map(), opponent: new Map() },
        laneCards: { player: new Map(), opponent: new Map() },
    };
    for (const side of ['player', 'opponent'] as Player[]) {
        snap.hands[side] = new Map(state[side].hand.map(c => [c.id, cardName(c)]));
        const laneMap = new Map<string, string>();
        state[side].lanes.forEach((lane, laneIdx) => {
            for (const c of lane) {
                if (!c.isFaceUp) laneMap.set(c.id, `${cardName(c)} (lane ${laneIdx})`);
            }
        });
        snap.laneCards[side] = laneMap;
    }
    return snap;
}

function diffHidden(state: GameState, before: HiddenSnapshot): string[] {
    const lines: string[] = [];
    for (const side of ['player', 'opponent'] as Player[]) {
        const label = side === 'player' ? 'PLAYER' : 'KI';
        const gained: string[] = [];
        for (const c of state[side].hand) {
            if (!before.hands[side].has(c.id)) gained.push(cardName(c));
        }
        if (gained.length > 0) lines.push(`    [INFO] ${label} hand gained: ${gained.join(', ')}`);

        const newFaceDown: string[] = [];
        state[side].lanes.forEach((lane, laneIdx) => {
            for (const c of lane) {
                if (!c.isFaceUp && !before.laneCards[side].has(c.id)) {
                    newFaceDown.push(`${cardName(c)} (lane ${laneIdx})`);
                }
            }
        });
        if (newFaceDown.length > 0) lines.push(`    [INFO] ${label} face-down played: ${newFaceDown.join(', ')}`);
    }
    return lines;
}

function summaryLine(state: GameState): string {
    const p = state.player, o = state.opponent;
    const control = state.controlCardHolder === 'player' ? 'PLAYER'
        : state.controlCardHolder === 'opponent' ? 'KI' : '-';
    return `[TURN ${state.turn === 'player' ? 'PLAYER' : 'KI'}] lanes PLAYER:${p.laneValues.join('/')} vs KI:${o.laneValues.join('/')}`
        + ` | compiled PLAYER:${p.compiled.filter(Boolean).length} KI:${o.compiled.filter(Boolean).length}`
        + ` | hand PLAYER:${p.hand.length} KI:${o.hand.length}`
        + ` | control:${control}`;
}

function send(lines: string[]): void {
    if (!currentFile || lines.length === 0) return;
    try {
        fetch('/__gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: currentFile, lines }),
            keepalive: true,
        }).catch(() => { /* dev logging is best-effort */ });
    } catch {
        // best-effort only
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start a new game log file. Called once per game. */
export function startGameLog(state: GameState, difficulty: string): void {
    if (!isGameLoggingEnabled()) return;

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    currentFile = `${stamp}_vs-${difficulty}.log`;
    lastLogCount = 0;
    lastTurn = null;
    winnerLogged = false;
    hiddenSnapshot = captureHidden(state);

    send([
        `=== GAME vs ${difficulty.toUpperCase()} | PLAYER: ${state.player.protocols.join(',')} | KI: ${state.opponent.protocols.join(',')} | ${state.turn === 'player' ? 'PLAYER' : 'KI'} starts ===`,
        `    [INFO] PLAYER starting hand: ${state.player.hand.map(cardName).join(', ')}`,
        `    [INFO] KI starting hand: ${state.opponent.hand.map(cardName).join(', ')}`,
    ]);
}

/** Trace the latest state. Called on every game state change. */
export function traceGameState(state: GameState): void {
    if (!isGameLoggingEnabled() || !currentFile) return;

    const lines: string[] = [];

    // Turn header whenever the active player changes
    if (state.turn !== lastTurn) {
        lastTurn = state.turn;
        lines.push(summaryLine(state));
    }

    // New game-log entries (the same log the players see)
    if (state.log.length < lastLogCount) lastLogCount = 0; // log was reset
    for (let i = lastLogCount; i < state.log.length; i++) {
        const entry: any = state.log[i];
        lines.push(`    ${entry.message}`);
    }
    lastLogCount = state.log.length;

    // Hidden-information diff (drawn cards, face-down identities)
    if (hiddenSnapshot) {
        lines.push(...diffHidden(state, hiddenSnapshot));
    }
    hiddenSnapshot = captureHidden(state);

    // Result line
    if (state.winner && !winnerLogged) {
        winnerLogged = true;
        lines.push(`=== RESULT: ${state.winner === 'player' ? 'PLAYER' : 'KI'} wins ===`);
        lines.push(`=== FINAL: ${summaryLine(state)} ===`);
    }

    send(lines);
}
