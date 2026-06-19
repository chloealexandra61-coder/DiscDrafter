# Draft Pick Bot

A Discord bot for leaving conditional draft picks privately (via DM), with public evaluation in the server.

## How it works

- **Players DM the bot** to queue their picks privately before their turn
- **In the server**, the draft manager evaluates picks publicly when a player's turn comes up
- Picks persist across restarts via SQLite (`draft.db`)

---


## Commands

### DM the bot to manage your picks (private)

| Command | Description |
|---|---|
| `/addpick round:<n> pick:<name> [condition:<text>]` | Add a pick to your queue |
| `/mypicks [round:<n>]` | View your queue |
| `/clearpicks [round:<n>]` | Clear your queue |
| `/insertpick round:<n> position:<pos> pick:<name> [condition:<text>]` | Insert at a specific position |
| `/removepick round:<n> position:<pos>` | Remove a specific entry |

Picks are evaluated top-to-bottom. The first one whose condition is met executes, then the rest for that round are deleted. Leave `condition` blank for an unconditional fallback (always executes if reached).

### Server commands (public)

| Command | Description |
|---|---|
| `/draftorder [players:@A @B @C]` | Set or view the draft order |
| `/whosturn` | Show whose turn it currently is |
| `/evaluate [player:@user] [round:<n>]` | Evaluate a player's pick queue |
| `/condition result:met\|not met` | Report if the current condition is met |
| `/confirmpick result:yes\|no` | Lock in (or reject) the pending pick |
| `/pick pokemon:<name> [player:@user] [round:<n>]` | Skip the queue entirely — directly make a pick for whoever's turn it is |
| `/nextturn` | Advance to the next player's turn |
| `/teams` | Show everyone's drafted picks so far |
| `/myteam [player:@user]` | Show a specific player's drafted picks |
| `/addteampick player:@user round:<n> pick:<name>` | **Admin only.** Manually add or overwrite a pick on someone's team |
| `/removeteampick player:@user round:<n>` | **Admin only.** Remove a pick from someone's team for a round |
| `/resetdraft confirm:true` | **Admin only.** Wipes the draft order, turn pointer, all queued picks, and drafted rosters for this draft |

This is a **snake draft**: the order reverses each round. With players A, B, C, D set via `/draftorder`, the pick order runs:

```
Round 1: A, B, C, D
Round 2: D, C, B, A   ← D picks twice in a row (the "turn")
Round 3: A, B, C, D   ← A picks twice in a row (the "turn")
```

This is standard for fantasy-style drafts — it balances out the advantage of picking first.

`/evaluate` with no arguments uses the current player from the draft order. There are two stages before a pick is final:

1. **Condition check** (`/condition result:met|not met`) — walks through the player's queue until a condition is met (or an unconditional fallback is reached). At this point the pick is shown as **pending**, not yet locked in.
2. **Confirmation** (`/confirmpick result:yes|no`) — `yes` locks the pick into that player's roster, clears their queue for the round, and **automatically advances + pings the next player**. `no` rejects the pending pick and falls through to the next backup in their queue, as if the condition had failed.

`/nextturn` is for manually skipping ahead outside the normal confirm flow — e.g. if a queue is exhausted and the player needs to pick manually.

`/pick` is the quick path when there's no condition queue to walk through, or the player just wants to choose right now instead of using DM-queued picks. With no arguments it targets whoever's currently up in the draft order. Anyone can use it for their own turn; only an admin can use it to pick *for* someone else. It clears that player's queue for the round (so leftover backups don't linger) and auto-advances + pings the next player, same as a confirmed pick.

`/addteampick` and `/removeteampick` are for fixing up a roster directly — useful when a pick happened outside the bot (e.g. queue was exhausted and the manager just asked the player verbally), when correcting a mistake, or when backfilling history. `/addteampick` overwrites whatever's already recorded for that round if one exists.

---

## Example session

**Before the draft — players DM the bot:**
```
/addpick round:2 pick:Quaquaval condition:Thundurus available
/addpick round:2 pick:Dragapult condition:Thundurus gone
/addpick round:2 pick:Corviknight
```

**In the server — setting up:**
```
/draftorder players:@Alice @Bob @Chloe @Dan
```

**When it's Chloe's turn:**
```
/evaluate
```
> 📋 Evaluating picks for Chloe — Round 2
> **Condition:** Thundurus available
> *The pick will be revealed once the condition is confirmed met.*

```
/condition result:not met
```
> ⏭️ Condition not met — trying next pick
> **Condition:** Thundurus gone

```
/condition result:met
```
> 🕐 **Pending confirmation** — Chloe would like to pick **Dragapult**.
> Use `/confirmpick result:yes` to lock it in, or `result:no` to move to the next backup.

```
/confirmpick result:yes
```
> ✅ **Chloe drafts Dragapult!** Round 2 queue cleared.
> 🎯 @Dan — it's your turn. Round 2 • Position 4 of 4.

**Checking rosters any time:**
```
/teams
```
> 🏆 Current Teams
> **Chloe:** R1: Quaquaval, R2: Dragapult
> **Alice:** R1: Corviknight
> ...

---

## Notes
- `draft.db` is created automatically on first run and persists picks, draft order, and drafted rosters across restarts
- One active evaluation per server channel at a time
- A pick isn't final until `/confirmpick result:yes` — this is your chance to catch mistakes (wrong condition reading, sniped pick, etc.) before it's locked into the roster
- `/confirmpick result:no` doesn't end the evaluation — it just rejects the current pending pick and moves to the next backup in the queue, same as a failed condition
- If all backups are exhausted, the bot warns and the player needs to pick manually (use `/nextturn` to move on once that's sorted)
- `/resetdraft` requires Administrator permission by default. Run it once with `confirm:false` (or omit) to see the warning, then `confirm:true` to actually wipe everything — this deletes the draft order, the turn pointer, every queued pick, and the drafted rosters for players in that order. It does not touch picks for players not currently in a draft order (e.g. if they're queuing for a future draft).
