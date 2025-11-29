require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const db = require('./database');
const taxonomy = require('./taxonomy.json');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- CONFIGURATION ---
const CHANNEL_LEADERBOARD = '1441545661316206685';
const CHANNEL_MOD_QUEUE = '1441526604449710133';
const CHANNEL_LEGACY = '1441526523659026626'; 
const CHANNEL_VOICE_PARTY = '1441790056770572398';
const CHANNEL_SESSION_LOG = '1444069047816687679';

const CHANNEL_ROUTER = {
    'EDM: House & Techno': '1442168642388230164', 'EDM: Trance & Synth': '1442168642388230164',
    'EDM: Bass & Breakbeat': '1442168686411645100', 'Hip Hop & Rap': '1442168686411645100',
    'Pop & R&B': '1442168686411645100', 'Latin & Reggae': '1442168686411645100',
    'Rock: Classic & Hard': '1442168727717019819', 'Rock: Metal & Heavy': '1442168727717019819',
    'Rock: Indie & Alt': '1442168727717019819', 'Country: Modern & Pop': '1442168727717019819',
    'Country: Trad & Folk': '1442168727717019819', 'Jazz & Blues': '1442168727717019819',
    'Cinematic & Score': '1442168819836649515', 'World & International': '1442168819836649515',
    'Experimental & AI': '1442168819836649515'
};

const DAILY_SUBMISSION_LIMIT = 3; 
const DAILY_POINT_CAP = 40; 
const WALLET_CAP = 60;
const VOICE_PAYOUT = 2; 
const ALLOWED_DOMAINS = ['youtube.com', 'youtu.be', 'music.youtube.com', 'spotify.com', 'suno.com', 'suno.ai', 'soundcloud.com', 'udio.com', 'sonauto.ai', 'tunee.ai', 'mureka.ai'];

// --- SYSTEM ---
const listenTimers = new Map();
const draftSubmissions = new Map(); 
const commandCooldowns = new Map();

process.on('uncaughtException', (err) => console.error('CRITICAL:', err));
setInterval(() => { try { fs.copyFileSync('./data/ravedad.db', './data/ravedad.backup.db'); } catch (e) {} }, 24 * 60 * 60 * 1000);
try { db.prepare('ALTER TABLE songs ADD COLUMN artist_name TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE songs ADD COLUMN channel_id TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE songs ADD COLUMN title TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE votes ADD COLUMN amount INTEGER DEFAULT 1').run(); } catch (e) {}

