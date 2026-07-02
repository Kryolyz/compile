# Headless AI vs AI Simulation - Architecture Plan

**Date**: 2025-01-06  
**Status**: ✅ Phase 1, 2 & 3 Complete (2025-01-06)  
**Goal**: Separate game logic from frontend to enable headless CLI-driven AI vs AI games

---

## Executive Summary

✅ **Highly Achievable** - The codebase already has ~80% of the required infrastructure:
- Working AI vs AI simulation (`tests/ai-simulation.test.ts`)
- Headless game harness with localStorage shim (`tests/helpers/headlessGame.ts`)
- Synchronous AI system (no async operations in game logic)
- CLI entry point (`npm run simulate`)

**Estimated Effort**: 2-4 days  
**Critical Path**: Clean up React imports in `logic/` + Create clean CLI wrapper

---

## Phase 1 Completion Report ✅

**Date**: 2025-01-06  
**Status**: Complete  
**Tests**: 207 passed, 1 skipped  
**Build**: ✅ Passes  

### What Was Fixed

1. **Removed React imports from `logic/`**
   - File: `logic/customProtocols/patternStyles.ts`
   - Removed: `import React from 'react'`
   - Replaced: `React.CSSProperties` → Local `CSSProperties` type alias
   - Verification: `grep` confirms zero React imports in `logic/`

2. **Fixed `localStorage` dependency in headless environment**
   - File: `logic/customProtocols/cardFactory.ts`
   - Added: `StorageAdapter` interface for dependency injection
   - Modified: `getAllCustomProtocolCards(storage?: StorageAdapter)` - now accepts optional storage adapter
   - Default behavior preserved (uses localStorage in browser)

3. **Created test setup for Node.js environment**
   - File: `tests/setup.ts`
   - Installs `localStorage` shim before all tests run
   - Updated: `vite.config.ts` to use `setupFiles: ['./tests/setup.ts']`

### Verification

```bash
# Zero React imports in logic/
grep -r "^import.*'react'\|^import React" logic/ --include="*.ts"
# Returns: (empty)

# All tests pass
npm test
# Result: 207 passed, 1 skipped

# Build succeeds
npm run build
# Result: ✓ built in 3.20s
```

### Files Modified

| File | Change |
|------|--------|
| `logic/customProtocols/patternStyles.ts` | Removed React import, added CSSProperties type |
| `logic/customProtocols/cardFactory.ts` | Added StorageAdapter, parameterized getAllCustomProtocolCards() |
| `tests/setup.ts` | **New file** - localStorage shim for Node.js tests |
| `vite.config.ts` | Added setupFiles config |

---

## Phase 2 Completion Report ✅

**Date**: 2025-01-06  
**Status**: Complete  
**Tests**: ✅ Headless CLI works (tested with 3-5 games)  

### What Was Built

1. **Created `scripts/run-headless.mjs`**
   - Wraps existing `tests/ai-simulation.test.ts`
   - Accepts CLI arguments: `node scripts/run-headless.mjs hard normal 10`
   - Sets environment variables: `SIM_GAMES`, `SIM_AI1`, `SIM_AI2`
   - Spawns vitest in child process

2. **Updated `package.json`**
   - Added script: `"headless": "node scripts/run-headless.mjs"`
   - Usage: `npm run headless -- hard normal 10`

### Usage Examples

```bash
# Run 10 games: hard AI vs normal AI
npm run headless -- hard normal 10

# Run 100 games: hard vs hard
npm run headless -- hard hard 100

# Custom protocols (modify tests/ai-simulation.test.ts)
npm run headless -- medium easy 50
```

### Verification

```bash
npm run headless -- hard normal 3
# Output:
# Game   1: P1-hard    in  35 turns | P1:3 P2:0
# Game   2: P1-hard    in  37 turns | P1:3 P2:1
# Game   3: P1-hard    in  35 turns | P1:3 P2:1
# SUMMARY: 3 games | P1 HARD: 3 (100%) | P2 NORMAL: 0 (0%)
```

### Files Modified

| File | Change |
|------|--------|
| `scripts/run-headless.mjs` | **New file** - Headless CLI wrapper |
| `package.json` | Added `headless` script |

---

## Phase 3 Completion Report 🎲

**Date**: 2025-01-06  
**Status**: ✅ Complete  
**Tests**: Build passes ✅, Seeded RNG verified  

