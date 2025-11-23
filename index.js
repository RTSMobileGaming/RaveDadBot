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
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- CONFIG: PASTE YOUR CHANNEL IDs HERE ---
// Be sure these match your actual Discord Channel IDs
const CHANNEL_LEADERBOARD = '1441545661316206685';
const CHANNEL_MOD_QUEUE = '1441526604449710133';
const CHANNEL_LEGACY = '1441526523659026626'; 

// Router Map (Genre -> Channel ID)
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
const DAILY_POINT_CAP = 40; 

const ALLOWED_DOMAINS = ['youtube.com', 'youtu.be', 'music.youtube.com', 'spotify.com', 'suno.com', 'suno.ai', 'soundcloud.com', 'udio.com', 'sonauto.ai', 'tunee.ai', 'mureka.ai'];
const BACKUP_INTERVAL = 24 * 60 * 60 * 1000; 

// --- CACHE ---
const listenTimers = new Map();
const draftSubmissions = new Map(); 
const commandCooldowns = new Map();

// --- ERROR & BACKUP ---
process.on('uncaughtException', (error) => { console.error('CRITICAL ERROR:', error); });
setInterval(() => {
    try { fs.copyFileSync('./data/ravedad.db', './data/ravedad.backup.db'); } catch (e) { console.error('Backup failed:', e); }
}, BACKUP_INTERVAL);

// --- AUTO-MIGRATION ---
try { db.prepare('ALTER TABLE songs ADD COLUMN artist_name TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE songs ADD COLUMN channel_id TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE votes ADD COLUMN amount INTEGER DEFAULT 1').run(); } catch (e) {} // Fix for Vote tracking

// --- HELPERS ---
function isValidLink(url) {
    try {
        const domain = new URL(url).hostname.toLowerCase();
        return ALLOWED_DOMAINS.some(d => domain.includes(d));
    } catch (e) { return false; }
}

function checkDailyLimit(userId) {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const count = db.prepare('SELECT COUNT(*) as count FROM songs WHERE user_id = ? AND timestamp > ?').get(userId, oneDayAgo);
    return count.count;
}

function getUser(userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
        db.prepare('INSERT INTO users (id, credits, lifetime_points, daily_points) VALUES (?, 10, 0, 0)').run(userId);
        return { id: userId, credits: 10, lifetime_points: 0, daily_points: 0 };
    }
    return user;
}

function addPoints(userId) {
    const user = getUser(userId);
    if (user.daily_points >= DAILY_POINT_CAP) return { earned: false, reason: "daily_cap" }; 
    if (user.credits >= 60) { 
        db.prepare('UPDATE users SET lifetime_points = lifetime_points + 2, daily_points = daily_points + 2 WHERE id = ?').run(userId);
        return { earned: false, reason: "wallet_cap" };
    }
    db.prepare('UPDATE users SET credits = credits + 2, lifetime_points = lifetime_points + 2, daily_points = daily_points + 2 WHERE id = ?').run(userId);
    return { earned: true, amount: 2 };
}

function spendCredits(userId, amount) {
    const user = getUser(userId);
    if (user.credits < amount) return false;
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
    return true;
}