// --- HELPERS ---
function isValidLink(url) { try { return ALLOWED_DOMAINS.some(d => new URL(url).hostname.toLowerCase().includes(d)); } catch { return false; } }
function truncate(str, n){ return (str.length > n) ? str.slice(0, n-1) + '...' : str; }
function getRankIcon(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`; }

function getUser(userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (id, credits, lifetime_points, daily_points, last_active) VALUES (?, 10, 0, 0, ?)').run(userId, new Date().toDateString());
        return { id: userId, credits: 10, lifetime_points: 0, daily_points: 0, last_active: new Date().toDateString() };
    }
    return user;
}

function getSubmissionCooldown(userId) {
    const songs = db.prepare('SELECT timestamp FROM songs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, DAILY_SUBMISSION_LIMIT);
    if (songs.length < DAILY_SUBMISSION_LIMIT) return null;
    const unlock = songs[songs.length - 1].timestamp + 86400000;
    return Date.now() > unlock ? null : Math.floor(unlock / 1000);
}

function checkDailyLimit(userId) {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const count = db.prepare('SELECT COUNT(*) as count FROM songs WHERE user_id = ? AND timestamp > ?').get(userId, oneDayAgo);
    return count.count;
}

function getCareerStats(userId) {
    const songs = db.prepare('SELECT COUNT(*) as count FROM songs WHERE user_id = ?').get(userId);
    const reviews = db.prepare('SELECT COUNT(*) as count FROM reviews WHERE user_id = ?').get(userId);
    return { songs: songs.count, reviews: reviews.count };
}

function getSongStats(songId) { 
    return db.prepare('SELECT upvotes, views, message_id, channel_id, user_id, description, artist_name, title, tags, url FROM songs WHERE id = ?').get(songId); 
}

function canUserVote(userId, songId, newPoints) {
    if (newPoints < 0) return true; 
    const record = db.prepare('SELECT SUM(amount) as total FROM votes WHERE voter_id = ? AND song_id = ? AND amount > 0').get(userId, songId);
    const currentTotal = record.total || 0;
    return (currentTotal + newPoints) <= 3;
}

function recordVote(userId, songId, amount) {
    db.prepare('INSERT INTO votes (song_id, voter_id, type, timestamp, amount) VALUES (?, ?, ?, ?, ?)').run(songId, userId, 'VOTE', Date.now(), amount);
}

function modifyUpvotes(songId, amount) { db.prepare('UPDATE songs SET upvotes = upvotes + ? WHERE id = ?').run(amount, songId); }
function incrementViews(songId) { db.prepare('UPDATE songs SET views = views + 1 WHERE id = ?').run(songId); }

function spendCredits(userId, amount) {
    const user = getUser(userId);
    if (user.credits < amount) return false;
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
    return true;
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

function buildTrackEmbed(songData) {
    const tags = JSON.parse(songData.tags);
    const artist = songData.artist_name ? `**Artist:** ${songData.artist_name}\n` : '';
    return new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('🔥 Fresh Drop Alert')
        .setDescription(`**User:** <@${songData.user_id}>\n${artist}**Genres:**\n${tags[0]} > ${tags[1]}\n${tags[2] ? `${tags[2]} > ${tags[3]}` : ''}\n\n**Description:**\n${songData.description}`)
        .addFields({ name: 'Listen Here', value: songData.url })
        .setFooter({ text: `Song ID: ${songData.id} | 🔥 Score: ${songData.upvotes || 0} | 👀 Views: ${songData.views || 0}` });
}

function generateSongListEmbed(targetUser, songs) {
    const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle(`💿 Discography: ${targetUser.username}`).setThumbnail(targetUser.displayAvatarURL());
    if (songs.length === 0) { embed.setDescription("*This user hasn't dropped any tracks yet.*"); return embed; }
    const songList = songs.map((s, i) => {
        const title = s.title ? truncate(s.title, 25) : 'Untitled Track';
        const channelId = s.channel_id || CHANNEL_LEGACY;
        const msgLink = s.message_id ? `https://discord.com/channels/${process.env.GUILD_ID}/${channelId}/${s.message_id}` : s.url;
        const tags = JSON.parse(s.tags);
        return `${i+1}. **[${title}](${msgLink})**\n└ ${tags[1]} • 🔥 **${s.upvotes}**`;
    }).join('\n\n');
    embed.setDescription(songList);
    embed.setFooter({ text: 'Click song title to jump to discussion.' });
    return embed;
}

async function updatePublicEmbed(guild, songId) {
    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
    if (!song || !song.message_id) return;
    
    const channel = guild.channels.cache.get(song.channel_id || CHANNEL_LEGACY);
    if (channel) {
        try {
            const message = await channel.messages.fetch(song.message_id);
            if (message) await message.edit({ embeds: [buildTrackEmbed(song)] });
        } catch (e) {}
    }
    const logChannel = guild.channels.cache.get(CHANNEL_SESSION_LOG);
    if (logChannel) {
        try {
            const logs = await logChannel.messages.fetch({ limit: 10 });
            const card = logs.find(m => m.embeds[0]?.footer?.text.includes(`ID: ${songId}`));
            if (card) await card.edit({ embeds: [new EmbedBuilder(card.embeds[0].data).setFooter({ text: `ID: ${songId} | Score: ${song.upvotes}` })] });
        } catch (e) {}
    }
}

