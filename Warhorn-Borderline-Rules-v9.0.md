# Warhorn - Borderline Rules (v9.0)

> A Go variant. Score by invading the opponent's territory, occupying empty points, besieging and capturing defending stones. Real-time scoring, forced endgame. Designed to shorten game time and increase fun compared with standard Go.

---

## 1. Board & Forces

- **Board**: 19x19. Rows 1-9 are Black's territory, rows 11-19 are White's territory, row 10 is the Border Line (neutral zone).
- **Border Line**: all scoring and troop-replenishment rules apply here.
- **Forces**: both sides start with a limit of **90** pieces. Playing a stone costs 1; captured stones are not returned.
- **Troop replenishment** (siege only; capturing no longer replenishes):
  - Besieging an opponent's stones: count the **total number of enemy stones besieged in your territory or on the border line**; restore **1 force per full 2 stones** (accumulated across moves, remainder carried over, fixed once restored, never clawed back, never above the limit).
  - Besieging in the opponent's territory: no replenishment.
  - Capturing an opponent's stone: **no replenishment**; instead earn capture score (+4 per stone, see Rule 4).

---

## 2. Scoring Overview

**Total = Enclosure Score + Capture Score + Siege Score + Stronghold Reward - Casualty Score**

Real-time scores are grouped into three categories for display (matching the UI):

- **Occupation Score** = Enclosure Score + Siege Score: earned by enclosing (+2 per empty point) and besieging (+3 per besieged stone, a state score) in the **opponent's territory or on the border line**. Enclosures and sieges in your own territory do not count toward Occupation Score.
- **Defense Score** = Capture Score: capturing an opponent's stone earns **+4 per stone**, regardless of the captured stone's location; captures in your own territory also count toward Defense Score.
- **Casualty Score**: each stone you lose to capture costs **+1**, deducted from the total.

Stronghold Reward (+10 per capture) is settled separately and is not merged into Occupation or Defense.

White additionally gets **+5 komi** at the end of the game.

Core principle: enclosing, besieging and capturing in the opponent's territory or on the border line score points; doing so in your own territory scores nothing. Capturing always earns +4 (regardless of location) and does not replenish troops; only besieging can replenish troops.

---

## 3. Enclosure Score

- Forming a valid enclosure in the **opponent's territory or on the border line**, each countable empty point inside earns **+2**.
- Countable empty points = total intersections inside - your occupied points - opponent's living occupied points.
- Points occupied by the opponent's besieged stones count toward your enclosure score.
- Enclosures inside your own territory earn nothing.

---

## 4. Capture Score

- Capturing an opponent's stone earns **+4 each**.
- Score is **independent of the captured stone's location**: whether it lies in the opponent's territory, your own territory, or on the border line, it is always worth +4 per stone.
- Capturing does not replenish troops (siege replenishment is covered in Rule 1).
- A multi-stone capture accumulates by count and is never clawed back.

---

## 5. Siege Score

- Siege score is a **state score**: when stones enter besiegement, the besieging side earns **+3 each**; when the besiegement disappears, that score is immediately deducted.
- Besiegement disappears when: siege is lifted (making life, breaking out, or free legal points >= 8) or the stones are captured.
- Awarded **only when the besieged stones lie in the opponent's territory or on the border line**.
- Besieging in your own territory earns nothing but restores troops.

---

## 6. Strongholds

- The 2 stones each side plays during the deployment phase automatically become strongholds.
- Capturing an opponent's stronghold: extra **+10**.
- A besieged stronghold is not considered captured; only actual capture triggers it.
- **Endgame on total stronghold loss**: if a side's 2 strongholds are both captured, the game ends immediately, settled by current total score (including komi).
- Capturing a stronghold does not count toward casualty score.

---

## 7. Casualty Score

- Each stone captured costs you **+1** of casualty score, deducted from the total.

---

## 8. Capture Settlement Order