function modifyUpvotes(songId, amount) { db.prepare('UPDATE songs SET upvotes = upvotes + ? WHERE id = ?').run(amount, songId); }
function incrementViews(songId) { db.prepare('UPDATE songs SET views = views + 1 WHERE id = ?').run(songId); }
function getSongStats(songId) { return db.prepare('SELECT upvotes, views, message_id, channel_id, user_id, description, artist_name, tags, url FROM songs WHERE id = ?').get(songId); }
function truncate(str, n){ return (str.length > n) ? str.slice(0, n-1) + '...' : str; }
function getRankIcon(index) { return index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`; }

// --- NEW: VOTE TRACKING ---
function canUserVote(userId, songId, newPoints) {
    // Only restrict positive votes (upvotes). Allow dislikes separately or treat them differently?
    // For now, let's assume the limit applies to Upvotes (Positive Score)
    if (newPoints < 0) return true; // Allow dislike

    const record = db.prepare('SELECT SUM(amount) as total FROM votes WHERE voter_id = ? AND song_id = ? AND amount > 0').get(userId, songId);
    const currentTotal = record.total || 0;
    return (currentTotal + newPoints) <= 3;
}

function recordVote(userId, songId, amount) {
    db.prepare('INSERT INTO votes (song_id, voter_id, type, timestamp, amount) VALUES (?, ?, ?, ?, ?)').run(songId, userId, 'VOTE', Date.now(), amount);
}

// --- LEADERBOARD ---
async function updateLeaderboard(guild) {
    const channel = guild.channels.cache.get(CHANNEL_LEADERBOARD);
    if (!channel) return;

    const topUsers = db.prepare('SELECT id, lifetime_points FROM users ORDER BY lifetime_points DESC LIMIT 10').all();
    const userList = topUsers.map((u, i) => `${getRankIcon(i)} <@${u.id}> • **${u.lifetime_points}** pts`).join('\n') || "No data yet.";
    const criticEmbed = new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 TOP 10 CRITICS').setDescription(userList).setFooter({ text: 'Earn points by reviewing tracks.' });

    const topSongs = db.prepare('SELECT id, url, upvotes, tags, description, artist_name FROM songs ORDER BY upvotes DESC LIMIT 10').all();
    const songList = topSongs.map((s, i) => {
        const tags = JSON.parse(s.tags);
        const artistDisplay = s.artist_name ? `**${s.artist_name}** - ` : '';
        const descSnippet = truncate(s.description, 25);
        return `${getRankIcon(i)} ${artistDisplay}[${descSnippet}](${s.url})\n└ ${tags[1]} • 🔥 **${s.upvotes}**`;
    }).join('\n') || "No data yet.";
    const trackEmbed = new EmbedBuilder().setColor(0x0099FF).setTitle('🎵 TOP 10 TRACKS').setDescription(songList).setFooter({ text: `Updated: ${new Date().toLocaleTimeString()}` });

    const messages = await channel.messages.fetch({ limit: 10 });
    const criticMsg = messages.find(m => m.embeds[0]?.title === '🏆 TOP 10 CRITICS');
    if (criticMsg) await criticMsg.edit({ embeds: [criticEmbed] }); else await channel.send({ embeds: [criticEmbed] });
    const trackMsg = messages.find(m => m.embeds[0]?.title === '🎵 TOP 10 TRACKS');
    if (trackMsg) await trackMsg.edit({ embeds: [trackEmbed] }); else await channel.send({ embeds: [trackEmbed] });
}

// --- FIXED EMBED UPDATER ---
async function updatePublicEmbed(guild, songId) {
    const song = getSongStats(songId);
    if (!song || !song.message_id) return;
    
    // 1. Try the saved channel ID
    let channelId = song.channel_id;
    
    // 2. Fallback if ID is missing (Old songs) or invalid
    if (!channelId) channelId = CHANNEL_LEGACY;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    try {
        const message = await channel.messages.fetch(song.message_id);
        if (message) {
            const tags = JSON.parse(song.tags); 
            const primaryDisplay = `${tags[0]} > ${tags[1]}`;
            const secondaryDisplay = tags[2] && tags[2] !== 'SKIP' ? `\n${tags[2]} > ${tags[3]}` : '';
            const artistField = song.artist_name ? `**Artist:** ${song.artist_name}\n` : '';

            const newEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('🔥 Fresh Drop Alert')
                .setDescription(`**User:** <@${song.user_id}>\n${artistField}**Genres:**\n${primaryDisplay}${secondaryDisplay}\n\n**Description:**\n${song.description}`)
                .addFields({ name: 'Listen Here', value: song.url })
                .setFooter({ text: `Song ID: ${songId} | 🔥 Score: ${song.upvotes} | 👀 Views: ${song.views}` });

            await message.edit({ embeds: [newEmbed] });
        }
    } catch (e) { console.error(`Update Embed Failed for Song ${songId}:`, e); }
}

async function finalizeSubmission(interaction, draft) {
    const finalTags = [draft.macro1, draft.micro1, draft.macro2, draft.micro2].filter(t => t && t !== 'SKIP');
    
    // ROUTER LOGIC
    const targetChannelId = CHANNEL_ROUTER[draft.macro1] || CHANNEL_LEGACY; 

    const stmt = db.prepare('INSERT INTO songs (user_id, url, description, tags, timestamp, artist_name, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(interaction.user.id, draft.link, draft.description, JSON.stringify(finalTags), Date.now(), draft.artist_name, targetChannelId);
    const songId = info.lastInsertRowid;

    const channel = interaction.guild.channels.cache.get(targetChannelId);
    if (channel) {
        const primaryDisplay = `${draft.macro1} > ${draft.micro1}`;
        const secondaryDisplay = draft.macro2 && draft.macro2 !== 'SKIP' ? `\n${draft.macro2} > ${draft.micro2}` : '';
        const artistField = draft.artist_name ? `**Artist:** ${draft.artist_name}\n` : '';

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('🔥 Fresh Drop Alert')
            .setDescription(`**User:** <@${interaction.user.id}>\n${artistField}**Genres:**\n${primaryDisplay}${secondaryDisplay}\n\n**Description:**\n${draft.description}`)
            .addFields({ name: 'Listen Here', value: draft.link })
            .setFooter({ text: `Song ID: ${songId} | 🔥 Score: 0 | 👀 Views: 0` });

        const listenBtn = new ButtonBuilder().setCustomId(`listen_${songId}`).setLabel('🎧 Start Listening').setStyle(ButtonStyle.Primary);
        const reportBtn = new ButtonBuilder().setCustomId(`report_${songId}`).setLabel('⚠️ Report').setStyle(ButtonStyle.Danger);

        const sentMsg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(listenBtn, reportBtn)] });
        db.prepare('UPDATE songs SET message_id = ? WHERE id = ?').run(sentMsg.id, songId);

        try {
            await sentMsg.startThread({
                name: `💬 Reviews: ${draft.artist_name ? draft.artist_name + ' - ' : ''}${truncate(draft.description, 15)}`,
                autoArchiveDuration: 60, 
                reason: 'Song Review Thread',
            });
        } catch (e) { console.error("Could not create thread:", e); }
    }
    await interaction.update({ content: `✅ **Submission Complete!** Posted to <#${targetChannelId}>.`, components: [] });
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
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
            
            const songId = interaction.options.getInteger('song_id');
            const song = getSongStats(songId);

            if (!song) return interaction.reply({ content: `❌ Song ID ${songId} not found in database.`, ephemeral: true });

            const targetChannelId = song.channel_id || CHANNEL_LEGACY;
            const channel = interaction.guild.channels.cache.get(targetChannelId);
            
            if (channel && song.message_id) {
                try {
                    const msg = await channel.messages.fetch(song.message_id);
                    if (msg) {
                        if (msg.thread) await msg.thread.delete(); 
                        await msg.delete(); 
                    }
                } catch (e) { console.log("Message/Thread already gone from Discord."); }
            }

            db.prepare('DELETE FROM songs WHERE id = ?').run(songId);
            await interaction.reply({ content: `🗑️ **Terminated.** Song ID ${songId} deleted.`, ephemeral: true });
        }

        if (interaction.commandName === 'submit') {
            const submissionCount = checkDailyLimit(interaction.user.id);
            if (submissionCount >= DAILY_SUBMISSION_LIMIT) {
                return interaction.reply({ content: `🛑 **Daily Limit Reached!**\nYou have submitted ${submissionCount}/${DAILY_SUBMISSION_LIMIT} songs in the last 24 hours.`, ephemeral: true });
            }
            const modal = new ModalBuilder().setCustomId('submission_modal').setTitle('Submit a Track');
            const linkInput = new TextInputBuilder().setCustomId('song_link').setLabel("Link").setStyle(TextInputStyle.Short).setRequired(true);
            const descInput = new TextInputBuilder().setCustomId('song_desc').setLabel("Description").setStyle(TextInputStyle.Paragraph).setMaxLength(100).setRequired(true);
            const artistInput = new TextInputBuilder().setCustomId('artist_name').setLabel("Artist/Band Name (Optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50);

            modal.addComponents(
                new ActionRowBuilder().addComponents(linkInput), 
                new ActionRowBuilder().addComponents(artistInput),
                new ActionRowBuilder().addComponents(descInput)
            );
            await interaction.showModal(modal);
        }
        if (interaction.commandName === 'profile') {
            const user = getUser(interaction.user.id);
            const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`👤 Agent Profile: ${interaction.user.username}`).addFields({ name: '💰 Credits', value: `${user.credits} / 60`, inline: true }, { name: '🏆 Lifetime Score', value: `${user.lifetime_points}`, inline: true }, { name: '📅 Daily Progress', value: `${user.daily_points} / ${DAILY_POINT_CAP} pts`, inline: true }).setThumbnail(interaction.user.displayAvatarURL());
            await interaction.reply({ embeds: [embed], ephemeral: true });
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
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
            await interaction.reply({ content: "Initializing dual leaderboards...", ephemeral: true });
            updateLeaderboard(interaction.guild);
        }
        if (interaction.commandName === 'init-welcome') {
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: "Admin only.", ephemeral: true });
            const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('🤖 Welcome to the Future of Music').setDescription(`We are a community of AI music creators dedicated to honest feedback and growth.\n\n**COMMUNITY RULES:**\n1. **Respect Everyone:** No hate speech, harassment, or toxicity.\n2. **Give to Get:** You must review songs to earn credits.\n3. **Honesty:** Low-effort spam reviews will result in a ban.\n4. **No Spam:** Don't DM members with self-promotion.\n\n*By clicking below, you agree to these terms.*`).setImage('https://media.discordapp.net/attachments/123456789/123456789/banner.png');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('accept_tos').setLabel('✅ I Accept & Enter').setStyle(ButtonStyle.Success));
            await interaction.channel.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: "Gatekeeper initialized.", ephemeral: true });
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'submission_modal') {
        const link = interaction.fields.getTextInputValue('song_link');
        if (!isValidLink(link)) return interaction.reply({ content: "❌ **Security Alert:** Link not allowed.", ephemeral: true });
        const desc = interaction.fields.getTextInputValue('song_desc');
        const artist = interaction.fields.getTextInputValue('artist_name'); 

        draftSubmissions.set(interaction.user.id, { link, description: desc, artist_name: artist });
        
        const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_1').setPlaceholder('Select Primary Category').addOptions(macroOptions));
        await interaction.reply({ content: `**Step 1/4:** Select Primary Genre`, components: [row], ephemeral: true });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('review_submit_')) {
        const songId = interaction.customId.split('_')[2];
        const reviewText = interaction.fields.getTextInputValue('review_text');
        const check = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND song_id = ?').get(interaction.user.id, songId);
        if (check) return interaction.reply({ content: "❌ **Nice try!** You have already earned points for this song.", ephemeral: true });
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
        // --- FIX: Use the stored channel ID or fallback to legacy ---
        const targetChannelId = song.channel_id || CHANNEL_LEGACY;
        
        if (song && song.message_id) {
            try {
                const channel = interaction.guild.channels.cache.get(targetChannelId);
                const message = await channel.messages.fetch(song.message_id);
                if (message && message.thread) {
                    await message.thread.send(`⭐ **<@${interaction.user.id}>** says:\n"${reviewText}"`);
                }
            } catch (e) { console.error("Thread Post Error:", e); }
        }
    }

    if (interaction.isStringSelectMenu()) {
        const draft = draftSubmissions.get(interaction.user.id);
        if (!draft) return interaction.reply({ content: "Session expired.", ephemeral: true });

        if (interaction.customId === 'select_macro_1') {
            draft.macro1 = interaction.values[0];
            draftSubmissions.set(interaction.user.id, draft);
            const options = taxonomy[draft.macro1].map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
            const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_1').setPlaceholder(`Select Style`).addOptions(options));
            const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
            await interaction.update({ content: `**Step 2/4:** Select specific style for ${draft.macro1}`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_micro_1') {
            draft.micro1 = interaction.values[0];
            draftSubmissions.set(interaction.user.id, draft);
            const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
            macroOptions.unshift(new StringSelectMenuOptionBuilder().setLabel("🚫 No Secondary Genre (Skip)").setValue("SKIP"));
            const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_2').setPlaceholder('Select Secondary Category').addOptions(macroOptions));
            const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_micro_1').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
            await interaction.update({ content: `**Step 3/4:** Select a Secondary Genre (or Skip)`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_macro_2') {
            if (interaction.values[0] === 'SKIP') {
                draft.macro2 = 'SKIP';
                return finalizeSubmission(interaction, draft);
            }
            draft.macro2 = interaction.values[0];
            draftSubmissions.set(interaction.user.id, draft);
            const options = taxonomy[draft.macro2].map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
            const menuRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_micro_2').setPlaceholder(`Select Style`).addOptions(options));
            const btnRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_macro_2').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary));
            await interaction.update({ content: `**Step 4/4:** Select specific style for ${draft.macro2}`, components: [menuRow, btnRow] });
        }
        else if (interaction.customId === 'select_micro_2') {
            draft.micro2 = interaction.values[0];
            return finalizeSubmission(interaction, draft);
        }
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const action = parts[0];

        if (action === 'back') {
            const draft = draftSubmissions.get(interaction.user.id);
            if (!draft) return interaction.reply({ content: "Session expired. Please restart.", ephemeral: true });
            const step = parts.slice(2).join('_');

            if (step === 'macro_1') {
                const macroOptions = Object.keys(taxonomy).map(m => new StringSelectMenuOptionBuilder().setLabel(m).setValue(m));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('select_macro_1').setPlaceholder('Select Primary Category').addOptions(macroOptions));
                await interaction.update({ content: `**Step 1/4:** Select Primary Genre`, components: [row] });
            }
            else if (step === 'micro_1') {
                const subGenres = taxonomy[draft.macro1];
                const options = subGenres.map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s));
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
                const role = interaction.guild.roles.cache.find(r => r.name === roleName);
                if (!role) return interaction.reply({ content: `❌ **Configuration Error:** Role "${roleName}" not found.`, ephemeral: true });
                if (interaction.member.roles.cache.has(role.id)) return interaction.reply({ content: "You are already verified! Go make some music.", ephemeral: true });
                try { await interaction.member.roles.add(role); await interaction.reply({ content: "✅ **Access Granted.** Welcome to the community!", ephemeral: true }); } catch (err) { console.error(err); await interaction.reply({ content: "❌ Error: Bot Role must be higher than 'Verified Member'.", ephemeral: true }); }
            }
        }

        if (action === 'listen') {
            const songId = parts[1];
            listenTimers.set(`${interaction.user.id}_${songId}`, Date.now());
            incrementViews(songId);
            await updatePublicEmbed(interaction.guild, songId);
            const link = interaction.message.embeds[0].fields[0].value;
            const reviewBtn = new ButtonBuilder().setCustomId(`review_${songId}`).setLabel('⭐ Review & Earn').setStyle(ButtonStyle.Success);
            
            try {
                await interaction.user.send({ 
                    content: `⏳ **Timer Started!**\nListen here: ${link}\n\nCome back and click **Review** below after 45 seconds.`, 
                    components: [new ActionRowBuilder().addComponents(reviewBtn)] 
                });
                await interaction.reply({ content: "📩 **Check your DMs!** I sent the listening timer there.", ephemeral: true });
            } catch (e) {
                await interaction.reply({ 
                    content: `⏳ **Timer Started!**\nListen here: ${link}\n\nCome back and click **Review** after 45 seconds.`, 
                    components: [new ActionRowBuilder().addComponents(reviewBtn)], 
                    ephemeral: true 
                });
            }
        }

        if (action === 'review') {
            const songId = parts[1];
            const check = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND song_id = ?').get(interaction.user.id, songId);
            if (check) return interaction.reply({ content: "❌ **You have already reviewed this track.**", ephemeral: true });

            const startTime = listenTimers.get(`${interaction.user.id}_${songId}`);
            if (!startTime) return interaction.reply({ content: "Click 'Start Listening' first.", ephemeral: true });
            const elapsed = Date.now() - startTime;
            if (elapsed < 45000) {
                const remaining = Math.ceil((45000 - elapsed) / 1000);
                return interaction.reply({ content: `🛑 **Too fast!** Listen for ${remaining} more seconds.`, ephemeral: true });
            }
            const modal = new ModalBuilder().setCustomId(`review_submit_${songId}`).setTitle('Write a Review');
            const input = new TextInputBuilder().setCustomId('review_text').setLabel('Feedback (Min 5 words)').setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }

        if (action === 'vote') {
            const type = parts[1]; 
            const songId = parts[2];
            let cost = type === 'neg1' ? 3 : parseInt(type);
            let pointsToAdd = type === 'neg1' ? -1 : parseInt(type);
            
            // --- FIX: CHECK VOTE CAP ---
            if (pointsToAdd > 0) {
                if (!canUserVote(interaction.user.id, songId, pointsToAdd)) {
                    return interaction.reply({ content: `🛑 **Vote Limit Reached.** You can only give a total of 3 Upvotes per song.`, ephemeral: true });
                }
            }

            const success = spendCredits(interaction.user.id, cost);
            if (success) {
                // Record the vote for future checking
                if (pointsToAdd > 0) recordVote(interaction.user.id, songId, pointsToAdd);
                
                modifyUpvotes(songId, pointsToAdd);
                await updatePublicEmbed(interaction.guild, songId); 
                const user = getUser(interaction.user.id);
                const actionText = pointsToAdd > 0 ? `Added +${pointsToAdd} Upvotes` : `Removed 1 Upvote`;
                
                try {
                    await interaction.user.send(`✅ **Success!** ${actionText}.\n💰 Remaining Balance: ${user.credits}`);
                    if (interaction.message.type === 0) await interaction.update({ content: "Vote Recorded.", components: [] });
                } catch(e) {
                    await interaction.update({ content: `✅ **Success!** ${actionText}.\n💰 Remaining Balance: ${user.credits}`, components: [] });
                }
            } else {
                await interaction.reply({ content: `❌ **Insufficient Credits!** Cost: ${cost}. Balance: ${getUser(interaction.user.id).credits}`, ephemeral: true });
            }
        }

        if (action === 'report') {
            await interaction.reply({ content: "✅ Report sent to moderators.", ephemeral: true });
            const modChannel = interaction.guild.channels.cache.get(CHANNEL_MOD_QUEUE);
            if (modChannel) modChannel.send(`⚠️ **Report:** Song ID ${parts[1]} reported by <@${interaction.user.id}>.`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);