// --- LEADERBOARD ENGINE (5 BOARDS) ---
async function updateLeaderboard(guild) {
    const channel = guild.channels.cache.get(CHANNEL_LEADERBOARD);
    if (!channel) return;
    const sevenDaysAgo = Date.now() - 604800000;

    const getStats = () => ({
        totalS: db.prepare('SELECT COUNT(*) as c FROM songs').get().c,
        totalR: db.prepare('SELECT COUNT(*) as c FROM reviews').get().c,
        weekS: db.prepare('SELECT COUNT(*) as c FROM songs WHERE timestamp > ?').get(sevenDaysAgo).c,
        weekR: db.prepare('SELECT COUNT(*) as c FROM reviews WHERE timestamp > ?').get(sevenDaysAgo).c
    });
    const getList = (query, mapFn) => db.prepare(query).all().map(mapFn).join('\n') || "No data.";
    const songMap = (s, i) => `${getRankIcon(i)} ${s.artist_name ? `**${s.artist_name}** - ` : ''}[${truncate(s.title || 'Track', 20)}](${s.url}) • 🔥 **${s.upvotes || s.score}**`;

    const s = getStats();
    const embeds = [
        new EmbedBuilder().setColor(0x2F3136).setTitle('📊 SERVER PULSE').addFields(
            { name: 'Total Songs', value: `**${s.totalS}**`, inline: true }, { name: 'Total Reviews', value: `**${s.totalR}**`, inline: true }, { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Weekly Songs', value: `**${s.weekS}**`, inline: true }, { name: 'Weekly Reviews', value: `**${s.weekR}**`, inline: true }, { name: '\u200B', value: '\u200B', inline: true }
        ),
        new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 ALL-TIME HALL OF FAME').addFields(
            { name: '👑 Top Critics', value: getList('SELECT id, lifetime_points FROM users ORDER BY lifetime_points DESC LIMIT 10', (u,i) => `${getRankIcon(i)} <@${u.id}> • **${u.lifetime_points}**`), inline: true },
            { name: '🎨 Top Artists', value: getList('SELECT user_id, COUNT(*) as c FROM songs GROUP BY user_id ORDER BY c DESC LIMIT 10', (u,i) => `${getRankIcon(i)} <@${u.user_id}> • **${u.c}**`), inline: true }
        ),
        new EmbedBuilder().setColor(0xFFA500).setTitle('🔥 LIFETIME: TOP TRACKS').setDescription(getList('SELECT * FROM songs ORDER BY upvotes DESC LIMIT 10', songMap)),
        new EmbedBuilder().setColor(0x00FF00).setTitle('📅 WEEKLY: TOP MEMBERS').addFields(
            { name: '🚀 Top Critics', value: db.prepare(`SELECT user_id as id, COUNT(*) * 2 as score FROM reviews WHERE timestamp > ${sevenDaysAgo} GROUP BY user_id ORDER BY score DESC LIMIT 10`).all().map((u,i) => `${getRankIcon(i)} <@${u.id}> • **${u.score}**`).join('\n') || "No data.", inline: true },
            { name: '🎨 Top Artists', value: db.prepare(`SELECT user_id, COUNT(*) as c FROM songs WHERE timestamp > ${sevenDaysAgo} GROUP BY user_id ORDER BY c DESC LIMIT 10`).all().map((u,i) => `${getRankIcon(i)} <@${u.user_id}> • **${u.c}**`).join('\n') || "No data.", inline: true }
        ),
        new EmbedBuilder().setColor(0x00FFFF).setTitle('📈 WEEKLY: TRENDING TRACKS').setDescription(db.prepare(`SELECT song_id, SUM(amount) as score FROM votes WHERE timestamp > ${sevenDaysAgo} AND amount > 0 GROUP BY song_id ORDER BY score DESC LIMIT 10`).all().map((stat, i) => {
            const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(stat.song_id);
            return song ? songMap({...song, score: stat.score}, i) : '';
        }).join('\n') || "No data.").setFooter({ text: `Updated: ${new Date().toLocaleTimeString()}` })
    ];

    const messages = await channel.messages.fetch({ limit: 10 });
    for (const embed of embeds) {
        const existing = messages.find(m => m.embeds[0]?.title === embed.data.title);
        if (existing) await existing.edit({ embeds: [embed] }); else await channel.send({ embeds: [embed] });
    }
}

async function finalizeSubmission(interaction, draft) {
    const finalTags = [draft.macro1, draft.micro1, draft.macro2, draft.micro2].filter(t => t && t !== 'SKIP');
    const targetChannelId = CHANNEL_ROUTER[draft.macro1] || CHANNEL_LEGACY; 
    
    const stmt = db.prepare('INSERT INTO songs (user_id, url, description, tags, timestamp, artist_name, title, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(interaction.user.id, draft.link, draft.description, JSON.stringify(finalTags), Date.now(), draft.artist_name, draft.title, targetChannelId);
    const songId = info.lastInsertRowid;

    const channel = interaction.guild.channels.cache.get(targetChannelId);
    if (channel) {
        const sentMsg = await channel.send({ embeds: [buildTrackEmbed({id: songId, ...draft, tags: JSON.stringify(finalTags)})], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`listen_${songId}`).setLabel('🎧 Start Listening').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`report_${songId}`).setLabel('⚠️ Report').setStyle(ButtonStyle.Danger))] });
        db.prepare('UPDATE songs SET message_id = ? WHERE id = ?').run(sentMsg.id, songId);
        try { await sentMsg.startThread({ name: `💬 Reviews: ${draft.artist_name ? draft.artist_name + ' - ' : ''}${truncate(draft.description, 15)}`, autoArchiveDuration: 60 }); } catch (e) {}
    }
    await interaction.update({ content: `✅ **Submission Complete!** Posted to <#${targetChannelId}>.`, components: [] });
    draftSubmissions.delete(interaction.user.id);
}

