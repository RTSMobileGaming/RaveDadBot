require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const db = require('./database');
const taxonomy = require('./taxonomy.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- CONFIGURATION ---
const CHANNEL_LEADERBOARD = '1441545661316206685';
const CHANNEL_MOD_QUEUE = '1441526604449710133';
const CHANNEL_LEGACY = '1441526523659026626'; 

const CHANNEL_VOICE_PARTY = '1441790056770572398';
const CHANNEL_SESSION_LOG = '1444069047816687679';

const CHANNEL_ROUTER = {
    'EDM: House & Techno': '1442168642388230164',
    'EDM: Trance & Synth': '1442168642388230164',
    'EDM: Bass & Breakbeat': '1442168686411645100',
    'Hip Hop & Rap': '1442168686411645100',
    'Pop & R&B': '1442168686411645100',
    'Latin & Reggae': '1442168686411645100',
    'Rock: Classic & Hard': '1442168727717019819',
    'Rock: Metal & Heavy': '1442168727717019819',
    'Rock: Indie & Alt': '1442168727717019819',
    'Country: Modern & Pop': '1442168727717019819',
    'Country: Trad & Folk': '1442168727717019819',
    'Jazz & Blues': '1442168727717019819',
    'Cinematic & Score': '1442168819836649515',
    'World & International': '1442168819836649515',
    'Experimental & AI': '1442168819836649515'
};

const DAILY_SUBMISSION_LIMIT = 3; 
const SUBMISSION_COST = 3; 
const DAILY_POINT_CAP = 40; 
const WALLET_CAP = 60;

const ALLOWED_DOMAINS = ['youtube.com', 'youtu.be', 'music.youtube.com', 'spotify.com', 'suno.com', 'suno.ai', 'soundcloud.com', 'udio.com', 'sonauto.ai', 'tunee.ai', 'mureka.ai'];
const BACKUP_INTERVAL = 24 * 60 * 60 * 1000; 

// --- CACHE ---
const draftSubmissions = new Map(); 
const commandCooldowns = new Map();

// --- SYSTEM UTILS ---
process.on('uncaughtException', (error) => { console.error('CRITICAL ERROR:', error); });
setInterval(() => {
    try { fs.copyFileSync('./data/ravedad.db', './data/ravedad.backup.db'); } catch (e) { console.error('Backup failed:', e); }
}, BACKUP_INTERVAL);

// --- AUTO-MIGRATION ---
function addColumn(table, col, type) {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); } catch (e) {}
}
addColumn('songs', 'artist_name', 'TEXT');
addColumn('songs', 'channel_id', 'TEXT');
addColumn('songs', 'title', 'TEXT');
addColumn('votes', 'amount', 'INTEGER DEFAULT 1');
addColumn('users', 'listen_start', 'INTEGER DEFAULT 0');
addColumn('users', 'listen_song_id', 'INTEGER DEFAULT 0');
addColumn('users', 'extra_submits', 'INTEGER DEFAULT 0');
addColumn('users', 'suspended_until', 'INTEGER DEFAULT 0');
addColumn('users', 'suspend_reason', 'TEXT');

// --- HELPERS ---
function isModerator(member) {
    return member.permissions.has('Administrator') || member.permissions.has('KickMembers');
}

function isValidLink(url) {
    try {
        const domain = new URL(url).hostname.toLowerCase();
        return ALLOWED_DOMAINS.some(d => domain.includes(d));
    } catch (e) { return false; }
}

function getUser(userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (id, credits, lifetime_points, daily_points, last_active) VALUES (?, 10, 0, 0, ?)').run(userId, new Date().toDateString());
        return { 
            id: userId, credits: 10, lifetime_points: 0, daily_points: 0, last_active: new Date().toDateString(), 
            listen_start: 0, listen_song_id: 0, extra_submits: 0, suspended_until: 0, suspend_reason: null 
        };
    }
    return user;
}

function checkDailyLimit(userId) {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const count = db.prepare('SELECT COUNT(*) as count FROM songs WHERE user_id = ? AND timestamp > ?').get(userId, oneDayAgo);
    const user = getUser(userId);
    const bonus = user.extra_submits || 0;
    return { count: count.count, limit: DAILY_SUBMISSION_LIMIT + bonus };
}