### What Was Implemented

1. **Created `utils/seededRandom.ts`** ✅
   - Seeded random number generator using Linear Congruential Generator (LCG)
   - Functions: `setRandomSeed(seed)`, `getRandomSeed()`, `resetRandomSeed()`
   - Exports: `random()`, `randomInt(max)`, `shuffleArray(array)`, `randomPick(array)`, `weightedRandom(items)`
   - ✅ Verified: Same seed produces identical sequences
   - ✅ Verified: `shuffleArray()` is reproducible

2. **Updated `utils/gameLogic.ts`** ✅
   - Modified `shuffleDeck()` to use `shuffleArray()` from seededRandom
   - Deck shuffling is now reproducible with same seed

3. **Updated `logic/game/stateManager.ts`** ✅
   - Added optional `seed` parameter to `createInitialState()`
   - Sets RNG seed if provided (for reproducible initial state)
   - Signature: `createInitialState(playerProtocols, opponentProtocols, useControlMechanic, startingPlayer, seed?)`

4. **Updated `scripts/run-headless.mjs`** ✅
   - Added `--seed=<number>` CLI argument
   - Passes `SIM_SEED` environment variable to test runner
   - Usage: `npm run headless -- hard normal 10 --seed=12345`

5. **Updated `tests/ai-simulation.test.ts`** ✅
   - Parses `SIM_SEED` from environment variables
   - Passes seed to `createInitialState()` for each game
   - Different seed per game: `SEED !== undefined ? SEED + g : undefined`

### Design Decision: AI Randomness

**User decision**: AI decision-making randomness does NOT need to be reproducible.

**Rationale**:
- ✅ Deck shuffling is the primary source of randomness (now seeded)
- ✅ AI `Math.random()` calls add "character" to AI behavior
- ✅ Simulations are "mostly reproducible" (same initial conditions)
- ✅ Benchmarks are fair (same initial state, AI choices vary naturally)

**What this means**:
- Same seed → Same initial hands and deck order
- Same seed → Different AI decisions (AI uses `Math.random()`)
- Result: Realistic AI behavior with reproducible starting conditions

### Usage Examples

```bash
# Reproducible initial state (deck shuffle is seeded)
npm run headless -- hard normal 10 --seed=12345

# Different seeds = different starting conditions
npm run headless -- hard normal 10 --seed=42
npm run headless -- hard normal 10 --seed=99

# No seed = fully random (Math.random() for everything)
npm run headless -- hard normal 10
```

### Verification

```bash
# Test 1: Same seed produces same initial state
npm run headless -- hard normal 1 --seed=42
# Check sim-results/ - initial hands should be identical

# Test 2: Different seeds produce different initial state  
npm run headless -- hard normal 1 --seed=42
npm run headless -- hard normal 1 --seed=99
# Initial hands should differ

# Test 3: Build passes
npm run build  # ✅ 222 modules transformed
```

### Files Modified

| File | Change | Status |
|------|--------|--------|
| `utils/seededRandom.ts` | **New file** - Seeded RNG utility | ✅ Complete |
| `utils/gameLogic.ts` | Uses `shuffleArray()` instead of `Math.random()` | ✅ Complete |
| `logic/game/stateManager.ts` | Added `seed` parameter to `createInitialState()` | ✅ Complete |
| `scripts/run-headless.mjs` | Added `--seed` argument | ✅ Complete |
| `tests/ai-simulation.test.ts` | Uses `SIM_SEED` environment variable | ✅ Complete |
| `logic/ai/easy.ts` | **Reverted** - Uses `Math.random()` (by design) | ✅ Complete |
| `logic/ai/normal.ts` | **Not modified** - Uses `Math.random()` (by design) | ✅ Complete |
| `logic/ai/hard.ts` | **Not modified** - Uses `Math.random()` (by design) | ✅ Complete |

---

## Current State Analysis

### ✅ What Already Works

1. **AI vs AI Simulation** (`tests/ai-simulation.test.ts`)
   - Runs full games with configurable AI difficulties
   - Logs detailed game state to `sim-results/`
   - Handles perspective swapping (aiManager drives both sides)
   - Anti-stall logic (MAX_STEPS = 500)

