const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const initSqlJs = require('sql.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DB_PATH = path.join(__dirname, 'draft.db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
  // Required to receive DM interactions
  partials: ['CHANNEL'],
});

// ─── Database setup ────────────────────────────────────────────────────────

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing database from disk.');
  } else {
    db = new SQL.Database();
    console.log('Created new database.');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS picks (
      user_id TEXT NOT NULL,
      round    INTEGER NOT NULL,
      position INTEGER NOT NULL,
      pick     TEXT NOT NULL,
      condition TEXT,
      PRIMARY KEY (user_id, round, position)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS draft_order (
      guild_id   TEXT NOT NULL,
      position   INTEGER NOT NULL,
      user_id    TEXT NOT NULL,
      PRIMARY KEY (guild_id, position)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS draft_state (
      guild_id      TEXT PRIMARY KEY,
      current_round INTEGER NOT NULL DEFAULT 1,
      current_pos   INTEGER NOT NULL DEFAULT 0
    )
  `);

  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── Pick DB helpers ───────────────────────────────────────────────────────

function dbGetPicks(userId, round) {
  const stmt = db.prepare(
    'SELECT position, pick, condition FROM picks WHERE user_id = ? AND round = ? ORDER BY position'
  );
  stmt.bind([userId, round]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGetAllPicks(userId) {
  const stmt = db.prepare(
    'SELECT round, position, pick, condition FROM picks WHERE user_id = ? ORDER BY round, position'
  );
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbAddPick(userId, round, pick, condition) {
  const existing = dbGetPicks(userId, round);
  const nextPos = existing.length > 0 ? existing[existing.length - 1].position + 1 : 1;
  db.run(
    'INSERT INTO picks (user_id, round, position, pick, condition) VALUES (?, ?, ?, ?, ?)',
    [userId, round, nextPos, pick, condition || null]
  );
  saveDb();
  return nextPos;
}

function dbInsertPick(userId, round, atPosition, pick, condition) {
  // Shift everything at >= atPosition up by 1
  db.run(
    'UPDATE picks SET position = position + 1 WHERE user_id = ? AND round = ? AND position >= ?',
    [userId, round, atPosition]
  );
  db.run(
    'INSERT INTO picks (user_id, round, position, pick, condition) VALUES (?, ?, ?, ?, ?)',
    [userId, round, atPosition, pick, condition || null]
  );
  saveDb();
}

function dbRemovePick(userId, round, atPosition) {
  db.run(
    'DELETE FROM picks WHERE user_id = ? AND round = ? AND position = ?',
    [userId, round, atPosition]
  );
  // Repack positions so there are no gaps
  const remaining = dbGetPicks(userId, round);
  remaining.forEach((row, i) => {
    db.run(
      'UPDATE picks SET position = ? WHERE user_id = ? AND round = ? AND position = ?',
      [i + 1, userId, round, row.position]
    );
  });
  saveDb();
}

function dbClearRound(userId, round) {
  db.run('DELETE FROM picks WHERE user_id = ? AND round = ?', [userId, round]);
  saveDb();
}

function dbClearAll(userId) {
  db.run('DELETE FROM picks WHERE user_id = ?', [userId]);
  saveDb();
}

function dbClearRoundQueue(userId, round) {
  db.run('DELETE FROM picks WHERE user_id = ? AND round = ?', [userId, round]);
  saveDb();
}

function dbResetGuild(guildId, order) {
  // Wipe picks for everyone currently in the draft order, plus the order/state itself
  for (const row of order) {
    db.run('DELETE FROM picks WHERE user_id = ?', [row.user_id]);
  }
  db.run('DELETE FROM draft_order WHERE guild_id = ?', [guildId]);
  db.run('DELETE FROM draft_state WHERE guild_id = ?', [guildId]);
  saveDb();
}

// ─── Draft order DB helpers ────────────────────────────────────────────────

function dbGetOrder(guildId) {
  const stmt = db.prepare(
    'SELECT position, user_id FROM draft_order WHERE guild_id = ? ORDER BY position'
  );
  stmt.bind([guildId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbSetOrder(guildId, userIds) {
  db.run('DELETE FROM draft_order WHERE guild_id = ?', [guildId]);
  userIds.forEach((uid, i) => {
    db.run(
      'INSERT INTO draft_order (guild_id, position, user_id) VALUES (?, ?, ?)',
      [guildId, i, uid]
    );
  });
  // Reset state
  db.run(
    'INSERT OR REPLACE INTO draft_state (guild_id, current_round, current_pos) VALUES (?, 1, 0)',
    [guildId]
  );
  saveDb();
}

function dbGetState(guildId) {
  const stmt = db.prepare('SELECT current_round, current_pos FROM draft_state WHERE guild_id = ?');
  stmt.bind([guildId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAdvanceTurn(guildId) {
  const order = dbGetOrder(guildId);
  const state = dbGetState(guildId);
  if (!order.length || !state) return null;

  let nextPos = state.current_pos + 1;
  let nextRound = state.current_round;

  if (nextPos >= order.length) {
    nextPos = 0;
    nextRound += 1;
  }

  db.run(
    'UPDATE draft_state SET current_round = ?, current_pos = ? WHERE guild_id = ?',
    [nextRound, nextPos, guildId]
  );
  saveDb();
  return { round: nextRound, pos: nextPos, userId: order[nextPos].user_id };
}

// ─── Slash command definitions ─────────────────────────────────────────────
// DM commands: addpick, mypicks, clearpicks, insertpick, removepick
// Server commands: evaluate, condition, draftorder, whosturn, nextturn

const DM_COMMANDS = new Set(['addpick', 'mypicks', 'clearpicks', 'insertpick', 'removepick']);
const SERVER_COMMANDS = new Set(['evaluate', 'condition', 'draftorder', 'whosturn', 'nextturn', 'resetdraft']);

const commands = [
  // ── DM commands ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('addpick')
    .setDescription('(DM only) Add a conditional pick to your queue')
    .addIntegerOption(o =>
      o.setName('round').setDescription('Draft round number').setRequired(true).setMinValue(1))
    .addStringOption(o =>
      o.setName('pick').setDescription('What you want to pick').setRequired(true))
    .addStringOption(o =>
      o.setName('condition').setDescription('Condition that must be met (leave blank for unconditional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('mypicks')
    .setDescription('(DM only) View your current pick queue')
    .addIntegerOption(o =>
      o.setName('round').setDescription('Round to view (leave blank for all rounds)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('clearpicks')
    .setDescription('(DM only) Clear your pick queue')
    .addIntegerOption(o =>
      o.setName('round').setDescription('Round to clear (leave blank for all rounds)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('insertpick')
    .setDescription('(DM only) Insert a pick at a specific position in your queue')
    .addIntegerOption(o =>
      o.setName('round').setDescription('Draft round number').setRequired(true).setMinValue(1))
    .addIntegerOption(o =>
      o.setName('position').setDescription('Position to insert at (1 = top of queue)').setRequired(true).setMinValue(1))
    .addStringOption(o =>
      o.setName('pick').setDescription('What you want to pick').setRequired(true))
    .addStringOption(o =>
      o.setName('condition').setDescription('Condition that must be met').setRequired(false)),

  new SlashCommandBuilder()
    .setName('removepick')
    .setDescription('(DM only) Remove a specific pick from your queue by position')
    .addIntegerOption(o =>
      o.setName('round').setDescription('Draft round number').setRequired(true).setMinValue(1))
    .addIntegerOption(o =>
      o.setName('position').setDescription('Position to remove (1-indexed)').setRequired(true).setMinValue(1)),

  // ── Server commands ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('evaluate')
    .setDescription('(Server only) Evaluate the current player\'s pick queue for their turn')
    .addUserOption(o =>
      o.setName('player').setDescription('The player whose turn it is (leave blank to use draft order)').setRequired(false))
    .addIntegerOption(o =>
      o.setName('round').setDescription('Round number (leave blank to use current round from draft order)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('condition')
    .setDescription('(Server only) Report whether the current condition is met')
    .addStringOption(o =>
      o.setName('result')
        .setDescription('Is the condition met?')
        .setRequired(true)
        .addChoices(
          { name: 'met', value: 'met' },
          { name: 'not met', value: 'not_met' }
        )),

  new SlashCommandBuilder()
    .setName('draftorder')
    .setDescription('(Server only) Set or view the draft pick order')
    .addStringOption(o =>
      o.setName('players')
        .setDescription('Mention players in order, e.g. @Alice @Bob @Charlie (leave blank to view current order)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('whosturn')
    .setDescription('(Server only) Show whose turn it currently is'),

  new SlashCommandBuilder()
    .setName('nextturn')
    .setDescription('(Server only) Advance to the next player\'s turn'),

  new SlashCommandBuilder()
    .setName('resetdraft')
    .setDescription('(Server only, admin) Wipe the draft order and all queued picks for this server')
    .setDefaultMemberPermissions(0) // Administrator-only by default; server admins can change this in Integrations settings
    .addBooleanOption(o =>
      o.setName('confirm')
        .setDescription('Set to true to actually confirm the reset')
        .setRequired(true)),

].map(c => c.toJSON());

// ─── Register commands ─────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatQueue(userId, round) {
  const queue = dbGetPicks(userId, round);
  if (queue.length === 0) return null;
  return queue.map((row, i) => {
    const cond = row.condition ? `*Condition: ${row.condition}*\n  → ` : '→ (unconditional) ';
    return `**${i + 1}.** ${cond}**${row.pick}**`;
  }).join('\n');
}

async function formatOrderEmbed(guildId) {
  const order = dbGetOrder(guildId);
  const state = dbGetState(guildId);
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Draft Order');

  if (order.length === 0) {
    embed.setDescription('No draft order set. Use `/draftorder players:@Alice @Bob ...` to set one.');
    return embed;
  }

  const lines = await Promise.all(order.map(async (row, i) => {
    const u = await client.users.fetch(row.user_id).catch(() => ({ username: row.user_id }));
    const isCurrent = state && state.current_pos === i;
    return `${isCurrent ? '▶️' : `${i + 1}.`} ${u.username}`;
  }));

  const roundLabel = state ? `Round ${state.current_round}` : '';
  embed.setDescription(lines.join('\n'));
  if (roundLabel) embed.setFooter({ text: roundLabel });
  return embed;
}

// ─── Evaluation logic ──────────────────────────────────────────────────────

// evaluations[channelId] = { userId, round, index }
const evaluations = {};

async function startEvaluation(interaction, targetUser, round) {
  const channelId = interaction.channelId;
  const userId = targetUser.id;
  const queue = dbGetPicks(userId, round);

  if (queue.length === 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('No picks queued')
        .setDescription(`${targetUser} has no picks queued for round ${round}.`)],
    });
  }

  evaluations[channelId] = { userId, round, index: 0 };

  const firstEntry = queue[0];
  // If first entry is unconditional, resolve immediately
  if (!firstEntry.condition) {
    return resolveUnconditional(interaction, targetUser, round, firstEntry.pick, queue.length);
  }

  return interaction.reply({ embeds: [buildConditionEmbed(targetUser, round, queue, 0)] });
}

function buildConditionEmbed(targetUser, round, queue, index) {
  const entry = queue[index];
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 Evaluating picks for ${targetUser.username} — Round ${round}`)
    .setDescription(
      `**Condition:** ${entry.condition}\n\n` +
      `*The pick will be revealed once the condition is confirmed met.*\n\n` +
      `Use \`/condition result:met\` or \`/condition result:not met\` to continue.`
    )
    .setFooter({ text: `Entry ${index + 1} of ${queue.length}` });
}

async function resolveUnconditional(interaction, targetUser, round, pickedItem, totalEntries) {
  delete evaluations[interaction.channelId];
  dbClearRoundQueue(targetUser.id, round);
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`✅ Pick confirmed${totalEntries > 1 ? ' (unconditional fallback)' : ''} — Round ${round}`)
      .setDescription(
        `**${targetUser.username}** picks: **${pickedItem}**\n\n` +
        `Their round ${round} queue has been cleared.`
      )],
  });
}

