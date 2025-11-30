require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
    new SlashCommandBuilder().setName('submit').setDescription('Submit a song to the community'),
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Check stats and financial status')
        .addUserOption(option => option.setName('user').setDescription('Admin/Mod Only: Look up another user')),
    new SlashCommandBuilder().setName('share-profile').setDescription('Post your stats publicly'),
    new SlashCommandBuilder().setName('weekly-report').setDescription('Admin Only: Generate weekly report'),
    
    // NEW: PORTFOLIO COMMANDS
    new SlashCommandBuilder()
        .setName('admin-add-points')
        .setDescription('Admin Only: Stimulus Package')
        .addUserOption(option => option.setName('user').setDescription('Target User').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount of Credits/Lifetime Pts').setRequired(true)),

    new SlashCommandBuilder()
        .setName('admin-set-bonus')
        .setDescription('Admin Only: Increase Daily Submission Cap')
        .addUserOption(option => option.setName('user').setDescription('Target User').setRequired(true))
        .addIntegerOption(option => option.setName('extra_slots').setDescription('Additional slots (e.g. 1 means limit is 4)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('songs')
        .setDescription('View a user\'s last 5 submissions (Private)')
        .addUserOption(option => option.setName('user').setDescription('The user to look up (defaults to you)')),
    
    new SlashCommandBuilder()
        .setName('share-songs')
        .setDescription('Share a user\'s last 5 submissions (Public)')
        .addUserOption(option => option.setName('user').setDescription('The user to look up (defaults to you)')),

    new SlashCommandBuilder()
        .setName('stage')
        .setDescription('Play a song in the Live Session (Earns credits)')
        .addStringOption(option => option.setName('link').setDescription('The song URL').setRequired(true)),

    new SlashCommandBuilder()
        .setName('top')
        .setDescription('Find top rated songs by genre')
        .addStringOption(option => 
            option.setName('genre').setDescription('The Macro Genre').setRequired(true)
            .addChoices(
                { name: 'EDM: House & Techno', value: 'EDM: House & Techno' },
                { name: 'EDM: Trance & Synth', value: 'EDM: Trance & Synth' },
                { name: 'EDM: Bass & Breakbeat', value: 'EDM: Bass & Breakbeat' },
                { name: 'Rock: Classic & Hard', value: 'Rock: Classic & Hard' },
                { name: 'Rock: Metal & Heavy', value: 'Rock: Metal & Heavy' },
                { name: 'Rock: Indie & Alt', value: 'Rock: Indie & Alt' },
                { name: 'Hip Hop & Rap', value: 'Hip Hop & Rap' },
                { name: 'Pop & R&B', value: 'Pop & R&B' },
                { name: 'Country: Modern & Pop', value: 'Country: Modern & Pop' },
                { name: 'Country: Trad & Folk', value: 'Country: Trad & Folk' },
                { name: 'Jazz & Blues', value: 'Jazz & Blues' },
                { name: 'Cinematic & Score', value: 'Cinematic & Score' },
                { name: 'World & International', value: 'World & International' },
                { name: 'Experimental & AI', value: 'Experimental & AI' }
            )),

    new SlashCommandBuilder().setName('init-leaderboard').setDescription('Admin Only: Spawn the leaderboard'),
    new SlashCommandBuilder().setName('init-welcome').setDescription('Admin Only: Spawn the TOS Gate'),
    
    new SlashCommandBuilder()
        .setName('admin-delete')
        .setDescription('Admin Only: Remove a song from DB and Discord')
        .addIntegerOption(option => option.setName('song_id').setDescription('The ID of the song to remove').setRequired(true)),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) { console.error(error); }
})();