function getSubmissionCooldown(userId) {
    const user = getUser(userId);
    const limit = DAILY_SUBMISSION_LIMIT + (user.extra_submits || 0);
    const songs = db.prepare('SELECT timestamp FROM songs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit);
    if (songs.length < limit) return null; 
    const oldestTimestamp = songs[songs.length - 1].timestamp;
    const unlockTime = oldestTimestamp + (24 * 60 * 60 * 1000);
    if (Date.now() > unlockTime) return null; 
    return Math.floor(unlockTime / 1000); 
}

function getCareerStats(userId) {
    const songs = db.prepare('SELECT COUNT(*) as count FROM songs WHERE user_id = ?').get(userId);
    const reviews = db.prepare('SELECT COUNT(*) as count FROM reviews WHERE user_id = ?').get(userId);
    return { songs: songs.count, reviews: reviews.count };
}

function addPoints(userId, amount = 2) {
    let user = getUser(userId);
    const today = new Date().toDateString();
    if (user.last_active !== today) {
        db.prepare('UPDATE users SET daily_points = 0, last_active = ? WHERE id = ?').run(today, userId);
        user.daily_points = 0; 
    }
    if (user.daily_points >= DAILY_POINT_CAP) return { earned: false, reason: "daily_cap" }; 
    if (user.credits >= WALLET_CAP) { 
        db.prepare('UPDATE users SET lifetime_points = lifetime_points + ?, daily_points = daily_points + ?, last_active = ? WHERE id = ?').run(amount, amount, today, userId);
        return { earned: false, reason: "wallet_cap" };
    }
    db.prepare('UPDATE users SET credits = credits + ?, lifetime_points = lifetime_points + ?, daily_points = daily_points + ?, last_active = ? WHERE id = ?').run(amount, amount, amount, today, userId);
    return { earned: true, amount: amount };
}

function spendCredits(userId, amount) {
    const user = getUser(userId);
    if (user.credits < amount) return false;
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
    return true;
}

function modifyUpvotes(songId, amount) { db.prepare('UPDATE songs SET upvotes = upvotes + ? WHERE id = ?').run(amount, songId); }
function incrementViews(songId) { db.prepare('UPDATE songs SET views = views + 1 WHERE id = ?').run(songId); }
function getSongStats(songId) { return db.prepare('SELECT upvotes, views, message_id, channel_id, user_id, description, artist_name, title, tags, url FROM songs WHERE id = ?').get(songId); }
function truncate(str, n){ return (str && str.length > n) ? str.slice(0, n-1) + '...' : str; }
function getRankIcon(index) { return index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`; }

function canUserVote(userId, songId, newPoints) {
    if (newPoints < 0) return true; 
    const record = db.prepare('SELECT SUM(amount) as total FROM votes WHERE voter_id = ? AND song_id = ? AND amount > 0').get(userId, songId);
    const currentTotal = record.total || 0;
    return (currentTotal + newPoints) <= 3;
}

function recordVote(userId, songId, amount) {
    db.prepare('INSERT INTO votes (song_id, voter_id, type, timestamp, amount) VALUES (?, ?, ?, ?, ?)').run(songId, userId, 'VOTE', Date.now(), amount);
}

// --- LEADERBOARD & STATS ---
async function updateLeaderboard(guild) {
    const channel = guild.channels.cache.get(CHANNEL_LEADERBOARD);
    if (!channel) return;
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    const totalSongs = db.prepare('SELECT COUNT(*) as count FROM songs').get().count;
    const totalReviews = db.prepare('SELECT COUNT(*) as count FROM reviews').get().count;
    const weeklySongs = db.prepare('SELECT COUNT(*) as count FROM songs WHERE timestamp > ?').get(sevenDaysAgo).count;
    const weeklyReviews = db.prepare('SELECT COUNT(*) as count FROM reviews WHERE timestamp > ?').get(sevenDaysAgo).count;

    const embedStats = new EmbedBuilder().setColor(0x2F3136).setTitle('📊 SERVER STATS').addFields(
        { name: 'Total Songs', value: `**${totalSongs}**`, inline: true }, { name: 'Total Reviews', value: `**${totalReviews}**`, inline: true }, { name: '\u200B', value: '\u200B', inline: true },
        { name: 'Weekly Songs', value: `**${weeklySongs}**`, inline: true }, { name: 'Weekly Reviews', value: `**${weeklyReviews}**`, inline: true }, { name: '\u200B', value: '\u200B', inline: true }
    );

    const topCritics = db.prepare('SELECT id, lifetime_points FROM users ORDER BY lifetime_points DESC LIMIT 10').all();
    const criticList = topCritics.map((u, i) => `${getRankIcon(i)} <@${u.id}> • **${u.lifetime_points}**`).join('\n') || "No data.";
    const topArtists = db.prepare('SELECT user_id, COUNT(*) as count FROM songs GROUP BY user_id ORDER BY count DESC LIMIT 10').all();
    const artistList = topArtists.map((u, i) => `${getRankIcon(i)} <@${u.user_id}> • **${u.count}**`).join('\n') || "No data.";
    const embedLifePeople = new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 LIFETIME: PEOPLE').addFields({ name: '👑 Top Critics (Pts)', value: criticList, inline: true }, { name: '🎨 Top Artists (Vol)', value: artistList, inline: true });

    const topSongs = db.prepare('SELECT id, url, upvotes, title, artist_name FROM songs ORDER BY upvotes DESC LIMIT 10').all();
    const songList = topSongs.map((s, i) => { const artist = s.artist_name ? `**${s.artist_name}**` : 'Unknown'; const displayTitle = s.title ? truncate(s.title, 20) : `Track ${s.id}`; return `${getRankIcon(i)} ${artist} - [${displayTitle}](${s.url}) • 🔥 **${s.upvotes}**`; }).join('\n') || "No data.";
    const embedLifeTracks = new EmbedBuilder().setColor(0xFFA500).setTitle('🔥 LIFETIME: TRACKS').setDescription(songList);

    const weekCritics = db.prepare(`SELECT user_id as id, COUNT(*) * 2 as score FROM reviews WHERE timestamp > ? GROUP BY user_id ORDER BY score DESC LIMIT 10`).all(sevenDaysAgo);
    const weekCriticList = weekCritics.map((u, i) => `${getRankIcon(i)} <@${u.id}> • **${u.score}**`).join('\n') || "No data.";
    const weekArtists = db.prepare(`SELECT user_id, COUNT(*) as count FROM songs WHERE timestamp > ? GROUP BY user_id ORDER BY count DESC LIMIT 10`).all(sevenDaysAgo);
    const weekArtistList = weekArtists.map((u, i) => `${getRankIcon(i)} <@${u.user_id}> • **${u.count}**`).join('\n') || "No data.";
    const embedWeekPeople = new EmbedBuilder().setColor(0x00FF00).setTitle('📅 WEEKLY: PEOPLE').addFields({ name: '🚀 Top Critics (Pts)', value: weekCriticList, inline: true }, { name: '🎨 Top Artists (Vol)', value: weekArtistList, inline: true });

    const weekSongsRaw = db.prepare(`SELECT song_id, SUM(amount) as score FROM votes WHERE timestamp > ? AND amount > 0 GROUP BY song_id ORDER BY score DESC LIMIT 10`).all(sevenDaysAgo);
    const weekSongList = weekSongsRaw.map((stat, i) => { const song = db.prepare('SELECT url, title, artist_name FROM songs WHERE id = ?').get(stat.song_id); if (!song) return `${getRankIcon(i)} Unknown`; const artist = song.artist_name ? `**${song.artist_name}**` : 'Unknown'; const displayTitle = song.title ? truncate(song.title, 20) : 'Track'; return `${getRankIcon(i)} ${artist} - [${displayTitle}](${song.url}) • 🔥 **+${stat.score}**`; }).join('\n') || "No data.";
    const embedWeekTracks = new EmbedBuilder().setColor(0x00FF00).setTitle('📈 WEEKLY: TRACKS').setDescription(weekSongList).setFooter({ text: `Updated: ${new Date().toLocaleTimeString()}` });

    const messages = await channel.messages.fetch({ limit: 10 });
    const sendOrEdit = async (title, embed) => { const existing = messages.find(m => m.embeds[0]?.title === title); if (existing) await existing.edit({ embeds: [embed] }); else await channel.send({ embeds: [embed] }); };

    await sendOrEdit('📊 SERVER STATS', embedStats); await sendOrEdit('🏆 LIFETIME: PEOPLE', embedLifePeople); await sendOrEdit('🔥 LIFETIME: TRACKS', embedLifeTracks); await sendOrEdit('📅 WEEKLY: PEOPLE', embedWeekPeople); await sendOrEdit('📈 WEEKLY: TRACKS', embedWeekTracks);
}

// --- SHARED UPDATE LOGIC ---
async function updatePublicEmbed(guild, songId) {
    const song = getSongStats(songId);
    if (!song || !song.message_id) return;
    let channelId = song.channel_id || CHANNEL_LEGACY;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;
    try {
        const message = await channel.messages.fetch(song.message_id);
        if (message) {
            const tags = JSON.parse(song.tags); 
            const primaryDisplay = `${tags[0]} > ${tags[1]}`;
            const secondaryDisplay = tags[2] && tags[2] !== 'SKIP' ? `\n${tags[2]} > ${tags[3]}` : '';
            const artistField = song.artist_name ? `**Artist:** ${song.artist_name}\n` : '';
            const newEmbed = new EmbedBuilder().setColor(0x0099FF).setTitle('🔥 Fresh Drop Alert').setDescription(`**User:** <@${song.user_id}>\n${artistField}**Genres:**\n${primaryDisplay}${secondaryDisplay}\n\n**Description:**\n${song.description}`).addFields({ name: 'Listen Here', value: song.url }).setFooter({ text: `Song ID: ${songId} | 🔥 Score: ${song.upvotes} | 👀 Views: ${song.views}` });
            await message.edit({ embeds: [newEmbed] });
        }
    } catch (e) { console.error(`Update Embed Failed for Song ${songId}:`, e); }
    
    // Update Session Log
    const logChannel = guild.channels.cache.get(CHANNEL_SESSION_LOG);
    if (logChannel) {
        try {
            const logs = await logChannel.messages.fetch({ limit: 10 });
            const card = logs.find(m => m.embeds[0]?.footer?.text.includes(`ID: ${songId}`));
            if (card) {
                const oldEmbed = card.embeds[0];
                const newEmbed = new EmbedBuilder(oldEmbed.data).setFooter({ text: `ID: ${songId} | Score: ${song.upvotes}` });
                await card.edit({ embeds: [newEmbed] });
            }
        } catch (e) { /* Ignore */ }
    }
}

async function finalizeSubmission(interaction, draft) {
    if (!spendCredits(interaction.user.id, SUBMISSION_COST)) {
         return interaction.update({ content: `❌ **Transaction Failed.** You need ${SUBMISSION_COST} Credits. Review tracks to earn more.`, components: [] });
    }

    const finalTags = [draft.macro1, draft.micro1, draft.macro2, draft.micro2].filter(t => t && t !== 'SKIP');
    const targetChannelId = CHANNEL_ROUTER[draft.macro1] || CHANNEL_LEGACY; 
    const stmt = db.prepare('INSERT INTO songs (user_id, url, description, tags, timestamp, artist_name, channel_id, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    
    // Using explicit Title from Modal (if available) or fallback
    const songTitle = draft.title || "Untitled Track";
    const info = stmt.run(interaction.user.id, draft.link, draft.description, JSON.stringify(finalTags), Date.now(), draft.artist_name, targetChannelId, songTitle);
    const songId = info.lastInsertRowid;
    const channel = interaction.guild.channels.cache.get(targetChannelId);
    if (channel) {
        const primaryDisplay = `${draft.macro1} > ${draft.micro1}`;
        const secondaryDisplay = draft.macro2 && draft.macro2 !== 'SKIP' ? `\n${draft.macro2} > ${draft.micro2}` : '';
        const artistField = draft.artist_name ? `**Artist:** ${draft.artist_name}\n` : '';
        const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('🔥 Fresh Drop Alert').setDescription(`**User:** <@${interaction.user.id}>\n**Title:** ${songTitle}\n${artistField}**Genres:**\n${primaryDisplay}${secondaryDisplay}\n\n**Description:**\n${draft.description}`).addFields({ name: 'Listen Here', value: draft.link }).setFooter({ text: `Song ID: ${songId} | 🔥 Score: 0 | 👀 Views: 0` });
        const listenBtn = new ButtonBuilder().setCustomId(`listen_${songId}`).setLabel('🎧 Start Listening').setStyle(ButtonStyle.Primary);
        const reportBtn = new ButtonBuilder().setCustomId(`report_${songId}`).setLabel('⚠️ Report').setStyle(ButtonStyle.Danger);
        const sentMsg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(listenBtn, reportBtn)] });
        db.prepare('UPDATE songs SET message_id = ? WHERE id = ?').run(sentMsg.id, songId);
        try {
            await sentMsg.startThread({ name: `💬 Reviews: ${draft.artist_name ? draft.artist_name + ' - ' : ''}${truncate(draft.description, 15)}`, autoArchiveDuration: 60, reason: 'Song Review Thread', });
        } catch (e) { console.error("Could not create thread:", e); }
    }
    
    const user = getUser(interaction.user.id);
    await interaction.update({ content: `✅ **Submission Complete!**\n💸 **Paid:** ${SUBMISSION_COST} Credits\n💰 **Remaining:** ${user.credits}\nPosted to <#${targetChannelId}>.`, components: [] });
    draftSubmissions.delete(interaction.user.id);
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(() => {
        const guildId = process.env.GUILD_ID;
        const guild = client.guilds.cache.get(guildId);
        if (guild) updateLeaderboard(guild);
    }, 5 * 60 * 1000); 
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const now = Date.now();
        const userId = interaction.user.id;
        if (interaction.commandName !== 'admin-delete' && commandCooldowns.has(userId)) {
            if (now < commandCooldowns.get(userId) + 3000) return interaction.reply({ content: `⏳ Wait 3 seconds.`, ephemeral: true });
        }
        commandCooldowns.set(userId, now);

        if (interaction.commandName === 'admin-delete') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            const songId = interaction.options.getInteger('song_id');
            const song = getSongStats(songId);
            if (!song) return interaction.reply({ content: `❌ Song ID ${songId} not found in database.`, ephemeral: true });
            const targetChannelId = song.channel_id || CHANNEL_LEGACY;
            const channel = interaction.guild.channels.cache.get(targetChannelId);
            if (channel && song.message_id) {
                try {
                    const msg = await channel.messages.fetch(song.message_id);
                    if (msg) { if (msg.thread) await msg.thread.delete(); await msg.delete(); }
                } catch (e) { console.log("Message/Thread already gone."); }
            }
            db.prepare('DELETE FROM songs WHERE id = ?').run(songId);
            await interaction.reply({ content: `🗑️ **Terminated.** Song ID ${songId} deleted.`, ephemeral: true });
        }

        if (interaction.commandName === 'admin-add-points') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            const target = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');
            getUser(target.id); 
            db.prepare('UPDATE users SET credits = credits + ?, lifetime_points = lifetime_points + ? WHERE id = ?').run(amount, amount, target.id);
            await interaction.reply({ content: `✅ **Stimulus Applied.** Given ${amount} Credits & Lifetime Pts to ${target.username}.`, ephemeral: true });
        }

        if (interaction.commandName === 'admin-set-bonus') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            const target = interaction.options.getUser('user');
            const slots = interaction.options.getInteger('extra_slots');
            getUser(target.id);
            db.prepare('UPDATE users SET extra_submits = ? WHERE id = ?').run(slots, target.id);
            await interaction.reply({ content: `✅ **Limit Updated.** ${target.username} now has +${slots} extra daily submissions.`, ephemeral: true });
        }

        if (interaction.commandName === 'leech-list') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            const limit = Math.min(interaction.options.getInteger('limit'), 25);
            const leeches = db.prepare(`WITH Stats AS (SELECT user_id, COUNT(*) as songs, (SELECT COUNT(*) FROM reviews WHERE user_id = songs.user_id) as reviews FROM songs GROUP BY user_id) SELECT *, (reviews * 1.0 / songs) as ratio FROM Stats ORDER BY ratio ASC, songs DESC LIMIT ?`).all(limit);
            if (leeches.length === 0) return interaction.reply({ content: "No data found.", ephemeral: true });
            const lines = leeches.map((l, i) => { const ratio = l.ratio ? l.ratio.toFixed(2) : "0.00"; return `${i+1}. <@${l.user_id}> • Ratio: **${ratio}** (🎵 ${l.songs} | 📝 ${l.reviews})`; });
            const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(`🧛 Top ${limit} Leeches`).setDescription(lines.join('\n')).setFooter({ text: 'Sorted by Lowest Ratio -> Highest Song Count' });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (interaction.commandName === 'weekly-report') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            updateLeaderboard(interaction.guild);
            await interaction.reply({ content: "✅ Boards refreshed.", ephemeral: true });
        }

        if (interaction.commandName === 'suspend') {
            if (!isModerator(interaction.member)) return interaction.reply({ content: "Mods only.", ephemeral: true });
            const target = interaction.options.getUser('user');
            const hours = interaction.options.getInteger('hours');
            const reason = interaction.options.getString('reason');
            
            getUser(target.id); // Ensure exists
            const unlockTime = Date.now() + (hours * 60 * 60 * 1000);
            
            db.prepare('UPDATE users SET suspended_until = ?, suspend_reason = ? WHERE id = ?').run(unlockTime, reason, target.id);
            await interaction.reply({ content: `🚫 **User Suspended.**\nTarget: ${target.username}\nDuration: ${hours} Hours\nReason: ${reason}`, ephemeral: false });
        }

        if (interaction.commandName === 'submit') {
            const user = getUser(interaction.user.id);

            // 0. CHECK SUSPENSION
            if (user.suspended_until > Date.now()) {
                const remaining = Math.ceil((user.suspended_until - Date.now()) / (1000 * 60 * 60));
                return interaction.reply({ 
                    content: `🚫 **ACCESS DENIED**\nYou are suspended from submitting.\n\n**Reason:** ${user.suspend_reason}\n**Lifted in:** ${remaining} Hours.`, 
                    ephemeral: true 
                });
            }

            // 1. CHECK BANK ACCOUNT
            if (user.credits < SUBMISSION_COST) {
                return interaction.reply({ 
                    content: `🛑 **Insufficient Credits!**\nIt costs **${SUBMISSION_COST} Credits** to submit a song.\nYou have: **${user.credits}**.\n\n💡 **How to earn:** Go review at least 2 songs from other members to earn credits!`, 
                    ephemeral: true 
                });
            }

            // 2. CHECK DAILY LIMIT
            const status = checkDailyLimit(interaction.user.id);
            if (status.count >= status.limit) {
                const cooldownTimestamp = getSubmissionCooldown(interaction.user.id);
                let timeMsg = "Tomorrow";
                if (cooldownTimestamp) timeMsg = `<t:${cooldownTimestamp}:R>`;
                return interaction.reply({ 
                    content: `🛑 **Daily Limit Reached!**\nYou have submitted ${status.count}/${status.limit} songs in the last 24 hours.\n\n🔓 **Next Unlock:** ${timeMsg}`, 
                    ephemeral: true 
                });
            }

            const modal = new ModalBuilder().setCustomId('submission_modal').setTitle('Submit a Track');
            const linkInput = new TextInputBuilder().setCustomId('song_link').setLabel("Link").setStyle(TextInputStyle.Short).setRequired(true);
            const titleInput = new TextInputBuilder().setCustomId('song_title').setLabel("Song Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50);
            const artistInput = new TextInputBuilder().setCustomId('artist_name').setLabel("Artist/Band Name (Optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50);
            const descInput = new TextInputBuilder().setCustomId('song_desc').setLabel("Description").setStyle(TextInputStyle.Paragraph).setMaxLength(100).setRequired(true);
            
            modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(artistInput), new ActionRowBuilder().addComponents(linkInput), new ActionRowBuilder().addComponents(descInput));
            await interaction.showModal(modal);
        }

        if (interaction.commandName === 'stage') {
            const link = interaction.options.getString('link');
            if (!isValidLink(link)) return interaction.reply({ content: "❌ Invalid Link.", ephemeral: true });
            const existing = db.prepare('SELECT * FROM songs WHERE url = ?').get(link);
            const logChannel = interaction.guild.channels.cache.get(CHANNEL_SESSION_LOG);
            if (existing) {
                const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🔴 NOW PLAYING').setDescription(`**${existing.title || 'Track'}** by ${existing.artist_name || 'Unknown'}\n${existing.description}`).addFields({ name: 'Listen', value: link }).setFooter({ text: `ID: ${existing.id} | Score: ${existing.upvotes}` });
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_1_${existing.id}`).setLabel('🔥 Banger (+1)').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`scribe_${existing.id}`).setLabel('📝 Scribe Note').setStyle(ButtonStyle.Secondary));
                await logChannel.send({ embeds: [embed], components: [row] });
                await interaction.reply({ content: "✅ Queued existing track.", ephemeral: true });
            } else {
                const status = checkDailyLimit(interaction.user.id);
                if (status.count >= status.limit) {
                    const cooldownTimestamp = getSubmissionCooldown(interaction.user.id);
                    return interaction.reply({ content: `🛑 **Daily Limit Reached!** You cannot stage NEW songs until <t:${cooldownTimestamp}:R>.`, ephemeral: true });
                }
                const modal = new ModalBuilder().setCustomId(`stage_modal`).setTitle('Quick Add to Stage');
                draftSubmissions.set(interaction.user.id, { link: link, is_stage: true });
                const titleInput = new TextInputBuilder().setCustomId('song_title').setLabel("Song Title").setStyle(TextInputStyle.Short).setRequired(true);
                const artistInput = new TextInputBuilder().setCustomId('artist_name').setLabel("Artist Name").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(artistInput));
                await interaction.showModal(modal);
            }
        }
        
        if (interaction.commandName === 'profile') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const isSelf = targetUser.id === interaction.user.id;
            const hasPower = isModerator(interaction.member);
            if (!isSelf && !hasPower) {
                 return interaction.reply({ content: "❌ Only Moderators can inspect other users.", ephemeral: true });
            }

            const user = getUser(targetUser.id);
            const stats = getCareerStats(targetUser.id);
            const today = new Date().toDateString();
            const displayDaily = (user.last_active === today) ? user.daily_points : 0;
            const subStatus = checkDailyLimit(targetUser.id);
            const cooldownTimestamp = getSubmissionCooldown(targetUser.id);
            const embed = generateProfileEmbed(user, stats, displayDaily, subStatus, cooldownTimestamp, targetUser.displayAvatarURL(), targetUser.username);
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (interaction.commandName === 'share-profile') {
            const user = getUser(interaction.user.id);
            const stats = getCareerStats(interaction.user.id);
            const today = new Date().toDateString();
            const displayDaily = (user.last_active === today) ? user.daily_points : 0;
            const subStatus = checkDailyLimit(interaction.user.id);
            const cooldownTimestamp = getSubmissionCooldown(interaction.user.id);
            const embed = generateProfileEmbed(user, stats, displayDaily, subStatus, cooldownTimestamp, interaction.user.displayAvatarURL(), interaction.user.username);
            await interaction.reply({ content: "📢 **Flexing Stats!**", embeds: [embed], ephemeral: false });
        }

        function generateProfileEmbed(user, stats, displayDaily, subStatus, cooldownTimestamp, avatarUrl, username) {
            let unlockStatus = "✅ Ready to Submit";
            if (user.suspended_until > Date.now()) {
                unlockStatus = "🚫 SUSPENDED";
            } else if (subStatus.count >= subStatus.limit) {
                if (cooldownTimestamp) unlockStatus = `⏳ Unlock: <t:${cooldownTimestamp}:R>`;
            } else {
                unlockStatus = `✅ Available (${subStatus.limit - subStatus.count} slots left)`;
            }

            let ratio = 0;
            if (stats.songs > 0) {
                ratio = (stats.reviews / stats.songs).toFixed(1);
            } else if (stats.reviews > 0) {
                ratio = "∞"; 
            }

            let ratioDisplay = `${ratio}`;
            if (ratio === "∞" || ratio >= 1.0) ratioDisplay = `🟢 ${ratio} (Contributor)`;
            else if (ratio > 0) ratioDisplay = `🔴 ${ratio} (Leech Warning)`;
            else ratioDisplay = `🔴 0.0 (Leech)`;

            return new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle(`👤 Agent Profile: ${username}`)
                .addFields(
                    { name: '💰 Credits', value: `**${user.credits}** / ${WALLET_CAP}`, inline: true },
                    { name: '🏆 Rank', value: `**${user.lifetime_points}** Lifetime Pts`, inline: true },
                    { name: '⚖️ Ratio', value: `**${ratioDisplay}** (Reviews/Songs)`, inline: true },
                    { name: '📊 Career Stats', value: `🎵 **${stats.songs}** Songs\n📝 **${stats.reviews}** Reviews`, inline: true },
                    { name: '📅 Daily Cap', value: `${displayDaily} / ${DAILY_POINT_CAP} pts`, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }, 
                    { name: '🔓 Submission Status', value: unlockStatus, inline: false }
                )
                .setThumbnail(avatarUrl);
        }

        if (interaction.commandName === 'top') {
             const genre = interaction.options.getString('genre');
             const tracks = db.prepare("SELECT * FROM songs WHERE tags LIKE ? ORDER BY upvotes DESC LIMIT 10").all(`%${genre}%`);
             if (tracks.length === 0) return interaction.reply({ content: `No tracks found for **${genre}** yet.`, ephemeral: true });
             const list = tracks.map((t, i) => {
                 const tags = JSON.parse(t.tags);
                 const artistDisplay = t.artist_name ? `**${t.artist_name}** - ` : '';
                 const descSnippet = truncate(t.description, 30);
                 return `${getRankIcon(i)} ${artistDisplay}**[${descSnippet}]**([Listen](${t.url})) - 🔥 ${t.upvotes}`;
             }).join('\n');
             const embed = new EmbedBuilder().setColor(0x00ff00).setTitle(`🔥 Top 10: ${genre}`).setDescription(list);
             await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        if (interaction.commandName === 'init-leaderboard') {
             if (!isModerator(interaction.member)) return interaction.reply({ content: "Admin only.", ephemeral: true });
             await interaction.reply({ content: "Initializing 5-Stack Leaderboard...", ephemeral: true });
             updateLeaderboard(interaction.guild);
        }
        if (interaction.commandName === 'init-welcome') {
             if (!isModerator(interaction.member)) return interaction.reply({ content: "Admin only.", ephemeral: true });
             const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🤖 Welcome to the Future of Music').setDescription(`We are a community of AI music creators dedicated to honest feedback and growth.\n\n**COMMUNITY RULES:**\n1. **Respect Everyone:** No hate speech, harassment, or toxicity.\n2. **Give to Get:** You must review songs to earn credits.\n3. **Honesty:** Low-effort spam reviews will result in a ban.\n4. **No Spam:** Don't DM members with self-promotion.\n\n*By clicking below, you agree to these terms.*`).setImage('https://media.discordapp.net/attachments/123456789/123456789/banner.png');
             const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('accept_tos').setLabel('✅ I Accept & Enter').setStyle(ButtonStyle.Success));
             await interaction.channel.send({ embeds: [embed], components: [row] });
             await interaction.reply({ content: "Gatekeeper initialized.", ephemeral: true });
        }
        if (interaction.commandName === 'songs') {
             const targetUser = interaction.options.getUser('user') || interaction.user;
             const songs = db.prepare('SELECT * FROM songs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 5').all(targetUser.id);
             const embed = generateSongListEmbed(targetUser, songs);
             await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        if (interaction.commandName === 'share-songs') {
             const targetUser = interaction.options.getUser('user') || interaction.user;
             const songs = db.prepare('SELECT * FROM songs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 5').all(targetUser.id);
             const embed = generateSongListEmbed(targetUser, songs);
             await interaction.reply({ content: `🎵 **Recent Tracks by ${targetUser.username}**`, embeds: [embed], ephemeral: false });
        }
    }

    // --- MODAL & MENU HANDLERS ---
    if (interaction.isStringSelectMenu()) {
        const draft = draftSubmissions.get(interaction.user.id);
        if (!draft) return interaction.reply({ content: "❌ **Session Expired.** The bot may have restarted. Please run `/submit` again.", ephemeral: true });

        if (interaction.customId === 'stage_select_genre') {
             const genre = interaction.values[0];
             const targetChannelId = CHANNEL_ROUTER[genre] || CHANNEL_LEGACY;
             const stmt = db.prepare('INSERT INTO songs (user_id, url, description, tags, timestamp, title, artist_name, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
             const tags = JSON.stringify([genre, "Live Session"]);
             const info = stmt.run(interaction.user.id, draft.link, "Played Live on Stage", tags, Date.now(), draft.title, draft.artist_name, targetChannelId);
             const songId = info.lastInsertRowid;
             const publicChannel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(targetChannelId);
             if (publicChannel) {
                 const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('🔥 Fresh Drop Alert').setDescription(`**User:** <@${interaction.user.id}>\n**Artist:** ${draft.artist_name}\n**Genres:**\n${genre} > Live Session\n\n**Description:**\nPlayed Live on Stage`).addFields({ name: 'Listen Here', value: draft.link }).setFooter({ text: `Song ID: ${songId} | 🔥 Score: 0 | 👀 Views: 0` });
                 const listenBtn = new ButtonBuilder().setCustomId(`listen_${songId}`).setLabel('🎧 Start Listening').setStyle(ButtonStyle.Primary);
                 const reportBtn = new ButtonBuilder().setCustomId(`report_${songId}`).setLabel('⚠️ Report').setStyle(ButtonStyle.Danger);
                 const msg = await publicChannel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(listenBtn, reportBtn)] });
                 db.prepare('UPDATE songs SET message_id = ? WHERE id = ?').run(msg.id, songId);
                 await msg.startThread({ name: `💬 Reviews: ${draft.title}`, autoArchiveDuration: 60 });
             }
             const logChannel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(CHANNEL_SESSION_LOG);
             const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🔴 NOW PLAYING').setDescription(`**${draft.title}** by ${draft.artist_name}`).addFields({ name: 'Listen', value: draft.link }).setFooter({ text: `ID: ${songId}` });
             const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_1_${songId}`).setLabel('🔥 Banger (+1)').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`scribe_${songId}`).setLabel('📝 Scribe Note').setStyle(ButtonStyle.Secondary));
             await logChannel.send({ embeds: [embed], components: [row] });
             await interaction.update({ content: "✅ On Stage! Posted to Session Log AND Public Channel.", components: [] });
        }

        // Standard Menus
        if (interaction.customId === 'select_macro_1') {
             draft.macro1 = interaction.values[0];
             draftSubmissions.set(interaction.user.id, draft);
             const rawOptions = taxonomy[draft.macro1] || [];
             const uniqueOptions = [...new Set(rawOptions)].filter(s => typeof s === 'string' && s.length > 0).slice(0, 25);
             if (uniqueOptions.length === 0) return interaction.update({ content: `❌ **Configuration Error.**`, components: [] });
             const options = uniqueOptions.map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
             const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_1').setPlaceholder(`Select Style`).addOptions(options));
             const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
             await interaction.update({ content: `**Step 2/4:** Select specific style for ${draft.macro1}`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_micro_1') {
             draft.micro1 = interaction.values[0];
             draftSubmissions.set(interaction.user.id, draft);
             const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m)).slice(0, 24); 
             macroOptions.unshift(new StringSelectMenuOptionBuilder().setLabel("🚫 No Secondary Genre (Skip)").setValue("SKIP"));
             const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_2').setPlaceholder('Select Secondary Category').addOptions(macroOptions));
             const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_micro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
             await interaction.update({ content: `**Step 3/4:** Select a Secondary Genre (or Skip)`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_macro_2') {
             if (interaction.values[0] === 'SKIP') { draft.macro2 = 'SKIP'; return finalizeSubmission(interaction, draft); }
             draft.macro2 = interaction.values[0];
             draftSubmissions.set(interaction.user.id, draft);
             const rawOptions = taxonomy[draft.macro2] || [];
             const uniqueOptions = [...new Set(rawOptions)].filter(s => typeof s === 'string' && s.length > 0).slice(0, 25);
             const options = uniqueOptions.map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
             const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_2').setPlaceholder(`Select Style`).addOptions(options));
             const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_2').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
             await interaction.update({ content: `**Step 4/4:** Select specific style for ${draft.macro2}`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_micro_2') {
             draft.micro2 = interaction.values[0];
             return finalizeSubmission(interaction, draft);
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'submission_modal') {
            const link = interaction.fields.getTextInputValue('song_link');
            if (!isValidLink(link)) return interaction.reply({ content: "❌ Invalid Link.", ephemeral: true });
            const title = interaction.fields.getTextInputValue('song_title'); 
            const desc = interaction.fields.getTextInputValue('song_desc');
            const artist = interaction.fields.getTextInputValue('artist_name'); 
            draftSubmissions.set(interaction.user.id, { link, description: desc, artist_name: artist, title: title });
            const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_1').setPlaceholder('Select Primary Category').addOptions(macroOptions));
            await interaction.reply({ content: `**Step 2/4:** Select Genre`, components: [row], ephemeral: true });
        }

        if (interaction.customId === 'stage_modal') {
            const draft = draftSubmissions.get(interaction.user.id);
            const title = interaction.fields.getTextInputValue('song_title');
            const artist = interaction.fields.getTextInputValue('artist_name');
            draft.title = title;
            draft.artist_name = artist;
            draftSubmissions.set(interaction.user.id, draft);
            const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('stage_select_genre').setPlaceholder('Select Genre').addOptions(macroOptions));
            await interaction.reply({ content: `Select Genre for the Stage:`, components: [row], ephemeral: true });
        }

        // SCRIBE NOTE WITH DUPLICATE CHECK
        if (interaction.customId.startsWith('scribe_submit_')) {
            const songId = interaction.customId.split('_')[2];
            const note = interaction.fields.getTextInputValue('scribe_note');
            
            // Check for duplicates
            const check = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND song_id = ?').get(interaction.user.id, songId);
            if (check) return interaction.reply({ content: "❌ **You have already scribed/reviewed this track.**", ephemeral: true });

            // Insert into DB to prevent future double-dipping and grant points
            db.prepare('INSERT OR IGNORE INTO reviews (user_id, song_id, timestamp) VALUES (?, ?, ?)').run(interaction.user.id, songId, Date.now());
            const reward = 2; 
            const result = addPoints(interaction.user.id, reward);
            
            const song = getSongStats(songId);
            const targetChannelId = song.channel_id || CHANNEL_LEGACY;
            const channel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(targetChannelId);
            if (channel && song.message_id) {
                const message = await channel.messages.fetch(song.message_id);
                if (message) {
                    let thread = message.thread;
                    if (!thread) { thread = await message.startThread({ name: `💬 Reviews: ${song.title || 'Track'}`, autoArchiveDuration: 60 }); }
                    await thread.send(`🎙️ **Live Session Note** by <@${interaction.user.id}> for <@${song.user_id}>:\n"${note}"`);
                    let msg = result.earned ? `✅ **Note Scribed!** (+${reward} Credits)` : `✅ **Note Scribed!** (Daily Cap Reached)`;
                    await interaction.reply({ content: msg, ephemeral: true });
                }
            }
        }
        
        if (interaction.customId.startsWith('review_submit_')) {
             const songId = interaction.customId.split('_')[2];
             const reviewText = interaction.fields.getTextInputValue('review_text');
             const check = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND song_id = ?').get(interaction.user.id, songId);
             if (check) return interaction.reply({ content: "❌ **You have already reviewed this track.**", ephemeral: true });
             if (reviewText.split(/\s+/).length < 5) return interaction.reply({ content: "❌ Review too short!", ephemeral: true });
             db.prepare('INSERT OR IGNORE INTO reviews (user_id, song_id, timestamp) VALUES (?, ?, ?)').run(interaction.user.id, songId, Date.now());
             const result = addPoints(interaction.user.id);
             const user = getUser(interaction.user.id);
             let msg = result.earned ? `✅ **Review Accepted!** (+2 Credits)` : `✅ **Review Accepted!** (Cap Reached)`;
             msg += `\n💰 **Balance:** ${user.credits} | 🏆 **Lifetime:** ${user.lifetime_points}\n\n**Spend credits to Vote:**`;
             const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_1_${songId}`).setLabel('+1 Vote (Cost: 1)').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`vote_2_${songId}`).setLabel('+2 Votes (Cost: 2)').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`vote_3_${songId}`).setLabel('🔥 God Mode +3 (Cost: 3)').setStyle(ButtonStyle.Success));
             if (user.lifetime_points >= 50) row.addComponents(new ButtonBuilder().setCustomId(`vote_neg1_${songId}`).setLabel('👎 Dislike (Cost: 3)').setStyle(ButtonStyle.Danger));
             try {
                 await interaction.user.send({ content: `**Review Submitted!**\n${msg}`, components: [row] });
                 await interaction.reply({ content: "✅ **Check your DMs!** I sent the voting menu there so you can keep scrolling.", ephemeral: true });
             } catch (e) {
                 await interaction.reply({ content: msg, components: [row], ephemeral: true });
             }
             const song = getSongStats(songId);
             const targetChannelId = song.channel_id || CHANNEL_LEGACY;
             if (song && song.message_id) {
                 try {
                     const guild = client.guilds.cache.get(process.env.GUILD_ID);
                     const channel = guild.channels.cache.get(targetChannelId);
                     const message = await channel.messages.fetch(song.message_id);
                     if (message && message.thread) { await message.thread.send(`⭐ **<@${interaction.user.id}>** left a review for <@${song.user_id}>:\n"${reviewText}"`); }
                 } catch (e) { console.error("Thread Post Error:", e); }
             }
        }
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const action = parts[0];

        if (action === 'back') {
             const draft = draftSubmissions.get(interaction.user.id);
             if (!draft) return interaction.reply({ content: "Session expired.", ephemeral: true });
             const step = parts.slice(2).join('_');
             if (step === 'macro_1') {
                 const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                 const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_1').setPlaceholder('Select Primary Category').addOptions(macroOptions));
                 await interaction.update({ content: `**Step 1/4:** Select Primary Genre`, components: [row] });
             }
             else if (step === 'micro_1') {
                 const subGenres = taxonomy[draft.macro1] || [];
                 const options = [...new Set(subGenres)].slice(0, 25).map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
                 const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_1').setPlaceholder(`Select Style`).addOptions(options));
                 const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                 await interaction.update({ content: `**Step 2/4:** Select specific style for ${draft.macro1}`, components: [menuRow, btnRow] });
             }
             else if (step === 'macro_2') {
                 const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                 macroOptions.unshift(new StringSelectMenuOptionBuilder().setLabel("🚫 No Secondary Genre (Skip)").setValue("SKIP"));
                 const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_2').setPlaceholder('Select Secondary Category').addOptions(macroOptions));
                 const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_micro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                 await interaction.update({ content: `**Step 3/4:** Select a Secondary Genre (or Skip)`, components: [menuRow, btnRow] });
             }
        }

        if (action === 'accept') {
             if (parts[1] === 'tos') {
                 const roleName = "Verified Member";
                 if (!interaction.guild) return interaction.reply({content: "Please accept TOS in the server channel.", ephemeral: true});
                 const role = interaction.guild.roles.cache.find(r => r.name === roleName);
                 if (!role) return interaction.reply({ content: `❌ **Configuration Error:** Role "${roleName}" not found.`, ephemeral: true });
                 if (interaction.member.roles.cache.has(role.id)) return interaction.reply({ content: "You are already verified! Go make some music.", ephemeral: true });
                 try { await interaction.member.roles.add(role); await interaction.reply({ content: "✅ **Access Granted.** Welcome to the community!", ephemeral: true }); } catch (err) { console.error(err); await interaction.reply({ content: "❌ Error: Bot Role must be higher than 'Verified Member'.", ephemeral: true }); }
             }
        }

        if (action === 'listen') {
             const songId = parts[1];
             db.prepare('UPDATE users SET listen_start = ?, listen_song_id = ? WHERE id = ?').run(Date.now(), songId, interaction.user.id);
             incrementViews(songId);
             const guild = client.guilds.cache.get(process.env.GUILD_ID);
             await updatePublicEmbed(guild, songId);
             const link = interaction.message.embeds[0].fields[0].value;
             const reviewBtn = new ButtonBuilder().setCustomId(`review_${songId}`).setLabel('⭐ Review & Earn').setStyle(ButtonStyle.Success);
             try {
                 await interaction.user.send({ content: `⏳ **Timer Started!**\nListen here: ${link}\n\nCome back and click **Review** below after 45 seconds.`, components: [new ActionRowBuilder().addComponents(reviewBtn)] });
                 await interaction.reply({ content: "📩 **Check your DMs!** I sent the listening timer there.", ephemeral: true });
             } catch (e) { await interaction.reply({ content: `⏳ **Timer Started!**\nListen here: ${link}\n\nCome back and click **Review** after 45 seconds.`, components: [new ActionRowBuilder().addComponents(reviewBtn)], ephemeral: true }); }
        }

        if (action === 'review') {
             const songId = parts[1];
             const check = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND song_id = ?').get(interaction.user.id, songId);
             if (check) return interaction.reply({ content: "❌ **You have already reviewed this track.**", ephemeral: true });
             const user = getUser(interaction.user.id);
             const startTime = user.listen_start;
             if (!startTime || user.listen_song_id != songId) return interaction.reply({ content: "Click 'Start Listening' first.", ephemeral: true });
             const elapsed = Date.now() - startTime;
             if (elapsed < 45000) { const remaining = Math.ceil((45000 - elapsed) / 1000); return interaction.reply({ content: `🛑 **Too fast!** Listen for ${remaining} more seconds.`, ephemeral: true }); }
             const modal = new ModalBuilder().setCustomId(`review_submit_${songId}`).setTitle('Write a Review');
             const input = new TextInputBuilder().setCustomId('review_text').setLabel('Feedback (Min 5 words)').setStyle(TextInputStyle.Paragraph).setRequired(true);
             modal.addComponents(new ActionRowBuilder().addComponents(input));
             await interaction.showModal(modal);
        }

        if (action === 'vote') {
             const type = parts[1]; const songId = parts[2];
             let cost = type === 'neg1' ? 3 : parseInt(type); let pointsToAdd = type === 'neg1' ? -1 : parseInt(type);
             if (pointsToAdd > 0) { if (!canUserVote(interaction.user.id, songId, pointsToAdd)) { return interaction.reply({ content: `🛑 **Vote Limit Reached.** You can only give a total of 3 Upvotes per song.`, ephemeral: true }); } }
             const success = spendCredits(interaction.user.id, cost);
             if (success) {
                 if (pointsToAdd > 0) recordVote(interaction.user.id, songId, pointsToAdd);
                 modifyUpvotes(songId, pointsToAdd);
                 const guild = client.guilds.cache.get(process.env.GUILD_ID);
                 await updatePublicEmbed(guild, songId); 
                 const user = getUser(interaction.user.id);
                 const actionText = pointsToAdd > 0 ? `Added +${pointsToAdd} Upvotes` : `Removed 1 Upvote`;
                 try {
                     await interaction.user.send(`✅ **Success!** ${actionText}.\n💰 Remaining Balance: ${user.credits}`);
                     if (interaction.message && interaction.message.channel.type === ChannelType.DM) { await interaction.update({ content: "Vote Recorded.", components: [] }); }
                 } catch(e) { await interaction.update({ content: `✅ **Success!** ${actionText}.\n💰 Remaining Balance: ${user.credits}`, components: [] }); }
             } else { await interaction.reply({ content: `❌ **Insufficient Credits!** Cost: ${cost}. Balance: ${getUser(interaction.user.id).credits}`, ephemeral: true }); }
        }

        if (action === 'report') {
             await interaction.reply({ content: "✅ Report sent to moderators.", ephemeral: true });
             const guild = client.guilds.cache.get(process.env.GUILD_ID);
             const modChannel = guild.channels.cache.get(CHANNEL_MOD_QUEUE);
             if (modChannel) modChannel.send(`⚠️ **Report:** Song ID ${parts[1]} reported by <@${interaction.user.id}>.`);
        }
        
        if (action === 'scribe') {
             const songId = parts[1];
             const modal = new ModalBuilder().setCustomId(`scribe_submit_${songId}`).setTitle('Scribe a Note');
             const input = new TextInputBuilder().setCustomId('scribe_note').setLabel('What was said?').setStyle(TextInputStyle.Paragraph).setRequired(true);
             modal.addComponents(new ActionRowBuilder().addComponents(input));
             await interaction.showModal(modal);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);