async function advanceEvaluation(interaction, conditionMet) {
  const channelId = interaction.channelId;
  const eval_ = evaluations[channelId];
  if (!eval_) {
    return interaction.reply({ content: 'No active evaluation in this channel.', ephemeral: true });
  }

  const { userId, round, index } = eval_;
  const queue = dbGetPicks(userId, round);
  const entry = queue[index];
  const targetUser = await client.users.fetch(userId);

  if (conditionMet) {
    dbClearRoundQueue(userId, round);
    delete evaluations[channelId];
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`✅ Pick confirmed — Round ${round}`)
        .setDescription(
          `**${targetUser.username}** picks: **${entry.pick}**\n\n` +
          `Their round ${round} queue has been cleared.`
        )],
    });
  }

  // Not met — advance
  const nextIndex = index + 1;

  if (nextIndex >= queue.length) {
    delete evaluations[channelId];
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle(`⚠️ No valid pick found — Round ${round}`)
        .setDescription(
          `**${targetUser.username}**'s queue is exhausted — all conditions were unmet.\n` +
          `They'll need to pick manually.`
        )],
    });
  }

  evaluations[channelId].index = nextIndex;
  const nextEntry = queue[nextIndex];

  // Next is unconditional — resolve immediately
  if (!nextEntry.condition) {
    return resolveUnconditional(interaction, targetUser, round, nextEntry.pick, queue.length);
  }

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle(`⏭️ Condition not met — trying next pick`)
      .setDescription(
        `**Condition:** ${nextEntry.condition}\n\n` +
        `*The pick will be revealed once the condition is confirmed met.*\n\n` +
        `Use \`/condition result:met\` or \`/condition result:not met\` to continue.`
      )
      .setFooter({ text: `Entry ${nextIndex + 1} of ${queue.length} • Round ${round} • ${targetUser.username}` })],
  });
}

