# Draft Pick Bot

A Discord bot for leaving conditional draft picks privately (via DM), with public evaluation in the server.

## How it works

- **Players DM the bot** to queue their picks privately before their turn
- **In the server**, the draft manager evaluates picks publicly when a player's turn comes up
- Picks persist across restarts via SQLite (`draft.db`)

---

## Setup

### 1. Create a Discord Application
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application → give it a name
3. Go to **Bot** tab → Reset Token → copy your token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`, `Read Message History`
   - Copy the generated URL and invite the bot to your server

### 2. Get your Client ID
In your application's **General Information** tab, copy the **Application ID**.

### 3. Install and run
```bash
npm install

export DISCORD_TOKEN=your_token_here
export CLIENT_ID=your_client_id_here

node bot.js
```

Optional `.env` support — install dotenv and add `require('dotenv').config()` to the top of `bot.js`.

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
| `/nextturn` | Advance to the next player's turn |

`/evaluate` with no arguments uses the current player from the draft order. `/nextturn` advances the pointer and announces who's up next (auto-increments the round when the order wraps).

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
> **If met, pick:** Quaquaval

```
/condition result:not met
```
> ⏭️ Condition not met — trying next pick
> **Condition:** Thundurus gone
> **If met, pick:** Dragapult

```
/condition result:met
```
> ✅ **Chloe picks Dragapult.** Round 2 queue cleared.

```
/nextturn
```
> ⏭️ It's now **Dan**'s turn.

---

## Notes
- `draft.db` is created automatically on first run and persists picks across restarts
- One active evaluation per server channel at a time
- If `/evaluate` shows an unconditional pick, it resolves immediately without needing `/condition`
- If all conditions fail, the bot warns and the player picks manually