2. **Headless Game Harness** (`tests/helpers/headlessGame.ts`)
   - `installLocalStorageShim()` - Mock localStorage for Node.js
   - `seedProtocols()` - Load protocol JSONs from disk
   - `swapPerspective()` - Mirror state for AI turn-taking
   - `NOOP_ENQUEUE` / `NOOP_END_GAME` - Disable animations/UI

3. **Synchronous Game Logic**
   - All logic in `logic/` directory runs synchronously (no async/await)
   - State updates immediately, animations are pure visual queue
   - `handleRequiredActionSync()` in aiManager.ts

### ⚠️ Current Coupling Points

| Dependency | Files Affected | Effort | Priority | Status |
|------------|----------------|--------|----------|--------|
| **React imports in `logic/`** | 1 file (patternStyles.ts) | ✅ Done | - | ✅ Complete |
| **localStorage usage** | 1 file (cardFactory.ts) | ✅ Done | - | ✅ Complete |
| **Animation system** | Already parameterized | None | - | ✅ No work needed |
| **useGameState hook** | Not needed for headless | N/A | Low | ✅ No work needed |

---

## Detailed Issue Breakdown

### 1. React Imports in `logic/` Directory

**Problem**: Some logic files import React, preventing headless usage.

**Affected Files**:
```
logic/customProtocols/effectInterpreter.ts
logic/customProtocols/patternStyles.ts
logic/effects/actions/drawExecutor.ts
logic/game/phaseManager.ts
logic/game/reactiveEffectProcessor.ts
logic/game/resolvers/cardResolver.ts  (likely)
```

**Root Causes**:
- JSX return values (should return strings)
- React hooks usage (should use dependency injection)
- `React.createElement` calls (should use plain objects)

**Fix Strategy** (1-2 days):
```typescript
// BEFORE: Returns JSX
const getCardText = (card) => <span>{card.value}</span>;

// AFTER: Returns string
const getCardText = (card) => `<span>${card.value}</span>`;
```

```typescript
// BEFORE: Uses hook
const useGameEffect = () => { /* ... */ };

// AFTER: Accept callback as parameter
const processGameEffect = (state, callback) => { /* ... */ };
```

### 2. Browser API Dependencies

#### A) `localStorage` Usage

| File | Usage | Fix |
|------|-------|-----|
| `utils/statistics.ts` | Game stats persistence | Accept `StorageAdapter` param |
| `logic/customProtocols/storage.ts` | Protocol CRUD | Already returns Promises, easy to abstract |
| `hooks/useGameState.ts` | Main state + localStorage | Don't use in headless (use aiManager directly) |

**Recommended Abstraction**:
```typescript
// src/logic/types/storage.ts
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Node.js implementation
export class NodeStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();
  
  getItem(key: string) { return this.store.get(key) ?? null; }
  setItem(key: string, value: string) { this.store.set(key, value); }
  removeItem(key: string) { this.store.delete(key); }
}

// Browser implementation (pass-through)
export class BrowserStorageAdapter implements StorageAdapter {
  getItem(key: string) { return localStorage.getItem(key); }
  setItem(key: string, value: string) { localStorage.setItem(key, value); }
  removeItem(key: string) { localStorage.removeItem(key); }
}
```

#### B) Other Browser APIs
- `uuid` package (already in dependencies) - ✅ No issues
- `Math.random()` - ⚠️ Needs seeding for reproducibility (see Phase 3)

### 3. Animation System (✅ Already Decoupled)

The animation system is already well-separated:
- Animation requests are generated as data: `AnimationRequest[]`
- `enqueueAnimation` callback is passed as parameter
- Headless mode uses `NOOP_ENQUEUE` (already implemented)

**No work needed here.**

### 4. `useGameState.ts` Hook (✅ Not Needed for Headless)

This is the main React coupling point, but:
- It's a **UI hook**, not game logic
- Headless simulation uses `aiManager.ts` directly
- The `headlessGame.ts` harness already bypasses this correctly

**Current architecture handles this correctly.**

---

## Recommended Implementation Plan

### Phase 1: Clean Up `logic/` Directory (1-2 days)

**Goal**: Remove all React imports from `logic/` to make it isomorphic (works in Node + Browser).

**Steps**:

1. **Audit React imports** (2 hours)
   ```bash
   grep -r "import.*react\|from.*react" logic/ --include="*.ts"
   ```