// --- EVENTS ---
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(() => {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (guild) updateLeaderboard(guild);
    }, 5 * 60 * 1000);
    // Voice Payroll
    setInterval(() => {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (!guild) return;
        const voiceChannel = guild.channels.cache.get(CHANNEL_VOICE_PARTY);
        if (!voiceChannel || voiceChannel.members.size < 2) return; 
        voiceChannel.members.forEach(member => {
            if (!member.voice.selfDeaf && !member.voice.serverDeaf) {
                addPoints(member.id, VOICE_PAYOUT);
            }
        });
    }, 15 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const now = Date.now();
        const userId = interaction.user.id;
        if (interaction.commandName !== 'admin-delete' && commandCooldowns.has(userId)) {
            if (now < commandCooldowns.get(userId) + 3000) return interaction.reply({ content: `⏳ Wait 3 seconds.`, ephemeral: true });
        }
        commandCooldowns.set(userId, now);

        if (interaction.commandName === 'submit') {
            const cd = getCooldownTime(interaction.user.id);
            if (cd) return interaction.reply({ content: `🛑 **Daily Limit Reached!** Unlock: <t:${cd}:R>`, ephemeral: true });
            const modal = new ModalBuilder().setCustomId('submission_modal').setTitle('Submit a Track');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_link').setLabel("Link").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_title').setLabel("Song Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('artist_name').setLabel("Artist (Optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_desc').setLabel("Description").setStyle(TextInputStyle.Paragraph).setMaxLength(100).setRequired(true))
            );
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
                const cd = getCooldownTime(interaction.user.id);
                if (cd) return interaction.reply({ content: `🛑 **Daily Limit Reached!** You cannot stage NEW songs until <t:${cd}:R>.`, ephemeral: true });
                const modal = new ModalBuilder().setCustomId(`stage_modal`).setTitle('Quick Add to Stage');
                draftSubmissions.set(interaction.user.id, { link: link, is_stage: true });
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('song_title').setLabel("Song Title").setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('artist_name').setLabel("Artist Name").setStyle(TextInputStyle.Short).setRequired(true))
                );
                await interaction.showModal(modal);
            }
        }

        if (interaction.commandName === 'profile' || interaction.commandName === 'share-profile') {
            const user = getUser(interaction.user.id);
            const stats = { songs: db.prepare('SELECT COUNT(*) as c FROM songs WHERE user_id = ?').get(user.id).c, reviews: db.prepare('SELECT COUNT(*) as c FROM reviews WHERE user_id = ?').get(user.id).c };
            const cd = getSubmissionCooldown(interaction.user.id);
            const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`👤 Agent Profile: ${interaction.user.username}`).addFields(
                { name: '💰 Credits', value: `**${user.credits}** / ${WALLET_CAP}`, inline: true }, { name: '🏆 Lifetime', value: `**${user.lifetime_points}**`, inline: true }, { name: '📅 Daily', value: `${user.last_active === new Date().toDateString() ? user.daily_points : 0} / ${DAILY_POINT_CAP}`, inline: true },
                { name: '📊 Stats', value: `🎵 **${stats.songs}** Songs | 📝 **${stats.reviews}** Reviews`, inline: false }, { name: '🔓 Status', value: cd ? `⏳ Unlock: <t:${cd}:R>` : `✅ Available`, inline: false }
            ).setThumbnail(interaction.user.displayAvatarURL());
            await interaction.reply({ content: interaction.commandName === 'share-profile' ? "📢 **Flexing Stats!**" : undefined, embeds: [embed], ephemeral: interaction.commandName === 'profile' });
        }
        if (interaction.commandName === 'admin-delete') {
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
            const songId = interaction.options.getInteger('song_id');
            const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
            if (!song) return interaction.reply({ content: "❌ ID not found.", ephemeral: true });
            const channel = interaction.guild.channels.cache.get(song.channel_id || CHANNEL_LEGACY);
            if (channel && song.message_id) {
                try { const msg = await channel.messages.fetch(song.message_id); if(msg) { if(msg.thread) await msg.thread.delete(); await msg.delete(); } } catch(e) {}
            }
            db.prepare('DELETE FROM songs WHERE id = ?').run(songId);
            await interaction.reply({ content: `🗑️ **Terminated.** Song ID ${songId}.`, ephemeral: true });
        }
        if (interaction.commandName === 'init-leaderboard') {
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            await updateLeaderboard(interaction.guild);
            await interaction.editReply({ content: "✅ 5-Board System Initialized." });
        }
        if (interaction.commandName === 'init-welcome') {
             if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
             const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🤖 Welcome to the Future of Music').setDescription(`We are a community of AI music creators dedicated to honest feedback and growth.\n\n**COMMUNITY RULES:**\n1. **Respect Everyone:** No hate speech, harassment, or toxicity.\n2. **Give to Get:** You must review songs to earn credits.\n3. **Honesty:** Low-effort spam reviews will result in a ban.\n4. **No Spam:** Don't DM members with self-promotion.\n\n*By clicking below, you agree to these terms.*`).setImage('https://media.discordapp.net/attachments/123456789/123456789/banner.png');
             const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('accept_tos').setLabel('✅ I Accept & Enter').setStyle(ButtonStyle.Success));
             await interaction.channel.send({ embeds: [embed], components: [row] });
             await interaction.reply({ content: "Gatekeeper initialized.", ephemeral: true });
        }
        if (interaction.commandName === 'weekly-report') {
             if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
             await interaction.deferReply({ ephemeral: true });
             updateLeaderboard(interaction.guild);
             await interaction.editReply({ content: "✅ Boards refreshed." });
        }
        if (interaction.commandName === 'songs' || interaction.commandName === 'share-songs') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const songs = db.prepare('SELECT * FROM songs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 5').all(targetUser.id);
            const embed = generateSongListEmbed(targetUser, songs);
            await interaction.reply({ content: interaction.commandName === 'share-songs' ? `🎵 **Recent Tracks by ${targetUser.username}**` : undefined, embeds: [embed], ephemeral: interaction.commandName === 'songs' });
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'submission_modal' || interaction.customId === 'stage_modal') {
            const isStage = interaction.customId === 'stage_modal';
            const draft = draftSubmissions.get(interaction.user.id) || {};
            if (isStage) {
                 draft.title = interaction.fields.getTextInputValue('song_title');
                 draft.artist_name = interaction.fields.getTextInputValue('artist_name');
            } else {
                 const link = interaction.fields.getTextInputValue('song_link');
                 if (!isValidLink(link)) return interaction.reply({ content: "❌ Invalid Link.", ephemeral: true });
                 draft.link = link;
                 draft.title = interaction.fields.getTextInputValue('song_title');
                 draft.artist_name = interaction.fields.getTextInputValue('artist_name');
                 draft.description = interaction.fields.getTextInputValue('song_desc');
            }
            draftSubmissions.set(interaction.user.id, draft);
            const options = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(isStage ? 'stage_select_genre' : 'select_macro_1').setPlaceholder('Select Genre').addOptions(options));
            await interaction.reply({ content: `**Select Genre:**`, components: [row], ephemeral: true });
        }
        if (interaction.customId.startsWith('scribe_submit_')) {
            const songId = interaction.customId.split('_')[2];
            const note = interaction.fields.getTextInputValue('scribe_note');
            const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
            const channel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(song.channel_id || CHANNEL_LEGACY);
            if (channel && song.message_id) {
                const msg = await channel.messages.fetch(song.message_id);
                let thread = msg.thread;
                if (!thread) thread = await msg.startThread({ name: `💬 Reviews: ${song.title || 'Track'}`, autoArchiveDuration: 60 });
                await thread.send(`🎙️ **Live Session Note** by <@${interaction.user.id}> for <@${song.user_id}>:\n"${note}"`);
                await interaction.reply({ content: "✅ Note scribed.", ephemeral: true });
            }
        }
    }

    if (interaction.isStringSelectMenu()) {
        const draft = draftSubmissions.get(interaction.user.id);
        if (!draft) return interaction.reply({ content: "Session expired.", ephemeral: true });
        
        const handleStep = async (step, selection) => {
            if (step === 'macro') {
                draft.macro1 = selection;
                draftSubmissions.set(interaction.user.id, draft);
                const options = taxonomy[selection].map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_1').setPlaceholder('Select Style').addOptions(options));
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                await interaction.update({ content: `**Step 2/4:** Style for ${selection}`, components: [row, btn] });
            } else if (step === 'micro') {
                draft.micro1 = selection;
                draftSubmissions.set(interaction.user.id, draft);
                const options = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                options.unshift(new StringSelectMenuOptionBuilder().setLabel("🚫 No Secondary Genre (Skip)").setValue("SKIP"));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_2').setPlaceholder('Secondary Genre').addOptions(options));
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_micro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                await interaction.update({ content: `**Step 3/4:** Secondary Genre`, components: [row, btn] });
            } else if (step === 'macro2') {
                if (selection === 'SKIP') return finalizeSubmission(interaction, draft);
                draft.macro2 = selection;
                draftSubmissions.set(interaction.user.id, draft);
                const options = taxonomy[selection].map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_2').setPlaceholder('Secondary Style').addOptions(options));
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_2').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                await interaction.update({ content: `**Step 4/4:** Secondary Style`, components: [row, btn] });
            } else if (step === 'micro2') {
                draft.micro2 = selection;
                finalizeSubmission(interaction, draft);
            }
        };

        if (interaction.customId === 'select_macro_1') handleStep('macro', interaction.values[0]);
        else if (interaction.customId === 'select_micro_1') handleStep('micro', interaction.values[0]);
        else if (interaction.customId === 'select_macro_2') handleStep('macro2', interaction.values[0]);
        else if (interaction.customId === 'select_micro_2') handleStep('micro2', interaction.values[0]);
        
        if (interaction.customId === 'stage_select_genre') {
            const genre = interaction.values[0];
            const targetChannelId = CHANNEL_ROUTER[genre] || CHANNEL_LEGACY;
            const stmt = db.prepare('INSERT INTO songs (user_id, url, description, tags, timestamp, title, artist_name, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            const tags = JSON.stringify([genre, "Live Session"]);
            const info = stmt.run(interaction.user.id, draft.link, "Played Live on Stage", tags, Date.now(), draft.title, draft.artist_name, targetChannelId);
            const songId = info.lastInsertRowid;
            const archiveChannel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(targetChannelId);
            if (archiveChannel) {
                const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('🔥 Fresh Drop Alert (Live)').setDescription(`**User:** <@${interaction.user.id}>\n**Artist:** ${draft.artist_name}\n**Genres:** ${genre}\n\n**Description:**\n${draft.title} (Played Live)`).addFields({name: 'Listen Here', value: draft.link}).setFooter({text: `Song ID: ${songId} | 🔥 Score: 0 | 👀 Views: 0`});
                const listenBtn = new ButtonBuilder().setCustomId(`listen_${songId}`).setLabel('🎧 Start Listening').setStyle(ButtonStyle.Primary);
                const reportBtn = new ButtonBuilder().setCustomId(`report_${songId}`).setLabel('⚠️ Report').setStyle(ButtonStyle.Danger);
                const msg = await archiveChannel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(listenBtn, reportBtn)] });
                db.prepare('UPDATE songs SET message_id = ? WHERE id = ?').run(msg.id, songId);
                await msg.startThread({ name: `💬 Reviews: ${draft.title}`, autoArchiveDuration: 60 });
            }
            const logChannel = client.guilds.cache.get(process.env.GUILD_ID).channels.cache.get(CHANNEL_SESSION_LOG);
            const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🔴 NOW PLAYING').setDescription(`**${draft.title}** by ${draft.artist_name}`).addFields({ name: 'Listen', value: draft.link }).setFooter({ text: `ID: ${songId}` });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_1_${songId}`).setLabel('🔥 Banger (+1)').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`scribe_${songId}`).setLabel('📝 Scribe Note').setStyle(ButtonStyle.Secondary));
            await logChannel.send({ embeds: [embed], components: [row] });
            await interaction.update({ content: "✅ On Stage!", components: [] });
        }
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const action = parts[0];

        if (action === 'back') { 
            const step = parts.slice(2).join('_');
            const draft = draftSubmissions.get(interaction.user.id);
             if (step === 'macro_1') {
                const options = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_1').setPlaceholder('Select Primary Genre').addOptions(options));
                await interaction.update({ content: `**Step 1/4:** Select Primary Genre`, components: [row] });
            } else if (step === 'micro_1') {
                const options = taxonomy[draft.macro1].map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_1').setPlaceholder(`Select Style`).addOptions(options));
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                await interaction.update({ content: `**Step 2/4:** Style for ${draft.macro1}`, components: [row, btn] });
            } else if (step === 'macro_2') {
                 const options = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                 options.unshift(new StringSelectMenuOptionBuilder().setLabel("🚫 No Secondary Genre (Skip)").setValue("SKIP"));
                 const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_2').setPlaceholder('Secondary Genre').addOptions(options));
                 const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_micro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
                 await interaction.update({ content: `**Step 3/4:** Secondary Genre`, components: [row, btn] });
            }
        }
        
        if (action === 'vote') {
            const songId = parts[2];
            const pointsToAdd = parseInt(parts[1] === 'neg1' ? -1 : parts[1]);
            const cost = Math.abs(pointsToAdd); 
            
            const totalVotesRec = db.prepare('SELECT SUM(amount) as total FROM votes WHERE voter_id = ? AND song_id = ? AND amount > 0').get(interaction.user.id, songId);
            const currentTotal = totalVotesRec?.total || 0;
            if (pointsToAdd > 0 && (currentTotal + pointsToAdd) > 3) return interaction.reply({ content: `🛑 **Limit:** You can only give 3 upvotes per song.`, ephemeral: true });
            
            if (spendCredits(interaction.user.id, cost)) {
                recordVote(interaction.user.id, songId, pointsToAdd);
                modifyUpvotes(songId, pointsToAdd);
                const guild = client.guilds.cache.get(process.env.GUILD_ID);
                await updatePublicEmbed(guild, songId);
                const user = getUser(interaction.user.id);
                try { await interaction.user.send(`✅ **Vote Recorded!**\n💰 Remaining: ${user.credits}`); } catch(e){}
                if (interaction.message.channel.type === ChannelType.DM) await interaction.update({ content: "Vote Recorded.", components: [] });
                else await interaction.reply({content: "Vote Recorded.", ephemeral: true});
            } else {
                await interaction.reply({ content: `❌ **Insufficient Credits.** Cost: ${cost}`, ephemeral: true });
            }
        }

        if (action === 'listen') {
            const songId = parts[1];
            listenTimers.set(`${interaction.user.id}_${songId}`, Date.now());
            incrementViews(songId);
            const guild = client.guilds.cache.get(process.env.GUILD_ID);
            await updatePublicEmbed(guild, songId);
            const link = interaction.message.embeds[0].fields[0].value;
            const reviewBtn = new ButtonBuilder().setCustomId(`review_${songId}`).setLabel('⭐ Review & Earn').setStyle(ButtonStyle.Success);
            try { await interaction.user.send({ content: `⏳ **Timer Started!**\nListen: ${link}\nClick below after 45s.`, components: [new ActionRowBuilder().addComponents(reviewBtn)] }); 
            await interaction.reply({ content: "📩 **Check DMs!**", ephemeral: true }); } catch(e) {
                await interaction.reply({ content: `⏳ **Timer Started!**\nListen: ${link}\nClick below after 45s.`, components: [new ActionRowBuilder().addComponents(reviewBtn)], ephemeral: true });
            }
        }

        if (action === 'review') {
             const songId = parts[1];
             const startTime = listenTimers.get(`${interaction.user.id}_${songId}`);
             if (!startTime) return interaction.reply({content: "Click Listen first.", ephemeral: true});
             if (Date.now() - startTime < 45000) return interaction.reply({content: `🛑 **Too fast!** Wait ${(45000 - (Date.now() - startTime))/1000}s`, ephemeral: true});
             const modal = new ModalBuilder().setCustomId(`review_submit_${songId}`).setTitle('Write a Review');
             modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('review_text').setLabel('Feedback').setStyle(TextInputStyle.Paragraph).setRequired(true)));
             await interaction.showModal(modal);
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