// ─── Event handlers ────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, channelId } = interaction;
  const inDM = !interaction.guildId;
  const inServer = !!interaction.guildId;

  // Enforce where each command can be used
  if (DM_COMMANDS.has(commandName) && !inDM) {
    return interaction.reply({
      content: `📬 \`/${commandName}\` is a DM-only command — message the bot directly to keep your picks private!`,
      ephemeral: true,
    });
  }
  if (SERVER_COMMANDS.has(commandName) && inDM) {
    return interaction.reply({
      content: `🏟️ \`/${commandName}\` can only be used in a server channel.`,
    });
  }

  const guildId = interaction.guildId;

  try {

    // ── /addpick ─────────────────────────────────────────────────────────────
    if (commandName === 'addpick') {
      const round = interaction.options.getInteger('round');
      const pick = interaction.options.getString('pick');
      const condition = interaction.options.getString('condition') || null;

      const pos = dbAddPick(user.id, round, pick, condition);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle(`Pick added — Round ${round}`)
          .setDescription(
            (condition ? `**Condition:** ${condition}\n` : '**Unconditional pick**\n') +
            `**Pick:** ${pick}\n\n` +
            `Position in queue: **${pos}**`
          )],
      });
    }

    // ── /mypicks ──────────────────────────────────────────────────────────────
    if (commandName === 'mypicks') {
      const round = interaction.options.getInteger('round');
      const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Your pick queue');

      if (round) {
        const formatted = formatQueue(user.id, round);
        embed.addFields({ name: `Round ${round}`, value: formatted || '*No picks queued.*' });
      } else {
        const allRows = dbGetAllPicks(user.id);
        if (allRows.length === 0) {
          embed.setDescription('You have no picks queued.');
        } else {
          // Group by round
          const byRound = {};
          for (const row of allRows) {
            if (!byRound[row.round]) byRound[row.round] = [];
            byRound[row.round].push(row);
          }
          for (const r of Object.keys(byRound).sort((a, b) => Number(a) - Number(b))) {
            const lines = byRound[r].map((row, i) => {
              const cond = row.condition ? `*Condition: ${row.condition}*\n  → ` : '→ (unconditional) ';
              return `**${i + 1}.** ${cond}**${row.pick}**`;
            }).join('\n');
            embed.addFields({ name: `Round ${r}`, value: lines });
          }
        }
      }

      return interaction.reply({ embeds: [embed] });
    }

    // ── /clearpicks ───────────────────────────────────────────────────────────
    if (commandName === 'clearpicks') {
      const round = interaction.options.getInteger('round');
      if (round) {
        dbClearRound(user.id, round);
        return interaction.reply({ content: `Cleared your round ${round} picks.` });
      } else {
        dbClearAll(user.id);
        return interaction.reply({ content: 'Cleared all your picks.' });
      }
    }

    // ── /insertpick ───────────────────────────────────────────────────────────
    if (commandName === 'insertpick') {
      const round = interaction.options.getInteger('round');
      const position = interaction.options.getInteger('position');
      const pick = interaction.options.getString('pick');
      const condition = interaction.options.getString('condition') || null;

      const existing = dbGetPicks(user.id, round);
      const insertAt = Math.min(position, existing.length + 1);
      dbInsertPick(user.id, round, insertAt, pick, condition);

      return interaction.reply({
        content: `Inserted pick at position ${insertAt} in your round ${round} queue.`,
      });
    }

    // ── /removepick ───────────────────────────────────────────────────────────
    if (commandName === 'removepick') {
      const round = interaction.options.getInteger('round');
      const position = interaction.options.getInteger('position');

      const queue = dbGetPicks(user.id, round);
      if (position < 1 || position > queue.length) {
        return interaction.reply({
          content: `Invalid position. Your round ${round} queue has ${queue.length} entries.`,
        });
      }

      const removed = queue[position - 1];
      dbRemovePick(user.id, round, removed.position);
      return interaction.reply({
        content: `Removed entry ${position}: ${removed.condition ? `[${removed.condition}] ` : ''}${removed.pick}`,
      });
    }

    // ── /evaluate ─────────────────────────────────────────────────────────────
    if (commandName === 'evaluate') {
      let targetUser = interaction.options.getUser('player');
      let round = interaction.options.getInteger('round');

      // Fall back to draft order if not specified
      if (!targetUser || !round) {
        const state = dbGetState(guildId);
        const order = dbGetOrder(guildId);
        if (!state || order.length === 0) {
          return interaction.reply({
            content: 'No draft order set. Use `/draftorder` to set one, or specify a player and round manually.',
            ephemeral: true,
          });
        }
        if (!round) round = state.current_round;
        if (!targetUser) {
          const currentUserId = order[state.current_pos].user_id;
          targetUser = await client.users.fetch(currentUserId);
        }
      }

      return startEvaluation(interaction, targetUser, round);
    }

    // ── /condition ────────────────────────────────────────────────────────────
    if (commandName === 'condition') {
      const result = interaction.options.getString('result');
      return advanceEvaluation(interaction, result === 'met');
    }

    // ── /draftorder ───────────────────────────────────────────────────────────
    if (commandName === 'draftorder') {
      const playersStr = interaction.options.getString('players');

      if (!playersStr) {
        // View current order
        const embed = await formatOrderEmbed(guildId);
        return interaction.reply({ embeds: [embed] });
      }

      // Parse mentions from the string
      const mentionRegex = /<@!?(\d+)>/g;
      const userIds = [];
      let match;
      while ((match = mentionRegex.exec(playersStr)) !== null) {
        userIds.push(match[1]);
      }

      if (userIds.length === 0) {
        return interaction.reply({
          content: 'No valid mentions found. Use `@username` to mention players.',
          ephemeral: true,
        });
      }

      dbSetOrder(guildId, userIds);

      const names = await Promise.all(
        userIds.map(id => client.users.fetch(id).then(u => u.username).catch(() => id))
      );

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅ Draft order set')
          .setDescription(names.map((n, i) => `${i + 1}. ${n}`).join('\n'))
          .setFooter({ text: 'Round 1 • Starting with position 1' })],
      });
    }

    // ── /whosturn ─────────────────────────────────────────────────────────────
    if (commandName === 'whosturn') {
      const state = dbGetState(guildId);
      const order = dbGetOrder(guildId);

      if (!state || order.length === 0) {
        return interaction.reply({
          content: 'No draft order set. Use `/draftorder` to set one.',
          ephemeral: true,
        });
      }

      const currentUserId = order[state.current_pos].user_id;
      const currentUser = await client.users.fetch(currentUserId).catch(() => ({ username: currentUserId }));

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`🎯 It's ${currentUser.username}'s turn`)
          .setDescription(
            `**Round:** ${state.current_round}\n` +
            `**Pick position:** ${state.current_pos + 1} of ${order.length}\n\n` +
            `Use \`/evaluate\` to process their queued picks.`
          )],
      });
    }

    // ── /nextturn ─────────────────────────────────────────────────────────────
    if (commandName === 'nextturn') {
      const order = dbGetOrder(guildId);
      if (order.length === 0) {
        return interaction.reply({
          content: 'No draft order set. Use `/draftorder` to set one.',
          ephemeral: true,
        });
      }

      const next = dbAdvanceTurn(guildId);
      const nextUser = await client.users.fetch(next.userId).catch(() => ({ username: next.userId }));
      const isNewRound = next.pos === 0;

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(isNewRound ? 0xFEE75C : 0x5865F2)
          .setTitle(isNewRound ? `🔄 Round ${next.round} begins!` : `⏭️ Next pick`)
          .setDescription(
            `It's now **${nextUser.username}**'s turn.\n` +
            `**Round:** ${next.round} • **Position:** ${next.pos + 1} of ${order.length}\n\n` +
            `Use \`/evaluate\` to process their queued picks.`
          )],
      });
    }

    // ── /resetdraft ───────────────────────────────────────────────────────────
    if (commandName === 'resetdraft') {
      const confirm = interaction.options.getBoolean('confirm');
      const order = dbGetOrder(guildId);

      if (!confirm) {
        return interaction.reply({
          content:
            '⚠️ This will permanently delete the draft order, the current turn pointer, ' +
            'and **all queued picks** for every player in this draft.\n\n' +
            'Run `/resetdraft confirm:true` to actually do it.',
          ephemeral: true,
        });
      }

      if (order.length === 0) {
        return interaction.reply({
          content: 'Nothing to reset — no draft order is set for this server.',
          ephemeral: true,
        });
      }

      dbResetGuild(guildId, order);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFF6B6B)
          .setTitle('🗑️ Draft reset')
          .setDescription(
            'The draft order, turn pointer, and all queued picks for this draft have been wiped.\n\n' +
            'Use `/draftorder` to start a new one.'
          )],
      });
    }

  } catch (err) {
    console.error(`Error handling /${commandName}:`, err);
    const msg = { content: 'Something went wrong. Check the logs.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────

initDb()
  .then(registerCommands)
  .then(() => client.login(TOKEN));