2. **Fix each file** (4-8 hours)
   - Replace JSX with string templates
   - Replace hooks with dependency injection
   - Remove `React` imports

3. **Add integration test** (2 hours)
   ```typescript
   // tests/logic-isomorphic.test.ts
   import { createInitialState } from '../logic/game/stateManager';
   import { handleRequiredActionSync } from '../logic/game/aiManager';
   
   test('game logic runs in Node.js without React', () => {
     // Should not throw "React is not defined"
     const state = createInitialState([...], [...], true, 'opponent');
     expect(state).toBeDefined();
   });
   ```

**Deliverable**: `logic/` directory has zero React imports

---

### Phase 2: Create Config-Driven CLI (0.5-1 day)

**Goal**: Clean CLI entry point that accepts game configuration and outputs results.

**New File**: `src/cli/runHeadlessGame.ts`

```typescript
// src/cli/runHeadlessGame.ts
import { GameState, Difficulty } from '../types';

export interface GameConfig {
  player1: {
    ai: Difficulty;
    protocols: string[];
  };
  player2: {
    ai: Difficulty;
    protocols: string[];
  };
  maxTurns?: number;      // Default: 500
  seed?: number;          // For reproducibility
  verbose?: boolean;      // Log each turn
  outputFile?: string;    // Save log to file
}

export interface GameResult {
  winner: 'player1' | 'player2' | 'draw' | 'timeout';
  turns: number;
  player1Compiled: number;
  player2Compiled: number;
  log: string[];
}

export function runHeadlessGame(config: GameConfig): GameResult {
  // Implementation using existing headlessGame.ts patterns
}
```

**CLI Wrapper**: `scripts/run-headless.mjs`

```javascript
#!/usr/bin/env node
// scripts/run-headless.mjs
import { runHeadlessGame } from '../src/cli/runHeadlessGame.js';

const config = {
  player1: { ai: process.argv[2] || 'hard', protocols: ['Fire', 'Metal', 'Hate'] },
  player2: { ai: process.argv[3] || 'normal', protocols: ['Water', 'Spirit', 'Light'] },
  verbose: true,
};

const result = runHeadlessGame(config);
console.log(JSON.stringify(result, null, 2));
```

**Package.json Script**:
```json
{
  "scripts": {
    "headless": "node scripts/run-headless.mjs",
    "headless:batch": "node scripts/run-batch.mjs"
  }
}
```

**Usage**:
```bash
npm run headless -- hard normal
npm run headless:batch -- 100 hard hard
```

---

### Phase 3: Seeded RNG for Reproducibility (0.5 day)

**Problem**: `Math.random()` makes games non-reproducible.

**Solution**: Seedable RNG (e.g., `seedrandom` package)

```typescript
// src/logic/utils/seededRandom.ts
let rng: () => number = Math.random;

export function seedRNG(seed: number): void {
  // Use seedrandom or simple LCG
  rng = createSeededRNG(seed);
}

export function random(): number {
  return rng();
}

// In stateManager.ts
export function createInitialState(..., seed?: number): GameState {
  if (seed !== undefined) seedRNG(seed);
  // ... existing logic
}
```

**Deliverable**: Games can be replayed 1:1 with same seed

---

### Phase 4 (Optional): Extract Pure Logic Package (1 day)

**Goal**: Create separate npm package with zero browser/React dependencies.

**New Package**: `@compile/game-logic`

```
packages/game-logic/
├── src/
│   ├── game/          # From logic/game/
│   ├── ai/            # From logic/ai/
│   ├── effects/       # From logic/effects/
│   ├── types/         # Shared types
│   └── utils/         # Pure utilities
├── package.json       # No React dependency!
├── tsconfig.json
└── index.ts          # Public API
```

**Benefits**:
- ✅ Truly isolated game logic
- ✅ Can be used in Node.js workers for parallel simulations
- ✅ Smaller bundle for browser (if tree-shaken correctly)

**Cost**: Additional build complexity, need to sync changes between packages.

**Recommendation**: **Skip this phase initially**. The current monorepo structure with cleaned-up `logic/` directory achieves 95% of the benefits with 10% of the effort.

---

## Foreseeable Problems & Mitigations