1. The captured side accrues casualty +1 per stone;
2. If the captured stones were previously besieged, deduct the besieger's earned siege score (-3 each);
3. The capturing side earns capture score: always +4 per stone (regardless of the captured stone's location);
4. If the captured stone is a stronghold, the capturer earns an extra +10;
5. (Capturing does not replenish troops; siege replenishment is not settled here — see Rule 1 / step 8);
6. Check whether the captured side has lost all strongholds; if so, the game ends immediately;
7. Re-judge the remaining stones' states and process siege changes (entering +3 each, lifted -3 each, replenishment based on the total number of enemy stones besieged in your territory/border, accumulated across moves).

---

## 9. Deployment Phase

- The first 4 moves (B1, W1, B2, W2) must all be played in your own territory.
- **No scores are settled or shown during the deployment phase; normal state judgments continue. After the 5th move is played, all existing scores are settled uniformly according to the then-current board state, including enclosure and siege scores formed during the deployment phase.**
- Passing is forbidden; forces are consumed normally. The 4 stones automatically become strongholds.

---

## 10. Moves & Endgame

### Moves
- Black plays first. Suicide is forbidden; no-liberty stones are captured on the spot. Scores update dynamically after each move.

### Passing
- Each side is limited to **2 passes** per game; passing is forbidden during the deployment phase.
- After passing, a side must wait **2 of its own turns** before passing again.
- Two consecutive active passes by both sides end the game. An exhausted side's automatic pass does not count toward consecutive-pass determination.

### Forced Endgame
1. Both sides have exhausted all their pieces;
2. Both sides pass twice consecutively (active passes);
3. One side has lost all its strongholds.

### Regular Endgame Settlement
1. If war fog is enabled and the game ends before move 30, trigger the dawn first;
2. Resolve ko;
3. **Final life-and-death judgment: adjust siege scores (entering +3 each, lifted -3 each);**
4. Freeze all scores;
5. Add +5 komi to White;
6. Compare totals: higher wins, tie is draw.

---

## 11. Enclosure & State Judgment

- **Enclosure**: a fully closed region formed by one side's chain of stones together with the board edge, judged purely geometrically, and must be enclosed by living stones.
- **Nested enclosures**: judged from the inside out. A valid inner layer belongs to the inner side; the outer layer deducts the inner layer's entire region; an invalid inner layer belongs to the outer layer. Updated dynamically.
- **Living**: satisfying any of - (a) has two real eyes; (b) not validly surrounded by the opponent; (c) surrounded but has >= 8 legal empty points.
- **Besieged**: satisfying all of - (a) validly surrounded by the opponent; (b) does not have two real eyes; (c) has fewer than 8 legal empty points.
- **Legal empty points**: empty points where a move can be played and the connected group keeps liberty after playing; points occupied by an opponent's stone also count as legal if playing there would capture the opponent's stones and thereby gain liberty.
- Re-run state judgment after every move, capture, pass, or before endgame freeze.

---

## 12. Optional Rules (off by default)

### Special Forces
- Twice per side per game, deployable only on your own turn; deployment consumes that turn and does not draw from the force pool.
- Must be placed with Manhattan distance <= 3 from no other stone. Announced publicly but not the location.
- Exposed when: the opponent plays on the point or an orthogonal neighbor; both sides' special forces are within distance <= 3; deployed for **20 moves (global count)**; endgame.
- When captured: casualty +6, and the opponent's capture score applies normally (scoring decided by the captured stone's location).
- **Participation definition**: the stone must be part of the chain forming a valid enclosure border.
- **Endgame reward/penalty** (for those still alive at endgame settlement):
  - As a border stone participating in a **still-valid** enclosure: that enclosure's enclosure score +50%, siege score +50% (ceiling; multiple of your own special forces in the same enclosure do not stack).
  - Participating in no still-valid enclosure: total -2.
  - Killed: no reward or penalty.
- When both this and war fog are enabled, deployment is only allowed after dawn.

### War Fog
- Full-board fog; only your own stones and the area with Manhattan distance <= 2 are visible.
- Deployment-phase moves are hidden; entering within <= 2 reveals a stronghold; move 30 dawn reveals everything.
- Skirmish: if the play point is occupied by an opponent's hidden stone, the opponent is revealed and your stone is displaced to one of the 8 surrounding points; if none is playable, your stone is destroyed (casualty +1; the opponent's capture score is always +4 per stone, regardless of location).
- Enclosure score is computed in real time but **hidden from players**, shown uniformly at move-10 dawn; other scores take effect in real time.
- Dawn: triggered after move 10 is completed; fog dissipates, the whole board is visible, strongholds are revealed.

---

## 13. Key Terms

- **Liberty**: the number of adjacent empty points of a connected group.
- **Connected group / chain**: an aggregate of same-color stones connected through adjacent intersections.
- **Real eye**: judged by the standard rules of traditional Go.
- **Suicide**: after playing, your connected group has no liberty and cannot capture the opponent's stones.
- **Ko**: playing that would recreate any previously seen board position is forbidden (positional superko / full-board repetition ban) — this covers not only a single ko but also multi-stone ko, triple ko, long ko, cycle (triple-ko) and eternal-life shapes, since any such loop must reproduce an earlier position. At endgame, duplicate the final position, assume respectively that ko is won by Black and by White, re-run state judgment and compute the total score change; the side with the greater net gain takes the ko; if equal, the side that last captured takes it; if none, the side that passed second takes it.