| Problem | Likelihood | Impact | Mitigation |
|---------|------------|--------|------------|
| **Randomness not seeded** | High | Medium | Phase 3 (Seeded RNG) |
| **Infinite loops in AI** | Medium | Low | Already handled (MAX_STEPS = 500) |
| **Protocol loading fails** | Low | High | Already loads from `custom_protocols/*.json` |
| **TypeScript config issues** | Low | Medium | Add `tsconfig.node.json` for Node builds |
| **Animation code accidentally called** | Low | Low | Already uses NOOP_ENQUEUE in headless |

---

## Testing Strategy

### 1. Unit Tests (Existing ✅)
```bash
npm test  # Vitest unit tests
```

### 2. Headless Smoke Test (New 🆕)
```typescript
// tests/headless-smoke.test.ts
test('hard vs hard completes 10 games without errors', () => {
  const result = runBatchGames({ count: 10, ai1: 'hard', ai2: 'hard' });
  expect(result.completed).toBe(10);
  expect(result.errors).toHaveLength(0);
});
```

### 3. Reproducibility Test (New 🆕)
```typescript
test('same seed produces identical games', () => {
  const config = { seed: 12345, ... };
  const result1 = runHeadlessGame(config);
  const result2 = runHeadlessGame(config);
  expect(result1.log).toEqual(result2.log);
});
```

### 4. Performance Benchmark (New 🆕)
```typescript
test('100 games complete in < 60 seconds', () => {
  const start = Date.now();
  runBatchGames({ count: 100, ai1: 'hard', ai2: 'hard' });
  const duration = Date.now() - start;
  expect(duration).toBeLessThan(60_000);
});
```

---

## Success Criteria

- [ ] `logic/` directory has **zero React imports**
- [ ] `npm run headless -- hard normal` runs a single game and outputs JSON result
- [ ] `npm run headless:batch -- 100 hard hard` runs 100 games and prints summary
- [ ] Same seed produces **identical game logs**
- [ ] All existing tests still pass (`npm test`)
- [ ] Build succeeds (`npm run build`)

---

## Next Steps

### Option A: Audit React Imports First (Recommended)
1. Run audit command to find all React imports in `logic/`
2. Create fix plan for each file
3. Implement fixes one file at a time
4. **Benefit**: Systematic, low risk

### Option B: Build CLI Wrapper First (Quick Win)
1. Create `src/cli/runHeadlessGame.ts`
2. Try to run it - see what breaks
3. Fix issues as they arise
4. **Benefit**: Fast feedback, might reveal hidden issues

### Option C: Hybrid (Recommended 🌟)
1. Start with Option B (build CLI wrapper)
2. When errors occur, switch to Option A (systematic fix)
3. Document findings as you go

---

## Appendix: Key Files Reference

### Core Game Logic (Target for Cleaning)
```
logic/game/aiManager.ts              ✅ No React imports
logic/game/stateManager.ts           ✅ No React imports
logic/game/phaseManager.ts           ⚠️  Has React imports
logic/game/resolvers/*.ts            ⚠️  Check each file
logic/effects/actions/*.ts           ⚠️  Check each file
logic/customProtocols/effectInterpreter.ts ⚠️  Has React imports
```

### Headless Infrastructure (Already Working)
```
tests/helpers/headlessGame.ts        ✅ Working localStorage shim
tests/ai-simulation.test.ts         ✅ Working AI vs AI simulation
scripts/run-simulation.mjs          ✅ CLI wrapper (uses Vitest)
```

### Animation System (Already Decoupled)
```
logic/animation/animationHelpers.ts   ✅ Pure functions
logic/animation/aiAnimationCreators.ts ✅ Pure functions
contexts/AnimationQueueContext.tsx    🎨 React-specific (don't need in headless)
```

---

## Opinion & Recommendation

**Proceed immediately**. The foundation is solid:

1. ✅ Headless simulation **already works** (proven by `ai-simulation.test.ts`)
2. ✅ Game logic is **mostly pure** (separated in `logic/`)
3. ✅ AI system has **synchronous API** (no async headaches)
4. ✅ Animation system is **parameterized** (can be NOOP'd)

**Biggest risk**: React imports in `logic/` - but these are straightforward to fix (string templates instead of JSX, callbacks instead of hooks).

**Suggested first step**: Run the React import audit, then fix `phaseManager.ts` (likely the simplest file with React imports). This will prove the approach works.

---

**Document Status**: Ready for implementation  
**Next Review**: After Phase 1 complete
